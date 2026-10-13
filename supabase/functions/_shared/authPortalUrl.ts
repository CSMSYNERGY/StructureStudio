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
//
// STILL /portal ON 2026-10-13, ON PURPOSE. The app's addresses lost their /portal segment
// that day (Carolyn 2026-10-12, "let's remove portal from anywhere") and the bare app
// address is /login now, but this constant does not follow yet. An edge deploy goes live
// for PRODUCTION at once, and production serves the old _redirects until main is
// promoted: there /login is the 404 page and the token in the link is lost. /portal works
// on both hosts: the old one serves the app at it, the new one 301s it to /login, and the
// browser keeps the #access_token fragment across the redirect (a PKCE ?code= rides the
// 301's query). So every function that imports this can deploy any time.
// FLIP IT TO /login (with the Forgot-password redirectTo in portal/01-core.jsx) only once
// production serves the root-address _redirects AND
// https://app.structurestudiosuite.com/login is on the Supabase Auth redirect allow-list.
// (Listing /login early does no harm while nothing asks for it.) scripts/redirects.test.mjs
// holds this address to "works on the old host and the new one".
export const AUTH_PORTAL_URL = "https://app.structurestudiosuite.com/portal";
