// WHICH "GETTING SET UP" STEPS AN ACCOUNT OF EACH SHAPE SEES (migration 368).
//
// setup_template_items.account_type tags each template step 'all', 'sheds' or 'smartbuild', and
// the account's shape is client_settings.sheds_enabled (migration 364). portal-setup asks this per
// row, through template_item_id, at request time — the same way it asks migration 185's two gates —
// so a list copied before a step was tagged still filters itself, and switching an account's shape
// back brings its steps back. Kept here, apart from the handler, so the rule has a test.

export type SetupAudience = "all" | "sheds" | "smartbuild" | "phone";

/** Does a step tagged `audience` belong on the list of an account whose shed product is `shedsOn`?
 *  'all' — and anything unknown or missing, which the table's check constraint rules out — is
 *  every account's, as every step was before 368.
 *
 *  PHONE-ONLY (migration 384) is the exception to 'all': such an account sees ONLY its own 'phone'
 *  steps, because the shared ones include commissions, QuickBooks and a CSV import into a pipeline,
 *  none of which it has. And a 'phone' step is nobody else's. */
export function setupStepFits(audience: string | null | undefined, shedsOn: boolean, phoneOnly = false): boolean {
  if (phoneOnly) return audience === "phone";
  if (audience === "phone") return false;
  if (audience === "sheds") return shedsOn;
  if (audience === "smartbuild") return !shedsOn;
  return true;
}

/** The account's shape, read only as an explicit `false` and FAILING OPEN, migration 364's posture:
 *  a missing row or a failed read is a shed builder. Showing a SmartBuild builder a shed step by
 *  mistake is cosmetic; hiding a shed builder's whole catalog setup would strand them. */
// deno-lint-ignore no-explicit-any
export async function shedsOnOrOpen(admin: any, clientId: string): Promise<boolean> {
  try {
    const { data, error } = await admin.from("client_settings").select("sheds_enabled")
      .eq("client_id", clientId).maybeSingle();
    if (error) throw error;
    return data?.sheds_enabled !== false;
  } catch (e) {
    console.warn("setupShape: sheds_enabled read failed, treating the shed product as ON:", (e as Error)?.message);
    return true;
  }
}
