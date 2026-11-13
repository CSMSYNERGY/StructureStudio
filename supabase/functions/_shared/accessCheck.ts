// _shared/accessCheck.ts — the tab check for a function that does NOT go through resolveTenant's
// gate table (plans as data, stage D).
//
// resolveTenant refuses an action whose tab the company has not got, but only for a function that
// hands it a gate table and its own name. Some code decides for a company without that: a function
// with its own sign-in (portal-commissions), a clock with no caller at all (crm-rules-tick). They
// ask here instead, with the tabs spelled out by the caller, and get the same three answers in the
// same fail directions as accessEnforce.ts:
//
//   not named, or the read failed   "ok". Exactly what the function did before. Never a refusal.
//   report                          "ok", and what WOULD have been refused is filed as an info row
//                                   (code module_would_refuse), once per isolate per company,
//                                   function and action, AWAITED: the runtime may drop work a
//                                   response does not wait for, and a report that never lands reads
//                                   as "nothing would be refused".
//   block                           "refuse" when NONE of the tabs is exactly "on". "locked" is a
//                                   padlock in the rail, an offer to buy, not access.
//
// The caller turns "refuse" into its own answer: a 403 { error: MODULE_REFUSAL, code: "module_off" }
// where a person asked, a skipped row where a clock did. An empty tab list means "part of every
// account" and never reads the map at all.
//
// ⚠️ A PLAN ONLY STOPS NEW WORK. Do not put this in front of a call or payment in flight, an inbound
// call or text, 911, posting a charge for a cost already incurred, sign-out, a typed-in lead, a
// customer accepting, signing or paying, the undo of something already done, or a legal opt-out
// page. Those are not a plan's to refuse.
//
// Imports logError.ts, which loads supabase-js: so NOT for jack-agent's own files (their tests load
// no registry module). Jack asks accessEnforce.ts directly and files through his own logger.
// Importers: portal-commissions, crm-rules-tick. Bundled per function: deploy both when this changes.

import { anyModuleOn, firstReport, MODULE_REFUSAL, serverAccess } from "./accessEnforce.ts";
import { logEdgeError } from "./logError.ts";

export { MODULE_REFUSAL };

// deno-lint-ignore no-explicit-any
type Admin = any;

/** May this company do `action` of function `fn`, which belongs to `tabs` (any one of them on is
 *  enough)? "refuse" only for a company the server BLOCKS by its map. Never throws: anything that
 *  goes wrong is "ok", the rules the function already had. */
export async function moduleVerdict(
  admin: Admin,
  clientId: string,
  fn: string,
  action: string,
  tabs: readonly string[],
  req?: Request | null,
): Promise<"ok" | "refuse"> {
  try {
    if (!Array.isArray(tabs) || tabs.length === 0) return "ok";
    const acc = await serverAccess(admin, clientId);
    if (!acc || anyModuleOn(acc.modules, tabs)) return "ok";
    if (acc.mode === "block") return "refuse";
    if (firstReport(clientId, fn, action)) {
      await logEdgeError({
        fn, severity: "info", code: "module_would_refuse", clientId, req: req ?? null,
        message: `Report only: ${action} would be refused (needs ${tabs.join(" or ")}).`,
        context: { action, tabs: [...tabs], states: Object.fromEntries(tabs.map((t) => [t, acc.modules[t] ?? null])) },
      });
    }
    return "ok";
  } catch (e) {
    console.error("moduleVerdict threw; this company keeps the old rules:", (e as Error)?.message ?? e);
    return "ok";
  }
}
