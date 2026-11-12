// Admin → Plans and a company's access (migration 386, "plans as data"; Ahsan 2026-11-12).
//
// The operator actions that write and read the five tables of migration 386. This is the whole of
// "make a new plan": a plan row, its tab rows, and an assignment. No code change and no deploy, which
// is what lets a new plan take minutes. Stage A ships these with no screen; the Admin screens of
// stage E call the same actions.
//
//   access_plan_list             every plan with its tabs, how many companies hold it, and the catalogue
//   access_plan_save             create a plan, or change its name, blurb, visibility, order
//   access_plan_set_modules      which tabs a plan includes, teases or hides (a patch; `replace` for the whole list)
//   access_plan_duplicate        copy a plan and its tabs under a new key (always a private plan)
//   access_plan_retire           retire a plan, or bring a retired one back
//   access_client_get            one company: every tab's state and why, its plans and its exceptions
//   access_client_plan_assign    put a company on a plan (a comp, or paid outside the card system)
//   access_client_plan_remove    take it off one
//   access_client_module_set     force one tab on or off for one company, or clear that
//
// WHO MAY CALL, in order:
//   * admin-catalog's checkAdminAuth: an operator JWT or the break-glass password. A support
//     operator and a builder are refused there.
//   * admin-catalog's rights gate: the two reads are on READ_ONLY_ACTIONS; every write needs
//     can_write AND can_bill, because a plan decides what a company gets without paying for it, the
//     same class of change as set_feature_grants and set_account_type.
//
// EVERY WRITE IS AUDITED (admin_audit) with what changed, before and after, on top of the row
// admin-catalog writes for every operator call. A failed audit never fails the write: the write is
// the operator's intent and the response says what happened.
//
// WHAT IS DELIBERATELY ABSENT
//   * No delete of a plan. A plan a company holds must keep meaning something; retire it instead.
//   * No write to billing_plans or billing_subscriptions. A PAID plan is a subscription and stays
//     one; this module only reads which plans are sold, to say so.
//   * Nothing here decides what a company may DO. public.access_resolve does, and until the later
//     stages nothing reads it. These actions only write the rows it reads.
//
// The repo is public: no client identifiers in here.

import { ACCESS_KEY_RE, isAccessModule, PHONE_ONLY_PLAN, PLAN_MODULE_STATES } from "../_shared/accessModules.ts";

// deno-lint-ignore no-explicit-any
type Db = any;
type Identity = { via: string; userId?: string; email?: string };
type Json = (b: unknown, s?: number) => Response;
type Row = Record<string, unknown>;

export const ACCESS_PLAN_READS: readonly string[] = ["access_plan_list", "access_client_get"];
export const ACCESS_PLAN_WRITES: readonly string[] = [
  "access_plan_save", "access_plan_set_modules", "access_plan_duplicate", "access_plan_retire",
  "access_client_plan_assign", "access_client_plan_remove", "access_client_module_set",
];
export const ACCESS_PLAN_ACTIONS: readonly string[] = [...ACCESS_PLAN_READS, ...ACCESS_PLAN_WRITES];

/** PostgREST's db-max-rows on this project: a read returns at most this many rows whatever its limit
 *  says, with no error. Every read here that could pass it pages with range(). */
export const MAX_ROWS = 1000;

const CLIENT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PLAN_COLS = "key, name, blurb, status, visibility, free_period, replaces, sort, created_at, updated_at";
const VISIBILITIES = ["public", "private"];
const REASONS = ["comp", "paid_offline"];
const NAME_MAX = 80;
const BLURB_MAX = 400;
const NOTE_MAX = 500;
const AUDIT_NOTE_MAX = 1800;

class Refuse extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** A plan key or throw. Named in the sentence, because the caller is often a person typing one. */
function planKey(v: unknown, what = "plan"): string {
  const k = str(v);
  if (!ACCESS_KEY_RE.test(k)) {
    throw new Refuse(`The ${what} key must be 2 to 40 characters: lower-case letters, numbers and underscores, starting with a letter.`);
  }
  return k;
}

function clientId(v: unknown): string {
  const c = str(v);
  if (!CLIENT_ID.test(c)) throw new Refuse("That company id isn't valid.");
  return c;
}

/** An end date: absent or null = none; otherwise an ISO date in the future. */
function expiry(v: unknown, now: Date): string | null {
  if (v === undefined || v === null || v === "") return null;
  const ms = typeof v === "string" ? Date.parse(v) : NaN;
  if (!Number.isFinite(ms)) throw new Refuse("The end date isn't a date.");
  if (ms <= now.getTime()) throw new Refuse("The end date is in the past. Leave it empty for no end date, or remove the row instead.");
  return new Date(ms).toISOString();
}

function note(v: unknown): string | null {
  const n = str(v);
  if (n.length > NOTE_MAX) throw new Refuse(`Keep the note under ${NOTE_MAX} characters.`);
  return n || null;
}

/** Read every row of a small table in pages (the 1000-row cap), in a stable order. */
async function readAll(sb: Db, table: string, cols: string, order: string[]): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += MAX_ROWS) {
    let q = sb.from(table).select(cols);
    for (const o of order) q = q.order(o, { ascending: true });
    const { data, error } = await q.range(from, from + MAX_ROWS - 1);
    if (error) throw error;
    const rows = (data ?? []) as Row[];
    out.push(...rows);
    if (rows.length < MAX_ROWS) return out;
  }
}

async function audit(sb: Db, identity: Identity, action: string, target: string | null, detail: unknown) {
  try {
    let text = JSON.stringify(detail);
    if (text.length > AUDIT_NOTE_MAX) text = text.slice(0, AUDIT_NOTE_MAX) + "…";
    await sb.from("admin_audit").insert({
      action,
      target_client_id: target,
      actor_email: identity.email ?? null,
      actor_user_id: identity.userId && UUID.test(identity.userId) ? identity.userId : null,
      note: text,
    });
  } catch (_e) { /* best-effort: the write already happened and the response says so */ }
}

async function getPlan(sb: Db, key: string): Promise<Row | null> {
  const { data, error } = await sb.from("access_plans").select(PLAN_COLS).eq("key", key).maybeSingle();
  if (error) throw error;
  return (data as Row) ?? null;
}

async function planModules(sb: Db, key: string): Promise<Record<string, string>> {
  const { data, error } = await sb.from("access_plan_modules").select("module, state").eq("plan_key", key).order("module", { ascending: true });
  if (error) throw error;
  const out: Record<string, string> = {};
  for (const r of (data ?? []) as Row[]) out[String(r.module)] = String(r.state);
  return out;
}

/** How many companies a change to this plan reaches: operator assignments that have not ended, and
 *  card subscriptions to it that are not cancelled. A count for the operator, not an entitlement:
 *  the resolver alone decides who holds what. */
async function holders(sb: Db, key: string, now: Date): Promise<{ assigned: number; subscribed: number }> {
  const assignedRows = (await readAllWhere(sb, "client_access_plans", "client_id, expires_at", "plan_key", key, ["client_id"]))
    .filter((r) => !r.expires_at || Date.parse(String(r.expires_at)) > now.getTime());
  const { data: prices, error: pErr } = await sb.from("billing_plans").select("id").eq("feature", key);
  if (pErr) throw pErr;
  const ids = ((prices ?? []) as Row[]).map((p) => String(p.id));
  let subscribed = 0;
  if (ids.length) {
    const { data: subs, error: sErr } = await sb.from("billing_subscriptions").select("client_id, status").in("plan_id", ids).range(0, MAX_ROWS - 1);
    if (sErr) throw sErr;
    subscribed = new Set(((subs ?? []) as Row[]).filter((s) => s.status !== "cancelled").map((s) => String(s.client_id))).size;
  }
  return { assigned: assignedRows.length, subscribed };
}

async function readAllWhere(sb: Db, table: string, cols: string, col: string, val: string, order: string[]): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += MAX_ROWS) {
    let q = sb.from(table).select(cols).eq(col, val);
    for (const o of order) q = q.order(o, { ascending: true });
    const { data, error } = await q.range(from, from + MAX_ROWS - 1);
    if (error) throw error;
    const rows = (data ?? []) as Row[];
    out.push(...rows);
    if (rows.length < MAX_ROWS) return out;
  }
}

async function companyExists(sb: Db, id: string): Promise<boolean> {
  const { data, error } = await sb.from("client_configs").select("client_id").eq("client_id", id).maybeSingle();
  if (error) throw error;
  return !!data;
}

/** One company's answer from the resolver, plus the rows behind it. */
async function clientAccess(sb: Db, id: string): Promise<Row> {
  const [{ data: detail, error: dErr }, { data: usable, error: uErr }, assigned, exceptions] = await Promise.all([
    sb.rpc("access_resolve_detail", { p_client_id: id }),
    sb.rpc("access_usable_plans", { p_client_id: id }),
    readAllWhere(sb, "client_access_plans", "plan_key, reason, expires_at, note, set_at", "client_id", id, ["plan_key"]),
    readAllWhere(sb, "client_modules", "module, mode, expires_at, note, set_at", "client_id", id, ["module"]),
  ]);
  if (dErr) throw dErr;
  if (uErr) throw uErr;
  const subscribed = [...new Set(((usable ?? []) as unknown[]).map((u) => String(u)))].sort();
  return { clientId: id, tabs: detail ?? [], subscribed, assigned, exceptions };
}

export async function handleAccessPlansAction(
  sb: Db, action: string, p: Record<string, unknown>, identity: Identity, json: Json,
  deps: { now: () => Date } = { now: () => new Date() },
): Promise<Response> {
  const now = deps.now();
  try {
    switch (action) {
      // ── reads ──────────────────────────────────────────────────────────────────────────────
      case "access_plan_list": {
        const [modules, plans, planMods, assigned, prices] = await Promise.all([
          readAll(sb, "access_modules", "key, label, grp, shed, sort", ["sort", "key"]),
          readAll(sb, "access_plans", PLAN_COLS, ["sort", "key"]),
          readAll(sb, "access_plan_modules", "plan_key, module, state", ["plan_key", "module"]),
          readAll(sb, "client_access_plans", "client_id, plan_key, expires_at", ["client_id", "plan_key"]),
          readAll(sb, "billing_plans", "id, feature, availability, active", ["id"]),
        ]);
        const mods = new Map<string, Record<string, string>>();
        for (const r of planMods) {
          const k = String(r.plan_key);
          if (!mods.has(k)) mods.set(k, {});
          mods.get(k)![String(r.module)] = String(r.state);
        }
        const assignedN = new Map<string, number>();
        for (const r of assigned) {
          if (r.expires_at && Date.parse(String(r.expires_at)) <= now.getTime()) continue;
          assignedN.set(String(r.plan_key), (assignedN.get(String(r.plan_key)) ?? 0) + 1);
        }
        // Sold = it has a price point customers can be on. `forSale` = one they can buy today.
        const sold = new Set(prices.filter((x) => x.feature).map((x) => String(x.feature)));
        const forSale = new Set(prices.filter((x) => x.feature && x.active && x.availability === "available").map((x) => String(x.feature)));
        return json({
          modules,
          plans: plans.map((pl) => ({
            ...pl,
            modules: mods.get(String(pl.key)) ?? {},
            assigned: assignedN.get(String(pl.key)) ?? 0,
            sold: sold.has(String(pl.key)),
            forSale: forSale.has(String(pl.key)),
          })),
        });
      }

      case "access_client_get": {
        const id = clientId(p.clientId);
        if (!(await companyExists(sb, id))) throw new Refuse("No company with that id.", 404);
        return json(await clientAccess(sb, id));
      }

      // ── plans ──────────────────────────────────────────────────────────────────────────────
      case "access_plan_save": {
        const key = planKey(p.key);
        const before = await getPlan(sb, key);
        const patch: Row = {};
        if (p.name !== undefined || !before) {
          const name = str(p.name);
          if (!name) throw new Refuse("Give the plan a name.");
          if (name.length > NAME_MAX) throw new Refuse(`Keep the name under ${NAME_MAX} characters.`);
          patch.name = name;
        }
        if (p.blurb !== undefined) {
          const blurb = str(p.blurb);
          if (blurb.length > BLURB_MAX) throw new Refuse(`Keep the description under ${BLURB_MAX} characters.`);
          patch.blurb = blurb || null;
        }
        if (p.visibility !== undefined) {
          if (!VISIBILITIES.includes(String(p.visibility))) throw new Refuse("Visibility is public or private.");
          patch.visibility = String(p.visibility);
        }
        if (p.freePeriod !== undefined) {
          if (typeof p.freePeriod !== "boolean") throw new Refuse("freePeriod is true or false.");
          patch.free_period = p.freePeriod;
        }
        if (p.sort !== undefined) {
          const n = Number(p.sort);
          if (!Number.isInteger(n) || n < 0 || n > 100000) throw new Refuse("The order is a whole number from 0 to 100000.");
          patch.sort = n;
        }
        if (p.replaces !== undefined) {
          if (!Array.isArray(p.replaces)) throw new Refuse("replaces is a list of plan keys.");
          const keys = [...new Set(p.replaces.map((k) => planKey(k, "replaced plan")))];
          if (keys.includes(key)) throw new Refuse("A plan cannot replace itself.");
          for (const k of keys) if (!(await getPlan(sb, k))) throw new Refuse(`There is no plan "${k}" to replace.`);
          patch.replaces = keys;
        }
        if (p.status !== undefined) {
          // Only a NEW plan may be saved as a draft, and a draft may be made active here. Retiring
          // is access_plan_retire. A plan in use is never made a draft: a draft confers nothing, so
          // every company holding it would lose its tabs with no row saying why.
          const s = String(p.status);
          if (s === "draft") {
            if (before && before.status !== "draft") throw new Refuse("A plan already in use can't go back to draft. Retire it instead.");
            if (key === PHONE_ONLY_PLAN) throw new Refuse("That plan is what a phone-only account is read as holding. It can't be a draft.");
            patch.status = "draft";
          } else if (s === "active") {
            if (before && before.status === "retired") throw new Refuse("Bring a retired plan back with access_plan_retire.");
            patch.status = "active";
          } else {
            throw new Refuse("Status here is draft or active. Use access_plan_retire to retire a plan.");
          }
        }
        if (before) {
          if (Object.keys(patch).length === 0) throw new Refuse("Nothing to change.");
          patch.updated_at = now.toISOString();
          const { error } = await sb.from("access_plans").update(patch).eq("key", key);
          if (error) throw error;
        } else {
          // A new plan is private unless it says otherwise: a custom plan is the common case, and
          // public means "part of what Non-billable confers", which should be a decision.
          const row = { key, visibility: "private", status: "active", created_by: identity.userId && UUID.test(identity.userId) ? identity.userId : null, ...patch };
          const { error } = await sb.from("access_plans").insert(row);
          if (error) throw error;
        }
        const after = await getPlan(sb, key);
        await audit(sb, identity, "access_plan_save", null, { plan: key, created: !before, before, after });
        return json({ ok: true, created: !before, plan: { ...after, modules: await planModules(sb, key) } });
      }

      case "access_plan_set_modules": {
        const key = planKey(p.key);
        const plan = await getPlan(sb, key);
        if (!plan) throw new Refuse("No plan with that key.", 404);
        if (!p.modules || typeof p.modules !== "object" || Array.isArray(p.modules)) {
          throw new Refuse("modules is an object: { tab: \"included\" | \"teaser\" | \"hidden\" }.");
        }
        const wanted = p.modules as Record<string, unknown>;
        const upserts: Row[] = [];
        const removes: string[] = [];
        for (const [m, s] of Object.entries(wanted)) {
          if (!isAccessModule(m)) throw new Refuse(`"${m}" isn't a tab in the catalogue.`);
          if (s === null || s === "hidden") removes.push(m);
          else if (typeof s === "string" && PLAN_MODULE_STATES.includes(s)) upserts.push({ plan_key: key, module: m, state: s });
          else throw new Refuse(`"${m}" must be included, teaser or hidden.`);
        }
        const before = await planModules(sb, key);
        // `replace: true` makes `modules` the plan's WHOLE list: every tab it does not name is removed.
        // Without it this is a patch, so a caller that sends one tab cannot empty a plan by accident.
        if (p.replace === true) {
          for (const m of Object.keys(before)) if (!(m in wanted)) removes.push(m);
        }
        if (key === PHONE_ONLY_PLAN) {
          const left = new Set([...Object.keys(before).filter((m) => before[m] === "included"), ...upserts.filter((u) => u.state === "included").map((u) => String(u.module))]);
          for (const m of removes) left.delete(m);
          for (const u of upserts) if (u.state !== "included") left.delete(String(u.module));
          if (left.size === 0) throw new Refuse("That would leave every phone-only account with nothing. Keep at least one included tab on this plan.");
        }
        // Upsert first, remove second: a failure between the two leaves the plan with MORE tabs than
        // asked, never an empty plan.
        if (upserts.length) {
          const { error } = await sb.from("access_plan_modules").upsert(upserts, { onConflict: "plan_key,module" });
          if (error) throw error;
        }
        for (const m of removes) {
          const { error } = await sb.from("access_plan_modules").delete().eq("plan_key", key).eq("module", m);
          if (error) throw error;
        }
        const { error: tErr } = await sb.from("access_plans").update({ updated_at: now.toISOString() }).eq("key", key);
        if (tErr) throw tErr;
        const after = await planModules(sb, key);
        const reach = await holders(sb, key, now);
        await audit(sb, identity, "access_plan_set_modules", null, { plan: key, replace: p.replace === true, before, after, reach });
        return json({ ok: true, plan: key, modules: after, reach });
      }

      case "access_plan_duplicate": {
        const from = planKey(p.from, "source plan");
        const key = planKey(p.key, "new plan");
        const name = str(p.name);
        if (!name) throw new Refuse("Give the new plan a name.");
        if (name.length > NAME_MAX) throw new Refuse(`Keep the name under ${NAME_MAX} characters.`);
        const src = await getPlan(sb, from);
        if (!src) throw new Refuse("No plan with that key to copy.", 404);
        if (await getPlan(sb, key)) throw new Refuse(`A plan "${key}" already exists.`, 409);
        // Always private, active, and never free-period or replacing anything: a copy is a custom
        // plan until someone decides otherwise.
        const { error: iErr } = await sb.from("access_plans").insert({
          key, name, blurb: src.blurb ?? null, status: "active", visibility: "private", free_period: false, replaces: [],
          sort: src.sort ?? 0, created_by: identity.userId && UUID.test(identity.userId) ? identity.userId : null,
        });
        if (iErr) throw iErr;
        const srcMods = await planModules(sb, from);
        const rows = Object.entries(srcMods).map(([module, state]) => ({ plan_key: key, module, state }));
        if (rows.length) {
          const { error: mErr } = await sb.from("access_plan_modules").insert(rows);
          if (mErr) {
            // A plan with no tabs is worse than no plan: take the half-made copy back out.
            try { await sb.from("access_plans").delete().eq("key", key); } catch (_e) { /* reported below either way */ }
            throw mErr;
          }
        }
        await audit(sb, identity, "access_plan_duplicate", null, { from, plan: key, name, modules: srcMods });
        return json({ ok: true, plan: { ...(await getPlan(sb, key)), modules: await planModules(sb, key) } });
      }

      case "access_plan_retire": {
        const key = planKey(p.key);
        const plan = await getPlan(sb, key);
        if (!plan) throw new Refuse("No plan with that key.", 404);
        if (typeof p.retired !== "boolean") throw new Refuse("retired is true or false.");
        if (plan.status === "draft") throw new Refuse("A draft isn't in use yet. Make it active with access_plan_save, or leave it.");
        const status = p.retired ? "retired" : "active";
        if (plan.status !== status) {
          const { error } = await sb.from("access_plans").update({ status, updated_at: now.toISOString() }).eq("key", key);
          if (error) throw error;
        }
        const reach = await holders(sb, key, now);
        await audit(sb, identity, "access_plan_retire", null, { plan: key, before: plan.status, after: status, reach });
        // A retired plan still means what it meant to whoever holds it; it just can't be newly assigned.
        return json({ ok: true, plan: key, status, reach });
      }

      // ── one company ────────────────────────────────────────────────────────────────────────
      case "access_client_plan_assign": {
        const id = clientId(p.clientId);
        const key = planKey(p.planKey);
        if (!(await companyExists(sb, id))) throw new Refuse("No company with that id.", 404);
        const plan = await getPlan(sb, key);
        if (!plan) throw new Refuse("No plan with that key.", 404);
        if (plan.status !== "active") throw new Refuse(`That plan is ${plan.status}. Only an active plan can be assigned.`);
        const reason = p.reason === undefined ? "comp" : String(p.reason);
        if (!REASONS.includes(reason)) throw new Refuse("The reason is comp or paid_offline.");
        const row = {
          client_id: id, plan_key: key, reason, expires_at: expiry(p.expiresAt, now), note: note(p.note),
          set_by: identity.userId && UUID.test(identity.userId) ? identity.userId : null, set_at: now.toISOString(),
        };
        const { error } = await sb.from("client_access_plans").upsert(row, { onConflict: "client_id,plan_key" });
        if (error) throw error;
        await audit(sb, identity, "access_client_plan_assign", id, { plan: key, reason, expires_at: row.expires_at, note: row.note });
        return json({ ok: true, ...(await clientAccess(sb, id)) });
      }

      case "access_client_plan_remove": {
        const id = clientId(p.clientId);
        const key = planKey(p.planKey);
        const { data: had, error: hErr } = await sb.from("client_access_plans").select("plan_key, reason, expires_at, note")
          .eq("client_id", id).eq("plan_key", key).maybeSingle();
        if (hErr) throw hErr;
        if (!had) throw new Refuse("That company isn't on that plan by assignment. A plan it pays for by card is cancelled in Billing, not here.", 404);
        const { error } = await sb.from("client_access_plans").delete().eq("client_id", id).eq("plan_key", key);
        if (error) throw error;
        await audit(sb, identity, "access_client_plan_remove", id, { plan: key, removed: had });
        return json({ ok: true, ...(await clientAccess(sb, id)) });
      }

      case "access_client_module_set": {
        const id = clientId(p.clientId);
        const m = str(p.module);
        if (!isAccessModule(m)) throw new Refuse(`"${m}" isn't a tab in the catalogue.`);
        if (!(await companyExists(sb, id))) throw new Refuse("No company with that id.", 404);
        const { data: had, error: hErr } = await sb.from("client_modules").select("module, mode, expires_at, note")
          .eq("client_id", id).eq("module", m).maybeSingle();
        if (hErr) throw hErr;
        // mode null (or "plan") clears the exception: the tab goes back to whatever the plans say.
        if (p.mode === null || p.mode === "plan") {
          if (had) {
            const { error } = await sb.from("client_modules").delete().eq("client_id", id).eq("module", m);
            if (error) throw error;
          }
          await audit(sb, identity, "access_client_module_set", id, { module: m, before: had ?? null, after: null });
          return json({ ok: true, ...(await clientAccess(sb, id)) });
        }
        if (p.mode !== "on" && p.mode !== "off") throw new Refuse("mode is on, off, or plan (to clear it).");
        const row = {
          client_id: id, module: m, mode: p.mode, expires_at: expiry(p.expiresAt, now), note: note(p.note),
          set_by: identity.userId && UUID.test(identity.userId) ? identity.userId : null, set_at: now.toISOString(),
        };
        const { error } = await sb.from("client_modules").upsert(row, { onConflict: "client_id,module" });
        if (error) throw error;
        await audit(sb, identity, "access_client_module_set", id, { module: m, before: had ?? null, after: { mode: row.mode, expires_at: row.expires_at, note: row.note } });
        return json({ ok: true, ...(await clientAccess(sb, id)) });
      }
    }
    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    if (e instanceof Refuse) return json({ error: e.message }, e.status);
    throw e;   // a database fault: admin-catalog's own catch answers it, like every other action's
  }
}
