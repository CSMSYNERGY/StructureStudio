// What billing-webhook KEEPS of a gateway event: a whitelist REBUILD of the parsed body, never
// the body itself. The cpSummary posture (_shared/cardpointe.ts), not a blacklist.
//
// WHY THIS EXISTS. billing_webhook_events is the webhook's idempotency log, and until 2026-10 it
// stored every Deposyt/NMI event body verbatim. NMI's event_body carries the payer: a `card` block
// (the number masked to its first six and last four digits, the expiry, the BIN, the card type and
// the address/security-code RESULT codes) and a `billing_address` block (first and last name,
// email, phone, street address). Every one of the 40 rows stored 2026-07-28 → 2026-10-05 held both,
// and about half belonged to OTHER products' customers: the gateway account is shared
// (billingOrderId.ts), so their events arrive here too, and were kept after being acked as foreign.
// Never a full card number and never a security code, so not a PCI breach — but the published
// privacy policy says we keep the gateway's reference plus the card brand and last four, and these
// copies kept more than that, for people who are not even our customers. Raised 2026-07-31.
//
// Nothing reads the stored copy back. Processing reads the parsed body IN MEMORY (subscription id,
// order id, status, dates, the tenant fields), and the row exists for idempotency (id + status)
// and for whoever triages a failed event. So the copy keeps what a triage needs to see what the
// webhook acted on, and nothing that identifies a payer.
//
// ⚠️ WHITELIST, SO A NEW GATEWAY FIELD IS DROPPED BY DEFAULT. NMI's body is not ours and has
// grown fields we never asked for; a blacklist would store the next one silently. To keep a new
// field, add it to BODY_KEYS, and check migration 281's pg_temp.m281_carries patterns do not name
// it (billingWebhookRedact.test.ts runs those patterns over this module's output).
//
// ⚠️ VALUES ARE SCALARS ONLY. A whitelisted key that arrives holding an object or an array (a
// `status` that is suddenly `{...}`) is dropped, so a nested block cannot ride in under a kept
// name. `plan` is the one object kept, and it is rebuilt from PLAN_KEYS the same way.
//
// ⚠️ THE TENANT FIELDS KEEP ONLY A TENANT-SHAPED VALUE. merchant_defined_field_1, field 1 of
// merchant_defined_fields and metadata.clientId carry OUR client id on our own subscriptions — a
// DNS-safe slug, because it doubles as a subdomain. Another product on the shared gateway may put
// anything there (an email is the obvious guess), so a value that is not slug-shaped is dropped.
//
// NEVER THROWS. It runs on the delivery path, ahead of the idempotency insert, and a throw there
// would 500 a real gateway event. On any failure the copy is a stub that still carries the event id
// and type — {id, type, redacted: "failed"} — which is all idempotency and triage need to find it.
//
// ⚠️ DUPLICATION LEDGER: bundled per function, and `billing-webhook` is its only importer
// (`grep -rl billingWebhookRedact.ts supabase/functions/*/index.ts`). No Deno.env at load, so
// `deno test` runs it with no permissions.

type Obj = Record<string, unknown>;

/** Top level: the event's own id and type, in both the NMI (event_*) and older spellings. */
const TOP_KEYS = ["id", "event_id", "type", "event_type"] as const;

/** Inside event_body / data.subscription / subscription: what the webhook reads, and what a
 *  triage reads to tell one subscription event from another. Scalars only. */
const BODY_KEYS = [
  "subscription_id", "id", "order_id", "orderid", "status",
  "next_charge_date", "current_period_end", "subscription_type", "processor_id",
  "attempted_payments", "completed_payments", "remaining_payments",
  "order_description", "ponumber",
] as const;

/** The plan the gateway billed — the live shape (2026-10-05) has exactly these. */
const PLAN_KEYS = ["id", "name", "amount", "payments", "day_of_month", "month_frequency", "day_frequency"] as const;

// Our client id: a lower-case DNS label (portal-billing mints `ss_<clientId>_…` from it, and
// billing-webhook's order-id fallback relies on there being no underscore in it).
const TENANT_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const isScalar = (v: unknown) =>
  v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
const tenantOf = (v: unknown): string | undefined =>
  typeof v === "string" && TENANT_RE.test(v) ? v : undefined;

function pick(src: Obj, keys: readonly string[]): Obj {
  const out: Obj = {};
  for (const k of keys) {
    if (Object.hasOwn(src, k) && isScalar(src[k])) out[k] = src[k];
  }
  return out;
}

/** One subscription container (event_body, data.subscription or subscription), rebuilt. */
function rebuildBody(b: Obj): Obj {
  const out = pick(b, BODY_KEYS);

  if (isObj(b.plan)) out.plan = pick(b.plan, PLAN_KEYS);
  else if (typeof b.plan === "string") out.plan = b.plan;

  const mdf1 = tenantOf(b.merchant_defined_field_1);
  if (mdf1) out.merchant_defined_field_1 = mdf1;

  // Field 1 only, in whichever shape it arrived (array of {id|field, value}, or an object keyed
  // "1"), stored as {"1": <tenant>}. Every other field is another product's to fill.
  const mdf = b.merchant_defined_fields;
  const one = Array.isArray(mdf)
    ? tenantOf(mdf.find((f) => isObj(f) && String(f.id ?? f.field ?? "") === "1")?.value)
    : isObj(mdf) ? tenantOf(mdf["1"] ?? mdf.merchant_defined_field_1) : undefined;
  if (one) out.merchant_defined_fields = { "1": one };

  const clientId = isObj(b.metadata) ? tenantOf(b.metadata.clientId) : undefined;
  if (clientId) out.metadata = { clientId };

  return out;
}

/**
 * The copy of a gateway event that billing_webhook_events stores. Mirrors the input's shape
 * (event_body, data.subscription, subscription) so a reader finds fields where the gateway put
 * them; drops card, billing_address, shipping, merchant and anything not named above.
 */
export function redactWebhookPayload(p: unknown): Obj {
  try {
    if (!isObj(p)) return {};
    const out = pick(p, TOP_KEYS);
    if (isObj(p.event_body)) out.event_body = rebuildBody(p.event_body);
    if (isObj(p.data) && isObj(p.data.subscription)) out.data = { subscription: rebuildBody(p.data.subscription) };
    if (isObj(p.subscription)) out.subscription = rebuildBody(p.subscription);
    return out;
  } catch {
    try {
      const o = p as Obj;
      return { id: String(o?.id ?? o?.event_id ?? ""), type: String(o?.type ?? o?.event_type ?? ""), redacted: "failed" };
    } catch {
      return { redacted: "failed" };
    }
  }
}
