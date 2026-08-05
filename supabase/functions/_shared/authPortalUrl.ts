// ── Where every auth email lands ────────────────────────────────────────────
// ONE canonical destination for invite / set-password / reset links, regardless of
// which host generated them. Callers used to pass `location.origin + "/portal"`, so a
// link created from beta.structurestudio.app carried redirect_to=beta — and Supabase
// only honours allow-listed redirects, silently substituting Site URL for anything
// else. Verified 2026-07-28 against this project: beta got back the *identical*
// response as a deliberately hostile control URL. Every invite Carolyn created from
// beta therefore bounced to the apex, which is how these links broke.
//
// Forcing the apex is correct rather than a workaround: beta and production share ONE
// Supabase project, so a password set here is immediately valid on beta too. A
// caller-supplied portalUrl is IGNORED on purpose — one allow-listed destination
// cannot drift out of the allow-list, and no future caller can reintroduce this bug.
//
// It lives in _shared for the same reason it is a constant at all: the guarantee is
// "there is exactly one destination". Two functions each holding their own copy IS the
// drift this is meant to prevent, so any new function that sends an auth email must
// import this rather than re-declare it.
// Rebrand 2026-08-05: canonical host moved to app.structurestudiosuite.com
// (structurestudio.app is being sunset behind a redirect). Until the Supabase
// allow-list contains this URL, Supabase substitutes Site URL — i.e. the old
// behavior — so deploying this ahead of the allow-list change is safe.
export const AUTH_PORTAL_URL = "https://app.structurestudiosuite.com/portal";
