/**
 * The customer quote-portal link (my-quotes.html) for a tenant — and, since migration 229,
 * the builder's own order link in the portal.
 *
 * Where the SS-mode quote email's CTA points (migration 124): the customer signs in with a
 * texted code and can view, accept and SIGN the quote there. The GHL-mode email keeps
 * linking GHL's hosted estimate page instead — this helper is only ever called on the SS
 * path.
 *
 * HOST RULE: only `beta.` and `app.` structurestudiosuite.com exist in DNS (CLAUDE.md — the
 * bare apex has NO record, and per-tenant subdomains are a my-quotes RESOLVER feature, not
 * hostnames). So the link is built from the request's Origin when that origin is one of the
 * two real hosts — an estimate submitted from beta keeps its whole journey on beta — and
 * falls back to production for everything else (curl, n8n, a tenant's own embed page).
 * The tenant rides in `?client=`, which my-quotes.html's resolveTenant already reads.
 */

const KNOWN_HOSTS = new Set([
  "beta.structurestudiosuite.com",
  "app.structurestudiosuite.com",
]);
const CANONICAL_HOST = "app.structurestudiosuite.com";

/** The host rule above, shared by both links so they can never disagree about it. */
function hostFor(req?: Request | null): string {
  try {
    const origin = req?.headers?.get("origin") || "";
    if (origin) {
      const h = new URL(origin).hostname.toLowerCase();
      if (KNOWN_HOSTS.has(h)) return h;
    }
  } catch { /* a malformed Origin header falls back to canonical */ }
  return CANONICAL_HOST;
}

export function myQuotesUrl(clientId: string, req?: Request | null): string {
  return `https://${hostFor(req)}/my-quotes?client=${encodeURIComponent(clientId)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The builder's order page: /portal/orders/o-<orders.id> (the deep link portal/12-shell.jsx
 * reads — keyed on the UUID, not order_no).
 *
 * Used by the "Invoice to approve" email (migration 229), which customer-accept sends while
 * answering a CUSTOMER's request — so the Origin here is the customer's page, and a quote
 * accepted on beta sends the builder to the beta portal. Same database either way; the host
 * only decides which frontend opens.
 *
 * Anything that is not a UUID falls back to the Orders list rather than being spliced into a
 * path: a missing order row (its upsert is best-effort) still lands the builder one click away.
 */
export function portalOrderUrl(orderId: string | null | undefined, req?: Request | null): string {
  const base = `https://${hostFor(req)}/portal/orders`;
  const id = String(orderId ?? "").trim();
  return UUID_RE.test(id) ? `${base}/o-${id}` : base;
}
