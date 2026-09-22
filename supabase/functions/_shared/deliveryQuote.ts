/**
 * The ONE authority on a delivery fee (Carolyn, 2026-09-14): given a tenant, a delivery
 * address and the rep submitting, decide where the truck leaves from, how far it drives and
 * what the builder's rules say that costs. Both surfaces that show a delivery figure call
 * this and nothing else, so the preview a rep sees is the number the estimate carries.
 *
 * ⚠️ DUPLICATION LEDGER: this module is bundled per function, so a change here — or in
 * deliveryFee.ts / deliveryDistance.ts beneath it — means redeploying EVERY importer in the
 * same push, or two copies of the pricing rule disagree in a way nobody can see:
 *     delivery-quote     — the portal/designer preview endpoint
 *     submit-estimate    — stamps the fee on the estimate
 *     portal-settings    — validates the rule card via normalizeRules on save
 * Grep before you deploy (the path is spelled without a star-slash on purpose — that
 * sequence would end this comment):
 *     grep -rl --include=index.ts 'deliveryQuote.ts\|deliveryFee.ts' supabase/functions
 *
 * ── ORIGIN MODES ─────────────────────────────────────────────────────────────────────
 *   business — always from the business address (client_settings.business_address).
 *   rep      — from the submitting rep's home lot (client_users.location_id →
 *              builder_locations). A rep with no home lot, an inactive lot, or no rep at
 *              all (the public designer) FALLS THROUGH to `nearest` rather than refusing:
 *              the customer still gets a price, from wherever is closest.
 *   nearest  — the business address plus every active builder_locations row; the closest
 *              by driving miles wins, the business address first on a tie.
 *
 * ── TABLES READ (all service-role) ───────────────────────────────────────────────────
 *   delivery_settings   one row per client: origin_mode, automate, rule_type, flat_fee,
 *                       base_fee, per_mile, free_miles, per_mile_counts, bands (jsonb).
 *   client_settings     business_address {addressLine1, city, state, postalCode},
 *                       business_name, ss_tax_delivery.
 *   client_users        location_id (the rep's home lot) — NOTE: as of 2026-09-14 this
 *                       column is not yet in any committed migration. The read is guarded:
 *                       an error or a null falls through to `nearest`, so shipping this
 *                       before that migration lands degrades to nearest, never to a 500.
 *   builder_locations   name, street, city, state, zip, active.
 *
 * ── WHY `automate` IS REPORTED, NOT ENFORCED, HERE ───────────────────────────────────
 * The preview endpoint wants to show a builder what the rule WOULD charge while they are
 * still deciding whether to switch it on. So the distance is resolved and the fee computed
 * regardless, and the CALLER decides whether to stamp it (submit-estimate applies it only
 * when `automate` is true). The cache keeps the preview cheap.
 *
 * ── A FLAT RULE NEVER CALLS GOOGLE ───────────────────────────────────────────────────
 * Distance is irrelevant to a flat fee, and a lookup per quote is a metered call. The
 * origin candidates are not even built for it.
 */

import type { StopAddress } from "./contactAddress.ts";
import { feeFor, nearestOrigin, normalizeRules, type RuleType } from "./deliveryFee.ts";
import { isConfigured, type NamedOrigin, resolveDistances } from "./deliveryDistance.ts";

export type OriginMode = "business" | "rep" | "nearest";

export interface DeliveryQuote {
  /** A delivery_settings row exists for this tenant. */
  configured: boolean;
  /** The builder has switched automatic pricing on. Reported, not enforced — see header. */
  automate: boolean;
  originMode: OriginMode | null;
  ruleType: RuleType | null;
  /** Whole driving miles from the chosen origin; null for a flat rule or an unresolved trip. */
  miles: number | null;
  originName: string | null;
  amount: number | null;
  /** True exactly when `amount` is a number. */
  autoPriced: boolean;
  /**
   * Why there is no amount: a feeFor reason ("beyond_last_band" | "no_distance" |
   * "rule_incomplete") or one of this module's own — "not_configured" (no settings row),
   * "no_origin" (no usable origin address), "distance_not_configured" (no Google key),
   * "no_route" (Google answered, no origin reached the address). Null when priced.
   */
  reason: string | null;
  desc: string;
  /** client_settings.ss_tax_delivery — whether the caller should tax the delivery line. */
  taxable: boolean;
  distanceConfigured: boolean;
}

const ORIGIN_MODES: readonly OriginMode[] = ["business", "rep", "nearest"];

/** An origin needs a city, a state and a zip to be worth sending to Google; street is optional. */
const usable = (a: StopAddress): boolean => !!(a.city && a.state && a.zip);

// deno-lint-ignore no-explicit-any
const s = (v: any): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

// deno-lint-ignore no-explicit-any
function businessOrigin(cs: any): NamedOrigin | null {
  const a = cs?.business_address;
  if (!a || typeof a !== "object") return null;
  const address: StopAddress = {
    street: s(a.addressLine1),
    city: s(a.city),
    state: s(a.state),
    zip: s(a.postalCode),
  };
  if (!usable(address)) return null;
  return { name: s(cs?.business_name) ?? "our shop", address };
}

// deno-lint-ignore no-explicit-any
function lotOrigin(row: any): NamedOrigin | null {
  if (!row || row.active === false) return null;
  const address: StopAddress = { street: s(row.street), city: s(row.city), state: s(row.state), zip: s(row.zip) };
  if (!usable(address)) return null;
  return { name: s(row.name) ?? "our lot", address };
}

export async function quoteDelivery(
  // deno-lint-ignore no-explicit-any
  admin: any,
  opts: { clientId: string; address: StopAddress; repUserId: string | null; fetchImpl?: typeof fetch },
): Promise<DeliveryQuote> {
  const { clientId, address, repUserId } = opts;
  const distanceConfigured = isConfigured();

  const [{ data: settings }, { data: cs }] = await Promise.all([
    admin.from("delivery_settings").select("*").eq("client_id", clientId).maybeSingle(),
    admin.from("client_settings").select("business_address, ss_tax_delivery, business_name").eq("client_id", clientId).maybeSingle(),
  ]);
  const taxable = !!cs?.ss_tax_delivery;

  const quote = (over: Partial<DeliveryQuote>): DeliveryQuote => ({
    configured: true,
    automate: !!settings?.automate,
    originMode: null,
    ruleType: null,
    miles: null,
    originName: null,
    amount: null,
    autoPriced: false,
    reason: null,
    desc: "Delivery",
    taxable,
    distanceConfigured,
    ...over,
  });

  if (!settings) return quote({ configured: false, automate: false, reason: "not_configured" });

  const modeRaw = String(settings.origin_mode ?? "").trim() as OriginMode;
  const originMode: OriginMode = ORIGIN_MODES.includes(modeRaw) ? modeRaw : "business";

  const normalized = normalizeRules(settings);
  if (normalized.rules === null) {
    return quote({ originMode, ruleType: null, reason: "rule_incomplete" });
  }
  const rules = normalized.rules;
  const base = { originMode, ruleType: rules.ruleType };

  // Flat: no origin, no Google, no cache. Just the number.
  if (rules.ruleType === "flat") {
    const fee = feeFor(rules, null, null);
    return quote({ ...base, amount: fee.amount, autoPriced: fee.autoPriced, reason: fee.reason, desc: fee.desc });
  }

  // ── Origin candidates ──────────────────────────────────────────────────────────────
  let candidates: NamedOrigin[] = [];
  const business = businessOrigin(cs);

  if (originMode === "business") {
    candidates = business ? [business] : [];
  } else {
    let repLot: NamedOrigin | null = null;
    if (originMode === "rep" && repUserId) {
      try {
        const { data: cu } = await admin.from("client_users").select("location_id")
          .eq("client_id", clientId).eq("user_id", repUserId).maybeSingle();
        if (cu?.location_id) {
          const { data: lot } = await admin.from("builder_locations")
            .select("name, street, city, state, zip, active")
            .eq("client_id", clientId).eq("id", cu.location_id).maybeSingle();
          repLot = lotOrigin(lot);
        }
      } catch {
        // No home-lot column yet, or a read failure: fall through to nearest.
      }
    }
    if (repLot) {
      candidates = [repLot];
    } else {
      // `nearest`, and `rep` without a usable home lot. Business first so it wins a tie.
      const { data: lots } = await admin.from("builder_locations")
        .select("name, street, city, state, zip, active")
        .eq("client_id", clientId).eq("active", true);
      candidates = [
        ...(business ? [business] : []),
        ...((Array.isArray(lots) ? lots : []).map(lotOrigin).filter((o: NamedOrigin | null): o is NamedOrigin => !!o)),
      ];
    }
  }

  if (candidates.length === 0) return quote({ ...base, reason: "no_origin" });

  // THE CACHE IS CONSULTED EVEN WITH NO KEY, and that ordering is load-bearing (fixed
  // 2026-09-15, found in beta testing). resolveDistances reads delivery_distance_cache first
  // and only calls Google for a miss, and drivingMiles already returns nulls when the key is
  // unset — so bailing out ahead of it threw away answers we already had. The failure that
  // mattered was not the test: a key that is rotated, revoked or briefly misconfigured would
  // stop pricing trips already computed, and a customer could be shown a delivery fee in the
  // designer and then get an estimate with no delivery line at all. Whether a trip is
  // priceable is a question about the trip, not about today's key.
  const resolved = await resolveDistances(admin, clientId, candidates, address, { fetchImpl: opts.fetchImpl });
  const nearest = nearestOrigin(resolved);
  // Nothing resolved: say WHY. No key is a configuration problem the builder can fix (and the
  // portal card says so); a key that answered with no route is a fact about this address.
  if (!nearest) return quote({ ...base, reason: distanceConfigured ? "no_route" : "distance_not_configured" });

  const fee = feeFor(rules, nearest.miles, nearest.name);
  return quote({
    ...base,
    miles: nearest.miles,
    originName: nearest.name,
    amount: fee.amount,
    autoPriced: fee.autoPriced,
    reason: fee.reason,
    desc: fee.desc,
  });
}
