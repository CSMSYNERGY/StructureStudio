// ── Server-Timing ───────────────────────────────────────────────────────────────────────
// Where one call's time went, written on the response itself so it can be read from the
// portal's own tab (DevTools → Network → Timing, or response.headers) without filing a row
// anywhere: `auth` is resolveTenant (the sign-in check plus the company lookup), `db` is every
// query made through `admin` summed — the company lookup included, and parallel queries
// counted in full, so it can exceed wall time — and `total` is the whole handler. Durations
// and the region only; nothing about the caller or the data.
//
// Added 2026-10-01 to find out what is left of "every call costs ~2.2 s" once the function
// runs next to the database (the portal pins it to us-east-1 since the same day).
//
// Moved here from portal-settings/index.ts on 2026-10-05, unchanged, when sync-design-status
// needed the same header to answer "one Pipeline sync took 6.1 s: was it the CRM or the
// database?". A function with spans of its own beyond auth and db (sync-design-status's
// estimate and opportunity reads, and its writes) adds them with addPhase(); they are written
// between `db` and `total`, in the order they were added. A function that adds none gets
// exactly the header portal-settings has sent since 10-01, byte for byte
// (serverTiming.test.ts pins that string).
//
// Importers (deploy every one of them when this file changes): portal-settings,
// sync-design-status.

/** One extra named span (sync-design-status's `est`, `opp`, `writes`). */
export type ServerTimingPhase = { name: string; dur: number; desc?: string };

export type ServerTiming = {
  auth: number;
  authPath?: string;
  db: number;
  dbN: number;
  /** Extra spans, written between `db` and `total` in the order they were added. */
  phases?: ServerTimingPhase[];
};

export const timedFetch = (st: ServerTiming): typeof fetch => async (input, init) => {
  const t0 = performance.now();
  try {
    return await fetch(input, init);
  } finally {
    st.db += performance.now() - t0;
    st.dbN++;
  }
};

/** Record one extra span. `desc` is a short label we write ourselves ("3 pages", "skipped"):
 *  counts and modes only, never anything about the caller or the data. */
export function addPhase(st: ServerTiming, name: string, dur: number, desc?: string): void {
  (st.phases ??= []).push({ name, dur, desc });
}

/** The header value. Pure, so the test can pin the exact string a function with no extra spans
 *  sends (the shape portal-settings has always sent). */
export function serverTimingValue(st: ServerTiming, totalMs: number, region: string): string {
  const ms = (n: number) => Math.round(n);
  // A metric name is an HTTP token and a desc is a quoted string. Every caller passes literals,
  // but a stray quote would end the header's quoted string early and corrupt every span after it,
  // so both are cleaned rather than trusted.
  const extra = (st.phases ?? []).map((p) => {
    const name = p.name.replace(/[^A-Za-z0-9_-]/g, "") || "phase";
    const desc = p.desc === undefined ? "" : `;desc="${String(p.desc).replace(/["\\\r\n]/g, "")}"`;
    return `, ${name}${desc};dur=${ms(p.dur)}`;
  }).join("");
  return `auth;desc="${st.authPath ?? "none"}";dur=${ms(st.auth)}, db;desc="${st.dbN} queries";dur=${ms(st.db)}` +
    extra + `, total;dur=${ms(totalMs)}, region;desc="${region}"`;
}

export function withServerTiming(
  handler: (req: Request, st: ServerTiming) => Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const t0 = performance.now();
    const st: ServerTiming = { auth: 0, db: 0, dbN: 0 };
    const res = await handler(req, st);
    // Only real calls are timed; a preflight carries nothing to time. (Written as a POST test,
    // not an OPTIONS equality test, since its portal-settings days: aiDraftRetryWiring_test
    // finds that handler's first line by the first OPTIONS test in its file.)
    if (req.method !== "POST") return res;
    try {
      const region = Deno.env.get("SB_REGION") ?? "unknown";
      res.headers.set("Server-Timing", serverTimingValue(st, performance.now() - t0, region));
      // Cross-origin JS sees only safelisted headers; the refusal marker may already be named.
      const exposed = res.headers.get("Access-Control-Expose-Headers");
      res.headers.set("Access-Control-Expose-Headers", exposed ? `${exposed}, Server-Timing` : "Server-Timing");
      res.headers.set("Timing-Allow-Origin", "*");
    } catch {
      // Immutable headers (a Response.redirect): the response matters, the timing does not.
    }
    // The SAME object, never a copy: withErrorLog's alreadyFiled check is by identity.
    return res;
  };
}
