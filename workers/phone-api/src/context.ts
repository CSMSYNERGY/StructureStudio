// Who is calling an app endpoint: the verified login, and their phone context from ONE
// uncached RPC (phone_caller_context). Every app endpoint goes through here, so a person removed
// from the team, or set to phone access `none`, is refused on their very next request rather
// than when their login token runs out.

import type { Env } from "./env";
import { adminClient, callerContext, type Admin, type CallerContext } from "./db";
import { ApiError } from "./http";
import { bearerToken, verifySupabaseJwt, type AuthClaims } from "./jwt";
import { PHONE_TAB, emergencyWindowOpen, planFor, planNamedSoon, planRefuses, type ServerAccess } from "./plan";

export interface Caller {
  admin: Admin;
  claims: AuthClaims;
  token: string;
  userId: string;
  ctx: CallerContext;
  /**
   * The company's plan answer (plan.ts), read once here so a route that checks another tab (texting,
   * the contact list) asks nothing more. Null: the old rules. Absent on a needOn: false or
   * plan: false route, which never reads it; planVerdict treats absent as null.
   */
  plan?: ServerAccess | null;
}

export interface RequireOpts {
  /** ?access_token= is accepted (voicemail audio only, for extension builds from before 2026-09-29 that play it through <audio src>). */
  allowQueryToken?: boolean;
  /** Refuse unless the tenant's phone switch is on. Default true. */
  needOn?: boolean;
  /**
   * false: this route works a call ALREADY UP (hold, resume, both transfers, moving it to the
   * other device, the relay servers it runs through), so the company's plan is never asked. A plan
   * only stops new work: taking the `phone` tab away while a customer is on hold must not leave
   * them there with a Resume button that answers phone_off. The switch (needOn) is still checked,
   * as it always was. None of these routes can start a call: /token and /voice/outbound do that,
   * and they ask. Default true.
   */
  plan?: boolean;
}

export async function requireCaller(env: Env, req: Request, opts: RequireOpts = {}): Promise<Caller> {
  const token = bearerToken(req, opts.allowQueryToken === true);
  if (!token) throw new ApiError("unauthorized");
  const claims = await verifySupabaseJwt(env, token);
  const admin = adminClient(env);
  const needOn = opts.needOn !== false;
  const askPlan = needOn && opts.plan !== false;
  // Plans as data (plan.ts): "is anybody on a plan map" starts here, beside the context read, so
  // it costs this request no round trip of its own. Not for needOn: false or plan: false, which
  // ask nothing.
  const named = askPlan ? planNamedSoon(admin) : undefined;
  const ctx = await callerContext(admin, claims.sub);
  if (!ctx || ctx.phone_level === "none") {
    throw new ApiError("no_phone_access");
  }
  if (opts.needOn !== false && ctx.phone_status !== "on") throw new ApiError("phone_off");
  if (!askPlan) return { admin, claims, token, userId: claims.sub, ctx };
  // ── THE PLAN'S PHONE TAB (plan.ts) ─────────────────────────────────────────────────
  // After the switch has said yes, and only on a route that needs the switch: a company whose plan
  // map is enforced (block mode) and whose `phone` tab is not on is told what a company with the
  // switch off is told, phone_off, the one refusal both installed apps already show as "not
  // switched on for your business". Report mode refuses nothing and files one row. No plan answer
  // (nobody named, which is everyone today, or a read that failed) changes nothing at all.
  // A needOn: false route never gets here: a person's own settings, their history, registering a
  // device and signing out keep working whatever the plan says. Nor does a plan: false route: the
  // controls of a call in flight.
  // ⚠️ AND NEVER INSIDE THIS PERSON'S 911 CALLBACK WINDOW (plan.ts emergencyWindowOpen): for 60
  // minutes after they dialed 911 the dispatcher's callback rings their app, and phone_off here
  // would send that app to its "not switched on" screen. Asked only once the plan is about to
  // refuse, so no other request pays the read; a read that fails or is slow does not refuse.
  // Inside the window every default route answers this one person as it did before plans, not
  // only the routes a callback needs (recording a greeting still rings their own app, for one).
  // The route still gets the plan answer, so the `sms` and `contacts` tabs decide what they
  // always decide, and a new call that is not 911 is still refused at /voice/outbound.
  const plan = await planFor(admin, ctx.client_id, { named });
  if (await planRefuses(plan, ctx.client_id, "app_route", PHONE_TAB) && !(await emergencyWindowOpen(admin, ctx.client_id, claims.sub))) {
    throw new ApiError("phone_off");
  }
  return { admin, claims, token, userId: claims.sub, ctx, plan };
}

/** Signed in, nothing more (for /log, /devices/signout-all). The context may be null. */
export async function requireLogin(env: Env, req: Request): Promise<{ admin: Admin; claims: AuthClaims; token: string; userId: string; ctx: CallerContext | null }> {
  const token = bearerToken(req);
  if (!token) throw new ApiError("unauthorized");
  const claims = await verifySupabaseJwt(env, token);
  const admin = adminClient(env);
  const ctx = await callerContext(admin, claims.sub);
  return { admin, claims, token, userId: claims.sub, ctx };
}
