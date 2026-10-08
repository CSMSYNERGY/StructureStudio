import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { checkAdminPassword } from "../_shared/adminGate.ts";
import { checkAdminAuth } from "../_shared/adminAuth.ts";
import { logEdgeError, withErrorLog } from "../_shared/logError.ts";
import { AUTH_PORTAL_URL } from "../_shared/authPortalUrl.ts";
import { linkOwnerRow, type LinkRole } from "../_shared/linkOwnerRow.ts";
import { paidThroughOf } from "../_shared/billingPeriods.ts";
import { pingAvalara } from "../_shared/salesTax.ts";
import { finishLookup, insertLookup, PING_CLIENT_ID, pingResponse } from "../_shared/taxLookups.ts";
import { syncTaxCodes } from "../_shared/taxCodeSync.ts";
// "Offered on" (272): a template's per-style fixture lists, carried into a clone. portal-settings
// imports the same module, so a change to it deploys both functions.
import { cloneStyleIds } from "../_shared/fixtureStyleIds.ts";
// delete_client cancels the builder's subscriptions and removes their saved card at the gateway
// before it wipes anything (2026-10-05). nmi.ts is the one gateway client; see its importer ledger.
import { nmiConfigured, nmiPost } from "../_shared/nmi.ts";
import { cleanupTenantGateway, GatewayCleanupError, needsGateway, openSubscriptions } from "../_shared/tenantGatewayCleanup.ts";
import {
  chargingMode, describeSettingsChange, monthRange, normalizePilotIds, normalizeSettings,
  parseSettingsPatch, PHONE_METER_LABELS, PHONE_METERS, PHONE_SETTINGS_COLUMNS, phoneBillingDbError,
  summarizePhoneUsage, type PhoneBillingSettings, type TwilioDailyRow, type UsageChargeRow,
} from "../_shared/phoneBillingAdmin.ts";

// Operator (super-admin) catalog tool, used by the standalone admin.html page.
// Gated by the shared ADMIN_PASSWORD edge-function secret (same secret as
// admin-save-settings). Manages the GLOBAL master layout-item palette (layout_item_types)
// and per-client catalog (client_layout_items, building_styles/building_sizes). All writes
// use the service role (bypass RLS).
// Kept separate from admin-save-settings so GHL-credential logic stays isolated.

const cors = {
  "Access-Control-Allow-Origin": "*",
  // x-ss-stepup: sent by portal.html's adminApi on password-carrying step-up calls
  // (delete_client) so its 401s bypass the global session-expired logout. A custom
  // request header MUST be in this allow-list or the browser kills the call at CORS
  // preflight — for right AND wrong passwords alike, which is exactly how the 00a819b
  // step-up fix shipped broken: the header was added client-side only.
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-ss-stepup",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  // The browser keeps this preflight for 2 h (Chrome's cap) instead of 5 s — see portal-settings.
  "Access-Control-Max-Age": "86400",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
const reqStr = (v: unknown, name: string) => {
  if (typeof v !== "string" || !v.trim()) throw new Error(`${name} is required.`);
  return v.trim();
};

// AUTH_PORTAL_URL — the one destination every auth email lands on — moved to
// `_shared/authPortalUrl.ts` (imported above) when operator-portal gained its own
// reset-link action. The reasoning is in that file; the short version is that a second
// copy of this constant would be exactly the drift it exists to prevent.

// ── Supabase Auth custom-SMTP config via the Management API ──────────────────
// Powers the admin.html "Email Sender" card. Pointing the project's Auth SMTP at
// a Google account (Gmail host + app password) makes ALL auth emails — owner
// invites, password resets, email changes — send from that address instead of
// Supabase's default sender, with no per-flow code. Requires a Supabase personal
// access token in the MGMT_TOKEN secret — NOT "SUPABASE_MGMT_TOKEN": Supabase
// reserves the SUPABASE_ prefix and rejects any edge secret named with it. The app
// password is write-only: it lives only inside this Auth config, never returned by GET.
const PROJECT_REF = "jzeamjbhdrsbygdnphbm";
async function mgmtAuthConfig(method: "GET" | "PATCH", body?: unknown) {
  const token = Deno.env.get("MGMT_TOKEN");
  if (!token) {
    throw new Error(
      "Email sending isn't set up on the server yet: the MGMT_TOKEN secret is missing. " +
      "Create a Supabase personal access token at https://supabase.com/dashboard/account/tokens and add " +
      "it as an Edge Function secret named MGMT_TOKEN.");
  }
  const r = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/config/auth`, {
    method,
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
  if (!r.ok) {
    const msg = (data && (data.message || data.error || data.msg)) || text || `request failed (${r.status})`;
    // 401/403 means the secret EXISTS but the Management API rejected it — an expired, revoked or
    // wrong-project token. That is a different fix from the missing-secret branch above, and it used
    // to surface as a bare "Supabase Management API: Unauthorized", which reads like a code bug and
    // cost a whole session to diagnose (the giveaway was only that it was NOT the missing-token
    // message). Name the actual cause and the actual fix, matching that branch's helpfulness.
    if (r.status === 401 || r.status === 403) {
      throw new Error(
        "Email sending is misconfigured on the server: the MGMT_TOKEN secret is present but the " +
        "Supabase Management API rejected it (expired, revoked, or issued for a different project). " +
        "Mint a fresh personal access token at https://supabase.com/dashboard/account/tokens and " +
        "replace the Edge Function secret named MGMT_TOKEN, then retry. " +
        `Until then get_email_sender / connect_email / disconnect_email all fail. (API said: ${String(msg).slice(0, 200)})`);
    }
    throw new Error(`Supabase Management API: ${String(msg).slice(0, 500)}`);
  }
  return data;
}

// Validate a client_id: DNS-safe slug AND must exist in client_configs — so a
// write/upload can never land under a typo'd or malformed tenant prefix.
async function assertClient(sb: any, clientId: string) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(clientId)) throw new Error("invalid client id");
  const { data, error } = await sb.from("client_configs").select("client_id").eq("client_id", clientId).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("unknown builder");
  return clientId;
}

// Shared CSV pricing + inclusion importer (also used by portal-settings).
// rows: [{ style, width, length, price, active, inclusions: { item_key: qty } }].
// Inclusion cells are QUANTITIES (2026-07-07): loft = included sq ft (e.g. 50),
// doors = count (e.g. 1); 0/blank/"no" = not included. Legacy yes-style tokens
// still import as quantity 1 so previously downloaded sheets keep working.
// Resolves the style by label OR key (case-insensitive). CREATES the size if a
// (style, width, length) combo doesn't exist yet, otherwise UPDATES it — keyed on
// dimensions, so re-uploading the same sheet updates prices without ever creating
// duplicates. A size is offered only when it's active AND priced: a blank price (or
// active=no) hides it (NULL-base-price contract). Never creates styles — those must
// exist first (built via the styles tab), which is what the IDs are matched against.
async function importPricingRows(sb: any, clientId: string, rows: any[]) {
  const st = await sb.from("building_styles").select("id, key, label").eq("client_id", clientId);
  if (st.error) throw st.error;
  const sz = await sb.from("building_sizes").select("id, style_id, width_ft, length_ft, sort_order").eq("client_id", clientId);
  if (sz.error) throw sz.error;
  // A cell resolves against every style's label OR key, hidden styles included — and nothing
  // makes a label unique (create_style only uniquifies the key). So with a hidden "Barn" and a
  // fresh "Barn", last-writer-wins sent a whole sheet of prices to whichever came back last,
  // possibly the hidden one, while the live style kept quoting the old numbers and the banner
  // reported them imported. A name more than one style answers to now resolves to nobody and
  // its rows are skipped by name. (The portal's Structures upload refuses the same case before
  // sending; both operator consoles reach this function with no such guard.)
  const styleByName = new Map<string, any>();
  const claimedBy = new Map<string, Set<string>>();   // lowercased label/key -> style ids
  for (const s of st.data ?? []) {
    for (const tok of [s.label, s.key]) {
      const t = String(tok ?? "").trim().toLowerCase();
      if (!t) continue;
      styleByName.set(t, s);
      const ids = claimedBy.get(t) ?? new Set<string>();
      ids.add(String(s.id));
      claimedBy.set(t, ids);
    }
  }
  const sizeByDims = new Map<string, any>();   // `${style_id}|${w}|${l}` -> row
  const maxSort = new Map<string, number>();   // style_id -> highest sort_order
  for (const z of sz.data ?? []) {
    const zw = Number(z.width_ft), zl = Number(z.length_ft);
    sizeByDims.set(`${z.style_id}|${zw}|${zl}`, { id: z.id });
    const cur = maxSort.get(z.style_id) ?? -1;
    if ((z.sort_order ?? 0) > cur) maxSort.set(z.style_id, z.sort_order ?? 0);
  }
  // Inclusion cell -> included quantity. 0 = not included (delete the row).
  // Numbers win ("50" -> 50 sq ft, "2" -> 2); legacy yes-tokens mean quantity 1;
  // anything else (blank, "no", garbage) is 0 — same delete behavior as before.
  const parseInclusionQty = (v: unknown): number => {
    if (v === true) return 1;
    const s = String(v ?? "").trim().toLowerCase();
    if (s === "") return 0;
    if (["yes", "y", "true", "x", "included"].includes(s)) return 1;
    const n = Number(s.replace(/[$,\s]/g, ""));
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  };
  const isLegacyYes = (v: unknown) => v === true || ["yes", "y", "true", "x", "included"].includes(String(v ?? "").trim().toLowerCase());
  // Existing inclusion quantities: a legacy "yes" cell (old saved sheet) PRESERVES a
  // configured qty (e.g. loft 50 sq ft) instead of silently downgrading it to 1.
  const existingQty = new Map<string, number>();   // `${size_id}|${item_key}` -> qty
  const exq = await sb.from("building_size_inclusions").select("size_id, item_key, qty").eq("client_id", clientId);
  if (exq.error) throw exq.error;
  for (const r of exq.data ?? []) existingQty.set(`${r.size_id}|${r.item_key}`, Number(r.qty) || 1);
  const inactiveWord = (v: unknown) => ["no", "n", "0", "false", "inactive"].includes(String(v ?? "").trim().toLowerCase());
  const num = (v: unknown) => { const blank = v === "" || v == null; if (blank) return { blank: true, n: NaN }; return { blank: false, n: Number(String(v).replace(/[$,\s]/g, "")) }; };
  const fmt = (n: number) => String(n);
  let created = 0, updated = 0; const skipped: string[] = [];
  for (const row of rows) {
    const styleName = String(row?.style ?? "").trim();
    const wv = num(row?.width), lv = num(row?.length);
    if (!styleName && wv.blank && lv.blank) continue;   // wholly blank line
    if ((claimedBy.get(styleName.toLowerCase())?.size ?? 0) > 1) {
      skipped.push(`${styleName}: more than one building style answers to this name (a hidden style counts) — rename one of them, then import again`);
      continue;
    }
    const style = styleByName.get(styleName.toLowerCase());
    if (!style) { skipped.push(`${styleName || "(blank)"}: unknown style`); continue; }
    if (wv.blank && lv.blank) { skipped.push(`${styleName}: missing width & length`); continue; }
    if (!Number.isFinite(wv.n) || !Number.isFinite(lv.n) || wv.n <= 0 || lv.n <= 0) {
      skipped.push(`${styleName} ${row?.width}x${row?.length}: invalid width/length`); continue;
    }
    const w = wv.n, l = lv.n;
    const pr = num(row?.price);
    // Negative is refused with the unparseable: nothing in the product means a building priced
    // below zero: submit-estimate would email it as a negative building line, while the
    // designer's preview clamps the line to $0, so the customer saw one number and got another.
    if (!pr.blank && (!Number.isFinite(pr.n) || pr.n < 0)) { skipped.push(`${styleName} ${w}x${l}: invalid price "${row?.price}"`); continue; }
    const price = pr.blank ? null : pr.n;
    const active = !inactiveWord(row?.active) && price != null;   // active intent AND priced
    const label = `${fmt(w)}x${fmt(l)}`;
    const dimKey = `${style.id}|${w}|${l}`;
    let sizeId: string;
    const existing = sizeByDims.get(dimKey);
    if (existing) {
      const up = await sb.from("building_sizes").update({ label, base_price: price, active }).eq("id", existing.id);
      if (up.error) { skipped.push(`${styleName} ${label}: ${up.error.message}`); continue; }
      sizeId = existing.id; updated++;
    } else {
      const nextSort = (maxSort.get(style.id) ?? -1) + 1; maxSort.set(style.id, nextSort);
      const insv = await sb.from("building_sizes").insert(
        { client_id: clientId, style_id: style.id, label, width_ft: w, length_ft: l,
          base_price: price, active, sort_order: nextSort }).select("id").maybeSingle();
      if (insv.error) { skipped.push(`${styleName} ${label}: ${insv.error.message}`); continue; }
      sizeId = insv.data!.id; sizeByDims.set(dimKey, { id: sizeId }); created++;
    }
    const inc = (row.inclusions && typeof row.inclusions === "object") ? row.inclusions : {};
    for (const [itemKey, val] of Object.entries(inc)) {
      if (!itemKey) continue;
      let qty = parseInclusionQty(val);
      if (qty === 1 && isLegacyYes(val)) qty = existingQty.get(`${sizeId}|${itemKey}`) ?? 1;
      const incRes = qty > 0
        ? await sb.from("building_size_inclusions").upsert({ client_id: clientId, size_id: sizeId, item_key: itemKey, included: true, qty }, { onConflict: "size_id,item_key" })
        : await sb.from("building_size_inclusions").delete().eq("size_id", sizeId).eq("item_key", itemKey);
      if (incRes.error) skipped.push(`${styleName} ${label} / ${itemKey}: ${incRes.error.message}`);
    }
  }
  return { imported: created + updated, created, updated, skipped };
}

// ── Phone & text billing: the database half (usage billing Part 1 step 6, 2026-10-02) ──────
// The rules — what may be saved, what "charging is on" means, how a month adds up — live in
// _shared/phoneBillingAdmin.ts so they are unit-tested; these helpers only read and write.
// phone_billing_settings, usage_charges and twilio_usage_daily are server-only tables
// (migration 259 revokes them from anon/authenticated), so the service-role client here is
// their only reader outside the phone-api worker.
const PHONE_BILLING_ACTIONS = new Set(["phone_billing_get", "phone_billing_set", "phone_billing_arm", "phone_usage_report"]);

async function readPhoneBilling(sb: any): Promise<{ settings: PhoneBillingSettings; meters: any[] }> {
  const [st, mt] = await Promise.all([
    sb.from("phone_billing_settings").select(PHONE_SETTINGS_COLUMNS).eq("id", true).maybeSingle(),
    sb.from("usage_prices").select("kind, label, unit_label, active, pricing, price_cents, updated_at").in("kind", [...PHONE_METERS]),
  ]);
  if (st.error) throw phoneBillingDbError(st.error);
  if (mt.error) throw phoneBillingDbError(mt.error);
  // 259 seeds the one row; its absence means 259 is not (fully) applied, not "all defaults".
  if (!st.data) throw phoneBillingDbError({ code: "42P01" });
  // Always the contract's order, so the console lists out/in calls then out/in texts.
  const meters = PHONE_METERS.map((k) => (mt.data ?? []).find((m: any) => m.kind === k)).filter(Boolean);
  return { settings: normalizeSettings(st.data), meters };
}

/** Switch the four phone meters on or off together, and prove it reached every one of them. */
async function setPhoneMeters(sb: any, active: boolean, nowIso: string) {
  const { data, error } = await sb.from("usage_prices").update({ active, updated_at: nowIso })
    .in("kind", [...PHONE_METERS]).select("kind, active");
  if (error) throw phoneBillingDbError(error);
  const n = (data ?? []).filter((m: any) => m.active === active).length;
  // Switching OFF with a meter row missing is fine — a missing row charges nobody. Switching ON
  // with one missing would leave that kind of usage free while the console says "every builder".
  if (active && n !== PHONE_METERS.length) {
    throw new Error(`Only ${n} of the ${PHONE_METERS.length} phone meters exist in the price list, so charging could not be switched on for everything. Check migration 259.`);
  }
}

/**
 * Every usage_charges row for one month. KEYSET pages on id, continuing until an EMPTY page —
 * not "until a short page": PostgREST's max-rows can sit below the page size asked for, and a
 * short-page stop would then end after the first page and report a fraction of the month as
 * the whole of it. Capped so a runaway month cannot hold the isolate; the report says when it
 * stopped short.
 */
async function readUsageChargesForMonth(sb: any, from: string, to: string): Promise<{ rows: UsageChargeRow[]; truncated: boolean }> {
  const PAGE = 1000, MAX_ROWS = 100_000;
  const rows: UsageChargeRow[] = [];
  let lastId = 0;
  for (;;) {
    const { data, error } = await sb.from("usage_charges")
      .select("id, client_id, source, direction, state, occurred_at, cost_micros, cost_source, units, unit, charge_micros")
      .gte("occurred_at", from).lt("occurred_at", to)
      .gt("id", lastId).order("id", { ascending: true }).limit(PAGE);
    if (error) throw phoneBillingDbError(error);
    const batch = (data ?? []) as any[];
    if (batch.length === 0) return { rows, truncated: false };
    rows.push(...batch);
    lastId = Number(batch[batch.length - 1].id);
    if (rows.length >= MAX_ROWS) return { rows, truncated: true };
  }
}

/** Twilio's daily account totals for one month (a few hundred rows at most), same paging rule. */
async function readTwilioDaily(sb: any, firstDay: string, nextFirstDay: string): Promise<TwilioDailyRow[]> {
  const PAGE = 1000;
  const out: TwilioDailyRow[] = [];
  // The offset advances by what CAME BACK, not by PAGE, for the max-rows reason above: a
  // server cap of 500 with `offset += PAGE` would silently skip rows 500–999 of every page.
  let offset = 0;
  while (offset < 20_000) {
    const { data, error } = await sb.from("twilio_usage_daily")
      .select("day, category, count, usage, price_micros")
      .gte("day", firstDay).lt("day", nextFirstDay)
      .order("day", { ascending: true }).order("category", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw phoneBillingDbError(error);
    const batch = (data ?? []) as TwilioDailyRow[];
    if (batch.length === 0) break;
    out.push(...batch);
    offset += batch.length;
  }
  return out;
}

Deno.serve(withErrorLog("admin-catalog", async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // ── Warm-up ───────────────────────────────────────────────────────────────────────
  // The portal pings this when an operator's flags resolve and when the pointer reaches the
  // Admin link, so the console's first list_clients/get_master does not also pay a cold isolate
  // (~2.5 s). It answers ABOVE EVERYTHING THE GATE DOES, and that placement is the safety case:
  //   • before checkAdminAuth: no getUser round trip, no app_operators read, and above all no
  //     checkAdminPassword. The ping carries the anon key and no password, and below this line
  //     that is a FAILED ADMIN PASSWORD: an admin_auth_attempts failure on the caller's IP
  //     bucket (5 = a lock), an admin_auth_failed audit row, a count toward the global brake and
  //     a 400 ms sleep. A ping per boot would walk an operator's own IP up the lock tiers;
  //   • before createClient and the operator success audit further down;
  //   • before req.json(): it never reads the BODY (the single parse below owns that stream);
  //   • 200, so withErrorLog (minStatus 500) files nothing in app_errors;
  //   • a QUERY PARAM, not an action: READ_ONLY_ACTIONS, PASSWORD_REQUIRED and the switch are
  //     untouched. It can only skip work, never authorize any.
  // ⚠️ DEPLOY THIS BEFORE ANY PORTAL BUNDLE THAT WARMS admin-catalog (2026-10-02: shipped alone,
  // ahead of the portal change that pings it). _test_stubs/adminCatalogWarm_test.ts pins the order.
  if (new URL(req.url).searchParams.get("warm") === "1") return json({ ok: true });

  let p: any;
  try { p = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  // Service-role client is created BEFORE the gate because the gate needs it for the
  // attempt ledger + audit. Creating a client grants nothing on its own.
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const action = p.action;

  // Dual-credential gate: a valid operator JWT (the portal's embedded Admin tab, which
  // already carries the operator's session) OR the shared password (standalone admin.html).
  // Password callers keep the full throttle/lockout/audit behaviour of migration 053 —
  // see _shared/adminAuth.ts for why a signed-in NON-operator is refused outright rather
  // than being allowed to fall through and probe the password.
  const gate = await checkAdminAuth(req, p?.adminPassword, sb, String(action ?? ""));
  if (!gate.ok) return json(gate.body, gate.status);
  const identity = gate.identity;

  // Step-up: a few actions stay password-gated even for an operator, because their blast
  // radius is not the one tenant being administered.
  //   delete_client       — irreversibly wipes a tenant AND deletes their auth logins.
  //   connect/disconnect_email — rewrite the PROJECT-WIDE Auth SMTP config, so they affect
  //                         every tenant's password-reset mail, not just this one.
  const PASSWORD_REQUIRED = new Set(["delete_client", "connect_email", "disconnect_email"]);
  if (identity.via === "operator" && PASSWORD_REQUIRED.has(String(action ?? ""))) {
    const stepUp = await checkAdminPassword(req, p?.adminPassword, sb, String(action ?? ""));
    if (!stepUp.ok) return json(stepUp.body, stepUp.status);
  }

  // Per-operator rights (migration 056: can_write / can_bill, both default FALSE).
  //
  // Enumerated as READS rather than writes, deliberately: a new action added below and
  // forgotten here is then denied to read-only operators rather than silently granted to
  // them. Deny-by-default is the only safe direction for a list somebody will extend.
  //
  // Gated on `via === "operator"` ONLY. The password path has no operator row, so
  // `canWrite` is undefined there and an unconditional check would 403 the standalone
  // break-glass console out of every write while telling it the account is read-only.
  const READ_ONLY_ACTIONS = new Set([
    "list_clients", "get_master", "get_client_catalog", "get_email_sender",
    "get_billing_overview", "get_payments", "avalara_tax_codes_status",
  ]);
  if (identity.via === "operator" && !READ_ONLY_ACTIONS.has(String(action ?? ""))) {
    if (!identity.canWrite) {
      return json({ error: "This operator account is read-only." }, 403);
    }
    // Money is a separate grant from configuration — 056's own words: "Adding an operator
    // should never silently grant the ability to charge a client's card." set_billing sets
    // the discount and the exemption that every later charge is computed from.
    if ((String(action ?? "") === "set_billing" || String(action ?? "") === "set_feature_grants"
         || String(action ?? "") === "wallet_credit" || String(action ?? "") === "wallet_adjust"
         || String(action ?? "") === "wallet_set_limits")
        && !identity.canBill) {
      return json({ error: "This operator account cannot change billing." }, 403);
    }
    // set_payments charges nobody, so it is not "billing" in 056's sense — but it decides
    // WHOSE BANK ACCOUNT a shopper's card lands in, which is the same class of mistake and a
    // worse one to make quietly. Gated on the same money grant, deny-by-default, with its own
    // sentence because "cannot change billing" would send an operator to the wrong screen.
    // The ADMIN_PASSWORD break-glass path is untouched (it carries no operator row at all).
    if (String(action ?? "") === "set_payments" && !identity.canBill) {
      return json({ error: "This operator account cannot change payment routing." }, 403);
    }
    // Phone & text billing (usage billing Part 1 step 6): all four on the money grant, the two
    // READS included. phone_billing_get and phone_usage_report serve OUR COST of every call and
    // text — the margin on every builder, the same class of number as wallet_status's
    // cost_cents — and an operator without can_bill has no reason to see it. Being absent from
    // READ_ONLY_ACTIONS they need can_write as well. Own sentence, because "cannot change
    // billing" would be wrong for a read.
    if (PHONE_BILLING_ACTIONS.has(String(action ?? "")) && !identity.canBill) {
      return json({ error: "This operator account cannot see or change phone and text billing." }, 403);
    }
  }

  // Successful operator-authenticated calls are recorded. Until now only FAILURES were
  // audited, which meant an authorized admin action left no trace at all.
  if (identity.via === "operator") {
    try {
      await sb.from("admin_audit").insert({
        action: `admin_${String(action ?? "")}`,
        target_client_id: typeof p?.clientId === "string" ? p.clientId : null,
        actor_email: identity.email,
        actor_user_id: identity.userId,
        note: "via=operator_jwt",
      });
    } catch (_e) { /* best-effort: never block the console on a log failure */ }
  }

  try {
    switch (action) {
      // ── reads ───────────────────────────────────────────────────────────
      case "list_clients": {
        const { data, error } = await sb.from("client_configs").select("client_id, company_name").order("client_id");
        if (error) throw error;
        // Billing posture per tenant, so the console can show at a glance who is comped
        // and who is discounted. client_settings is service-role only — this function is
        // the only place it can be read from.
        // ⚠️ All three reads below THROW on error rather than defaulting to empty. The console
        // seeds editable state from this answer and writes it back whole: an unread
        // client_settings showed every tenant as billable at 0%, so one Save on the Billing
        // card (set_billing sends billingExempt every time) cleared a real exemption and locked
        // that tenant out; an unread grant list showed nobody holding a comp, so the 3D toggle
        // (set_feature_grants REPLACES the set) revoked every other grant the tenant had. A
        // console that fails to load is recoverable; a confidently wrong one that saves is not.
        const { data: cs, error: csErr } = await sb.from("client_settings")
          .select("client_id, billing_exempt, billing_exempt_until, discount_percent, discount_features");
        if (csErr) throw csErr;
        const byId = new Map((cs ?? []).map((r: any) => [r.client_id, r]));
        // The billable feature list, so the console can offer a per-feature discount
        // picker without hardcoding a copy of the catalogue that would drift from
        // billing_plans. One entry per feature (monthly/annual share a feature).
        const { data: planRows, error: planErr } = await sb.from("billing_plans")
          .select("feature, name, availability, required, operator_grantable").eq("active", true).order("sort_order", { ascending: false });
        if (planErr) throw planErr;
        const seenFeature = new Set<string>();
        const features = (planRows ?? []).filter((p: any) => {
          if (!p.feature || seenFeature.has(p.feature)) return false;
          seenFeature.add(p.feature);
          return true;
        }).map((p: any) => ({ feature: p.feature, name: p.name, availability: p.availability, required: p.required, operatorGrantable: Boolean(p.operator_grantable) }));
        // Operator grants per tenant (migration 109) — the console's "Early access" card.
        // client_feature_grants is service-role only, so this function is the only reader.
        const { data: grantRows, error: grantErr } = await sb.from("client_feature_grants")
          .select("client_id, feature, expires_at");
        if (grantErr) throw grantErr;
        const grantsById = new Map<string, any[]>();
        for (const g of (grantRows ?? []) as any[]) {
          const arr = grantsById.get(g.client_id) ?? [];
          arr.push({ feature: g.feature, expiresAt: g.expires_at ?? null });
          grantsById.set(g.client_id, arr);
        }
        const clients = (data ?? []).map((c: any) => {
          const s = byId.get(c.client_id);
          return {
            ...c,
            billingExempt: Boolean(s?.billing_exempt),
            discountPercent: Number(s?.discount_percent) || 0,
            discountFeatures: s?.discount_features ?? null,
            exemptUntil: s?.billing_exempt_until ?? null,
            grants: grantsById.get(c.client_id) ?? [],
          };
        });
        return json({ ok: true, clients, features });
      }
      case "get_billing_overview": {
        // Operator revenue dashboard (portal Admin → Billing tab). Returns RAW rows and the
        // UI computes MRR/health metrics client-side in memos — FramedUp's
        // get_admin_subscribers pattern, so the numbers on screen and the rows in the table
        // can never disagree. The billing_* tables are service-role only; this action is
        // their only cross-tenant reader.
        // ⛔ NEVER return billing_customers.vault_id — an NMI vault id is a bearer
        // capability for charging that card. This response carries no vault data at all.
        const [subsRes, plansRes, cfgRes, csRes, grantsRes] = await Promise.all([
          sb.from("billing_subscriptions")
            .select("id, client_id, plan_id, status, price_cents, list_price_cents, current_period_start, current_period_end, past_due_since, canceled_at, created_at")
            .order("created_at", { ascending: false }),
          // Inactive plans included on purpose: a subscription's meaning is historical, and
          // a retired plan must still render its name (FramedUp hit this exact blank).
          sb.from("billing_plans").select("id, name, feature, billing_interval, required"),
          sb.from("client_configs").select("client_id, company_name"),
          sb.from("client_settings").select("client_id, billing_exempt, billing_exempt_until, discount_percent"),
          sb.from("client_feature_grants").select("client_id, feature, expires_at"),
        ]);
        if (subsRes.error) throw subsRes.error;
        if (plansRes.error) throw plansRes.error;
        if (cfgRes.error) throw cfgRes.error;
        const planById = new Map((plansRes.data ?? []).map((r: any) => [r.id, r]));
        const nameById = new Map((cfgRes.data ?? []).map((r: any) => [r.client_id, r.company_name]));
        const subscriptions = (subsRes.data ?? []).map((s: any) => {
          const plan = planById.get(s.plan_id);
          const interval = plan?.billing_interval ?? "month";
          // current_period_end goes stale after the first gateway renewal (billing-webhook's
          // periodEnd is dead data — NMI sends next_charge_date '1970-01-01'), so the display
          // date is the calendar roll-forward, the same math portal-billing's entitlement uses.
          const paid = paidThroughOf(s, interval);
          return {
            ...s,
            company_name: nameById.get(s.client_id) ?? s.client_id,
            plan_name: plan?.name ?? s.plan_id,
            feature: plan?.feature ?? null,
            billing_interval: plan?.billing_interval ?? null,
            required: Boolean(plan?.required),
            paid_through: Number.isFinite(paid) ? new Date(paid).toISOString() : null,
          };
        });
        // Support alerts. closed_unknown = a checkout whose outcome could not be verified —
        // the customer may have been charged with nothing recorded, and that plan's checkout
        // is BLOCKED for them until reconciled, so operators must see these.
        const { data: unknownRows } = await sb.from("billing_charge_attempts")
          .select("client_id, plan_id, detail, sale_txn, created_at")
          .eq("state", "closed_unknown").order("created_at", { ascending: false });
        const since30 = new Date(Date.now() - 30 * 86400000).toISOString();
        const { count: declined30 } = await sb.from("billing_charge_attempts")
          .select("id", { count: "exact", head: true })
          .eq("state", "closed_declined").gte("created_at", since30);
        // Tenant billing posture: exempt/comped accounts have no subscription rows, which is
        // what keeps them out of MRR — surfaced separately so they're visible, not invisible.
        const csById = new Map((csRes.data ?? []).map((r: any) => [r.client_id, r]));
        const grantCount = new Map<string, number>();
        for (const g of (grantsRes.data ?? []) as any[]) {
          grantCount.set(g.client_id, (grantCount.get(g.client_id) ?? 0) + 1);
        }
        const tenants = (cfgRes.data ?? []).map((c: any) => {
          const s = csById.get(c.client_id);
          return {
            client_id: c.client_id,
            company_name: c.company_name,
            billing_exempt: Boolean(s?.billing_exempt),
            exempt_until: s?.billing_exempt_until ?? null,
            discount_percent: Number(s?.discount_percent) || 0,
            grant_count: grantCount.get(c.client_id) ?? 0,
          };
        });
        return json({
          ok: true,
          subscriptions,
          tenants,
          alerts: { unknown: unknownRows ?? [], declined30: declined30 ?? 0 },
        });
      }
      case "get_master": {
        // Master LAYOUT-ITEM palette only. The global building-style catalog was retired
        // (migration 030) — tenants get styles via the Clone feature or per-client
        // create_style, not by assigning from a global master template.
        const items = await sb.from("layout_item_types").select("*").order("sort_order").order("item_key");
        if (items.error) throw items.error;
        return json({ ok: true, layoutItemTypes: items.data });
      }
      // The Admin console's "Avalara tax codes" row (Master Catalog tab): how many codes the
      // platform catalog holds, how many are active, and when a sync last wrote it — so an
      // operator can see whether a sync is needed before pressing one. A read of the stored copy
      // only; it never calls Avalara, which is why it can sit on READ_ONLY_ACTIONS while
      // avalara_sync_tax_codes cannot. Same count and syncedAt readings as portal-settings'
      // tax_codes_get `catalog`, so the operator and a builder's Tax tab report the same list.
      case "avalara_tax_codes_status": {
        const [all, active, last] = await Promise.all([
          sb.from("avalara_tax_codes").select("code", { count: "exact", head: true }),
          sb.from("avalara_tax_codes").select("code", { count: "exact", head: true }).eq("is_active", true),
          sb.from("avalara_tax_codes").select("synced_at").not("synced_at", "is", null)
            .order("synced_at", { ascending: false }).limit(1).maybeSingle(),
        ]);
        if (all.error) throw all.error;
        if (active.error) throw active.error;
        if (last.error) throw last.error;
        return json({ ok: true, count: all.count ?? 0, activeCount: active.count ?? 0, syncedAt: last.data?.synced_at ?? null });
      }
      case "get_client_catalog": {
        const clientId = reqStr(p.clientId, "clientId");
        const [styles, sizes, items, incl] = await Promise.all([
          sb.from("building_styles").select("id, client_id, key, label, image_url, sort_order, active").eq("client_id", clientId).order("sort_order"),
          sb.from("building_sizes").select("id, style_id, label, width_ft, length_ft, base_price, sort_order, active").eq("client_id", clientId).order("sort_order"),
          sb.from("client_layout_items").select("*").eq("client_id", clientId).order("sort_order"),
          sb.from("building_size_inclusions").select("size_id, item_key, included, qty").eq("client_id", clientId),
        ]);
        if (styles.error) throw styles.error; if (sizes.error) throw sizes.error; if (items.error) throw items.error; if (incl.error) throw incl.error;
        return json({ ok: true, buildingStyles: styles.data, buildingSizes: sizes.data, clientLayoutItems: items.data, inclusions: incl.data });
      }
      // ── layout-item assignment ──────────────────────────────────────────
      case "toggle_item":
      case "save_item_assignment": {
        const clientId = reqStr(p.clientId, "clientId");
        const itemKey  = reqStr(p.itemKey, "itemKey");
        const row: any = { client_id: clientId, item_key: itemKey,
          active: p.active !== false, sort_order: Number.isFinite(p.sortOrder) ? p.sortOrder : 0,
          updated_at: new Date().toISOString() };
        if (action === "save_item_assignment") {
          row.label_override       = p.labelOverride ?? null;
          row.width_override       = p.widthOverride ?? null;
          row.height_override      = p.heightOverride ?? null;
          row.short_label_override = p.shortLabelOverride ?? null;
        }
        const { error } = await sb.from("client_layout_items").upsert(row, { onConflict: "client_id,item_key" });
        if (error) throw error;
        return json({ ok: true });
      }

      // ── building-style management (per-client; the global master was retired in 030) ──
      case "unassign_style": {
        const clientId = reqStr(p.clientId, "clientId");
        const styleKey = reqStr(p.styleKey, "styleKey");
        const { error } = await sb.from("building_styles").update({ active: false }).eq("client_id", clientId).eq("key", styleKey);
        if (error) throw error;
        return json({ ok: true });
      }
      case "save_style": {
        const clientId = reqStr(p.clientId, "clientId");
        const styleKey = reqStr(p.styleKey, "styleKey");
        const patch: any = {};
        if ("label" in p)     patch.label = p.label;
        if ("imageUrl" in p)  patch.image_url = p.imageUrl;
        if ("sortOrder" in p) patch.sort_order = p.sortOrder;
        if ("active" in p)    patch.active = !!p.active;
        const { error } = await sb.from("building_styles").update(patch).eq("client_id", clientId).eq("key", styleKey);
        if (error) throw error;
        return json({ ok: true });
      }
      case "save_sizes": {
        // body.sizes: [{ label, widthFt, lengthFt, basePrice, sortOrder, active }]
        const clientId = reqStr(p.clientId, "clientId");
        const styleId  = reqStr(p.styleId, "styleId");
        if (!Array.isArray(p.sizes)) throw new Error("sizes[] required");
        for (const s of p.sizes) {
          await sb.from("building_sizes").upsert({
            client_id: clientId, style_id: styleId, label: reqStr(s.label, "size.label"),
            width_ft: s.widthFt, length_ft: s.lengthFt,
            base_price: (s.basePrice === "" || s.basePrice == null) ? null : Number(s.basePrice),
            sort_order: s.sortOrder ?? 0, active: s.active !== false,
          }, { onConflict: "style_id,label" });
        }
        return json({ ok: true });
      }

      // ── per-client style creation (no master dependency) ───────────────
      // Building styles are never shared across companies (every client has
      // their own "garage"/"studio" with their own image + prices), so this
      // creates a style straight on the client, deriving a unique per-client key.
      case "create_style": {
        const clientId = await assertClient(sb, reqStr(p.clientId, "clientId"));
        const label    = reqStr(p.label, "label");
        const base = (label.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40).replace(/^-+|-+$/g, "")) || "style";
        // INSERT (not upsert) so a concurrent same-key create surfaces as a 23505 we
        // retry — never a silent overwrite of an existing style. (The global master
        // key-reservation was removed with the building_style_catalog table in 030.)
        let key = base, n = 1;
        for (let attempt = 0; attempt < 50; attempt++) {
          const ins = await sb.from("building_styles").insert(
            { client_id: clientId, key, label, image_url: p.imageUrl ?? null,
              sort_order: Number.isFinite(p.sortOrder) ? p.sortOrder : 0, active: true })
            .select("id, key").maybeSingle();
          if (!ins.error) return json({ ok: true, styleId: ins.data!.id, key: ins.data!.key });
          if (ins.error.code !== "23505") throw ins.error;
          key = `${base}-${++n}`;
        }
        throw new Error("could not allocate a unique style key");
      }
      // Upload a building-style image (base64) to the public 'branding' bucket
      // and return its public URL; the caller stores it via create_style/save_style.
      case "upload_image": {
        const clientId = await assertClient(sb, reqStr(p.clientId, "clientId"));
        if (typeof p.imageBase64 !== "string" || !p.imageBase64.trim()) throw new Error("No image data.");
        // Raster allowlist only — reject SVG (script-bearing stored-XSS vector on
        // the public branding bucket) and any other caller-asserted type.
        const ct = String(p.contentType || "image/jpeg");
        const EXT_BY_CT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
        const ext = EXT_BY_CT[ct];
        if (!ext) throw new Error("Unsupported image type (use JPG, PNG, WEBP or GIF).");
        const rawB64 = p.imageBase64.replace(/^data:[^;]+;base64,/, "");
        if (rawB64.length > 4_200_000) throw new Error("Image too large (max 3MB)."); // guard before the full atob decode
        let bytes: Uint8Array;
        try { bytes = Uint8Array.from(atob(rawB64), (c) => c.charCodeAt(0)); } catch { throw new Error("Invalid image data."); }
        if (bytes.length > 3_000_000) throw new Error("Image too large (max 3MB).");
        // crypto.randomUUID(), not Date.now(): clientId is public and a ms timestamp is
        // guessable, which made every uploaded image enumerable (audit 2026-08-19).
        const path = `${clientId}/style-${crypto.randomUUID()}.${ext}`;
        const upl = await sb.storage.from("branding").upload(path, bytes, { contentType: ct, upsert: true });
        if (upl.error) throw new Error(`Image upload failed: ${upl.error.message}`);
        const { data: pub } = sb.storage.from("branding").getPublicUrl(path);
        return json({ ok: true, url: pub.publicUrl });
      }

      // ── master catalog CRUD ─────────────────────────────────────────────
      case "save_master_item": {
        const row = {
          item_key: reqStr(p.itemKey, "itemKey"),
          label: reqStr(p.label, "label"),
          icon: p.icon ?? "", color: p.color ?? "#000000",
          default_width: Number(p.defaultWidth ?? 3), default_height: Number(p.defaultHeight ?? 3),
          wall_only: !!p.wallOnly, wall_snap: !!p.wallSnap, door_snap: !!p.doorSnap,
          short_label: p.shortLabel ?? "", sort_order: p.sortOrder ?? 0, active: p.active !== false,
          updated_at: new Date().toISOString(),
        };
        const { error } = await sb.from("layout_item_types").upsert(row, { onConflict: "item_key" });
        if (error) throw error;
        return json({ ok: true });
      }

      // ── CSV pricing + inclusion import ──────────────────────────────────
      // body.rows: [{ style, width, length, price, active, inclusions: {item_key: yes/no} }]
      // Creates-or-updates building_sizes by (style, width, length) — see importPricingRows.
      case "import_pricing_csv": {
        const clientId = reqStr(p.clientId, "clientId");
        if (!Array.isArray(p.rows)) throw new Error("rows[] required");
        const r = await importPricingRows(sb, clientId, p.rows);
        return json({ ok: true, ...r });
      }

      // ── create a new tenant (config row only) ──────────────────────────
      // Makes a COMPLETE client_configs row by cloning a template's
      // contact_fields/default_sizes/options + the supplied branding, so
      // get_config returns a valid (empty-catalog) config the moment it exists.
      // The owner LOGIN is created separately in Supabase Auth (account creation
      // is out of scope here); building styles/items/pricing are added via the tabs.
      case "create_client": {
        const clientId = reqStr(p.clientId, "clientId").toLowerCase();
        if (!/^[a-z0-9][a-z0-9-]*$/.test(clientId)) throw new Error("Builder id must be lowercase letters, numbers and hyphens (DNS-safe).");
        // "first" (2026-10-05): portal-billing's first-charge order ids are ss_first_<clientId>_<plan>,
        // so a tenant slugged "first" mints ss_first_<plan>_… and billing-webhook's ssClientIdOf
        // reads the plan's first word as the tenant. Its events would be homed on, or acked as the
        // deleted tenant, "simple" / "crm" / "full". No tenant had it on 2026-10-05.
        const reserved = ["www", "beta", "dev", "staging", "app", "api", "admin", "portal", "first"];
        if (reserved.includes(clientId)) throw new Error(`"${clientId}" is a reserved id.`);
        const companyName = reqStr(p.companyName, "companyName");
        const exists = await sb.from("client_configs").select("client_id").eq("client_id", clientId).maybeSingle();
        if (exists.error) throw exists.error;
        if (exists.data) throw new Error(`A builder "${clientId}" already exists.`);
        // templateClientId === "__none__" => start blank (no clone): a standard contact
        // form so the designer works, and empty sizes/options the operator fills in via
        // the tabs + pricing CSV. Otherwise clone the named template (or junior-barns).
        const blank = String(p.templateClientId || "").trim().toLowerCase() === "__none__";
        let contactFields: unknown, defaultSizes: unknown, options: unknown;
        let templateId: string | null = null;
        if (blank) {
          contactFields = ["name", "email", "phone", "street", "city", "state", "zip"];
          defaultSizes = [];
          options = [];
        } else {
          const tmplId = (typeof p.templateClientId === "string" && p.templateClientId.trim()) ? p.templateClientId.trim() : "junior-barns";
          const tmpl = await sb.from("client_configs").select("contact_fields, default_sizes, options").eq("client_id", tmplId).maybeSingle();
          if (tmpl.error) throw tmpl.error;
          if (!tmpl.data) throw new Error(`Template builder "${tmplId}" not found.`);
          contactFields = tmpl.data.contact_fields; defaultSizes = tmpl.data.default_sizes; options = tmpl.data.options;
          templateId = tmplId;
        }
        // Discount inputs are validated BEFORE the config insert: a throw after the row
        // lands would leave a half-created tenant that the exists-check above then blocks
        // from ever retrying — validation must come before the first write.
        const newDiscount = Math.round(Number(p.discountPercent) || 0);
        if (!Number.isFinite(newDiscount) || newDiscount < 0 || newDiscount > 100) {
          throw new Error("discountPercent must be a whole number from 0 to 100.");
        }
        // Empty/absent = the discount applies to EVERY feature. A list narrows it.
        const newDiscountFeatures = Array.isArray(p.discountFeatures) && p.discountFeatures.length
          ? p.discountFeatures.map((f: unknown) => String(f))
          : null;

        const opt = (v: unknown) => (typeof v === "string" && v.trim()) ? v.trim() : null;
        const ins = await sb.from("client_configs").insert({
          client_id: clientId, company_name: companyName,
          tagline: opt(p.tagline), accent_color: opt(p.accentColor), header_bg: opt(p.headerBg), logo_url: opt(p.logoUrl),
          contact_fields: contactFields, default_sizes: defaultSizes, options,
          updated_at: new Date().toISOString(),
        });
        if (ins.error) throw ins.error;

        // Non-billable (CSM Synergy internal / demo / testing) accounts skip the billing
        // gate entirely. This is the ONLY place the flag is set at creation, and it needs
        // a client_settings row to live in — which create_client otherwise leaves for the
        // owner to fill in via the portal. A normal new client gets no row here, so
        // billing_exempt reads false and the gate applies: they land on Billing and pay
        // before anything unlocks.
        if (p.billingExempt === true || newDiscount > 0) {
          const bx = await sb.from("client_settings").upsert({
            client_id: clientId,
            billing_exempt: p.billingExempt === true,
            discount_percent: newDiscount,
            discount_features: newDiscountFeatures,
            updated_at: new Date().toISOString(),
          }, { onConflict: "client_id" });
          if (bx.error) throw bx.error;
        }

        // Clone the template's FULL catalog so the new client is usable immediately — the
        // config row alone has no styles/sizes/prices/items/colors (the old bug: a cloned
        // client "didn't bring it all over"). New rows get fresh ids; foreign keys are
        // remapped old→new. client_settings is intentionally NOT copied (GHL credentials +
        // business identity are per-client). Inserts only — nothing is dropped or removed.
        let clonedCounts: Record<string, number> | null = null;
        if (templateId) {
          const T = templateId, Cc = clientId;
          const counts: Record<string, number> = {};

          // 1. building_styles → old id → new id (matched by stable per-client key)
          // taxable (158) and show_image_on_estimate (037) ride along: both default TRUE, so leaving
          // them out silently reversed a template's "not taxable" / "no photo on the estimate"
          // on every cloned style — tax charged on a building line the template exempted.
          const stSrc = await sb.from("building_styles").select("key, label, image_url, sort_order, active, taxable, show_image_on_estimate").eq("client_id", T);
          if (stSrc.error) throw new Error(`clone styles read: ${stSrc.error.message}`);
          if ((stSrc.data ?? []).length) {
            const r = await sb.from("building_styles").insert((stSrc.data ?? []).map((s: any) => ({
              client_id: Cc, key: s.key, label: s.label, image_url: s.image_url, sort_order: s.sort_order, active: s.active,
              taxable: s.taxable !== false, show_image_on_estimate: s.show_image_on_estimate !== false,
            })));
            if (r.error) throw new Error(`clone styles: ${r.error.message}`);
          }
          const [oldStyles, newStyles] = await Promise.all([
            sb.from("building_styles").select("id, key").eq("client_id", T),
            sb.from("building_styles").select("id, key").eq("client_id", Cc),
          ]);
          if (oldStyles.error) throw oldStyles.error; if (newStyles.error) throw newStyles.error;
          const newStyleIdByKey = new Map<string, string>();
          for (const s of newStyles.data ?? []) newStyleIdByKey.set(String(s.key), s.id);
          const styleIdMap = new Map<string, string>();   // old style id → new style id
          for (const s of oldStyles.data ?? []) { const nid = newStyleIdByKey.get(String(s.key)); if (nid) styleIdMap.set(s.id, nid); }
          counts.building_styles = styleIdMap.size;

          // 2. building_sizes → remap style_id; old size id → new size id (by new style_id|label)
          const szSrc = await sb.from("building_sizes").select("id, style_id, label, width_ft, length_ft, base_price, sort_order, active").eq("client_id", T);
          if (szSrc.error) throw new Error(`clone sizes read: ${szSrc.error.message}`);
          const szRows = (szSrc.data ?? []).filter((z: any) => styleIdMap.has(z.style_id)).map((z: any) => ({
            client_id: Cc, style_id: styleIdMap.get(z.style_id), label: z.label, width_ft: z.width_ft,
            length_ft: z.length_ft, base_price: z.base_price, sort_order: z.sort_order, active: z.active,
          }));
          if (szRows.length) { const r = await sb.from("building_sizes").insert(szRows); if (r.error) throw new Error(`clone sizes: ${r.error.message}`); }
          const newSizes = await sb.from("building_sizes").select("id, style_id, label").eq("client_id", Cc);
          if (newSizes.error) throw newSizes.error;
          const newSizeIdByKey = new Map<string, string>();
          for (const z of newSizes.data ?? []) newSizeIdByKey.set(`${z.style_id}|${z.label}`, z.id);
          const sizeIdMap = new Map<string, string>();   // old size id → new size id
          for (const z of szSrc.data ?? []) { const ns = styleIdMap.get(z.style_id); if (!ns) continue; const nid = newSizeIdByKey.get(`${ns}|${z.label}`); if (nid) sizeIdMap.set(z.id, nid); }
          counts.building_sizes = sizeIdMap.size;

          // 3. fixture_items (the doors/windows/ramps catalog) → old id → new id.
          // Must run BEFORE inclusions: a size can include a FIXTURE, and it references it
          // by the fixture's uuid in item_key (migration 074 dropped that FK so the column
          // can hold either a builtin key or a fixture id). Cloning without this step left
          // the new client with no catalog doors at all AND inclusion rows pointing at the
          // template's fixture ids — invisible rows referencing another tenant's data.
          // Ids are generated up front rather than read back, because fixtures have no
          // stable per-client natural key to re-match on the way the styles clone does.
          // Archived fixtures are skipped: they exist only so a template's OLD designs still
          // render, and a brand-new client has no old designs.
          const fxSrc = await sb.from("fixture_items").select("*").eq("client_id", T).eq("archived", false);
          if (fxSrc.error) throw new Error(`clone fixtures read: ${fxSrc.error.message}`);
          const fixtureIdMap = new Map<string, string>();  // old fixture id → new fixture id
          let fxStylesDropped = 0;
          if ((fxSrc.data ?? []).length) {
            const fxRows = (fxSrc.data ?? []).map((f0: any) => {
              const { id, client_id, created_at, updated_at, ...rest } = f0;
              const newId = crypto.randomUUID();
              fixtureIdMap.set(String(id), newId);
              // "Offered on" (272): style_ids names the TEMPLATE's styles, so it is remapped through
              // styleIdMap like the sizes (cloneStyleIds says why). Only a list is touched: NULL
              // (every style) stays NULL, and a read from before 272 has no such key, so nothing is
              // sent for a column that is not there yet.
              if (Array.isArray(rest.style_ids)) {
                const s = cloneStyleIds(rest.style_ids, styleIdMap);
                rest.style_ids = s.value;
                if (s.dropped) fxStylesDropped++;
              }
              return { id: newId, client_id: Cc, ...rest };
            });
            const r = await sb.from("fixture_items").insert(fxRows);
            if (r.error) throw new Error(`clone fixtures: ${r.error.message}`);
          }
          counts.fixture_items = fixtureIdMap.size;
          // Lists none of whose styles came across, sent as every style instead (cloneStyleIds).
          if (fxStylesDropped) counts.fixture_style_ids_dropped = fxStylesDropped;

          // 4. building_size_inclusions → remap size_id (qty travels with the row —
          // previously dropped here, resetting every clone's quantities to the default 1)
          // and remap item_key when it names a fixture. A uuid-shaped key with no entry in
          // the map belongs to a fixture we did NOT clone (archived, or deleted since the
          // inclusion was written) — copying it would recreate the dangling reference, so
          // the row is dropped and counted instead of silently carried over.
          const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
          const incSrc = await sb.from("building_size_inclusions").select("size_id, item_key, included, qty").eq("client_id", T);
          if (incSrc.error) throw new Error(`clone inclusions read: ${incSrc.error.message}`);
          let incDropped = 0;
          const incRows = (incSrc.data ?? [])
            .filter((x: any) => sizeIdMap.has(x.size_id))
            .map((x: any) => {
              const key = String(x.item_key ?? "");
              let newKey: string | null = key;
              if (fixtureIdMap.has(key)) newKey = fixtureIdMap.get(key) as string;
              else if (isUuid(key)) newKey = null;
              if (newKey === null) { incDropped++; return null; }
              return { client_id: Cc, size_id: sizeIdMap.get(x.size_id), item_key: newKey, included: x.included, qty: x.qty ?? 1 };
            })
            .filter(Boolean) as any[];
          if (incRows.length) { const r = await sb.from("building_size_inclusions").insert(incRows); if (r.error) throw new Error(`clone inclusions: ${r.error.message}`); }
          counts.building_size_inclusions = incRows.length;
          if (incDropped) counts.building_size_inclusions_dropped = incDropped;

          // 5. client_layout_items (no style FK). The per-row flags are copied too — each column
          // defaults to the permissive value, so dropping it changed what the clone SELLS:
          // archived (075) brought a retired option back onto the palette, internal_only (082)
          // put a rep-only option in front of the new builder's public shoppers, taxable (158)
          // taxed an option the template exempted, and the shelf dimensions (171) fell back to
          // the master defaults.
          const liSrc = await sb.from("client_layout_items").select("item_key, active, sort_order, label_override, width_override, height_override, short_label_override, archived, internal_only, taxable, depth_in, height_off_floor_in").eq("client_id", T);
          if (liSrc.error) throw new Error(`clone items read: ${liSrc.error.message}`);
          if ((liSrc.data ?? []).length) {
            const r = await sb.from("client_layout_items").insert((liSrc.data ?? []).map((i: any) => ({ client_id: Cc, ...i })));
            if (r.error) throw new Error(`clone items: ${r.error.message}`);
          }
          counts.client_layout_items = (liSrc.data ?? []).length;

          // 6. layout_item_pricing → remap style_id (NULL default stays NULL)
          const lpSrc = await sb.from("layout_item_pricing").select("item_key, style_id, pricing_method, rate, image_url").eq("client_id", T);
          if (lpSrc.error) throw new Error(`clone pricing read: ${lpSrc.error.message}`);
          const lpRows = (lpSrc.data ?? []).filter((q: any) => !q.style_id || styleIdMap.has(q.style_id)).map((q: any) => ({
            client_id: Cc, item_key: q.item_key, style_id: q.style_id ? styleIdMap.get(q.style_id) : null,
            pricing_method: q.pricing_method, rate: q.rate, image_url: q.image_url,
          }));
          if (lpRows.length) { const r = await sb.from("layout_item_pricing").insert(lpRows); if (r.error) throw new Error(`clone pricing: ${r.error.message}`); }
          counts.layout_item_pricing = lpRows.length;

          // 7. colors (no FK) — copy every column except identity/timestamps
          const colSrc = await sb.from("colors").select("*").eq("client_id", T);
          if (colSrc.error) throw new Error(`clone colors read: ${colSrc.error.message}`);
          if ((colSrc.data ?? []).length) {
            const colRows = (colSrc.data ?? []).map((c0: any) => { const { id, client_id, created_at, updated_at, ...rest } = c0; return { client_id: Cc, ...rest }; });
            const r = await sb.from("colors").insert(colRows); if (r.error) throw new Error(`clone colors: ${r.error.message}`);
          }
          counts.colors = (colSrc.data ?? []).length;

          clonedCounts = counts;
        }

        // ── Assign the setup checklist (migration 157) ─────────────────────
        // Carolyn 2026-08-28: a new builder should arrive with the setup steps already
        // waiting, in the order they should do them. The active template rows are COPIED
        // (not referenced) so editing the template later never rewrites a list somebody
        // is already working through.
        //
        // Best-effort on purpose: the tenant is fully created by this point and the
        // response is about to say so. Failing the whole creation over a checklist —
        // when the duplicate-slug check then blocks the retry (see the note at the top of
        // this action) — would turn a cosmetic problem into a half-made tenant.
        //
        // ⚠️ The gate flags (migration 185: requires_feature, builder_visible) are NOT
        // copied and NOT filtered on — they live on the template and portal-setup reads
        // them through template_item_id at request time. So a new builder gets every
        // step, including ones we have not finished building, and they stay invisible to
        // them until the flag flips — at which point they appear for everyone at once.
        // Do not add a `builder_visible` filter here; it would exclude every builder who
        // signed up while a feature was still being built.
        let setupAssigned = 0;
        try {
          const tpl = await sb.from("setup_template_items")
            .select("id, title, detail, link_page, section, image_url").eq("active", true).order("position");
          if (tpl.error) throw new Error(tpl.error.message);
          const rows = (tpl.data ?? []).map((t: any, i: number) => ({
            client_id: clientId, template_item_id: t.id, title: t.title,
            detail: t.detail, link_page: t.link_page, section: t.section,
            image_url: t.image_url, position: (i + 1) * 1024,
          }));
          if (rows.length) {
            const ins = await sb.from("tenant_setup_items").insert(rows);
            if (ins.error) throw new Error(ins.error.message);
            setupAssigned = rows.length;
          }
        } catch (e) {
          console.error("setup checklist assign failed for", clientId, e instanceof Error ? e.message : String(e));
        }

        return json({ ok: true, clientId, blank, cloned: clonedCounts, setupAssigned });
      }

      // ── link a user login to a client (with a role) ────────────────────
      // Finds-or-CREATES the Supabase auth user for the email, then maps it to the
      // client in client_users. No manual "Authentication → Add user" step: if the
      // login doesn't exist we create it and try to email an invite (best-effort,
      // needs SMTP), and either way we return a one-time set-password link the
      // operator can copy & send. role: "owner"/"admin" (full access incl. Pricing +
      // Settings) or "user" (Designs & Leads only).
      // ── WALLET, OPERATOR SIDE ───────────────────────────────────────────────────────
      // Every one of these is an APPEND. Deliberately NOT modelled on set_feature_grants'
      // replace-the-whole-set shape: the 2026-08-19 audit found real bugs in that pattern
      // (stale rows surviving, granted_by wiped), and an append is structurally immune to
      // the entire class. It also means the ledger cannot be rewritten by a later call --
      // an append-only ledger whose balance can be silently overwritten is not a ledger.
      case "wallet_credit": {
        // Comp credits: the demo lever, and the goodwill lever ("that one failed on us,
        // here's $20 back"). MEMO IS REQUIRED -- a comp is a commercial act and should say
        // why, the same argument 109_feature_grants makes for granted_by.
        const clientId = reqStr(p.clientId, "clientId");
        const amountCents = Math.round(Number(p.amountCents));
        if (!Number.isFinite(amountCents) || amountCents <= 0) throw new Error("A positive amount is required.");
        if (amountCents > 500000) throw new Error("That credit is over the $5,000 single-entry limit.");
        const memo = reqStr(p.memo, "memo").slice(0, 300);
        const { data: exists } = await sb.from("client_configs")
          .select("client_id").eq("client_id", clientId).maybeSingle();
        if (!exists) throw new Error(`Unknown builder: ${clientId}`);
        const { data: bal, error } = await sb.rpc("wallet_credit", {
          p_client_id: clientId, p_amount_cents: amountCents, p_kind: "grant",
          p_ref_type: "operator", p_ref_id: null, p_memo: memo,
          p_idem: String(p.idempotencyKey ?? "").slice(0, 120) || null, p_actor: null,
        });
        if (error) throw new Error(error.message);
        return json({ ok: true, balanceCents: bal });
      }

      case "wallet_adjust": {
        // Signed correction, INCLUDING zeroing out. Never a delete, never an UPDATE of the
        // balance: zeroing is an `adjustment` row for -balance_cents with a memo, so the
        // history still explains how the number got where it is.
        const clientId = reqStr(p.clientId, "clientId");
        const amountCents = Math.round(Number(p.amountCents));
        if (!Number.isFinite(amountCents) || amountCents === 0) throw new Error("A non-zero amount is required.");
        if (Math.abs(amountCents) > 500000) throw new Error("That adjustment is over the $5,000 single-entry limit.");
        const memo = reqStr(p.memo, "memo").slice(0, 300);
        const { data: bal, error } = await sb.rpc("wallet_credit", {
          p_client_id: clientId, p_amount_cents: amountCents, p_kind: "adjustment",
          p_ref_type: "operator", p_ref_id: null, p_memo: memo,
          p_idem: String(p.idempotencyKey ?? "").slice(0, 120) || null, p_actor: null,
        });
        if (error) throw new Error(error.message);
        return json({ ok: true, balanceCents: bal });
      }

      case "wallet_set_limits": {
        // metered_exempt is the EXEMPTION -- not a new flag. An exempt tenant still gets a
        // ledger row, at $0, so "how many generations did this tenant run and what did they
        // cost us" stays answerable for internal accounts, which are exactly the ones most
        // likely to run a lot of them.
        const clientId = reqStr(p.clientId, "clientId");
        const patch: Record<string, unknown> = { client_id: clientId, updated_at: new Date().toISOString() };
        if (p.meteredExempt !== undefined) patch.metered_exempt = Boolean(p.meteredExempt);
        if (p.monthlyAiCostCapCents !== undefined) {
          const c = p.monthlyAiCostCapCents === null ? null : Math.round(Number(p.monthlyAiCostCapCents));
          if (c !== null && (!Number.isFinite(c) || c < 0)) throw new Error("The cost cap must be a positive number of cents, or blank.");
          patch.monthly_ai_cost_cap_cents = c;
        }
        const { error } = await sb.from("wallet_accounts").upsert(patch, { onConflict: "client_id" });
        if (error) throw new Error(error.message);
        return json({ ok: true });
      }

      case "wallet_status": {
        // Operator read, and the ONLY place cost_cents is ever served. This is our gross
        // margin on a $20 charge; a tenant must never see it (portal-billing's wallet
        // projection deliberately omits the column entirely).
        const clientId = reqStr(p.clientId, "clientId");
        const [acct, txs, recon] = await Promise.all([
          sb.from("wallet_accounts").select("*").eq("client_id", clientId).maybeSingle(),
          sb.from("wallet_transactions").select("id, kind, amount_cents, balance_after_cents, meter_kind, state, cost_cents, memo, created_at")
            .eq("client_id", clientId).order("created_at", { ascending: false }).limit(25),
          sb.from("wallet_reconcile").select("*").eq("client_id", clientId).maybeSingle(),
        ]);
        return json({ ok: true, account: acct.data ?? null, transactions: txs.data ?? [], reconcile: recon.data ?? null });
      }

      // ── PHONE & TEXT BILLING, OPERATOR SIDE (usage billing Part 1 step 6, 2026-10-02) ─────
      // The "Phone & text billing" card under Admin → Billing. Every call minute and text a
      // builder uses is charged to their wallet at Twilio's real cost × ONE markup set here
      // (Ahsan 2026-10-02). Until it is armed, the phone-api worker still records each item's
      // real cost and what it WOULD have charged (usage_charges state 'shadow'), and
      // phone_usage_report adds that up, so Carolyn sets the markup against what GoHighLevel
      // charges with real numbers instead of guesses. All four are on can_bill (see the gate).
      case "phone_billing_get": {
        const { settings, meters } = await readPhoneBilling(sb);
        let pilots: { clientId: string; companyName: string }[] = [];
        if (settings.pilot_client_ids.length) {
          const { data: cfg } = await sb.from("client_configs").select("client_id, company_name").in("client_id", settings.pilot_client_ids);
          const byId = new Map((cfg ?? []).map((c: any) => [String(c.client_id), String(c.company_name || c.client_id)]));
          pilots = settings.pilot_client_ids.map((id) => ({ clientId: id, companyName: byId.get(id) ?? id }));
        }
        return json({
          ok: true,
          settings,
          meters: meters.map((m: any) => ({
            kind: m.kind, label: m.label, plainLabel: PHONE_METER_LABELS[m.kind as keyof typeof PHONE_METER_LABELS] ?? m.label,
            active: m.active === true, pricing: m.pricing ?? null, updatedAt: m.updated_at ?? null,
          })),
          charging: chargingMode(settings, meters),
          pilots,
          // The env rail as the EDGE functions see it (it gates texts sent from the portal). The
          // phone-api worker reads its own copy from wrangler; both are off until go-live, and
          // with the rail off nothing is charged and nobody is blocked whatever this card says.
          serverSwitchOn: Deno.env.get("PHONE_USAGE_METERS") === "on",
        });
      }

      case "phone_billing_set": {
        // Validated before any read: a refused body costs nothing and writes nothing.
        const patch = parseSettingsPatch(p, new Set(["action", "adminPassword"]));
        const { settings: before, meters } = await readPhoneBilling(sb);
        const wasMode = chargingMode(before, meters).mode;
        // No markup = nothing can be priced, and 259's gate reads it as "not armed". Clearing it
        // while charging is on would stop charging through the Save prices button — no confirm,
        // no arm audit row, and the card would still show the pilot list as live. Stopping has
        // its own button; this refuses the side door.
        if ("markup" in patch && patch.markup === null && wasMode !== "off") {
          throw new Error("Charging is on. Press Stop charging before clearing the markup.");
        }
        const { data: row, error } = await sb.from("phone_billing_settings")
          .update({ ...patch, updated_at: new Date().toISOString(), updated_by: identity.via === "operator" ? identity.userId : null })
          .eq("id", true).select(PHONE_SETTINGS_COLUMNS).maybeSingle();
        if (error) throw phoneBillingDbError(error);
        if (!row) throw phoneBillingDbError({ code: "42P01" });
        // The column list is a joined constant, so supabase-js cannot type the row; it is the
        // PHONE_SETTINGS_COLUMNS shape, and normalizeSettings reads it defensively either way.
        const after = normalizeSettings(row as unknown as Record<string, unknown>);
        const changes = describeSettingsChange(before, after);
        // A DEDICATED audit row, the set_payments way: the generic operator row at the top of
        // this function records only that the action ran, and the password path writes no success
        // row at all. When a builder asks why a minute cost what it did, the question is which
        // markup or cap was in force from when, and who set it.
        try {
          await sb.from("admin_audit").insert({
            action: "phone_billing_set",
            target_client_id: null,
            actor_email: identity.via === "operator" ? identity.email : null,
            actor_user_id: identity.via === "operator" ? identity.userId : null,
            note: `via=${identity.via} charging=${wasMode} ${changes.join("; ") || "no change"}`.slice(0, 2000),
          });
        } catch (_e) { /* best-effort: never fail a completed write on a logging failure */ }
        return json({
          ok: true,
          settings: after,
          changed: changes,
          charging: chargingMode(after, meters),
          note: changes.length === 0
            ? "Nothing changed."
            : wasMode === "off"
            ? "Saved. Charging is off, so nobody is charged. The report uses these prices for “would have charged”."
            // The worker prices an item when it runs, not when the call happened, so a call still
            // waiting for Twilio's price is charged at the NEW numbers. Said, because it is true.
            : "Saved. Charging is on: these prices apply from the next charge run (within about 5 minutes), including calls and texts still waiting for Twilio's price.",
        });
      }

      case "phone_billing_arm": {
        // Start or stop charging. TWO shapes of "on", one of "off" (259's gate: markup set AND
        // armed_at set AND (meter active OR tenant in pilot_client_ids)):
        //   {armed:true, pilot_client_ids:[…]} → PILOT: meters stay inactive, only the listed
        //                                         builders are charged.
        //   {armed:true, scope:"all"}          → EVERYONE: all four meters active, pilot list
        //                                         cleared (it no longer means anything).
        //   {armed:false}                      → OFF: meters inactive AND the pilot list
        //                                         CLEARED. armed_at is kept (the contract keeps
        //                                         it as when charging last started), so a pilot
        //                                         list left behind would keep charging every
        //                                         pilot — membership alone satisfies the gate.
        // armed_at is set to now() on EVERY arm, including a change to the pilot list while on:
        // the worker shadows anything that happened before armed_at, so a builder added today is
        // never charged for yesterday. The cost is the other side of the same rule — a call
        // already pilot-billed but still waiting for Twilio's price when the list changes is
        // recorded, not charged. Undercharging is the safe direction.
        if (typeof p.armed !== "boolean") throw new Error("armed must be true or false.");
        const pilots = p.pilot_client_ids == null ? [] : normalizePilotIds(p.pilot_client_ids);
        if (!p.armed && pilots.length) throw new Error("Stop charging takes no pilot list: it stops charging for everyone.");
        // "Everyone" must be asked for by name. An empty or blank pilot list normalises to [],
        // and reading that as "everyone" would let the field meant to NARROW charging widen it
        // to every builder on the platform.
        if (p.armed && !pilots.length && p.scope !== "all") {
          throw new Error("Add at least one pilot builder, or choose every builder.");
        }
        const { settings: before, meters } = await readPhoneBilling(sb);
        const was = chargingMode(before, meters);
        const target: "off" | "pilot" | "all" = !p.armed ? "off" : pilots.length ? "pilot" : "all";
        if (p.armed) {
          if (before.markup == null) {
            throw new Error("Set a markup and save it before charging starts. Without one nothing can be priced.");
          }
          if (target === "all" && meters.length !== PHONE_METERS.length) {
            throw new Error(`Only ${meters.length} of the ${PHONE_METERS.length} phone meters exist in the price list, so charging can't be switched on for everything. Check migration 259.`);
          }
          if (pilots.length) {
            const { data: known, error: kErr } = await sb.from("client_configs").select("client_id").in("client_id", pilots);
            if (kErr) throw kErr;
            const have = new Set((known ?? []).map((r: any) => String(r.client_id)));
            const missing = pilots.filter((id) => !have.has(id));
            if (missing.length) throw new Error(`Unknown builder${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}. Nothing was changed.`);
          }
        }
        // WRITE ORDER, with no transaction across PostgREST calls: everything that NARROWS who is
        // charged goes first and the one write that WIDENS it goes last. A failure part-way then
        // leaves fewer builders charged than either the old or the new state — never more.
        const nowIso = new Date().toISOString();
        const by = identity.via === "operator" ? identity.userId : null;
        if (target !== "all") await setPhoneMeters(sb, false, nowIso);
        const settingsPatch: Record<string, unknown> = target === "off"
          ? { pilot_client_ids: [], updated_at: nowIso, updated_by: by }
          : { pilot_client_ids: target === "pilot" ? pilots : [], armed_at: nowIso, updated_at: nowIso, updated_by: by };
        const { data: row, error } = await sb.from("phone_billing_settings")
          .update(settingsPatch).eq("id", true).select("armed_at").maybeSingle();
        if (error) throw phoneBillingDbError(error);
        if (!row) throw phoneBillingDbError({ code: "42P01" });
        if (target === "all") await setPhoneMeters(sb, true, nowIso);

        // Read back what is REALLY on, rather than echo what was asked for.
        const { settings: after, meters: metersAfter } = await readPhoneBilling(sb);
        const now = chargingMode(after, metersAfter);
        try {
          await sb.from("admin_audit").insert({
            action: "phone_billing_arm",
            target_client_id: null,
            actor_email: identity.via === "operator" ? identity.email : null,
            actor_user_id: identity.via === "operator" ? identity.userId : null,
            note: (`via=${identity.via} mode ${was.mode} -> ${now.mode}`
              + ` pilots [${before.pilot_client_ids.join(",")}] -> [${after.pilot_client_ids.join(",")}]`
              + ` armed_at ${before.armed_at ?? "(none)"} -> ${after.armed_at ?? "(none)"}`
              + ` markup ${after.markup ?? "(none)"}`).slice(0, 2000),
          });
        } catch (_e) { /* best-effort: never fail a completed write on a logging failure */ }

        const serverSwitchOn = Deno.env.get("PHONE_USAGE_METERS") === "on";
        const railNote = serverSwitchOn || now.mode === "off"
          ? ""
          : " The server switch is still off, so nothing is actually charged until it is turned on.";
        const note = now.mode === "all"
          ? `Charging is on for every builder. From now on each call minute and text comes out of their wallet at Twilio's cost × ${after.markup}. Non-billable builders are never charged.${railNote}`
          : now.mode === "pilot"
          ? `Charging is on for ${after.pilot_client_ids.length} pilot builder${after.pilot_client_ids.length === 1 ? "" : "s"} only (${after.pilot_client_ids.join(", ")}), at Twilio's cost × ${after.markup}. Everyone else's costs are only recorded.${railNote}`
          : now.mode === "off"
          ? "Charging is off. Nothing new is charged and nobody is blocked for a low balance. Costs are still recorded, and charges already made stay on the wallets."
          : `Saved, but the result isn't clean: ${now.problem ?? "check the meters."}`;
        return json({
          ok: true,
          settings: after,
          meters: metersAfter.map((m: any) => ({
            kind: m.kind, label: m.label, plainLabel: PHONE_METER_LABELS[m.kind as keyof typeof PHONE_METER_LABELS] ?? m.label,
            active: m.active === true, pricing: m.pricing ?? null, updatedAt: m.updated_at ?? null,
          })),
          charging: now,
          serverSwitchOn,
          note,
        });
      }

      case "phone_usage_report": {
        // One month, UTC (Twilio's daily totals are UTC days). Everything is computed from the
        // RAW rows in _shared/phoneBillingAdmin.ts, so every figure on the card and in the CSV
        // comes from one pass and they cannot disagree. "Would have charged" is priced at TODAY's
        // markup and caps — that is the question being asked before arming ("what would this
        // month have made at 2×?"), not the markup that happened to be set on the day.
        const range = monthRange(p.month, new Date());
        const [{ settings }, charges, twilio, cfg] = await Promise.all([
          readPhoneBilling(sb),
          readUsageChargesForMonth(sb, range.from, range.to),
          readTwilioDaily(sb, range.firstDay, range.nextFirstDay),
          sb.from("client_configs").select("client_id, company_name"),
        ]);
        if (cfg.error) throw cfg.error;
        const names = new Map<string, string>((cfg.data ?? []).map((c: any) => [String(c.client_id), String(c.company_name || c.client_id)]));
        return json({
          ok: true,
          ...summarizePhoneUsage({ range, rows: charges.rows, twilio, settings, names, truncated: charges.truncated }),
        });
      }

      // ── Avalara credential check (2026-09-17) ─────────────────────────────────────
      // Do the platform's Avalara credentials work? GET /api/v2/utilities/ping, run on purpose by
      // an operator. Deliberately NOT in READ_ONLY_ACTIONS: whether Avalara bills a ping is not
      // documented, so it is treated as a counted call. It needs can_write, and it writes a
      // ledger row like every other lookup.
      //
      // Recorded in tax_lookups as kind 'ping' under PING_CLIENT_ID, not under a tenant: it
      // checks our credentials, not a builder's (see that constant for the choice), and the
      // daily cap does not count pings. The row goes in BEFORE the request, and a row that
      // cannot be written refuses the ping: a call nothing recorded is the one the ledger is
      // for. With no credentials configured, no request is made and the row closes as
      // not_configured.
      //
      // The answer names the account id and the user behind the key. None of that leaves this
      // case: pingAvalara whitelists four fields, and pingResponse whitelists them again.
      case "avalara_ping": {
        const lookupId = await insertLookup(sb, {
          clientId: PING_CLIENT_ID,
          kind: "ping",
          actorUserId: identity.via === "operator" ? identity.userId : null,
          operator: true,
        });
        if (!lookupId) {
          return json({ error: "Couldn't record the ping in the tax lookup ledger, so it wasn't sent. Try again in a minute." }, 503);
        }
        const ping = await pingAvalara();
        if (!(await finishLookup(sb, lookupId, ping))) {
          // Best-effort: the request already happened. The row stays in flight; pings are not
          // capped, so it blocks nothing, but it should not be invisible either.
          logEdgeError({
            fn: "admin-catalog", req, clientId: null, code: "tax_lookup_unclosed",
            message: "avalara_ping: the ledger row could not be closed",
            context: { lookupId },
          }).catch(() => {});
        }
        return json(pingResponse(ping));
      }

      // ── Avalara tax code sync (migration 246, 2026-09-17) ─────────────────────────────────
      // Fill the platform catalog (avalara_tax_codes) that every builder's Tax tab searches, from
      // Avalara's ListTaxCodes. Pressed on purpose by an operator; nothing automatic calls it.
      // Like avalara_ping, deliberately NOT in READ_ONLY_ACTIONS: it writes the catalog and makes
      // up to ten authenticated Avalara requests, so it needs can_write. It is not a rate lookup
      // and never touches a tenant's tax_lookup_enabled switch or the lookup ledger's cap. The
      // paging, the write rules (refused credentials write nothing, a partial sync deactivates
      // nothing) and the operator's sentences are in _shared/taxCodeSync.ts. The answer is counts,
      // plus stoppedBy and a warning sentence when the sync stopped short (still ok: what it read
      // was saved) — no credentials, no account ids, no Avalara body.
      case "avalara_sync_tax_codes": {
        const out = await syncTaxCodes(sb);
        if (!out.ok) {
          const { status, ok: _ok, ...body } = out;
          return json(body, status);
        }
        return json(out);
      }

      case "set_feature_grants": {
        // EARLY ACCESS: switch a feature on for ONE builder before it goes on sale.
        // Carolyn 2026-08-18 — "I would like to be able to see the 3D as I'm in beta, but not
        // all clients need to see it." This is a COMP: it creates no subscription, charges
        // nothing, and never touches the billing gate (portal-billing keeps requiredFeatures
        // and entState untouched by grants).
        //
        // Replaces the whole set for this tenant, the way the Team screen replaces an access
        // map: the card sends what should be true now, so an unchecked box is a revoke.
        const clientId = reqStr(p.clientId, "clientId");
        const { data: exists } = await sb.from("client_configs")
          .select("client_id").eq("client_id", clientId).maybeSingle();
        if (!exists) throw new Error(`Unknown builder: ${clientId}`);

        // TWO SERVER-SIDE GUARDS, both mandatory. The UI only ever offers grantable
        // features, but the UI is a courtesy and this is the control.
        const { data: planRows } = await sb.from("billing_plans")
          .select("feature, operator_grantable");
        const grantable = new Set((planRows ?? [])
          .filter((r: any) => r.operator_grantable)
          .map((r: any) => r.feature));
        // Mirrors portal-billing's set. Kept here as well rather than imported, because the
        // two functions are deployed separately and a comp that the reader refuses to honour
        // is confusing, while a comp this writer refuses is self-explanatory.
        // on_demand_pricing joined 2026-08-28 with the Real-Time Pricing build — pay-only
        // from the start, so no comp can hand out a feature whose whole point is the upcharge.
        // crm joined portal-billing's and featureCheck's sets 2026-08-29 but never this one, so a
        // CRM comp saved here read as granted while the reader refused to honour it.
        const PAID_ONLY_FEATURES = new Set(["schedule_builds", "quickbooks_sync", "on_demand_pricing", "crm"]);

        const wanted = Array.isArray(p.grants) ? p.grants : [];
        if (wanted.length > 50) throw new Error("Too many grants in one request.");

        // What this tenant holds NOW. Two reasons (both audit 2026-08-19):
        //   1. VALIDATION applies only to what is being ADDED. A grant whose feature was
        //      later un-armed (operator_grantable flipped false) must stay REMOVABLE --
        //      validating the whole replacement set left stale grants that no UI could
        //      revoke, because every save carrying the other, legitimate grants was
        //      refused on the stale one's account.
        //   2. METADATA on merely-preserved grants must survive. The wipe-and-reinsert
        //      rewrote granted_by/granted_at and dropped note on every save that touched a
        //      DIFFERENT feature, erasing the audit trail this table exists to keep.
        const { data: existingRows } = await sb.from("client_feature_grants")
          .select("feature, expires_at").eq("client_id", clientId);
        const existing = new Map((existingRows ?? []).map((r: any) => [r.feature, r.expires_at ?? null]));

        // Last occurrence wins: two rows for one feature share a primary key, so an
        // un-deduped pair turned the whole save into a constraint violation.
        const byFeature = new Map<string, any>();
        for (const g of wanted) {
          const feature = typeof g?.feature === "string" ? g.feature.trim() : "";
          if (feature) byFeature.set(feature, g);
        }

        const rows: Record<string, unknown>[] = [];
        const refused: string[] = [];
        for (const [feature, g] of byFeature) {
          // Refuse LOUDLY rather than dropping silently -- but only for features being
          // ADDED. A feature the tenant already holds passes through so it can be kept
          // or revoked regardless of whether it is still grantable today.
          if (!existing.has(feature) && (!grantable.has(feature) || PAID_ONLY_FEATURES.has(feature))) {
            refused.push(feature);
            continue;
          }
          // PAID_ONLY is refused even for held grants: a hand-inserted row for
          // schedule_builds must not be re-writable through this door.
          if (PAID_ONLY_FEATURES.has(feature)) { refused.push(feature); continue; }
          let expiresAt: string | null = null;
          if (g.expiresAt) {
            const t = Date.parse(String(g.expiresAt));
            if (!Number.isFinite(t)) throw new Error(`Not a date: ${g.expiresAt}`);
            expiresAt = new Date(t).toISOString();
          }
          rows.push({
            client_id: clientId,
            feature,
            // Only the operator-JWT path has a user id. The ADMIN_PASSWORD break-glass path
            // has none, and reading userId off it yields undefined — see _shared/adminAuth.ts.
            granted_by: identity.via === "operator" ? identity.userId : null,
            expires_at: expiresAt,
            note: typeof g.note === "string" ? g.note.slice(0, 300) : null,
          });
        }
        if (refused.length) {
          throw new Error(`Not available for early access: ${refused.join(", ")}. `
            + "A feature must be marked operator_grantable, and paid-only features never are.");
        }

        // Write order matters without a transaction: UPSERT the changed/new rows first,
        // then PRUNE what was un-picked. A failure between the two leaves every feature
        // either at its old value or its new one -- never the wiped-out nothing that
        // delete-then-insert left when the insert failed (audit 2026-08-19). Rows whose
        // expiry is unchanged are skipped entirely, which is what preserves their
        // granted_by/granted_at/note.
        // Compare INSTANTS, not strings. PostgREST returns timestamptz as
        // "...T23:59:59.999+00:00" while the incoming value is normalised through
        // toISOString() ("...Z"), so a string compare called EVERY dated grant "changed"
        // on every save and re-upserted it -- rewriting granted_by and wiping note, the
        // exact loss the paragraph above says this skip prevents. A stored value that
        // will not parse yields NaN, which compares unequal, so garbage still gets rewritten.
        const ms = (v: unknown) => (v == null ? null : Date.parse(String(v)));
        const changed = rows.filter((r: any) =>
          !existing.has(r.feature) || ms(existing.get(r.feature)) !== ms(r.expires_at));
        if (changed.length) {
          const { error: upErr } = await sb.from("client_feature_grants")
            .upsert(changed, { onConflict: "client_id,feature" });
          if (upErr) throw upErr;
        }
        const keep = new Set(rows.map((r: any) => r.feature));
        const drop = [...existing.keys()].filter((f) => !keep.has(f));
        if (drop.length) {
          const { error: delErr } = await sb.from("client_feature_grants")
            .delete().eq("client_id", clientId).in("feature", drop);
          if (delErr) throw delErr;
        }
        return json({
          ok: true,
          grants: rows.map((r: any) => ({ feature: r.feature, expiresAt: r.expires_at })),
          note: rows.length
            ? `Early access on for ${rows.length} feature(s). This is a comp — no subscription, no charge.`
            : "Early access cleared for this builder.",
        });
      }
      case "set_billing": {
        // Billing posture for an EXISTING tenant: the comp flag and the account discount.
        // Separate from create_client because the customers most likely to need a discount
        // — founding customers — already exist by the time you decide to give them one.
        //
        // Two things this deliberately does NOT do:
        //   1. It does not touch live subscriptions. NMI stores the amount on the
        //      subscription itself, so a discount set now applies to what they subscribe
        //      to NEXT, not to what is already running. Re-pricing an existing
        //      subscription would mean a gateway update_subscription call and is a
        //      separate, money-moving operation.
        //   2. Clearing billing_exempt on a tenant with no active subscription LOCKS them
        //      out immediately — the gate has nothing to let them in on. Order matters:
        //      set the discount first, let them subscribe, then remove the exemption.
        //      ⚠️ Since 2026-09-21 (migration 228) that is worse than it was: billing_exempt
        //      confers EVERY feature, so clearing it takes away Scheduling, QuickBooks Sync,
        //      Real-Time Pricing, the CRM and 3D as well as the base gate. The response note
        //      below now says so; it used to talk about discounts only.
        const clientId = reqStr(p.clientId, "clientId");
        const { data: exists } = await sb.from("client_configs")
          .select("client_id").eq("client_id", clientId).maybeSingle();
        if (!exists) throw new Error(`Unknown builder: ${clientId}`);

        // Prior posture, read BEFORE the upsert, so the note below can talk about what
        // actually CHANGED. The card sends billingExempt on every save, so "false" on its
        // own says nothing — an account that was already billable is not being locked out.
        const { data: priorCs } = await sb.from("client_settings")
          .select("billing_exempt").eq("client_id", clientId).maybeSingle();
        const wasExempt = Boolean(priorCs?.billing_exempt);

        const patch: Record<string, unknown> = { client_id: clientId, updated_at: new Date().toISOString() };
        if (p.billingExempt !== undefined) patch.billing_exempt = p.billingExempt === true;
        if (p.discountPercent !== undefined) {
          const pct = Math.round(Number(p.discountPercent));
          if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
            throw new Error("discountPercent must be a whole number from 0 to 100.");
          }
          patch.discount_percent = pct;
        }
        if (p.discountFeatures !== undefined) {
          patch.discount_features = Array.isArray(p.discountFeatures) && p.discountFeatures.length
            ? p.discountFeatures.map((f: unknown) => String(f))
            : null;
        }
        // Dated free period (059). Empty string clears it. A date-only value is taken as the
        // END of that day in UTC, so "free until Aug 5" includes all of Aug 5 rather than
        // expiring at midnight as it begins.
        if (p.exemptUntil !== undefined) {
          const raw = String(p.exemptUntil ?? "").trim();
          if (!raw) {
            patch.billing_exempt_until = null;
          } else {
            const iso = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T23:59:59.999Z` : raw;
            const t = Date.parse(iso);
            if (!Number.isFinite(t)) throw new Error(`exemptUntil is not a valid date: ${raw}`);
            patch.billing_exempt_until = new Date(t).toISOString();
          }
        }
        const { error } = await sb.from("client_settings").upsert(patch, { onConflict: "client_id" });
        if (error) throw error;

        // Warn the operator when the change cannot take effect on its own.
        const { data: live } = await sb.from("billing_subscriptions")
          .select("id").eq("client_id", clientId).neq("status", "cancelled").limit(1);
        // Clearing the comp flag is the destructive direction, so it speaks first: it is
        // the one change here that can take a working portal away from someone.
        const clearedExempt = wasExempt && p.billingExempt === false;
        const hasLive = Boolean(live && live.length);
        const note = clearedExempt && !hasLive
          ? "Saved — but this tenant is now BILLABLE with no active subscription, so they are locked out of the portal as of right now, and Scheduling, QuickBooks Sync, Real-Time Pricing, the CRM and 3D are switched off. Tick Non-billable again, or give them a Free until date, until they subscribe."
          : clearedExempt
          ? "Saved. Non-billable is off, so this tenant now keeps only what their subscription covers — Scheduling, QuickBooks Sync, Real-Time Pricing, the CRM and 3D are switched off unless they are paying for them."
          : hasLive
          ? "Saved. This tenant already has a live subscription — the gateway holds its amount, so a discount change applies only to features they subscribe to from now on."
          : "Saved.";
        return json({
          ok: true,
          hasLiveSubscription: hasLive,
          clearedExempt,
          note,
        });
      }
      // ── card payments: the per-tenant merchant of record (migration 174) ──────────
      // `client_settings.payments_online_enabled` + `.cardpointe_merchid` are what
      // portal-payments and customer-pay gate every card charge on. Both columns shipped
      // with 174 and, until these two actions existed, NOTHING could write them — turning a
      // builder's pay surface on meant hand-written SQL, so the whole card path (customer
      // pay-an-invoice, the builder card modal, the swipe reader) was unreachable for every
      // tenant. This is that missing door, and it is deliberately the only one.
      case "get_payments": {
        // Per-tenant on purpose, rather than folded into list_clients: a MID identifies
        // somebody else's bank account, and there is no reason for every operator page-load
        // to carry one for every builder when the console shows one tenant at a time.
        const clientId = await assertClient(sb, reqStr(p.clientId, "clientId"));
        const { data, error } = await sb.from("client_settings")
          .select("payments_online_enabled, cardpointe_merchid")
          .eq("client_id", clientId).maybeSingle();
        if (error) throw error;
        return json({
          ok: true,
          clientId,
          paymentsEnabled: data?.payments_online_enabled === true,
          merchid: data?.cardpointe_merchid ?? null,
        });
      }
      case "set_payments": {
        // ⚠️ WHAT THIS WRITES IS THE MERCHANT OF RECORD. Each builder boards and underwrites
        // DIRECTLY with Fiserv, holds their own CardPointe MID and carries their own
        // chargeback liability (174's own column comment, Kaylee McLaughlin 2026-08-28). The
        // money lands in THEIR account; we pass the card through and keep a token + last 4.
        // A wrong MID here does not fail — it succeeds, into a stranger's bank account. That
        // is why every branch below refuses rather than repairs.
        const clientId = await assertClient(sb, reqStr(p.clientId, "clientId"));

        // The pair is meaningless half-stated, so the switch is never inferred from the
        // presence of a merchid — the caller has to say which one it means.
        if (typeof p.paymentsEnabled !== "boolean") {
          throw new Error("paymentsEnabled must be true or false.");
        }

        const patch: Record<string, unknown> = { client_id: clientId, updated_at: new Date().toISOString() };
        // undefined = leave the stored id alone (a plain on/off toggle); null or "" = clear it.
        let merchid: string | null | undefined;
        if (p.merchid !== undefined) {
          if (p.merchid !== null && typeof p.merchid !== "string") {
            // A 16-digit MID sent as a JSON *number* loses precision past 2^53 and arrives as
            // a different, still-plausible merchant id. Refuse the type rather than coerce.
            throw new Error("merchid must be sent as a string.");
          }
          const raw = String(p.merchid ?? "").trim();
          if (!raw) {
            merchid = null;
          } else if (!/^[0-9]{12,16}$/.test(raw)) {
            // SHAPE: digits only, 12–16 of them. A CardPointe MID is a 12-digit number
            // (the gateway fixtures in _shared/cardpointe.test.ts are 12), and Fiserv has
            // issued longer numeric ids on some front-ends — 16 leaves that headroom without
            // ever accepting free text. NOTHING IS STRIPPED: "1002-0030-0400" and
            // "1002 0030 0400" are refused, not silently repunctuated, because a value the
            // operator never typed is exactly the class of change that must not happen
            // quietly to the field that decides where money goes.
            throw new Error(
              `That doesn't look like a CardPointe merchant id: "${raw.slice(0, 40)}". ` +
              "Expected 12–16 digits and nothing else — no spaces, dashes or letters. " +
              "Copy it exactly from this builder's own Fiserv/CardConnect boarding paperwork.");
          } else {
            merchid = raw;
          }
          patch.cardpointe_merchid = merchid;
        }

        const { data: current, error: curErr } = await sb.from("client_settings")
          .select("payments_online_enabled, cardpointe_merchid")
          .eq("client_id", clientId).maybeSingle();
        if (curErr) throw curErr;
        const effectiveMerchid = merchid !== undefined ? merchid : (current?.cardpointe_merchid ?? null);

        // ⛔ ENABLED WITH NO MID IS THE DANGEROUS STATE, NOT MERELY AN INCOMPLETE ONE.
        // Both readers resolve `settings.cardpointe_merchid || CP_DEFAULT_MERCHID` — so a
        // blank id does NOT refuse, it falls through to the deployment-wide CARDPOINTE_MERCHID
        // and takes this builder's customers' money into OUR merchant account. Refusing at
        // this door is the only place that pairing is checked.
        if (p.paymentsEnabled === true && !effectiveMerchid) {
          throw new Error(
            "Add this builder's own CardPointe merchant id before switching payments on. " +
            "Enabled with no MID is not a half-finished setting: portal-payments and customer-pay " +
            "both fall back to the deployment-wide merchant id, so their customers' card payments " +
            "would land in the wrong account rather than being refused.");
        }
        patch.payments_online_enabled = p.paymentsEnabled === true;

        const { error: upErr } = await sb.from("client_settings").upsert(patch, { onConflict: "client_id" });
        if (upErr) throw upErr;

        // A DEDICATED audit row, on top of the generic operator one at the top of this
        // function. That row records only that `set_payments` ran; when money has landed
        // somewhere unexpected the question is which id it was pointed at, from what, and by
        // whom — and the ADMIN_PASSWORD path writes no success row at all (adminGate audits
        // only failures), so without this a break-glass change is invisible after the fact.
        try {
          await sb.from("admin_audit").insert({
            action: "set_payments",
            target_client_id: clientId,
            actor_email: identity.via === "operator" ? identity.email : null,
            actor_user_id: identity.via === "operator" ? identity.userId : null,
            note: `via=${identity.via}`
              + ` enabled ${current?.payments_online_enabled === true} -> ${patch.payments_online_enabled === true}`
              + ` merchid ${current?.cardpointe_merchid || "(none)"} -> ${effectiveMerchid || "(none)"}`,
          });
        } catch (_e) { /* best-effort: never fail a completed write on a logging failure */ }

        return json({
          ok: true,
          clientId,
          paymentsEnabled: patch.payments_online_enabled === true,
          merchid: effectiveMerchid,
          note: patch.payments_online_enabled === true
            ? `Card payments are ON for ${clientId}. Charges route to merchant id ${effectiveMerchid} — their Fiserv account, their chargeback liability.`
            : `Card payments are OFF for ${clientId}. Their pay surface disappears; nothing already taken is affected.`,
        });
      }
      case "link_owner": {
        const clientId = await assertClient(sb, reqStr(p.clientId, "clientId"));
        const email = reqStr(p.email, "email").toLowerCase();
        const role = ["owner", "admin", "user"].includes(String(p.role || "").toLowerCase())
          ? String(p.role).toLowerCase() : "owner";
        // Where the set-password link lands. ALWAYS the canonical production portal —
        // a caller-supplied portalUrl is deliberately ignored (see AUTH_PORTAL_URL).
        const portalUrl = AUTH_PORTAL_URL;

        // 1. find an existing auth user by email (admin API, paginated)
        let user: any = null;
        for (let page = 1; page <= 20 && !user; page++) {
          const list = await sb.auth.admin.listUsers({ page, perPage: 1000 });
          if (list.error) throw list.error;
          const users = list.data?.users || [];
          user = users.find((u: any) => String(u.email || "").toLowerCase() === email) || null;
          if (users.length < 1000) break;
        }

        // 2. create the login if missing. inviteUserByEmail creates + emails the
        // invite when SMTP is set up; if that fails (e.g. no SMTP) we still want the
        // account, so fall back to a plain confirmed createUser.
        let created = false, emailSent = false;
        if (!user) {
          const inv = await sb.auth.admin.inviteUserByEmail(email, { redirectTo: portalUrl });
          if (!inv.error && inv.data?.user) {
            user = inv.data.user; created = true; emailSent = true;
          } else {
            const cu = await sb.auth.admin.createUser({ email, email_confirm: true });
            if (cu.error && !/already|registered|exist/i.test(cu.error.message || "")) throw cu.error;
            user = cu.data?.user || null;
            if (!user) {
              const relist = await sb.auth.admin.listUsers({ page: 1, perPage: 1000 });
              user = (relist.data?.users || []).find((u: any) => String(u.email || "").toLowerCase() === email) || null;
            }
            if (!user) throw new Error(`Could not create a login for "${email}".`);
            created = !cu.error; emailSent = false;
          }
        }

        // 3. map the user to this client with the chosen role. Refuse to SILENTLY re-home a
        //    login already linked to a different client (operator typo / isolation footgun);
        //    require an explicit reassign:true to move them.
        const existingLink = await sb.from("client_users").select("client_id, role").eq("user_id", user.id).maybeSingle();
        if (existingLink.error) throw existingLink.error;
        if (existingLink.data && existingLink.data.client_id && existingLink.data.client_id !== clientId && p.reassign !== true) {
          throw new Error(`"${email}" is already linked to builder "${existingLink.data.client_id}". Pass reassign:true to move them to "${clientId}".`);
        }
        // Not just `role`: access resolves from title + overrides, which a role-only upsert left
        // behind from the old builder or the old role — see _shared/linkOwnerRow.ts.
        const up = await sb.from("client_users").upsert(
          linkOwnerRow(existingLink.data, user.id, clientId, role as LinkRole), { onConflict: "user_id" });
        if (up.error) throw up.error;

        // 4. always hand back a one-time set-password link (works without SMTP)
        let setupLink: string | null = null;
        try {
          const gl = await sb.auth.admin.generateLink({ type: "recovery", email, options: { redirectTo: portalUrl } });
          if (!gl.error) setupLink = gl.data?.properties?.action_link || null;
        } catch (_) { /* link is best-effort */ }

        return json({ ok: true, userId: user.id, email, role, created, emailSent, setupLink });
      }

      // ── email sender: connect a Google account so auth emails send from it ──
      // (Supabase Auth custom SMTP via the Management API — see mgmtAuthConfig.)
      case "get_email_sender": {
        const cfg = await mgmtAuthConfig("GET");
        const host = (cfg && cfg.smtp_host) || "";
        return json({ ok: true, connected: !!host, senderEmail: (cfg && cfg.smtp_admin_email) || null, host: host || null });
      }
      case "connect_email": {
        const email = reqStr(p.email, "email").toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("Enter a valid Google email address.");
        // Google shows app passwords as 4 space-separated groups; strip whitespace
        // to the raw 16 chars. Required on every connect (it's tied to the account),
        // so we never PATCH an empty smtp_pass — the stored secret can't be blanked
        // by an empty save; clearing is the explicit disconnect_email action.
        const appPassword = String(p.appPassword ?? "").replace(/\s+/g, "");
        if (!appPassword) throw new Error("Paste the 16-character Google app password.");
        if (appPassword.length < 16) throw new Error("That app password looks too short — paste the full 16-character code from Google.");
        await mgmtAuthConfig("PATCH", {
          external_email_enabled: true,
          smtp_host: "smtp.gmail.com",
          // String, not number: the Management API's auth-config schema types
          // smtp_port as a string and rejects a number ("Expected string, received number").
          smtp_port: "465",
          smtp_user: email,
          smtp_pass: appPassword,
          smtp_admin_email: email,
          smtp_sender_name: (typeof p.senderName === "string" && p.senderName.trim()) ? p.senderName.trim().slice(0, 100) : "Structure Studio",
        });
        return json({ ok: true, connected: true, senderEmail: email });
      }
      case "disconnect_email": {
        // Revert to Supabase's built-in sender by clearing the custom SMTP fields.
        // Leave external_email_enabled untouched so email logins keep working.
        await mgmtAuthConfig("PATCH", { smtp_host: "", smtp_user: "", smtp_pass: "", smtp_admin_email: "", smtp_sender_name: "" });
        return json({ ok: true, connected: false, senderEmail: null });
      }
      // ── send a test email through the connected sender ──────────────────
      // Proves the configured SMTP actually delivers by pushing a REAL auth email
      // through it — a password-recovery email, which is one of the flows this
      // feature powers and has no side effects: nothing is created, and nothing
      // changes unless the recipient clicks the link (which only lets them set a
      // password they already own). The recipient must be an existing login: GoTrue
      // recover returns 200 even when it skips a non-user, so we verify first rather
      // than report a misleading "sent".
      case "test_email": {
        const email = reqStr(p.email, "email").toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("Enter a valid email address to send the test to.");

        // Refuse to "test" when there's no custom sender — the email would quietly
        // go out via Supabase's default sender and prove nothing about the connection.
        const cfg = await mgmtAuthConfig("GET");
        if (!(cfg && cfg.smtp_host)) throw new Error("Connect a Google account first — there's no custom sender to test yet.");

        // Confirm the recipient is a real login (recovery only emails existing users).
        let exists = false;
        for (let page = 1; page <= 20 && !exists; page++) {
          const list = await sb.auth.admin.listUsers({ page, perPage: 1000 });
          if (list.error) throw list.error;
          const users = list.data?.users || [];
          exists = users.some((u: any) => String(u.email || "").toLowerCase() === email);
          if (users.length < 1000) break;
        }
        if (!exists) throw new Error(`"${email}" isn't a login yet, so no test can be sent to it. Use an existing owner/operator login address (or create it first under "Link owner").`);

        // Where the reset link lands; the panel passes location.origin + "/portal.html".
        const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: AUTH_PORTAL_URL });
        if (error) throw error;
        return json({ ok: true, sentTo: email, senderEmail: (cfg && cfg.smtp_admin_email) || null });
      }

      // ── delete a tenant and ALL of its data (operator hard delete) ──────
      // Removes the client's designs + version history + captured leads, catalog
      // (styles/sizes/inclusions/layout items/colours/pricing), fixtures catalog,
      // settings, error logs, feedback submissions (and their comments, by cascade),
      // billing subscription + vaulted-card mirrors, QuickBooks item map, user
      // mappings + their now-orphaned auth logins, and uploaded storage objects in
      // all four buckets (floor-plans, branding, fixtures, feedback-attachments),
      // then the client_configs row itself. Requires the typed client id to match
      // (confirmClientId) so a stray/mistaken call can't nuke a tenant.
      // Irreversible. GHL-side contacts/estimates are external and untouched.
      // BEFORE any of that, at the payment gateway: the tenant's open subscriptions are
      // cancelled and its saved card is removed from the vault (2026-10-05), or the delete
      // is refused with nothing wiped. The response and audit row carry COUNTS, never ids.
      // ⚠️ NOT removed: the financial ledgers (orders/payments/invoice_sends/
      // billing_charge_attempts/wallet_transactions/usage_charges). Those are records of
      // money that moved, so the response reports their counts as `retained` instead of
      // silently keeping them — deciding to destroy them is a retention call, not a code change.
      // ⚠️ NOT removed EITHER, and not decided yet: the tenant's CRM, phone, text, email and
      // customer-login rows (end customers' names, numbers, message bodies, voicemails). They
      // are counted as `leftBehind` so the operator sees them; see the note at that list.
      // Keep this list in step with the wipes below; drift here is what left a
      // deleted tenant's PII in the database twice already.
      case "delete_client": {
        const clientId = await assertClient(sb, reqStr(p.clientId, "clientId"));
        if (reqStr(p.confirmClientId, "confirmClientId") !== clientId) {
          throw new Error("Confirmation text does not match the client id.");
        }
        const deleted: Record<string, number> = {};
        // Adds to the count rather than setting it: billing_customers is wiped twice, once by the
        // gateway step the moment the card is gone, and again in the list below as the backstop.
        const wipe = async (table: string) => {
          const { error, count } = await sb.from(table).delete({ count: "exact" }).eq("client_id", clientId);
          if (error) throw new Error(`${table}: ${error.message}`);
          deleted[table] = (deleted[table] ?? 0) + (count ?? 0);
        };

        // ── The payment gateway FIRST, before a single row is wiped (2026-10-05). ──────────────
        // billing_subscriptions and billing_customers (wiped below) are only MIRRORS. Until this,
        // deleting a paying builder left their subscriptions charging their card at Deposyt/NMI and
        // the card in the gateway's vault, with no row left on our side to show either. Carolyn,
        // 07-31: card information is not kept for a builder who is gone.
        //
        // ⚠️ The gateway account is SHARED with other CSM Synergy products, and both calls are
        // irreversible. Only ids read from THIS tenant's own rows are touched, and it fails CLOSED:
        // no gateway configured, or any answer short of "done" / "that id is already gone", refuses
        // the delete with nothing wiped. A wiped tenant with a live subscription is a builder still
        // being charged with nothing here to show why. The rules live in _shared/tenantGatewayCleanup.ts.
        //
        // ⛔ The vault id is a bearer capability for charging that card (see get_billing_overview).
        // It is read here, handed to the gateway, and never reaches a response, an audit note or a
        // log: counts only.
        const [subsRes, custRes] = await Promise.all([
          sb.from("billing_subscriptions").select("id, status").eq("client_id", clientId),
          sb.from("billing_customers").select("vault_id").eq("client_id", clientId).maybeSingle(),
        ]);
        if (subsRes.error) throw new Error(`billing_subscriptions: ${subsRes.error.message}`);
        if (custRes.error) throw new Error(`billing_customers: ${custRes.error.message}`);
        const tenantSubs = (subsRes.data ?? []) as { id: string; status: string | null }[];
        let tenantVault: string | null = custRes.data?.vault_id ? String(custRes.data.vault_id) : null;
        // A vault another builder's row ALSO points at is still in use, and deleting it would break
        // THEIR billing. It is kept and reported. Never true on 2026-10-05 (4 rows, 4 distinct
        // vaults); one count to rule it out on an irreversible call is cheap.
        let vaultShared = false;
        if (tenantVault) {
          const { count: others, error: sharedErr } = await sb.from("billing_customers")
            .select("client_id", { count: "exact", head: true })
            .eq("vault_id", tenantVault).neq("client_id", clientId);
          if (sharedErr) throw new Error(`billing_customers: ${sharedErr.message}`);
          if (others) { vaultShared = true; tenantVault = null; }
        }
        const openSubs = openSubscriptions(tenantSubs).length;
        let gateway = { subscriptionsCancelled: 0, vaultDeleted: false, alreadyGone: 0 };
        // One dedicated audit row, written as soon as the gateway step has run, whichever way it went:
        // the generic operator row at the top only records that the action was asked for, and the
        // ADMIN_PASSWORD path writes no success row at all, yet what happened at the gateway cannot be
        // undone and must be findable. Counts only.
        const auditGateway = async (outcome: string) => {
          try {
            await sb.from("admin_audit").insert({
              action: "delete_client",
              target_client_id: clientId,
              actor_email: identity.via === "operator" ? identity.email : null,
              actor_user_id: identity.via === "operator" ? identity.userId : null,
              note: (`via=${identity.via} gateway ${outcome}`
                + ` subscriptions_cancelled=${gateway.subscriptionsCancelled} of ${openSubs}`
                + ` vault_deleted=${gateway.vaultDeleted} already_gone=${gateway.alreadyGone}`
                + (vaultShared ? " vault_kept=shared" : "")).slice(0, 2000),
            });
          } catch (_e) { /* best-effort: the gateway outcome is also in the response */ }
        };
        const atGateway = needsGateway(tenantSubs, tenantVault);
        if (atGateway) {
          if (!nmiConfigured) {
            return json({ error: "Can't reach the payment gateway; nothing was deleted." }, 503);
          }
          try {
            gateway = await cleanupTenantGateway({
              subs: tenantSubs,
              vaultId: tenantVault,
              nmiPost,
              // Mark each mirror row cancelled the moment the gateway confirms, the way
              // portal-billing's cancel does, so a delete that stops part-way and is retried
              // skips what already went.
              onCancelled: async (subscriptionId: string) => {
                const now = new Date().toISOString();
                await sb.from("billing_subscriptions")
                  .update({ status: "cancelled", canceled_at: now, updated_at: now })
                  .eq("id", subscriptionId).eq("client_id", clientId);
              },
              // And the row that points at the saved card goes the moment the gateway confirms the
              // card is gone, not fifteen wipes later. If a later wipe throws, the tenant survives
              // the failed delete, and a vault id left behind would show a card on file that the
              // gateway no longer holds: Billing says "card on file", subscribe and top-up reuse it
              // and are declined, and a retry asks the gateway to delete it again. With the row gone
              // the retry has nothing to send. The wipe in the list below stays as the backstop.
              onVaultDeleted: () => wipe("billing_customers"),
            });
          } catch (e) {
            // Anything that is not the module's own refusal is treated as "no answer": we cannot
            // say what happened at the gateway, so the operator is sent to look.
            const stopped = e instanceof GatewayCleanupError ? e : null;
            const noAnswer = stopped ? stopped.unknown : true;
            if (stopped) gateway = stopped.progress;
            await auditGateway(`refused(${noAnswer ? "no_answer" : "declined"})`);
            const cancelledSoFar = gateway.subscriptionsCancelled;
            const partial = cancelledSoFar
              ? ` ${cancelledSoFar} of their ${openSubs} paid plan${openSubs === 1 ? "" : "s"} ${cancelledSoFar === 1 ? "was" : "were"} cancelled at the gateway before it stopped.`
              : "";
            return json({
              error: noAnswer
                ? `The payment gateway didn't answer, so nothing was deleted. A cancellation may still have gone through: check this builder's plans in the Deposyt portal before you try again.${partial}`
                : `The payment gateway wouldn't cancel this builder's plan or remove their saved card, so nothing was deleted. It said: "${stopped!.said}".${partial}`,
              gateway,
            }, 502);
          }
        }
        await auditGateway(atGateway ? "done" : "none");

        // tax_code_assignments (migration 246) goes FIRST, ahead of the order below. Its rows have
        // no foreign key to anything wiped here (target_key is text, shared by style ids and
        // heading keys), so none cascade; and the HEADING rows — delivery, doors, services — pass
        // tax_codes_get's visibility filter for any tenant, because the heading keys are the same
        // everywhere. Left behind, a recreated slug's Tax tab would show the deleted company's
        // codes as its own saved choices, and a save that kept them would stamp them as theirs.
        // First, because it is the one table here that can be missing: admin-catalog deployed
        // before 246 is applied refuses the delete on this line, before anything is gone, instead
        // of half-deleting the tenant and throwing further down. (Only the gateway step above runs
        // ahead of it: its refusals wipe nothing, and once the gateway has removed the saved card it
        // wipes the billing_customers row that pointed at it, which is the one row that must not
        // outlive the card.)
        await wipe("tax_code_assignments");
        // wallet_accounts (migration 164) is the BALANCE, keyed by client_id with no FK to anything,
        // so a recreated slug inherited it: a deleted test tenant left $100.00 behind (seen 10-05),
        // which the next tenant on that slug would have spent as its own. The movements stay:
        // wallet_transactions is a ledger, reported under `retained` below.
        await wipe("wallet_accounts");
        // client_feature_grants is the same kind of entitlement as wallet_accounts and
        // billing_subscriptions: keyed by client_id, no FK, so a recreated slug inherited the dead
        // tenant's comped features (seen 10-05: an unexpired view_3d grant outliving its tenant).
        // get_config's view3d is an EXISTS over this table, so the new tenant would have had paid
        // 3D on day one. A grant is a comp, not a record of money that moved, so it is wiped, not
        // retained.
        await wipe("client_feature_grants");
        // Catalog/design rows first, config last. Order respects FKs
        // (layout_item_pricing & building_sizes → building_styles; inclusions → sizes).
        await wipe("designs");
        // design_versions and captured_leads were BOTH missing from this list until
        // 2026-07-30. Neither has a foreign key to designs (verified: zero FKs on either), so
        // nothing cascaded and both survived a tenant hard-delete — leaving that tenant's
        // full quote history and their browsing leads, complete with customer names, phone
        // numbers and addresses, in a database the tenant no longer exists in.
        await wipe("design_versions");
        await wipe("captured_leads");
        await wipe("layout_item_pricing");      // FK style_id → building_styles
        await wipe("colors");                   // standalone per-tenant palette
        await wipe("building_size_inclusions");
        await wipe("building_sizes");
        await wipe("building_styles");
        await wipe("client_layout_items");
        await wipe("client_settings");
        // 2026-08-01: the same orphan-cascade hole as design_versions/captured_leads above, on the
        // tables added since. Verified against information_schema rather than by memory — no FK
        // chain reaches any of these from anything wiped here.
        //
        //   billing_subscriptions + billing_customers are the DANGEROUS pair, and not merely
        //   untidy: entitlement is computed purely from surviving rows keyed on client_id, and
        //   `hasCard` / the charge vault come from billing_customers.vault_id. Recreating a slug
        //   (a re-onboard, or just reusing a test slug) therefore handed the new tenant the dead
        //   one's 'active' subscription — full product, no payment — and made a subscribe call
        //   charge the FORMER customer's stored card, on an invoice nobody could attribute.
        //   Neither table is an accounting record; both are mirrors of gateway state, and the
        //   gateway remains the source of truth. By this line the gateway step at the top has
        //   already cancelled the subscriptions and removed the card these rows describe (and
        //   wiped billing_customers once the card was gone; this second wipe is the backstop).
        await wipe("billing_subscriptions");
        await wipe("billing_customers");
        //   feedback_submissions holds submitter_name + submitter_email — the named people who
        //   filed bugs from that portal. feedback_comments cascades from it (verified ON DELETE
        //   CASCADE), and the attachments live under {client_id}/ in the bucket loop below.
        await wipe("feedback_submissions");
        //   fixture_items is the per-tenant door catalog; its photos are served PUBLICLY from the
        //   `fixtures` bucket, now included below.
        await wipe("fixture_items");
        //   qbo_item_map points at QuickBooks item ids from the DELETED tenant's company. Only the
        //   style-scoped rows cascade (via qbo_item_map_style_id_fkey); the tenant-default rows
        //   (style_id IS NULL) survived, so a recreated slug that connects a DIFFERENT QuickBooks
        //   company would resolve its first invoice against stale ids and bill whatever items
        //   happen to share them — exactly the harm qbo-oauth-callback's realm-change wipe exists
        //   to prevent.
        await wipe("qbo_item_map");
        try { await wipe("app_errors"); } catch (_) { /* error logs are best-effort */ }

        // DELIBERATELY RETAINED, and reported rather than silently kept: the financial ledgers.
        // orders (payments cascades from it), invoice_sends and billing_charge_attempts are
        // records of money that actually moved. Destroying them is a data-retention decision with
        // accounting consequences, not a bug fix, so it is NOT made here — but leaving them
        // unmentioned is how this class of miss happened in the first place. The counts go back in
        // the response so the operator can see exactly what outlived the tenant and escalate if a
        // deletion request requires them gone too. wallet_transactions (every top-up, debit and
        // refund) and usage_charges (each metered call, text and 3D generation) joined the list on
        // 2026-10-05: they are the same kind of record, and were neither wiped nor reported.
        const retained: Record<string, number> = {};
        for (const t of ["orders", "payments", "invoice_sends", "billing_charge_attempts", "wallet_transactions", "usage_charges"]) {
          const { count } = await sb.from(t).select("client_id", { count: "exact", head: true }).eq("client_id", clientId);
          if (count) retained[t] = count;
        }
        // LEFT BEHIND, and NOT a decision: the tenant's CRM, phone, text, email and customer-login
        // rows, which name THEIR customers (names, phone numbers, message bodies, voicemails). All
        // keyed by client_id with no FK to anything wiped here, so none cascade, and on 2026-10-05
        // a deleted tenant's crm_contacts and customer_sessions were still in the database. Whether
        // they are wiped, kept or exported first is a retention call for Ahsan and Carolyn, not
        // part of the 10-05 change, so they are counted here exactly like `retained`: the dialog
        // says "all of its data", and what outlives it has to be visible rather than assumed.
        const leftBehind: Record<string, number> = {};
        for (
          const t of [
            "crm_contacts", "crm_notes", "crm_files", "crm_activities", "sms_messages", "phone_calls",
            "phone_voicemails", "phone_call_recordings", "email_sends", "email_inbound", "customer_sessions",
            "customer_email_otps", "design_acceptances",
          ]
        ) {
          const { count } = await sb.from(t).select("client_id", { count: "exact", head: true }).eq("client_id", clientId);
          if (count) leftBehind[t] = count;
        }

        // Capture the logins mapped to this client, unmap them, then delete any
        // that aren't also attached to another client.
        const cu = await sb.from("client_users").select("user_id").eq("client_id", clientId);
        if (cu.error) throw cu.error;
        const userIds = [...new Set((cu.data ?? []).map((r: any) => r.user_id).filter(Boolean))];
        await wipe("client_users");
        let deletedUsers = 0;
        for (const uid of userIds) {
          const still = await sb.from("client_users").select("user_id").eq("user_id", uid).maybeSingle();
          if (!still.error && !still.data) { const d = await sb.auth.admin.deleteUser(uid); if (!d.error) deletedUsers++; }
        }
        deleted["auth_logins"] = deletedUsers;

        // Storage: remove everything under <clientId>/ in every bucket that can hold their files.
        //
        // `fixtures` and `feedback-attachments` were missing. fixtures is PUBLIC, so a deleted
        // tenant's product/door photos stayed downloadable by anyone holding the old URL;
        // feedback-attachments holds their users' bug-report screenshots. Both are keyed
        // {client_id}/…, so the same loop covers them.
        //
        // Paginated: list() caps at 1000 per call, and the old single call meant a tenant with
        // more than 1000 objects silently left the overflow behind — junior-barns alone already has
        // 93 floor plans, and nothing warned that the sweep was partial.
        let files = 0;
        for (const bucket of ["floor-plans", "branding", "fixtures", "feedback-attachments"]) {
          try {
            // Always re-list from offset 0: each round DELETES what it listed, so the next page
            // shifts down into the same window. The bound is a round counter, not an offset —
            // if a remove() ever fails we must not re-list the same 1000 objects forever.
            for (let round = 0; round < 20; round++) {
              const { data: list, error: lsErr } = await sb.storage.from(bucket)
                .list(clientId, { limit: 1000 });
              if (lsErr) break;
              const batch = list ?? [];
              if (batch.length === 0) break;
              const paths = batch.map((o: any) => `${clientId}/${o.name}`);
              const rm = await sb.storage.from(bucket).remove(paths);
              if (rm.error) break;                    // stop rather than spin on the same page
              files += rm.data?.length ?? paths.length;
              if (batch.length < 1000) break;         // that was the last page
            }
          } catch (_) { /* storage cleanup is best-effort */ }
        }
        deleted["storage_files"] = files;

        const cc = await sb.from("client_configs").delete({ count: "exact" }).eq("client_id", clientId);
        if (cc.error) throw new Error(`client_configs: ${cc.error.message}`);
        deleted["client_configs"] = cc.count ?? 0;

        // `retained` is empty for a normal tenant and only appears when financial rows outlived
        // the delete — see the note above. Surfacing it is the point: the dialog says "and ALL of
        // its data", so anything that survives has to be visible rather than assumed.
        // `gateway` is counts only (see the gateway step): what was cancelled and removed at the
        // payment gateway, so the operator's confirmation can say so. `leftBehind` works like
        // `retained`: present only when the tenant had rows there.
        return json({
          ok: true, clientId, deleted,
          gateway: { ...gateway, ...(vaultShared ? { vaultKept: "in use by another builder" } : {}) },
          ...(Object.keys(retained).length ? { retained } : {}),
          ...(Object.keys(leftBehind).length ? { leftBehind } : {}),
        });
      }

      default:
        return json({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (e) {
    return json({ error: (e as Error).message || String(e) }, 400);
  }
}));
