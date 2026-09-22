/**
 * designPromotion.ts: the one place a design becomes 'sent' (migration 241, 2026-09-15).
 *
 * WHY THIS EXISTS. Until 241 the anonymous save_design RPC promoted a design to 'sent' the
 * moment the browser saved it, before submit-estimate had decided anything. submit-estimate
 * has a long list of refusals after that save (a CRM location with no user to assign, no
 * starting quote number, no tax rate, the rate cap, an unpriced size), so a REFUSED Get Quote
 * left a design nobody ever received marked 'sent': listed on the customer's quotes page as a
 * quote with no number and nothing to accept, and held to its phone and email by 240's lock so
 * the customer could not even fix the typo that caused it. Observed on testtttttt
 * SS-TRJNVZJW5Z, 2026-09-15.
 *
 * After 241 a save is only a save, and submit-estimate promotes at the moment the paperwork is
 * real: the CRM estimate exists (CRM mode), or the quote number, lines and document exist and
 * the customer email is next (Structure Studio paperwork). A refusal, a throw, a timeout or a
 * closed tab all leave the design a draft, which is the truth.
 *
 * Three rules, each load-bearing:
 *   1. GUARDED ON status = 'draft' IN THE UPDATE ITSELF. A resubmit of an issued quote, an
 *      accepted design and a change order all arrive past draft and must not move. The status
 *      the caller read earlier only skips a pointless write; the WHERE is what makes it true.
 *   2. NEVER BLANKS A COLUMN. A null or empty field is left out of the write, so a CRM answer
 *      missing its id cannot erase one. The caller's later persist still runs unchanged; this
 *      only moves the proof of issue to before the email.
 *   3. NEVER THROWS. The estimate or quote already exists, so failing the submit now would
 *      strand it. The caller logs the returned error as a FAULT: a draft holding real paperwork
 *      is hidden from customer-quotes and skipped by sync-design-status, so nothing else would
 *      ever surface it.
 *
 * Dependency-free on purpose (see designPromotion.test.ts).
 */

// Same posture as taxMeter.ts: the caller's service-role client, typed structurally.
// deno-lint-ignore no-explicit-any
type Db = any;

export type PromoteResult = {
  /** false when the design was already past draft, so no write was sent. */
  attempted: boolean;
  /** The database's message when the write failed or threw; null otherwise. */
  error: string | null;
};

/** Drop null, undefined and blank-string values, so a missing id never overwrites a stored one. */
export function issueFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    out[key] = value;
  }
  return out;
}

/**
 * Mark an issued design 'sent', only if it is still a draft. `fields` ride in the same write
 * (the proof of issue: an estimate id and number, or a quote number and its lines).
 */
export async function promoteIssuedDesign(
  db: Db,
  opts: {
    clientId: string;
    designId: string;
    /** The status submit-estimate read at the start of this request. */
    currentStatus: unknown;
    fields?: Record<string, unknown>;
  },
): Promise<PromoteResult> {
  if (String(opts.currentStatus ?? "") !== "draft") return { attempted: false, error: null };
  try {
    const { error } = await db.from("designs")
      // status last, so no field can ride in a different one.
      .update({ ...issueFields(opts.fields ?? {}), updated_at: new Date().toISOString(), status: "sent" })
      .eq("short_code", opts.designId)
      .eq("client_id", opts.clientId)
      .eq("status", "draft");
    return { attempted: true, error: error ? String(error.message ?? error) : null };
  } catch (e) {
    return { attempted: true, error: String((e as Error)?.message ?? e) };
  }
}
