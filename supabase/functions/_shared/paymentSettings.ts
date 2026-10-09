// _shared/paymentSettings.ts — which merchant account a builder takes cards on, read off their own
// client_settings row: the switch (payments_online_enabled), the MID (cardpointe_merchid) and, since
// migration 296, the environment (cardpointe_env: 'uat' = Fiserv's test system, 'prod' = live).
//
// Its own module, with NO imports, so the two functions that only REPORT the account carry no
// gateway client: portal-settings (payments_status, the builder's read-only card) and admin-catalog
// (get_payments / set_payments). Putting this in cardpointe.ts would make every gateway change a
// portal-settings deploy too.
//
// ⚠️ THE MID COMES FROM THE TENANT'S OWN ROW AND NOWHERE ELSE. Until workstream 1 phase 3 a blank MID
//    fell back to the deployment-wide CARDPOINTE_MERCHID, so a builder switched on without one took
//    their customers' cards into the platform's own account. That default is gone: no MID, no
//    merchant, and every caller refuses.
//
//    Importers: _shared/cardpointe.ts (types only), _shared/invoicePayment.ts, customer-pay/index.ts,
//    portal-payments/index.ts, admin-catalog/index.ts, portal-settings/index.ts

/** Fiserv's two systems. 'uat' is the test system (no real money moves); 'prod' is live. */
export type CpEnv = "uat" | "prod";

/** A merchant account on one of the two systems. Every gateway call takes one. */
export type CpMerchant = { merchid: string; env: CpEnv };

/**
 * The environment a stored value names.
 *
 *   null / undefined   'uat'   a client_settings row read from a database without migration 296, or a
 *                              payment_attempts row written before it. Every charge before 296 went to
 *                              the existing CARDPOINTE_* secrets, which are the UAT set.
 *   'uat' / 'prod'     as named
 *   anything else      null    unrecognised: the caller REFUSES. The column's CHECK makes this
 *                              unreachable from the database, and guessing a system for money is the
 *                              one thing this must never do.
 */
export function cpEnvOf(raw: unknown): CpEnv | null {
  if (raw === null || raw === undefined) return "uat";
  return raw === "uat" || raw === "prod" ? raw : null;
}

/** The merchant a settings row names, or null when it names none: no MID, or an environment
 *  cpEnvOf does not recognise. Never a default. */
export function cpMerchant(row: unknown): CpMerchant | null {
  const r = (row && typeof row === "object" ? row : {}) as Record<string, unknown>;
  const merchid = typeof r.cardpointe_merchid === "string" ? r.cardpointe_merchid.trim() : "";
  if (!merchid) return null;
  const env = cpEnvOf(r.cardpointe_env);
  return env ? { merchid, env } : null;
}

/** What a builder may be told about their account: never the MID, only its last four. */
export function midLast4(merchid: unknown): string | null {
  const s = typeof merchid === "string" ? merchid.trim() : "";
  return s.length >= 4 ? s.slice(-4) : null;
}

const MISSING_COLUMN = new Set(["42703", "PGRST204"]);
/** A column the database does not have: Postgres's 42703, or PostgREST's PGRST204. */
export function isMissingColumn(err: unknown): boolean {
  return MISSING_COLUMN.has(String((err as { code?: unknown } | null)?.code ?? ""));
}

// deno-lint-ignore no-explicit-any
type Admin = any;

export type PaymentSettingsRead = {
  /** The row (null when the tenant has none), always carrying `cardpointe_env` (null = uat). */
  row: Record<string, unknown> | null;
  // deno-lint-ignore no-explicit-any
  error: any;
  /** False when the database has no cardpointe_env column yet (migration 296 not applied). */
  envColumn: boolean;
};

/**
 * The tenant's payment settings, read so that a function deployed AHEAD of migration 296 still works.
 *
 * Asks for `payments_online_enabled, cardpointe_merchid, cardpointe_env` plus `extra`. If the database
 * answers that cardpointe_env does not exist (42703 / PGRST204), it asks again without it and the row
 * reads `cardpointe_env: null`, which is UAT: exactly what every charge was before 296. Any OTHER error
 * is returned as it is, never retried into a guess.
 */
export async function readPaymentSettings(
  admin: Admin,
  clientId: string,
  extra: string[] = [],
): Promise<PaymentSettingsRead> {
  const cols = ["payments_online_enabled", "cardpointe_merchid", ...extra];
  const first = await admin.from("client_settings")
    .select([...cols, "cardpointe_env"].join(", ")).eq("client_id", clientId).maybeSingle();
  if (!first?.error) return { row: first?.data ?? null, error: null, envColumn: true };
  if (!isMissingColumn(first.error)) return { row: null, error: first.error, envColumn: true };
  const second = await admin.from("client_settings")
    .select(cols.join(", ")).eq("client_id", clientId).maybeSingle();
  if (second?.error) return { row: null, error: second.error, envColumn: false };
  return { row: second?.data ? { ...second.data, cardpointe_env: null } : null, error: null, envColumn: false };
}
