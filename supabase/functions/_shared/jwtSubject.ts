// Does this bearer token even claim to be a person?
//
// Lifted verbatim from supabase/functions/submit-estimate/index.ts on 2026-09-14 so that
// delivery-quote and submit-estimate share ONE copy: both are reachable with the public anon
// key (the designer always sends it) and both want to skip an auth round trip that is certain
// to fail when the token carries no subject. submit-estimate's inline copy is left in place
// deliberately — this file was created in a change that touched no existing function; swap
// its import over in its own deploy.
//
// A Supabase user JWT carries `sub`; the public anon key is a well-formed JWT with none,
// which is why auth.getUser() rejects it. Deliberately STRUCTURAL rather than a compare
// against SUPABASE_ANON_KEY: that env value and the literal baked into the browser bundle
// ship through different pipelines, and the day they drift a compare would invert in
// silence (the reasoning _shared/resolveTenant.ts records for its own classifier).
//
// This never verifies the signature — it only reads the shape. Anything that acts on the
// identity must still go through auth.getUser().
export const hasSubject = (token: string): boolean => {
  try {
    const part = token.split(".")[1];
    if (!part) return false;
    const b = part.replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(b + "=".repeat((4 - (b.length % 4)) % 4))) as Record<string, unknown>;
    return typeof claims?.sub === "string" && (claims.sub as string).length > 0;
  } catch {
    return false;
  }
};
