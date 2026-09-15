/**
 * Driving miles from a builder's origin(s) to a delivery address — the external call and
 * its cache (Carolyn, 2026-09-14: delivery priced by driving miles from an origin the
 * builder chooses). The money rules are in _shared/deliveryFee.ts; this file only answers
 * "how far".
 *
 * ── PROVIDER: Google Routes API, computeRouteMatrix ──────────────────────────────────
 * The legacy Distance Matrix API is closed to new Google Cloud projects, so this uses its
 * successor. One POST prices every origin against the one destination — a builder with a
 * shop and three sales lots costs one request, not four. Elements come back as a JSON array
 * keyed by originIndex/destinationIndex, and — because the wire format is proto3 JSON —
 * a ZERO-valued field is OMITTED, so `originIndex` is absent for the first origin and
 * `distanceMeters` is absent for a zero-length route. Both are read with a `?? 0`.
 *
 * ── DEGRADATION CONTRACT ─────────────────────────────────────────────────────────────
 * Same shape as _shared/salesTax.ts: one retry on 5xx/timeout/network, NO retry on 4xx (a
 * bad key or a malformed body does not improve on a second ask), and every failure becomes
 * `null` miles rather than an exception. Delivery is one line on a quote; a Google outage
 * must leave the builder pricing that line by hand, not stop the quote. drivingMiles never
 * throws.
 *
 * ── THE CACHE ────────────────────────────────────────────────────────────────────────
 * `delivery_distance_cache` (client_id, origin_key, dest_key, miles, provider, resolved_at;
 * PK on the three keys). Keys are addressKey() of each side, so two spellings of the same
 * address share a row. Rows older than 90 days are ignored — roads change, and a cached
 * figure that outlives a bypass is a quote nobody can explain. Only RESOLVED distances are
 * written: a null could be "no route" or "Google was down" and this function cannot tell
 * which, and caching an outage for 90 days is far worse than paying for the lookup again.
 *
 * ── ENV ──────────────────────────────────────────────────────────────────────────────
 * GOOGLE_MAPS_SERVER_KEY   — a server key restricted to the Routes API. Read at CALL time,
 *                            not module load, so a rotated secret takes effect on the next
 *                            request and tests can set it before importing.
 * GOOGLE_ROUTES_API_BASE   — override for tests; default https://routes.googleapis.com.
 */

import type { StopAddress } from "./contactAddress.ts";
import { addressKey, addressLine, milesFromMeters } from "./deliveryFee.ts";

const TIMEOUT_MS = 6_000;
const ATTEMPTS = 2;
const CACHE_TABLE = "delivery_distance_cache";
const CACHE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const PROVIDER = "google_routes";

const apiKey = (): string => Deno.env.get("GOOGLE_MAPS_SERVER_KEY") || "";
const apiBase = (): string =>
  (Deno.env.get("GOOGLE_ROUTES_API_BASE") || "https://routes.googleapis.com").replace(/\/+$/, "");

export function isConfigured(): boolean {
  return !!apiKey();
}

/**
 * Whole driving miles from each origin to `dest`, in origin order. Null for any origin with
 * no drivable route, and for every origin when the call fails or the key is not set.
 * `fetchImpl` exists so tests can hand in a stub without touching globalThis.fetch.
 */
export async function drivingMiles(
  origins: StopAddress[],
  dest: StopAddress,
  fetchImpl: typeof fetch = fetch,
): Promise<(number | null)[]> {
  if (origins.length === 0) return [];
  const none: (number | null)[] = origins.map(() => null);
  if (!isConfigured()) return none;

  const body = JSON.stringify({
    origins: origins.map((a) => ({ waypoint: { address: addressLine(a) } })),
    destinations: [{ waypoint: { address: addressLine(dest) } }],
    travelMode: "DRIVE",
    regionCode: "us",
  });

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetchImpl(`${apiBase()}/distanceMatrix/v2:computeRouteMatrix`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey(),
          // The field mask is REQUIRED by Routes — an unmasked request is a 400 — and it is
          // also what keeps the bill down: Google prices by fields returned.
          "X-Goog-FieldMask": "originIndex,destinationIndex,distanceMeters,condition,status",
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        // 4xx: bad key, bad field mask, bad body. Retrying changes none of them.
        if (res.status < 500) return none;
        continue;
      }
      const parsed = await res.json();
      if (!Array.isArray(parsed)) return none;
      const out = none.slice();
      for (const el of parsed) {
        if (!el || typeof el !== "object") continue;
        // deno-lint-ignore no-explicit-any
        const e = el as any;
        const oi = Number(e.originIndex ?? 0);
        const di = Number(e.destinationIndex ?? 0);
        if (di !== 0 || !Number.isInteger(oi) || oi < 0 || oi >= origins.length) continue;
        if (e.condition !== "ROUTE_EXISTS") continue;
        const meters = Number(e.distanceMeters ?? 0);
        if (!Number.isFinite(meters)) continue;
        out[oi] = milesFromMeters(meters);
      }
      return out;
    } catch {
      // Timeout or network. The next attempt is the retry; after the last one, give up.
    }
  }
  return none;
}

// ── The cache ───────────────────────────────────────────────────────────────────────────

/**
 * The slice of a supabase-js service client this module touches. Declared here so a test
 * can stub exactly these calls and nothing else; the real client satisfies it structurally.
 */
export interface CacheReadResult {
  data: { origin_key: string; miles: number | null; resolved_at: string | null }[] | null;
  error: unknown;
}
export interface CacheAdmin {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): {
        eq(column: string, value: string): {
          in(column: string, values: string[]): PromiseLike<CacheReadResult>;
        };
      };
    };
    upsert(rows: Record<string, unknown>[], opts: { onConflict: string }): PromiseLike<{ error: unknown }>;
  };
}

export interface NamedOrigin {
  name: string;
  address: StopAddress;
}

export interface ResolvedOrigin extends NamedOrigin {
  miles: number | null;
  /** True when the figure came from delivery_distance_cache rather than a fresh call. */
  cached: boolean;
}

/**
 * Miles from every origin to `dest`, served from the cache where a fresh row exists and
 * fetched — in ONE Google call — for the rest. Results come back in input order.
 *
 * `admin` is the service-role client; the cache table is service-role only because the
 * browser has no business writing another tenant's distances. Both the read and the upsert
 * are best-effort: a cache that is down costs a lookup, never a quote.
 */
export async function resolveDistances(
  // deno-lint-ignore no-explicit-any
  admin: any,
  clientId: string,
  origins: NamedOrigin[],
  dest: StopAddress,
  opts: { fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<ResolvedOrigin[]> {
  if (origins.length === 0) return [];
  const db = admin as CacheAdmin;
  const now = opts.now ?? new Date();
  const destKey = addressKey(dest);
  const keys = origins.map((o) => addressKey(o.address));
  const uniqueKeys = Array.from(new Set(keys));

  // Read every candidate row in one query; anything stale is simply not a hit.
  const fresh = new Map<string, number>();
  try {
    const { data, error } = await db.from(CACHE_TABLE)
      .select("origin_key, miles, resolved_at")
      .eq("client_id", clientId)
      .eq("dest_key", destKey)
      .in("origin_key", uniqueKeys);
    if (!error && Array.isArray(data)) {
      const cutoff = now.getTime() - CACHE_MAX_AGE_MS;
      for (const row of data) {
        if (row?.miles == null) continue;
        const at = row.resolved_at ? Date.parse(row.resolved_at) : NaN;
        if (!Number.isFinite(at) || at < cutoff) continue;
        fresh.set(row.origin_key, Number(row.miles));
      }
    }
  } catch {
    // A cache read that throws is a cache miss.
  }

  // One lookup for every distinct address not served from the cache.
  const missKeys = uniqueKeys.filter((k) => !fresh.has(k));
  const looked = new Map<string, number | null>();
  if (missKeys.length) {
    const missAddresses = missKeys.map((k) => origins[keys.indexOf(k)].address);
    const miles = await drivingMiles(missAddresses, dest, opts.fetchImpl ?? fetch);
    missKeys.forEach((k, i) => looked.set(k, miles[i] ?? null));

    const rows = missKeys
      .filter((k) => looked.get(k) != null)
      .map((k) => ({
        client_id: clientId,
        origin_key: k,
        dest_key: destKey,
        miles: looked.get(k),
        provider: PROVIDER,
        resolved_at: now.toISOString(),
      }));
    if (rows.length) {
      try {
        await db.from(CACHE_TABLE).upsert(rows, { onConflict: "client_id,origin_key,dest_key" });
      } catch {
        // Best-effort. The figure is already in hand; a failed write costs the next lookup.
      }
    }
  }

  return origins.map((o, i) => {
    const k = keys[i];
    if (fresh.has(k)) return { ...o, miles: fresh.get(k) as number, cached: true };
    return { ...o, miles: looked.get(k) ?? null, cached: false };
  });
}
