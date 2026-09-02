const { useState, useEffect, useMemo, useCallback, useRef } = React;
const { createClient } = window.supabase;

// ─── StructureStudio Business Portal ───
// Standalone owner-facing page (login + dashboard). Unlike index.html /
// StructureStudio.jsx — which are hand-mirrored siblings — this file has no
// .jsx twin: it is only ever served by Netlify, never embedded by hosts.
//
// Auth: Supabase email/password. Each owner account maps to one client via the
// client_users table; RLS confines every query to that tenant's rows. Secrets
// (the GHL API key) never reach this page — settings reads/writes go through
// the portal-settings edge function, which masks on read and is write-only for
// the key.

const SUPABASE_URL = "https://jzeamjbhdrsbygdnphbm.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp6ZWFtamJoZHJzYnlnZG5waGJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczNDIwNDMsImV4cCI6MjA5MjkxODA0M30.YawJS7aiyTbQdwVnzndyKwD2ejNGYhdBSiectURvxwY";
// Session-expiry guard: if any authenticated call (PostgREST or an edge
// function) comes back 401, the login session is dead — most often a
// refresh-token race between multiple open windows revoking it. The custom
// fetch spots those 401s and hands off to PortalApp (ssOnSessionExpired), which
// signs out cleanly and shows a friendly message on the login screen instead of
// raw "non-2xx" errors in every tab. Auth endpoints (/auth/v1/) are
// deliberately NOT intercepted — a wrong password legitimately 4xxes and must
// reach the login form's own error handling.
let ssOnSessionExpired = null; // installed by PortalApp on mount
// Requests that carry this header opt OUT of the session-expiry intercept, because a 401 from
// them means something else entirely. The operator step-up password is the case: since the Admin
// console became native (c59da3c), a wrong password makes admin-catalog answer 401 (adminGate) with
// the operator's JWT perfectly valid — indistinguishable here from a dead session. The intercept
// then signed them out of the whole portal mid-dialog with "Your session expired", discarding every
// keep-mounted form and any in-progress design, and destroying the in-dialog "2 more attempts locks
// this IP for 6 hours" warning — so the natural response was to sign back in and blind-retry into
// the shared 6-hour admin lockout that also disables the /admin break-glass console. The dialog's
// own "Incorrect admin password" handling never got to render.
const SS_NO_EXPIRY_HEADER = "x-ss-stepup";
const ssHasStepUpHeader = (url, opts) => {
  const read = (h) => {
    if (!h) return false;
    if (typeof h.get === "function") return Boolean(h.get(SS_NO_EXPIRY_HEADER));
    return Object.keys(h).some((k) => k.toLowerCase() === SS_NO_EXPIRY_HEADER);
  };
  // supabase-js may hand us either (Request) or (url, init), so check both.
  return read(opts && opts.headers) || read(url && url.headers);
};
const ssFetch = (url, opts) => fetch(url, opts).then((res) => {
  try {
    const u = String(url && url.url ? url.url : url);
    if (res.status === 401 && (u.indexOf("/rest/v1/") !== -1 || u.indexOf("/functions/v1/") !== -1)
        && !ssHasStepUpHeader(url, opts) && ssOnSessionExpired) ssOnSessionExpired();
  } catch (_e) { /* the guard must never break the request itself */ }
  return res;
});
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { fetch: ssFetch } });

// ── Central error logging → Supabase app_errors (via the log_error RPC). Best-effort:
// never throws, never blocks the UI. Auto-captures uncaught errors + unhandled promise
// rejections, and anything reported explicitly via window.ssLogError(source,msg,code,ctx). ──
// Same permissive shape as portal-settings' and submit-estimate's copies. Kept identical
// on purpose — this one only decides what the UI lets you SAVE, so if it were looser than
// the server's the owner would get a rejected save with no explanation, and if it were
// stricter they could not save a value the server would happily accept.
const ssIsEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || "").trim());

const SS_ERR_SOURCE = "portal";
// The tenant every row is filed under. This read `window.__SS_CLIENT_ID__`, which nothing in
// the repo has ever assigned, and the portal's own URLs carry `?view=`, never `?client=` — so
// every row this page wrote landed with client_id NULL. The ones with a server-side twin
// survive that (logEdgeError files those under the tenant the function resolved); the
// browser-only ones do not, and they are exactly the ones that need it: the 4xx refusals the
// invoke wrapper logs, session_reconnecting, window.onerror. Support could not scope
// app_errors to the builder who was on the phone. Latched further down from the tenant
// portal-settings reports it resolved — the one tenant id this page is handed as fact rather
// than as a request — EXCEPT during operator view-as, where the tenant on screen is the
// armed view-as target and no status call is made to echo anything (see the latch in the
// invoke wrapper and the stamp in 12-shell.jsx). Declared above ssLogError because the boot
// guard below calls it during module evaluation, and a TDZ throw there would swallow the
// row entirely. (Same reason ssLogError does NOT read ssTargetClientId directly: that one is
// declared below the boot-guard call, so a read here would TDZ-throw and lose the row.)
let ssResolvedClientId = null;
// `severity` is optional and defaults to "error", so every existing call site keeps its
// current meaning. Pass "info" for a REFUSAL — the product correctly declining something
// ("send the invoice first", "that width isn't valid"). Those still get a row, because a
// refusal that fires constantly is a bug in disguise (see migration 140), but they no
// longer sit in the same bucket as things that actually broke.
function ssLogError(source, message, code, context, severity) {
  try {
    const params = new URLSearchParams(location.search);
    fetch(SUPABASE_URL + "/rest/v1/rpc/log_error", {
      method: "POST", keepalive: true,
      headers: { "Content-Type": "application/json", "apikey": SUPABASE_ANON_KEY, "Authorization": "Bearer " + SUPABASE_ANON_KEY },
      body: JSON.stringify({
        p_source: String(source || SS_ERR_SOURCE).slice(0, 100),
        p_message: String(message == null ? "" : (message.message || message)).slice(0, 4000),
        p_code: code == null ? null : String(code).slice(0, 100),
        p_client_id: ssResolvedClientId || params.get("client") || null,
        p_url: location.href.slice(0, 600),
        p_context: context || null,
        p_severity: severity || "error",
      }),
    }).catch(() => {});
  } catch (_) { /* logging must never break the app */ }
}
window.ssLogError = ssLogError;
window.addEventListener("error", (e) => ssLogError(SS_ERR_SOURCE, (e && e.message) || "window.onerror", e && e.error && e.error.name,
  { stack: e && e.error && e.error.stack ? String(e.error.stack).slice(0, 2000) : null, file: e && e.filename, line: e && e.lineno }));
window.addEventListener("unhandledrejection", (e) => { const r = e && e.reason; ssLogError(SS_ERR_SOURCE, (r && r.message) || String(r), r && r.name,
  { stack: r && r.stack ? String(r.stack).slice(0, 2000) : null }); });

// ── The shared designer module, if it did not load ────────────────────────────
// REPORT ONLY, deliberately — and this is the opposite treatment from index.html, on
// purpose. There the module IS the page, so losing it is a blank screen and the boot guard's
// failure message replaces the page. Here it backs exactly ONE tab: with the module gone the
// portal still logs in and every other tab (designs, contacts, settings, billing, schedule)
// works perfectly — VERIFIED, the login screen renders its normal 3,261 chars — and
// DesignerTab already degrades to its own inline "the designer failed to load" message. So
// calling window.ssBootFail() here would replace a WORKING portal with an error screen over
// one optional tab: strictly worse than the bug, and the same catastrophic-false-positive
// class the guard's position rule in preflight exists to prevent.
// What was missing is that the degraded tab was SILENT — a tenant loses the designer and
// nobody finds out. One row, at block scope rather than inside DesignerTab, so it cannot fire
// twice on a re-render and is not a side effect in render.
if (!window.StructureStudio) {
  ssLogError("boot", "the shared component module did not load (structure-studio.component.compiled.js) — the portal still works, the Designer tab does not", "boot_component_missing", { app: "portal", missing: ["structure-studio.component.compiled.js"], degraded: "designer-tab-only" });
}
// ── Operator "view as" tenant override (transport-level) ──────────────────────
// While an operator has another tenant's portal open, every portal-settings /
// portal-billing / sync-design-status call must act on THAT tenant. This is a property of
// the transport, not of any component, so it is applied once here rather than threaded
// through ~23 call sites in six components — five of which take no clientId prop at all.
//
// Why not props or context: both need an edit at every call site, and both share one
// failure mode — a site missed today, or added in six months, silently reads AND WRITES
// the operator's own tenant. A wrong-tenant save_colors (a full-list replace with a
// server-side delete) or send_invoice is unrecoverable and invisible. Here, forgetting is
// impossible. Same module-level-transport-state pattern as ssOnSessionExpired above.
let ssTargetClientId = null;   // set by Dashboard during render; null when not viewing

// Allow-list, not a deny-list: a function added later gets NO injection until it is named
// here. operator-portal is deliberately absent — it passes its own explicit clientId, and
// its list_clients is a cross-tenant listing that must never look tenant-scoped.
// ⛔ portal-commissions is DELIBERATELY absent and must stay absent. Carolyn, 2026-08-07:
// "Operators should not be able to change commissions in builders pages." Adding it here
// would inject targetClientId and hand operators exactly that. The function itself refuses
// a targetClientId with a 403, so adding it here would break every operator call rather
// than quietly widening access — that pairing is intentional, not an oversight to fix.
const SS_TENANT_SCOPED_FNS = ["portal-settings", "portal-billing", "sync-design-status", "qbo-oauth-connect", "portal-schedule", "portal-setup", "portal-sms", "portal-payments"];

// Capture every portal-settings edge-function error in one place by wrapping invoke.
//
// ⚠️ `sb.functions` is a GETTER in supabase-js v2 — it mints a NEW FunctionsClient on
// every access. Assigning onto `sb.functions.invoke` therefore patches a throwaway
// instance and silently does nothing: that is exactly what happened from 2026-07-30 to
// 2026-07-31 — the targetClientId injection and the tripwire below never ran, and every
// portal-settings call in operator view-as resolved the OPERATOR'S OWN tenant. The fix
// is to mint ONE instance, wrap it, and pin it as an own data property so it shadows
// the prototype getter (verify in a console: `sb.functions === sb.functions` → true).
const __ssFunctions = sb.functions;
const __ssInvoke = __ssFunctions.invoke.bind(__ssFunctions);
__ssFunctions.invoke = async (name, opts) => {
  // ⛔ THE VIEW-AS TARGET IS READ FIRST, BEFORE ANY `await`, AND NOTHING MAY MOVE ABOVE IT.
  // `ssTargetClientId` is a module global that openAccount/exitAccount/onPop reassign
  // synchronously inside their handlers ("same tick as the click", 09-shell.jsx), and
  // 09-shell.jsx's own `if (!ssTargetClientId)` guard is only conclusive while this read
  // happens in the caller's tick. Put an await in front of it and the wrapper can inject a
  // target armed AFTER the call was issued — a tenant-scoped write such as `save_colors`
  // (a full-list replace with a server-side delete) landing on the WRONG tenant, silently:
  // the tripwire below only fires when the server disagrees with `injected`, and here it
  // agrees. Mid-flight view-as already poisoned a call once (audit 2026-08-20). Capture the
  // value synchronously; the session guard runs after.
  //
  // Captured in the same tick and for the same reason: which view-as target — if any — was
  // armed when this call was ISSUED. The attribution stamp at the bottom compares it against
  // the target armed when the response LANDS, and declines the server's echo when they
  // differ. `injected` cannot stand in for it: 03-catalog.jsx's `scoped()` puts
  // targetClientId on the body itself while viewing, and an explicit value skips the
  // injection below, so a call can be scoped to the viewed tenant with `injected` still null.
  const armedAtIssue = ssTargetClientId;
  let injected = null;
  if (
    ssTargetClientId &&
    SS_TENANT_SCOPED_FNS.indexOf(name) !== -1 &&
    opts && opts.body && typeof opts.body === "object" &&
    !(opts.body instanceof FormData) && !(opts.body instanceof Blob) && !(opts.body instanceof ArrayBuffer) &&
    opts.body.targetClientId === undefined                       // an explicit value always wins
  ) {
    injected = ssTargetClientId;
    // Never mutate the caller's object — several call sites build a local `body` and reuse it.
    opts = { ...opts, body: { ...opts.body, targetClientId: injected } };
  }
  // A tab whose session vanished under it must NOT fall back to the anon key. supabase-js
  // puts that key on the wire as the Bearer whenever getSession() resolves null — our
  // legacy `eyJ` anon key defeats supabase-js's own omitApiKeyAsBearer opt-out, which only
  // engages for `sb_publishable_` keys — and the server then correctly reads a valid JWT
  // with no `sub` and answers "Not signed in." So the call CANNOT succeed; firing it only
  // buys an error row nobody can act on. That is every one of the 34 such rows from
  // 2026-07-31 on, each from a tab that recovered by itself moments later: the multi-tab
  // refresh-token race named at the top of this file. Skip the round trip and say so
  // plainly instead — the effects that fire these calls are keyed on the session, so they
  // re-run on their own the moment a token lands. Returning an error rather than staying
  // silent is deliberate: a caller left waiting forever on a promise that never settles is
  // the worse failure, and this message tells the truth about a transient state.
  try {
    const { data: ssSess } = await sb.auth.getSession();
    if (!ssSess || !ssSess.session) {
      // Still record it, under its own code. Suppressing the call without a trace would
      // trade 34 visible rows for an invisible condition, and we would have no way to tell
      // "the race is fixed" from "the race now happens fifty times a day in silence".
      // Deliberately NOT routed through the 401 path below: this is a counter, not a fault.
      try {
        // info, not error: this is a COUNTER for a transient condition the app then
        // recovers from by itself, and filing it as a fault would put it straight back in
        // the queue the severity split exists to keep clean. It shipped as an error for
        // one afternoon and promptly became the top row there.
        ssLogError(SS_ERR_SOURCE, "call skipped: no session on the wire", "session_reconnecting",
          { fn: name, action: opts && opts.body && opts.body.action, target: injected, status: null }, "info");
      } catch (_l) { /* logging must never break the guard */ }
      const err = new Error("Your session is reconnecting — try that again in a moment.");
      err.ssNoSession = true;
      return { data: null, error: err };
    }
  } catch (_e) { /* the guard must never be the reason a call fails */ }
  const res = await __ssInvoke(name, opts);
  // Recover the SERVER'S message on a non-2xx. supabase-js reports every 4xx/5xx as
  // FunctionsHttpError("Edge Function returned a non-2xx status code") and leaves the JSON
  // body — which holds the actual reason — unread on error.context. Every call site here
  // does `throw new Error(error.message || data.error)`, and because `error` is truthy the
  // real reason was never even looked at: the builder got "non-2xx", and so did app_errors.
  // That is how seven fixture failures on 2026-08-05 recorded nothing anyone could act on.
  // Reading it once, here, fixes the message for every action and every call site at once.
  // ⚠️ THE STATUS IS READ FIRST, AND UNCONDITIONALLY. It used to be set only inside the
  // block below — i.e. only when supabase-js had produced its generic "non-2xx" wording AND
  // the body parsed as JSON AND that JSON carried an `error`/`message` field. Every 4xx that
  // missed any of those three fell through with `ssStatus` undefined and was filed as a
  // FAULT by the severity split further down, which keys on it. Two real cases:
  //   • the GATEWAY's own 401 ("Invalid JWT"), answered before our function runs — its
  //     message never says "non-2xx", so the block was skipped entirely;
  //   • any refusal whose body is not our JSON shape (an HTML error page from the edge).
  // Both are refusals, and the split is meant to key on the STATUS, never on the wording of
  // a client library's message. Read it once, here, and let the block below own the message.
  if (res && res.error && res.error.context && typeof res.error.context.status === "number") {
    res.error.ssStatus = res.error.context.status;
  }
  if (res && res.error && res.error.context && typeof res.error.context.json === "function"
      && /non-2xx/i.test(res.error.message || "")) {
    try {
      const body = await res.error.context.clone().json();
      const serverMsg = body && (body.error || body.message);
      if (serverMsg) {
        const status = res.error.context.status;
        res.error.message = String(serverMsg);
        // resolveTenant now classifies WHY a 401 happened ("missing" | "anon_key" |
        // "rejected"). Carry it into the log context below — that enum is the difference
        // between "this tab's session had gone" and "a real token was refused", which the
        // previous four weeks of rows could not tell apart. Never shown to the user.
        if (body.reason) res.error.ssReason = String(body.reason);
        // 401/403 are the two a builder can act on themselves, so say what to do.
        if (status === 401) res.error.message += " — sign out and back in.";
        else if (status === 403) res.error.message += " — ask an owner or admin to do this.";
      }
    } catch (_) { /* body already consumed, or not JSON — keep the generic message */ }
  }
  try {
    if (res && (res.error || (res.data && res.data.error))) {
      // A 4xx is the SERVER REFUSING this request, and every one of ours answers with a
      // sentence written for the person reading it ("send the invoice first", "that width
      // isn't valid", "ask an owner or admin to do this"). That is the product working, so
      // it is logged as info, not as a fault. 5xx, a network failure and an unreadable
      // response stay errors: those are things that broke.
      //
      // Demoted, NOT dropped — the distinction earns its keep. "Driver not found." was a
      // 400 that read exactly like a validation message and was really the client posting
      // driver_profiles.user_id where the server matches on .id, so reassigning a driver
      // failed every single time for twelve days. It was caught by reading these rows.
      // What makes a refusal suspicious is REPETITION, so the row has to survive:
      //   select message, count(*) from app_errors where severity = 'info'
      //   group by 1 having count(*) > 20 order by 2 desc;
      const st = (res.error && res.error.ssStatus) || null;
      ssLogError(SS_ERR_SOURCE, (res.error && res.error.message) || (res.data && res.data.error),
        (res.error && res.error.name) || null,
        { fn: name, action: opts && opts.body && opts.body.action, target: injected,
          status: st,
          reason: (res.error && res.error.ssReason) || null },
        (st >= 400 && st < 500) ? "info" : "error");
    }
  } catch (_) {}
  // Tripwire. portal-settings echoes the tenant it actually resolved. If it disagrees with
  // what we asked for, the backend is older than this page and is silently serving the
  // operator's OWN tenant — so refuse the response instead of rendering someone else's
  // data under this client's name. This is what makes the deploy order (backend first)
  // enforce itself rather than depending on anyone remembering it.
  if (injected && res && res.data && res.data.clientId && res.data.clientId !== injected) {
    ssLogError(SS_ERR_SOURCE, "operator view: server resolved a different tenant", null,
      { fn: name, asked: injected, got: res.data.clientId });
    return { data: null, error: new Error("This account view isn't wired up on the server yet — reload, and tell CSM Synergy if it persists.") };
  }
  // Same echo, put to a second use: it is what gives ssLogError a tenant. Read only from the
  // tenant-scoped list, because admin-catalog also answers with a `clientId` and that one is
  // the builder an operator is CREATING or deleting, not the portal on screen. Set AFTER the
  // tripwire so a response we just refused never becomes the tenant later rows are filed
  // under.
  //
  // ⛔ THE ECHO DOES NOT FOLLOW VIEW-AS ON ITS OWN — an earlier version of this comment said
  // it did ("the next status call restamps it") and that was false in both directions.
  // 12-shell.jsx SKIPS its portal-settings `status` call for the whole duration of a view-as
  // session, deliberately (see its own comment), so there is no next status call; and three
  // of the five tenant-scoped functions — portal-billing, sync-design-status,
  // portal-schedule — echo no clientId at all, so most responses inside a viewed portal
  // cannot restamp anything either. Left to the echo alone, every row written while an
  // operator has builder B open stays filed under whoever was latched last: the operator's
  // own tenant, or builder A from the previous view-as. That is WORSE than the NULL this
  // latch replaced — a wrong attribution is BELIEVED, and `where client_id = 'junior-barns'`
  // then serves another tenant's rows as fact. (Not a leak: the payload is the operator's
  // own activity and the `url` carries ?view=. It is triage that breaks.)
  //
  // So the armed view-as target wins outright, and it is read HERE rather than with
  // `injected` at the top on purpose: attribution must describe the portal on screen when
  // the row is written, not the tenant the call was issued for. 12-shell.jsx stamps the
  // same value the moment `viewing` changes (in the tick, beside the ssTargetClientId
  // lockstep), which covers the gap before the first response of a view-as session lands
  // and the reverse gap on the way out; this keeps it right for anything still in flight.
  //
  // ⛔ AND THE ECHO IS REFUSED OUTRIGHT WHEN THE VIEW-AS SESSION MOVED UNDER IT. 12-shell.jsx
  // stamping the operator's own tenant on exit does NOT close the way out on its own, because
  // a call issued while builder B was on screen can still be in flight when the operator
  // leaves. Its response echoes B — correctly, the server did resolve B — and the second
  // branch below then re-stamps B onto a portal that is now the operator's own, so an error
  // row written seconds AFTER the operator left is filed under the tenant they were viewing.
  // That is the same believed-wrong-attribution this latch exists to avoid, arriving by the
  // back door. So the second branch runs only when the target armed at issue is still the
  // target armed now: nothing armed then, nothing armed now.
  //
  // A generation counter on the view-as session would also close it, and this is smaller —
  // no counter, no bump in openAccount/exitAccount/onPop, nothing for a fourth entry point
  // added later to remember. It is not weaker either: the one case an equality check cannot
  // tell apart from "never left" is leaving B and re-entering B, and there the first branch
  // stamps B, which is the right answer because B is what is on screen.
  if (ssTargetClientId) {
    ssResolvedClientId = String(ssTargetClientId);
  } else if (armedAtIssue === ssTargetClientId && SS_TENANT_SCOPED_FNS.indexOf(name) !== -1 && res && res.data && res.data.clientId) {
    ssResolvedClientId = String(res.data.clientId);
  }
  return res;
};
// Pin the wrapped instance. An own data property shadows the class getter, so every
// later `sb.functions` access returns THIS client instead of minting an unwrapped one.
Object.defineProperty(sb, "functions", { value: __ssFunctions, configurable: true });

// (ADMIN_URL is gone — the Admin tab no longer iframes /admin. admin.html and its /admin
// redirect both REMAIN on disk as the break-glass route: if this portal will not load,
// operators still have a password-only way into the console.)

const TAB_META = {
  designer: ["Designer", "Design a building and build a quote"],
  accounts: ["Accounts", "Open any builder's portal — operators only"],
  admin: ["Admin", "Operator console — master catalog, builder setup, and onboarding"],
  projects: ["Projects", "Internal boards — bugs, feature requests, roadmap. Operators only"],
  // TWO SECTIONS AGAIN, reversing the 2026-08-24 merge (commit 4a54dad).
  //
  // She asked for the merge on 08-24 after walking Pipedrive — "these two needs to be
  // consolidated" — and then, on 08-26 at 12:15, having used it: "I was envisioning it that
  // we have contacts as one, and then we have another one that says pipeline. I would call
  // it a pipeline, not opportunities ... I would rather have MORE TABS and one specific
  // name on it." Ahsan confirmed on the call that they do not need to be one tab.
  //
  // What she actually disliked on 08-24 turned out to be the two lists looking alike, not
  // their being separate — she could not find the pipeline board at all until Ahsan pointed
  // at it ("I didn't see that you had the pipeline thing"). The board is what makes this
  // section different from a contact list, so the section is now NAMED after it.
  //
  // The ids stay `designs` and `leads` so deep links from BOTH eras keep working: these are
  // native pages again, and the merged era's /portal/designs/people|deals normalise
  // themselves in the shell. `leads` was already the pre-merge id for Contacts, so this is
  // a genuine revert rather than a third naming scheme.
  //
  // NOT renamed: "Deals". She talked herself out of it at 15:00 — "a quote can also mean you
  // do more than one quote for one deal, so let's leave it on the deals side right now."
  designs: ["Pipeline", "Customer designs and quotes — as a list or a pipeline board"],
  contacts: ["Contacts", "Everyone who has enquired, and their activity"],
  orders: ["Orders", "Track accepted quotes from sale to payment and delivery"],
  releases: ["What's New", "Latest features and fixes"],
  settings: ["Settings", "Structures, options, colors, branding & estimates, connection, QuickBooks, and billing"],
  quickbooks: ["QuickBooks", "QuickBooks Online connection and invoice item mappings"],
  "on-demand-pricing": ["RealTime Pricing", "Live building costs from your lumber prices — coming soon"],
  "build-schedule": ["Build Schedule", "Track buildings from order to done"],
  "delivery-schedule": ["Delivery Schedule", "Plan truck loads and manage deliveries"],
  "inventory": ["Inventory", "Buildings on your lots, ready to sell"],
  "repairs": ["Repairs", "Manage repair jobs from request to done"],
  "view-3d": ["3D Design", "Give each building style its own 3D look"],
  "rent-to-own-contracts": ["Rent to Own", "Generate and manage RTO agreements — coming soon"],
  "self-serve-display-units": ["Self Serve Displays", "In-unit kiosk to design, estimate, and get live help — coming soon"],
  "commissions": ["Commissions", "Track and calculate sales commissions — coming soon"],
  "reports": ["Reports", "Sales, leads, revenue, and delivery reporting — coming soon"],
};

// ── Path routing ─────────────────────────────────────────────────────────────
// Every page has its own URL: /portal/<page>[/<sub>]. Carolyn, 2026-07-29: "Let's say
// I'm right here, and I go and refresh the page — it goes back to designs." / "Every page
// doesn't have its own link. We should, shouldn't we? That's the problem."
//
// TAB_META above is the ONE registry — a page is routable because it has an entry, so
// there is no second list to keep in sync. `sub` is the Settings/Admin sub-tab.
//
// Everything is same-document pushState. No anchors, no location.assign: the designer and
// the admin console are keep-mounted, and a real navigation would throw their state away.
//
// `_redirects` needs `/portal/* /portal.html 200` for these to survive a cold load. A plain
// static server ignores _redirects, so deep links only work on beta/production — locally
// the app still runs, it just always boots at /portal.html.
const SS_TAB_ALIASES = { leads: "contacts" };
function ssParsePath() {
  const parts = String(window.location.pathname || "").split("/").filter(Boolean);
  // ["portal"] | ["portal","settings"] | ["portal","settings","colors"]
  if (parts[0] !== "portal" && parts[0] !== "portal.html") return { page: null, sub: null };
  // Old tab ids that must keep resolving. `leads` was renamed to `contacts` on 2026-09-02 so
  // the URL matches the label and the server-side permission area, both already "contacts".
  // Three live shapes depend on this: /portal/leads (nav + bookmarks), /portal/leads/c-<uuid>
  // (record deep links and browser history), and /portal/designs/people (the merged-era alias).
  // Without it every caller does `TAB_META[p.page] ? p.page : "designs"`, so a stale link would
  // land silently on Pipeline and a record link would lose its `sub` entirely. The shell's
  // existing replaceState then rewrites the address bar to the new path, with no history entry.
  const page = parts[1] || null;
  return { page: (page && SS_TAB_ALIASES[page]) || page, sub: parts[2] || null };
}

// Is this deployment a beta/preview surface? Decides whether the "Coming Soon" sidebar
// group (and its teaser routes) exist at all — Carolyn approved hiding them from
// production on 2026-08-27 ("Go ahead and do it, yes"). HOSTNAME is the only signal there
// is: the two workers serve identical bytes with no env vars, and one Supabase project
// serves both deployments, so no DB flag can tell them apart (the same reasoning as the
// designer's betaMode telemetry check, which this deliberately does NOT reuse — that one
// is documented as side-effect-free forever, and this one exists to have a side effect).
// The beta label must be exactly `beta` or `beta-…` so a tenant subdomain that merely
// starts with "beta" can never match; workers.dev previews and localhost count as beta,
// because both exist to look at unreleased work.
function ssIsBetaHost() {
  const h = String(window.location.hostname || "").toLowerCase();
  if (h === "localhost" || h === "127.0.0.1" || /\.workers\.dev$/.test(h)) return true;
  return /(^|\.)beta(-[a-z0-9-]+)?(\.|--)/.test(h);
}

// The four teaser tabs the Coming Soon group points at. On a production host the nav
// group is hidden AND these routes clamp (hiding a nav item does not remove its route —
// TAB_META is what grants routability, and bookmarked deep links exist).
const SS_SOON_TABS = ["on-demand-pricing", "rent-to-own-contracts", "reports", "self-serve-display-units"];

// Keeps the query string (?view=<clientId> is orthogonal to the path and must survive
// every navigation) and drops any hash.
function ssPagePath(page, sub) {
  const base = "/portal" + (page ? "/" + page : "") + (page && sub ? "/" + sub : "");
  return base + (window.location.search || "");
}

// Non-admins are confined to the Designs + Leads lists, the read-only "What's New" tab
// (product news), and the coming-soon teaser tabs (previews, no data). Everything else is
// admin-only. SUPERSEDED for anyone whose tenant row carries per-area access (migration
// 100) — see TAB_AREA below; this list is the fallback for the older binary shape.
const NONADMIN_TABS = ["designer", "designs", "contacts", "orders", "releases", "on-demand-pricing", "inventory", "repairs", "view-3d", "build-schedule", "delivery-schedule", "rent-to-own-contracts", "self-serve-display-units", "commissions", "reports"];

// Which permission area each page needs to be VISIBLE (migration 100). The server ships the
// caller's resolved map on the status call and enforces it on every action regardless —
// this only decides what is worth showing, so that a driver sees a portal made of the four
// things they do rather than a wall of tabs that 403.
//
// A page absent from this map is not access-controlled: "releases" is product news, and the
// coming-soon teasers render no tenant data at all.
const TAB_AREA = {
  designer: "designer",
  // Back to one area each, with the 08-26 split: Pipeline is the designs list, Contacts is
  // the contacts list, and each gates on the area whose data it actually shows. The merged
  // tab needed EITHER because it showed both; a rep granted only contacts must not get the
  // customer-designs list back through a tab that no longer contains it.
  designs: "designs",
  contacts: "contacts",
  inventory: "inventory",
  orders: "orders",
  "build-schedule": "build_schedule",
  "delivery-schedule": "delivery_schedule",
  repairs: "repairs",
  commissions: "commissions",
  reports: "reports",
  quickbooks: "settings_quickbooks",
};
// Which area each Settings sub-tab needs. Same registry idea as TAB_AREA above: a sub-tab
// missing from this map is not access-controlled.
const SETTINGS_TAB_AREA = {
  structures: "settings_structures",
  // Designer -> 3D writes building_styles.d3 (save_style_d3 and friends), and every one of
  // those actions is gated settings_structures:edit server-side. Mirror that here or the
  // sub-tab shows up for someone the server will refuse.
  designer: "settings_structures",
  options: "settings_options",
  colors: "settings_options",
  branding: "settings_branding",
  connection: "settings_crm",
  quickbooks: "settings_quickbooks",
  email: "settings_email",
  // Texting registers the BUSINESS's legal identity with the carriers and spends real money,
  // so it is held to the billing bar — by default an owner, and an admin only where an owner
  // has granted it. Reading the resulting status is contacts-level; that split lives in
  // portal-sms's GATES table, and this map only decides whether the sub-tab is worth showing.
  sms: "settings_billing",
  commissions: "commissions",
  team: "settings_team",
  billing: "settings_billing",
};
// Settings is a hub: show it if ANY of its cards is readable, then each card gates itself.
const SETTINGS_AREAS = ["settings_structures", "settings_options", "settings_branding",
  "settings_crm", "settings_quickbooks", "settings_team", "settings_billing", "settings_email"];

// 'own' (commissions) counts as read — see canRead in _shared/access.ts. Kept deliberately
// tiny and mirrored rather than imported: portal.html has no module loader, and the SERVER
// is the enforcement point, so a drift here costs a wrong tab and never wrong access.
function ssCanRead(access, area) {
  const v = access && access[area];
  return v === "view" || v === "edit" || v === "own";
}
// The write half. 'own' is NOT write: it means "your own commission rows", a read scope, and
// treating it as edit would let a rep act on an area they can only look at. Mirrored from
// canWrite in _shared/access.ts for the same reason ssCanRead is — the server enforces, this
// only decides what is worth rendering.
function ssCanWrite(access, area) {
  return !!access && access[area] === "edit";
}
function ssCanSeeTab(tab, access) {
  if (!access) return NONADMIN_TABS.includes(tab);   // pre-migration-100 shape: old behaviour
  if (tab === "settings") return SETTINGS_AREAS.some((a) => ssCanRead(access, a));
  const area = TAB_AREA[tab];
  // An ARRAY means "any of these is enough". No entry uses one since the 08-26 split undid
  // the merged Contacts & Designs tab, but the branch stays: it mirrors the server's
  // `{ any: [...] }` gate shape, and the next page that needs it should not have to
  // rediscover that the two must agree.
  if (Array.isArray(area)) return area.some((a) => ssCanRead(access, a));
  return area ? ssCanRead(access, area) : NONADMIN_TABS.includes(tab);
}

// Where the clamp LANDS someone must itself pass ssCanSeeTab, or the fallback recreates
// the exact leak the clamp exists to stop: a hardcoded "designs" put every migration-100
// driver (designs absent from their map = none) on the full customer-designs list at each
// bare /portal login — a page their own nav hides (audit 2026-08-20). Designs first, so
// the pre-migration-100 shape lands exactly where it always did; then the first page the
// person actually holds an area for (TAB_AREA[x] required — the no-data teaser tabs pass
// ssCanSeeTab for everyone and would otherwise win over a page they were granted); then
// "releases": product news, no tenant data, never refused for any access map.
function ssFallbackTab(access) {
  if (ssCanSeeTab("designs", access)) return "designs";
  const t = NONADMIN_TABS.find((x) => x !== "designs" && TAB_AREA[x] && ssCanSeeTab(x, access));
  return t || "releases";
}

// "accounts", "admin" and "projects" are operator-gated (independent of tenant role) and sit
// OUTSIDE the role clamp; everything else keeps it. Note none of them may go in NONADMIN_TABS —
// that array is the role escape hatch and would hand the operator surfaces to every team
// member. Content renders are ALSO gated (and the server re-checks regardless).
//
// At module scope so the router's URL-normalising effect can call it too. That effect has
// to sit ABOVE Dashboard's early returns (tenant loading / no tenant) — a hook below them
// changes the hook count between renders, which is React error #310 and a blank screen.
// The comment on `designerOpened` says the same thing; this is the second time it has bitten.
function ssClampTab(tab, isOperator, canAdmin, access) {
  // Teaser routes exist only where the Coming Soon group renders. Checked before the
  // role branches on purpose: an admin bookmark to /portal/reports on production should
  // land on a real page, not an unreleased teaser the sidebar no longer offers.
  if (SS_SOON_TABS.includes(tab) && !ssIsBetaHost()) return ssFallbackTab(access);
  if (tab === "accounts" || tab === "admin" || tab === "projects") return isOperator ? tab : ssFallbackTab(access);
  // Owners, admins and operators are never clamped — an owner locked out of their own
  // portal by a permission bug is the one failure this feature must not have.
  if (canAdmin) return tab;
  return ssCanSeeTab(tab, access) ? tab : ssFallbackTab(access);
}

const ACCENT = "#3D3672";  // brand purple
const S = {
  page: { minHeight: "100vh", display: "flex", flexDirection: "column" },
  header: { background: "linear-gradient(135deg, #3D3672 0%, #1B7895 100%)", color: "#FFF", padding: "16px 24px", display: "flex", alignItems: "center", gap: 12 },
  badge: { background: "#75E6DA", color: "#3D3672", borderRadius: 8, width: 40, height: 40, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 16, flexShrink: 0 },
  card: { background: "#FFF", border: "1px solid #E2E8F0", borderRadius: 12, padding: 20, marginBottom: 16 },
  h2: { fontSize: 15, fontWeight: 800, color: "#1E293B", marginBottom: 12, letterSpacing: 0.3 },
  lbl: { fontSize: 11, fontWeight: 700, color: "#64748B", display: "block", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 },
  // fontFamily is NOT decoration here: a bare <textarea> defaults to MONOSPACE in
  // every browser, so the ten textareas that render through this token wrote notes and
  // emails in a typeface that appears nowhere else in the product. `inherit` takes the
  // body font for both tag types, so a field finally looks like the page it sits on.
  input: { width: "100%", border: "1px solid #CBD5E1", borderRadius: 6, padding: "8px 10px", fontSize: 13, fontWeight: 600, fontFamily: "inherit", color: "#1E293B", background: "#FFF", boxSizing: "border-box" },
  btn: (bg, fg) => ({ background: bg, color: fg, border: "none", borderRadius: 8, padding: "10px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer" }),
  err: { background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 8, padding: "10px 14px", color: "#DC2626", fontSize: 13, fontWeight: 600, marginBottom: 12 },
  okMsg: { background: "#F0FDF4", border: "1px solid #BBF7D0", borderRadius: 8, padding: "10px 14px", color: "#15803D", fontSize: 13, fontWeight: 600, marginBottom: 12 },
  th: { textAlign: "left", fontSize: 11, fontWeight: 700, color: "#64748B", textTransform: "uppercase", letterSpacing: 0.5, padding: "8px 10px", borderBottom: "2px solid #E2E8F0", whiteSpace: "nowrap" },
  td: { fontSize: 13, color: "#1E293B", padding: "10px", borderBottom: "1px solid #F1F5F9", verticalAlign: "top" },
};

// ── The WHEN date filter — Carolyn's full Monday-style condition list ────────────────────
// LIFTED from 05-schedule.jsx (2026-08-27) so the Projects table engine and the Build
// Schedule share ONE implementation; the sched* names there are aliases onto these. Pure
// functions of ISO strings; weeks are Sunday-first; quarters are calendar quarters.
//
// Date-ONLY strings (YYYY-MM-DD) parse as UTC midnight through bare new Date(), so they
// render and compare a DAY EARLY in every US timezone (audit 2026-08-20). The constraint:
// parse a date-only string as LOCAL midnight, and build a day key / "today" from LOCAL
// components — never toISOString().
const ssLocalDate = (iso) => (iso ? new Date(String(iso).slice(0, 10) + "T00:00:00") : null);
const ssLocalIso = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
const SS_WHEN = [
  ["any", "Any date", "none"],
  ["today", "Today", "none"],
  ["yesterday", "Yesterday", "none"],
  ["this_week", "This week", "none"],
  ["this_month", "This month", "none"],
  ["this_quarter", "This quarter", "none"],
  ["in_month", "In month", "month"],
  ["this_year", "This year", "none"],
  ["on", "On", "date"],
  ["between", "Between", "date2"],
  ["more_than", "More than", "count"],
  ["after", "After date", "date"],
  ["less_than", "Less than", "count"],
  ["before", "Before date", "date"],
  ["in_next", "In the next", "count"],
  ["in_last", "In the last", "count"],
];
const SS_WHEN_PARAM = Object.fromEntries(SS_WHEN.map(([k, _l, p]) => [k, p]));
// ISO date + or - N days/weeks/months, in local time.
const ssShiftIso = (iso, n, unit) => {
  const d = ssLocalDate(iso);
  if (unit === "months") d.setMonth(d.getMonth() + n);
  else d.setDate(d.getDate() + n * (unit === "weeks" ? 7 : 1));
  return ssLocalIso(d);
};
// Does a date pass the condition? p = { a, b, month, n, unit }. A condition whose parameter
// is not filled in yet MATCHES EVERYTHING — filtering nothing while she types beats blanking
// the list mid-keystroke. More than / Less than measure distance FORWARD from today ("In the
// last" covers looking back). Between is inclusive at both ends.
const ssWhenMatch = (cond, p, iso, todayIso) => {
  switch (cond) {
    case "today": return iso === todayIso;
    case "yesterday": return iso === ssShiftIso(todayIso, -1, "days");
    case "this_week": {
      const t = ssLocalDate(todayIso); t.setDate(t.getDate() - t.getDay());
      const sun = ssLocalIso(t);
      return iso >= sun && iso <= ssShiftIso(sun, 6, "days");
    }
    case "this_month": return iso.slice(0, 7) === todayIso.slice(0, 7);
    case "this_quarter": {
      const q = (m) => Math.floor((Number(m.slice(5, 7)) - 1) / 3);
      return iso.slice(0, 4) === todayIso.slice(0, 4) && q(iso) === q(todayIso);
    }
    case "in_month": return !p.month || iso.slice(0, 7) === p.month;
    case "this_year": return iso.slice(0, 4) === todayIso.slice(0, 4);
    case "on": return !p.a || iso === p.a;
    case "between": return (!p.a || iso >= p.a) && (!p.b || iso <= p.b);
    case "more_than": return !p.n || iso > ssShiftIso(todayIso, Number(p.n), p.unit || "days");
    case "after": return !p.a || iso > p.a;
    case "less_than": return !p.n || (iso >= todayIso && iso <= ssShiftIso(todayIso, Number(p.n), p.unit || "days"));
    case "before": return !p.a || iso < p.a;
    case "in_next": return !p.n || (iso >= todayIso && iso <= ssShiftIso(todayIso, Number(p.n), p.unit || "days"));
    case "in_last": return !p.n || (iso <= todayIso && iso >= ssShiftIso(todayIso, -Number(p.n), p.unit || "days"));
    default: return true;
  }
};

function fmtDate(iso) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); }
  catch { return iso; }
}
// Capitalize each word of a building-style name for display. Designs store the style as
// either its label ("Farmland") or its lowercase key ("cabin"), so normalize to Title Case.
function titleCase(s) {
  return String(s || "").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Password input with a show/hide (eye) toggle. Forwards all input props; `wrapStyle`
// carries any flex/grid sizing onto the positioned wrapper so layouts are preserved.
function PasswordInput({ style, wrapStyle, ...rest }) {
  const [show, setShow] = useState(false);
  return (
    <div style={{ position: "relative", width: "100%", boxSizing: "border-box", ...wrapStyle }}>
      <input {...rest} type={show ? "text" : "password"} style={{ ...style, width: "100%", boxSizing: "border-box", paddingRight: 38 }} />
      <button type="button" tabIndex={-1} aria-label={show ? "Hide password" : "Show password"} title={show ? "Hide password" : "Show password"} onMouseDown={(e) => e.preventDefault()} onClick={() => setShow((v) => !v)} style={{ position: "absolute", top: 0, right: 0, height: "100%", width: 34, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent", border: "none", padding: 0, margin: 0, cursor: "pointer", color: "#64748B" }}>
        {show ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" /><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" /><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" /><line x1="2" x2="22" y1="2" y2="22" /></svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></svg>
        )}
      </button>
    </div>
  );
}

// ─── Login ───
function LoginView({ onRecoverySent, notice }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [info, setInfo] = useState(null);

  const signIn = async (e) => {
    e.preventDefault();
    setError(null); setInfo(null); setBusy(true);
    const { error: err } = await sb.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (err) setError(err.message === "Invalid login credentials" ? "Wrong email or password." : err.message);
    // success: onAuthStateChange in PortalApp takes over
  };

  const forgot = async () => {
    setError(null); setInfo(null);
    if (!email.trim()) { setError("Enter your email above first, then click “Forgot password” again."); return; }
    setBusy(true);
    // Always the canonical production portal, never window.location.origin. Supabase
    // honours only allow-listed redirects and silently substitutes Site URL otherwise,
    // so a reset started on beta (or localhost) used to produce a link that bounced to
    // the apex root — see AUTH_PORTAL_URL in supabase/functions/admin-catalog/index.ts.
    // Safe because beta and production share one Supabase project: the password set
    // here works on beta immediately.
    const { error: err } = await sb.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: "https://app.structurestudiosuite.com/portal",
    });
    setBusy(false);
    if (err) setError(err.message);
    else setInfo("Password reset email sent — check your inbox (it can take a minute).");
  };

  return (
    <div style={{ maxWidth: 380, margin: "60px auto", padding: "0 16px" }}>
      <div style={S.card}>
        <div style={{ ...S.h2, fontSize: 18, textAlign: "center" }}>Business Login</div>
        <p style={{ fontSize: 12, color: "#64748B", textAlign: "center", marginBottom: 16 }}>Sign in to see your contacts, designs, and settings.</p>
        {notice && !error && !info && <div style={{ background: "#FEF3C7", border: "1px solid #F59E0B", borderRadius: 8, padding: "10px 14px", color: "#92400E", fontSize: 13, fontWeight: 600, marginBottom: 12 }}>{notice}</div>}
        {error && <div style={S.err}>{error}</div>}
        {info && <div style={S.okMsg}>{info}</div>}
        <form onSubmit={signIn}>
          <div style={{ marginBottom: 12 }}>
            <span style={S.lbl}>Email</span>
            <input style={S.input} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@yourbusiness.com" />
          </div>
          <div style={{ marginBottom: 16 }}>
            <span style={S.lbl}>Password</span>
            <PasswordInput style={S.input} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
          </div>
          <button type="submit" disabled={busy} style={{ ...S.btn(ACCENT, "#FFF"), width: "100%", opacity: busy ? 0.6 : 1 }}>{busy ? "Signing in…" : "Sign In"}</button>
        </form>
        <button onClick={forgot} disabled={busy} style={{ ...S.btn("transparent", "#64748B"), width: "100%", marginTop: 8, fontSize: 12 }}>Forgot password?</button>
      </div>
    </div>
  );
}

// ─── Password reset (arrived via recovery email link) ───
function ResetPasswordView({ onDone }) {
  const [pw1, setPw1] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const save = async (e) => {
    e.preventDefault();
    setError(null);
    if (pw1.length < 8) { setError("Password must be at least 8 characters."); return; }
    if (pw1 !== pw2) { setError("Passwords don't match."); return; }
    setBusy(true);
    const { error: err } = await sb.auth.updateUser({ password: pw1 });
    setBusy(false);
    if (err) setError(err.message);
    else onDone();
  };

  return (
    <div style={{ maxWidth: 380, margin: "60px auto", padding: "0 16px" }}>
      <div style={S.card}>
        <div style={{ ...S.h2, fontSize: 18, textAlign: "center" }}>Set a New Password</div>
        {error && <div style={S.err}>{error}</div>}
        <form onSubmit={save}>
          <div style={{ marginBottom: 12 }}>
            <span style={S.lbl}>New password</span>
            <PasswordInput style={S.input} autoComplete="new-password" value={pw1} onChange={(e) => setPw1(e.target.value)} />
          </div>
          <div style={{ marginBottom: 16 }}>
            <span style={S.lbl}>Confirm password</span>
            <PasswordInput style={S.input} autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
          </div>
          <button type="submit" disabled={busy} style={{ ...S.btn(ACCENT, "#FFF"), width: "100%", opacity: busy ? 0.6 : 1 }}>{busy ? "Saving…" : "Save Password"}</button>
        </form>
      </div>
    </div>
  );
}

// ─── Share link card ───
function ShareLinkCard({ clientId }) {
  const [copied, setCopied] = useState(false);
  const link = `${window.location.origin}/?client=${encodeURIComponent(clientId)}`;
  const copy = () => {
    navigator.clipboard.writeText(link).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };
  return (
    <div style={S.card}>
      <div style={S.h2}>Your Customer Design Link</div>
      <p style={{ fontSize: 12, color: "#64748B", marginBottom: 10 }}>Share this link with customers (or embed it on your website). Every design submitted through it lands in your list below.</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input style={{ ...S.input, flex: "1 1 280px", fontFamily: "monospace", fontSize: 12 }} readOnly value={link} onFocus={(e) => e.target.select()} />
        <button onClick={copy} style={S.btn(copied ? "#15803D" : "#1E293B", "#FFF")}>{copied ? "✓ Copied" : "Copy"}</button>
        <a href={link} target="_blank" rel="noopener" style={{ ...S.btn("#F1F5F9", "#334155"), textDecoration: "none", border: "1px solid #E2E8F0" }}>Open ↗</a>
      </div>
    </div>
  );
}

// ─── Designs table ───
// Fulfillment status (read-only badge). Value is a GHL-derived projection cached on
// designs.status and refreshed by the sync-design-status edge function on load —
// EXCEPT 'draft' (migration 063): a browsing lead's silently-saved design, written by
// save_design alone. It has no GHL estimate, so the sync skips it; a real submit is
// what promotes it to 'sent'.
const STATUS_LABELS = { draft: "Draft", sent: "Sent", accepted: "Accepted", invoiced: "Invoiced", delivered: "Delivered" };
const STATUS_COLORS = {
  draft:     { bg: "#F1F5F9", fg: "#475569" },
  sent:      { bg: "#EEF2FF", fg: "#3D3672" },
  accepted:  { bg: "#F0FDF4", fg: "#15803D" },
  invoiced:  { bg: "#FFFBEB", fg: "#B45309" },
  delivered: { bg: "#ECFEFF", fg: "#0E7490" },
};
// Fulfillment workflow order — used so a Status-column sort follows the pipeline
// (draft → sent → accepted → invoiced → delivered) rather than sorting alphabetically.
const STATUS_RANK = { draft: -1, sent: 0, accepted: 1, invoiced: 2, delivered: 3 };

// ── Inventory: the TWO axes a lot building has (migrations 102 + 105) ─────────────────────
//
// It lives HERE, beside its siblings above, rather than next to InventoryTable 4,600 lines
// down — which is exactly why no shared map was ever written for it and the Status column was
// an inline ternary. Four different components read these (InventoryTable, the build tray,
// the delivery pool, SourceChip), and the first of them appears above the last.
//
// ONE object-map, not three parallel ones. Parallel maps are what let RANK → STATUS_RANK ship
// with a leftover usage and put the Contacts tab on "Loading…" for every tenant: seven rungs
// across three objects is 21 chances to forget a key, and nothing would fail loudly.
//
// The server owns these values (_shared/inventoryLifecycle.ts derives them and list_inventory
// sends both the key and its label). This map is for PRESENTATION only — colour, rank, and
// the short label a table cell can hold. There is NO `accepted` rung (migration 105): putting
// a building on the Build Schedule is the approval, so a unit without a build job simply
// reads Requested.
const INV_STAGES = {
  requested:          { label: "Requested",          group: "production", rank: 0 },
  in_queue:           { label: "In queue",           group: "production", rank: 1 },
  scheduled_build:    { label: "Scheduled to build", group: "production", rank: 2 },
  built:              { label: "Built",              group: "built",      rank: 3 },
  scheduled_delivery: { label: "Heading to lot",     group: "built",      rank: 4 },
  at_location:        { label: "At location",        group: "sellable",   rank: 5 },
  delivered:          { label: "Delivered",          group: "gone",       rank: 6 },
};
// Carolyn's full wording, for tooltips and the stage filter where there is room for it.
const INV_STAGE_LONG = {
  requested: "Requested",
  in_queue: "In Queue",
  scheduled_build: "Scheduled to build",
  built: "Built",
  scheduled_delivery: "Scheduled to be brought to location",
  at_location: "Available to sell at Location",
  delivered: "Delivered to the buyer",
};
// Colour by GROUP, not by stage. Seven badge colours is a rainbow nobody can read, and the
// question a colour should answer is "roughly where is this?" — the label answers "exactly
// where". Every pair below is already in use elsewhere in this file, so nothing new enters
// the palette. GREEN MEANS SELLABLE STOCK AND NOTHING ELSE: that is what makes "sold must be
// unavailable to sell" something you can check by looking, because a green pill beside a SOLD
// pill is a contradiction you can spot across the room.
const INV_GROUP_COLORS = {
  production: { bg: "#FFFBEB", fg: "#B45309" },   // amber — as invoiced / "In build"
  built:      { bg: "#ECFEFF", fg: "#0E7490" },   // cyan  — as delivered / the inventory chip
  sellable:   { bg: "#F0FDF4", fg: "#15803D" },   // green — as accepted / "Built ✓"
  gone:       { bg: "#F1F5F9", fg: "#475569" },   // slate — as draft / manual
};
const INV_SALE_COLORS = { bg: "#EEF2FF", fg: "#3D3672" };

// An unknown stage falls back to `requested` — the BOTTOM rung, so a value nobody recognises
// can never pass a "is it built yet" test.
const invStage = (u) => (u && INV_STAGES[u.lifecycle] ? u.lifecycle : "requested");
const invRank = (u) => INV_STAGES[invStage(u)].rank;
const invStageMeta = (u) => INV_STAGES[invStage(u)];
// Sold-ness is now a STORED fact (u.saleState), not a browser derivation. It used to be
// `stored sold OR any linked estimate accepted+`, computed only here — so a CRM sale showed
// Sold on this tab while the database still said available, the build board still offered the
// building as unbuilt stock, and the delivery pool never listed it, meaning a sold building
// was never scheduled to its buyer. sync-design-status now persists that claim, so keeping
// the `||` would only hide a stored-vs-derived disagreement.
const invSold = (u) => !!u && u.saleState === "sold";
// The one state that means "this is stock a customer can buy today".
const invSellable = (u) => invStage(u) === "at_location" && !invSold(u);
// "SOLD — Dave" (Carolyn 2026-08-07). The name is snapshotted on the unit at the sale, so
// this never has to reach into a customer's design row to render — which is also what lets a
// future public listing show it.
const invSoldLabel = (u) => (u && u.soldFirstName ? `SOLD — ${u.soldFirstName}` : "SOLD");

// Only let a design's image_url become a clickable href when it is an https URL on our own
// origin or our own Supabase project's storage. image_url is stored VERBATIM by the
// anon-granted save_design RPC, so a hostile caller can stash a javascript: or off-site
// phishing URL against any tenant's design — and this link renders inside the owner's
// authenticated portal, behind a "PDF" button they have every reason to trust. Returns
// null if unsafe, so the caller can drop the link entirely rather than render a dead one.
// This is the twin of ssSafeUrl in StructureStudio.jsx / structure-studio.component.js
// (audit #F8). portal.html has no .jsx sibling, so it needs its own copy — keep the three
// in step if the rule changes.
//
// OUR project's storage host, derived from SUPABASE_URL so a project move can't strand it.
// It must be an exact-host match, not a ".supabase.co" suffix: anyone can spin up a free
// Supabase project and get their own *.supabase.co hostname, so the suffix check admitted
// exactly the off-site phishing hosts this function exists to refuse.
const SS_SUPABASE_HOST = new URL(SUPABASE_URL).hostname;
const ssSafeUrl = (u) => {
  try {
    const url = new URL(u, window.location.origin);
    if (url.protocol !== "https:") return null;
    const h = url.hostname;
    return (h === window.location.hostname || h === SS_SUPABASE_HOST) ? u : null;
  } catch { return null; }
};

// ─── ONE BODY SCROLL LOCK, COUNTED ───
// Overlays NEST — an attachment pop-up opens on top of the Projects slide-in — and both of
// them lock the page behind. The save-my-predecessor's-value-and-restore-it idiom each one
// used independently breaks the moment two overlap, because the second to mount captures the
// FIRST one's "hidden" as the value to put back:
//
//   drawer mounts   → prev = ""       → overflow = "hidden"
//   pop-up mounts   → prev = "hidden" → overflow = "hidden"
//   both unmount    → React deletes siblings FIRST-TO-LAST, so the drawer restores "" and
//                     then the pop-up restores "hidden" over the top of it
//
// The page is left unscrollable with nothing open, until a reload. Found live on beta
// 2026-08-28 and reproduced in one gesture: Projects → open an item with an attachment →
// open the attachment → press Escape ONCE (both overlays listen for it) → `document.body`
// still reads `overflow: hidden` with zero `[role=dialog]` on the page, and the board no
// longer scrolls.
//
// A COUNTER fixes every pairing rather than the one pairing we happened to find: the first
// lock records the page's real value, the last release restores it. Each caller gets its own
// release function, and calling it twice is a no-op — an effect cleanup must be idempotent,
// and a double release would drop the count below the number of open overlays and unlock the
// page under one that is still up.
let ssScrollLockCount = 0;
let ssScrollLockPrev = "";
function ssLockBodyScroll() {
  if (ssScrollLockCount === 0) {
    ssScrollLockPrev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  ssScrollLockCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    ssScrollLockCount = Math.max(0, ssScrollLockCount - 1);
    if (ssScrollLockCount === 0) document.body.style.overflow = ssScrollLockPrev;
  };
}

// ─── PDF pop-up ───
// Carolyn, 2026-08-26 21:15: "I want PDFs to open in a pop-up always. I don't want another
// tab to open."
//
// Every quote, floor plan and invoice used to be an <a target="_blank">, so reading one
// meant leaving the portal, and closing it meant hunting for the tab you came from. Her
// whole session was about staying on the record — this is the same instinct as "I don't
// want to switch the screen" about the person card.
//
// ⚠️ The URL goes through ssSafeUrl BEFORE it reaches the iframe, exactly as it did on the
// anchor. An iframe src is a more permissive sink than an href, not a less one: a design
// row's image_url is tenant-writable, and framing an arbitrary origin inside the
// authenticated portal is worse than opening it in a tab where the user can at least see
// the address bar. An unsafe URL renders no viewer at all.
//
// The "Open in a new tab" link stays, deliberately. Some browsers and enterprise policies
// refuse to render PDFs inline, and a viewer that silently shows a grey rectangle with no
// way out is worse than the tab we just took away. It is the escape hatch, not the default.
// `image: true` renders the file as an <img> instead of framing it. Screenshots are the
// common attachment on a bug report, and an iframe shows them tiny in the corner of a
// grey page — same modal, same guards, right presentation for the thing being opened.
function PdfModal({ url, title, onClose, image }) {
  const safe = ssSafeUrl(url);
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    // The page behind a modal must not scroll under it. Counted, not saved-and-restored —
    // this modal opens on top of the Projects drawer, which locks too. See ssLockBodyScroll.
    const unlock = ssLockBodyScroll();
    return () => { window.removeEventListener("keydown", onKey); unlock(); };
  }, [onClose]);
  return (
    <div onClick={onClose} role="presentation"
      style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.6)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 1200 }}>
      <div role="dialog" aria-modal="true" aria-label={title || "Document"} onClick={(e) => e.stopPropagation()}
        style={{ background: "#FFF", borderRadius: 12, width: "min(1000px, 100%)", height: "min(88vh, 100%)", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 20px 50px rgba(0,0,0,0.3)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: "1px solid #E2E8F0", flexShrink: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: "#1E293B", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {title || "Document"}
          </div>
          {safe && (
            <a href={safe} target="_blank" rel="noopener noreferrer"
              style={{ fontSize: 12, fontWeight: 700, color: "#475569", textDecoration: "none", whiteSpace: "nowrap" }}>Open in a new tab ↗</a>
          )}
          <button type="button" onClick={onClose} aria-label="Close"
            style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0", padding: "5px 12px", fontSize: 12 }}>Close</button>
        </div>
        {safe ? (
          image ? (
            <div style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "#0F172A", padding: 12 }}>
              <img src={safe} alt={title || "Attachment"} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
            </div>
          ) : (
            <iframe src={safe} title={title || "Document"} style={{ flex: 1, width: "100%", border: "none" }} />
          )
        ) : (
          <div style={{ padding: 20, fontSize: 13, color: "#B91C1C" }}>
            This document's address is not one we can open safely, so it has not been loaded.
          </div>
        )}
      </div>
    </div>
  );
}

// The one place an unrecognised/absent status becomes "sent". This expression was written out
// by hand in seven places (search, sort, badge, and three times inside the Leads grouping),
// and LeadsTable additionally kept its own private copy of STATUS_RANK — so a filter deriving
// counts from one of them could disagree with the rows rendered from another. One function now.
const normStatus = (s) => (STATUS_LABELS[s] ? s : "sent");

// Unwrap a supabase-js FunctionsHttpError into the message the edge function actually sent.
// Without this every failure reads "Edge Function returned a non-2xx status code" — the real
// { error } body is only on error.context, the raw Response. Cloned before reading because a
// Response body can only be consumed once; the several inline copies of this pattern still
// scattered through the file omit that, which is latent rather than harmless.
const fnError = async (err) => {
  let m = (err && err.message) || "Request failed";
  try {
    const ctx = err && err.context;
    if (ctx && typeof ctx.json === "function") {
      const b = await (typeof ctx.clone === "function" ? ctx.clone() : ctx).json();
      if (b && b.error) m = b.error;
    }
  } catch (_e) { /* fall back to the generic message */ }
  return m;
};

// ─── Status filter chips (Designs + Contacts) ───
// Carolyn, 2026-06-18: filters so a client can tell leads from customers at a glance — the
// urgency came from Junior Barns selling three buildings in one day.
//
// Counts come from the SAME rows the table is about to render, so a chip can never promise
// rows the list won't show. Zero-count chips are omitted rather than greyed: "Delivered" is 0
// on every tenant today (no tenant has the delivered stage mapped), and a permanently dead
// chip reads as a broken feature. `extra` carries Contacts' synthetic "browsing" group, which
// is not a designs.status value at all.
function StatusChips({ counts, value, onChange, extra = [] }) {
  const present = Object.keys(STATUS_LABELS).filter((k) => (counts[k] || 0) > 0).map((k) => [k, STATUS_LABELS[k], STATUS_COLORS[k]]);
  const extras = extra.filter(([k]) => (counts[k] || 0) > 0);
  const items = extras.concat(present);
  // One bucket means the chips carry no information — don't spend a row on them.
  // UNLESS a filter is currently applied: the chip row is the only way to clear it. When the
  // selected bucket empties after a reload (a delete, a sync promotion, a browsing lead becoming a
  // design) the zero-count chip is dropped and only one bucket may remain — which used to hide the
  // whole row INCLUDING "All" while the stale filter stayed active, leaving the table showing "No
  // designs are Accepted yet." with no control to undo it. Refresh re-ran load() but not the
  // filter, so recovery meant switching tabs or reloading the page, neither of which was suggested.
  if (items.length < 2 && (value === "all" || !value)) return null;
  const total = items.reduce((n, [k]) => n + (counts[k] || 0), 0);
  const all = [["all", "All", null]].concat(items);
  return (
    <div role="group" aria-label="Filter by status" style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "0 0 12px" }}>
      {all.map(([k, label, color]) => {
        const on = value === k;
        const n = k === "all" ? total : (counts[k] || 0);
        return (
          <button key={k} type="button" aria-pressed={on} onClick={() => onChange(k)}
            style={{
              display: "flex", alignItems: "center", gap: 7, cursor: "pointer", fontFamily: "inherit",
              fontSize: 12, fontWeight: 700, padding: "5px 11px", borderRadius: 999,
              border: on ? "1px solid " + ACCENT : "1px solid #E2E8F0",
              background: on ? ACCENT : "#FFF", color: on ? "#FFF" : "#475569",
            }}>
            {color && <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 4, background: color.fg, flexShrink: 0, opacity: on ? 0.9 : 1 }} />}
            {label}
            <span style={{ fontSize: 11, fontWeight: 800, color: on ? "#FFF" : "#94A3B8", opacity: on ? 0.85 : 1 }}>{n}</span>
          </button>
        );
      })}
    </div>
  );
}

// ─── Column sorting (shared by the Designs + Leads tables) ───
// Clickable header cell. Clicking cycles the direction on the active column and
// selects a new column (starting ascending). A faded ▲ hints unsorted columns
// are clickable; the active column shows a solid ▲/▼ in the brand accent.
function SortTh({ label, col, sortKey, sortDir, onSort, style, thProps }) {
  const active = sortKey === col;
  return (
    <th
      {...(thProps || {})}
      onClick={() => onSort(col)}
      title={`Sort by ${label}`}
      // ⚠️ MERGE, never `style || S.th`. That fallback meant any caller passing a style
      // — PMTable passes {width} for columns that have one — REPLACED the header
      // typography wholesale, so those headers fell back to the browser's default <th>
      // (big, black, centred) while widthless ones kept the real style. On a Projects
      // board that showed up as every column added through the UI (no width) rendering
      // differently from the seeded ones (Carolyn 2026-08-29, spotted on "Due").
      style={{ ...S.th, ...(style || {}), cursor: "pointer", userSelect: "none", ...((thProps || {}).style || {}) }}
    >
      {label}
      <span style={{ marginLeft: 4, fontSize: 9, verticalAlign: "middle", color: active ? ACCENT : "#CBD5E1" }}>
        {active ? (sortDir === "asc" ? "▲" : "▼") : "▲"}
      </span>
    </th>
  );
}
// Stable-ish sort of `rows` by a per-row comparable value. Blanks (null/""/undefined)
// always sort last regardless of direction; numbers compare numerically and strings
// case-insensitively (with numeric-aware collation so "2" < "10"). ISO date strings
// sort chronologically as plain strings, so no special-casing is needed for dates.
function sortRows(rows, valueOf, dir) {
  const arr = [...rows];
  arr.sort((ra, rb) => {
    const a = valueOf(ra), b = valueOf(rb);
    const ae = a === null || a === undefined || a === "";
    const be = b === null || b === undefined || b === "";
    if (ae && be) return 0;
    if (ae) return 1;   // blanks last, both directions
    if (be) return -1;
    let c;
    if (typeof a === "number" && typeof b === "number") c = a - b;
    else c = String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
    return dir === "asc" ? c : -c;
  });
  return arr;
}
// Toggle helper for a [sortKey,sortDir] pair: same column flips direction, a new
// column starts ascending.
function makeOnSort(sortKey, setSortKey, sortDir, setSortDir) {
  return (col) => {
    if (col === sortKey) { setSortDir((d) => (d === "asc" ? "desc" : "asc")); }
    else { setSortKey(col); setSortDir("asc"); }
  };
}
// Lead activity indicator (traffic light) based on the most-recent activity — i.e. the
// newest design update for that lead. Anon shed-shoppers have no live login/session, so
// "active" is recency-based, not real-time presence. Thresholds are easy to tune here.
function activityInfo(lastActivity) {
  const t = lastActivity ? Date.parse(lastActivity) : NaN;
  if (!t || isNaN(t)) return { color: "#94A3B8", label: "No activity yet" };
  const hours = (Date.now() - t) / 3600000;
  if (hours <= 10)  return { color: "#16A34A", label: "Active recently (within 10 hours)" }; // green
  if (hours <= 720) return { color: "#F59E0B", label: "Used within the last 30 days" };      // orange (720h = 30d)
  return { color: "#EF4444", label: "Idle for over a month" };                               // red
}
// Case-insensitive "search all fields": deep-collects every value in a row
// (including nested contact/selections), plus any derived display text passed as
// `extra`, then requires every whitespace-separated query token to appear
// somewhere. Empty query matches everything.
function rowMatchesQuery(row, query, extra) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;
  const vals = [];
  const walk = (v) => {
    if (v == null) return;
    if (typeof v === "object") { for (const k in v) walk(v[k]); }
    else vals.push(String(v));
  };
  walk(row);
  if (extra) vals.push(String(extra));
  const hay = vals.join(" ").toLowerCase();
  return q.split(/\s+/).every((t) => hay.includes(t));
}

// Search box used by the Designs and Leads tables. Controlled; shows a clear (×) button.
function SearchInput({ value, onChange, placeholder }) {
  return (
    <div style={{ position: "relative", margin: "0 0 12px" }}>
      <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#94A3B8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }}><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder}
        style={{ ...S.input, paddingLeft: 32, paddingRight: 30 }} />
      {value && (
        <button onClick={() => onChange("")} title="Clear search" aria-label="Clear search"
          style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", background: "transparent", border: "none", cursor: "pointer", color: "#64748B", fontSize: 18, lineHeight: 1, padding: "2px 6px" }}>×</button>
      )}
    </div>
  );
}

// ─── Card header ───
// Deliberately NOT coloured: the brand surface is the gradient topbar, and a second coloured
// band directly beneath it would restate the page name and description the topbar already
// carries — the duplication this whole exercise was correcting.
//
// What it keeps is what the topbar does not have: the row count (a light blue chip with
// #3D3672 on it, ~9:1) and the page's own controls. A `desc` is passed only where there is
// operational detail worth stating that the topbar's one-line label does not cover.
function CardHead({ title, count, desc, right, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: "#1E293B", letterSpacing: 0.3 }}>{title}</div>
        {count != null && count !== "" && (
          <span style={{ fontSize: 12.5, fontWeight: 800, background: "#DBEAFF", color: "#3D3672", borderRadius: 6, padding: "1px 8px" }}>{count}</span>
        )}
        {right && <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>{right}</div>}
      </div>
      {(desc || children) && (
        <div style={{ fontSize: 12, color: "#64748B", marginTop: 5, lineHeight: 1.5 }}>
          {desc}{children}
        </div>
      )}
    </div>
  );
}

// ─── Facet filter bar (Designs / Contacts / Orders) ───
// Pattern lifted from the Commissions report's filter bar: labeled controls in a wrap row, a
// red Clear button, and a "Showing N of M" note whenever any facet is active. Facet OPTION
// LISTS must be derived from ALL loaded rows (never the filtered subset) so a filter can never
// hide its own options; status-chip counts likewise stay full-list so they don't shuffle.
const FCTRL = { display: "flex", flexDirection: "column", gap: 3 };
function FacetSelect({ label, value, onChange, options, allLabel = "All" }) {
  return (
    <div style={FCTRL}><span style={S.lbl}>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} style={{ ...S.input, padding: "6px 8px", minWidth: 120 }}>
        <option value="all">{allLabel}</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}
function DateRange({ label, from, to, onFrom, onTo }) {
  return (
    <div style={FCTRL}><span style={S.lbl}>{label}</span>
      <div style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
        <input type="date" value={from} onChange={(e) => onFrom(e.target.value)} style={{ ...S.input, padding: "6px 8px" }} />
        <span style={{ color: "#94A3B8", fontSize: 12 }}>–</span>
        <input type="date" value={to} onChange={(e) => onTo(e.target.value)} style={{ ...S.input, padding: "6px 8px" }} />
      </div>
    </div>
  );
}
// from/to are yyyy-mm-dd strings from <input type=date>; blank = open-ended. `to` is INCLUSIVE
// of the whole end day (compared against the start of the NEXT local day), matching what a
// person means by "to Aug 5". Rows with no date only show when no range is set.
function inDateRange(dateStr, from, to) {
  if (!from && !to) return true;
  if (!dateStr) return false;
  const t = new Date(dateStr).getTime();
  if (!Number.isFinite(t)) return false;
  if (from) { const f = new Date(from + "T00:00:00").getTime(); if (t < f) return false; }
  if (to) {
    // setDate, NOT midnight + 86400000: a fixed 24h misses the two DST-transition days.
    // On the 25h fall-back day it lands at 23:00 — rows from the end day's last hour were
    // silently excluded — and on the 23h spring-forward day it lands at 01:00 the next
    // day, including an hour nobody asked for. Rolling the calendar date lets the Date
    // engine apply the day's real UTC offset.
    const e = new Date(to + "T00:00:00"); e.setDate(e.getDate() + 1);
    if (t >= e.getTime()) return false;
  }
  return true;
}
function FilterBar({ children, hasFilters, onClear, shown, total, noun = "row" }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
        {children}
        {hasFilters && <button onClick={onClear} style={{ ...S.btn("#FEF2F2", "#DC2626"), padding: "6px 12px" }}>Clear</button>}
      </div>
      {hasFilters && <div style={{ fontSize: 12, color: "#64748B", marginTop: 8 }}>Showing <b>{shown}</b> of {total} {noun}{total === 1 ? "" : "s"}.{shown === 0 ? " Nothing matches — adjust the filters." : ""}</div>}
    </div>
  );
}

// ─── Skeletons ───
// Carolyn, 2026-08-26, watching a list sit empty: "the page opens and there's nothing
// there." Then, after Ahsan showed her the grey blocks another product paints while it
// loads (36:26): "so let's do that."
//
// A skeleton is not decoration — it is the difference between "this is broken" and "this
// is coming". The word "Loading…" on an empty card says the former to everyone who has
// ever waited on a broken page, which is everyone.
//
// ⚠️ NO CSS ANIMATION HERE, deliberately. The obvious shimmer is a keyframed gradient, and
// keyframes need a <style> rule — this codebase has no stylesheet for components, every
// style is an inline object, and rAF-driven animation does not run in a backgrounded tab
// (documented on the 3D viewer). A flat block that is honestly still is better than a
// shimmer that freezes half-swept and reads as a hang.
function SkelBar({ w = "100%", h = 11, style = {} }) {
  return <div style={{ width: w, height: h, borderRadius: 4, background: "#E2E8F0", ...style }} />;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab payload cache — stale-while-revalidate for the slow tabs.
//
// 12-shell renders tabs as {activeTab === "x" && <Component/>}, so leaving a tab UNMOUNTS
// it and its state is gone. Coming back re-ran the whole fetch and put the user in front of
// a skeleton again, every time, even for data seconds old. Each slow tab now seeds its
// state from here on mount (synchronously, via a useState initializer, so the first render
// already has rows) and refetches in the background to correct it.
//
// Considered and rejected: keeping those tabs mounted behind display:none the way the
// Designer and the admin console are. Those two are kept for USER state — an in-progress
// design, a half-filled form — which cannot be refetched. A list can. Hidden mounts would
// also keep their window-level key handlers live under whatever tab is on screen, and they
// would show stale data without refreshing it, so the revalidate half of this would still
// have to be built. One cache is less machinery than five hidden trees.
//
// IN-MEMORY ONLY, deliberately: these payloads carry customer names, addresses and money.
// sessionStorage would outlive the sign-out clear below on a shared shop computer, and a
// full reload re-pays the boot chain anyway, so persisting buys little.
const SS_TAB_CACHE_ON = true;          // one-line kill switch if cached data is ever suspect
const SS_TAB_CACHE_MAX_AGE = 10 * 60 * 1000;
const ssTabCache = new Map();
// Who the cached payloads belong to. A module global maintained by PortalApp, the same
// shape as ssTargetClientId above, so a tab deep in the tree can key its cache correctly
// without every component in between growing a prop it does not otherwise use.
let ssCurrentUserId = null;
function ssSetCurrentUser(id) {
  if (id !== ssCurrentUserId) { ssCurrentUserId = id || null; ssTabCache.clear(); }
}

// The key carries WHO as well as WHAT. Tenant, because an operator viewing another builder
// must never see the previous one's rows; user id, because portal-commissions scopes
// list_entries to the CALLER (a rep sees only their own lines, and rates are hidden unless
// they may see them), so a payload keyed by tenant alone would leak across a sign-out and
// sign-in on the same machine.
function ssCacheKey(fn, action, tenant) {
  return (ssCurrentUserId || "anon") + "|" + (tenant || "own") + "|" + fn + "|" + action;
}
function ssCacheGet(fn, action, tenant) {
  if (!SS_TAB_CACHE_ON) return null;
  const hit = ssTabCache.get(ssCacheKey(fn, action, tenant));
  return hit && (Date.now() - hit.at) < SS_TAB_CACHE_MAX_AGE ? hit.data : null;
}
// Only ever called with a payload that came back clean. Never cache the empty scaffold a
// failed load falls back to ({ entries: [] } and friends) — one blip would otherwise paint
// an empty tab instantly for the next ten minutes and look like data loss.
function ssCachePut(fn, action, tenant, data) {
  if (!SS_TAB_CACHE_ON || !data || data.error) return;
  ssTabCache.set(ssCacheKey(fn, action, tenant), { data, at: Date.now() });
}
function ssCacheClear() { ssTabCache.clear(); }

// Boot an edge function's isolate ahead of the click that needs it. A cold portal-schedule
// or portal-commissions costs ~2.5s before it runs a single query — measured, and it is the
// single largest slice of what "the schedule tab is slow" actually meant.
//
// Raw fetch, NOT sb.functions.invoke, for three reasons: invoke awaits getSession() first
// (work this does not need), it logs any non-2xx to app_errors (a ping firing on every boot
// must never file rows), and it goes through ssFetch, whose 401 handling drives the
// session-expiry screen — a warm-up must not be able to sign anyone out. The response is
// deliberately ignored: booting the isolate IS the whole point, and against a server that
// predates the ?warm=1 endpoint this must fail in complete silence.
function ssWarmFn(name) {
  try {
    fetch(SUPABASE_URL + "/functions/v1/" + name + "?warm=1", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": "Bearer " + SUPABASE_ANON_KEY,
      },
      body: "{}",
    }).catch(() => {});
  } catch (_e) { /* a warm-up must never be why something failed */ }
}

// Table-shaped skeleton: the same column count as the real table, so the header row and the
// first paint line up and nothing jumps when the rows arrive.
function SkelRows({ cols = 5, rows = 6, widths = null }) {
  const w = widths || Array.from({ length: cols }, (_, i) => (i === 0 ? "62%" : i === cols - 1 ? "40%" : "72%"));
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        <tr key={r}>
          {Array.from({ length: cols }, (_, c) => (
            <td key={c} style={{ padding: "11px 10px", borderTop: "1px solid #F1F5F9" }}>
              {/* Fade down the list: the eye reads it as "more below", not as six equal
                  pending things it has to track. */}
              <SkelBar w={w[c]} style={{ opacity: 1 - r * 0.11 }} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

// ─── Thumbnail frame ───
// Carolyn, 2026-08-26, on the order screen: "it's taking a little bit for it to load here
// … these are images." Then, once Ahsan showed her the grey blocks: "can we put things in
// place to load … at segments".
//
// The frame is reserved at a fixed height either way, so nothing on the page moves when the
// picture arrives — that part was already right. What was missing is that the reserved box
// sat BLANK WHITE for the whole download, which is the same "there's nothing there" she
// complained about on Contacts, one level down.
//
// Three things do the work:
//   * `loading="lazy"` — these sit well below the fold on the order document, so on a page
//     somebody opens to check a balance the bytes are never fetched at all.
//   * `decoding="async"` — decoding a large plan render is not free, and it has no business
//     blocking the main thread while the rest of the page is still settling.
//   * a skeleton INSIDE the reserved box until `onLoad` fires, so the space reads as
//     "coming" rather than as "empty".
//
// A failed image says so in words. The default is a broken-image glyph, which on a screen
// full of a customer's paperwork reads as "their design is gone" rather than "this picture
// did not load".
function ThumbFrame({ src, alt, title, onOpen, height = 280 }) {
  const [state, setState] = useState("loading"); // loading | ok | error
  const box = {
    display: "flex", alignItems: "center", justifyContent: "center",
    background: "#FFF", border: "1px solid #E2E8F0", borderRadius: 8,
    padding: 5, height, width: "100%", boxSizing: "border-box",
  };
  if (state === "error") {
    return (
      <div style={{ ...box, background: "#F8FAFC", borderStyle: "dashed" }}>
        <p style={{ fontSize: 11, color: "#94A3B8", lineHeight: 1.45, textAlign: "center", margin: 0 }}>
          This picture didn&rsquo;t load.{onOpen ? " Use Full ↗ to open it directly." : ""}
        </p>
      </div>
    );
  }
  return (
    <button type="button" title={title} onClick={onOpen}
      style={{ ...box, cursor: onOpen ? "pointer" : "default", position: "relative" }}>
      {state === "loading" && (
        <SkelBar w="82%" h={Math.max(40, height - 90)} style={{ position: "absolute", borderRadius: 6 }} />
      )}
      <img src={src} alt={alt} loading="lazy" decoding="async"
        onLoad={() => setState("ok")} onError={() => setState("error")}
        style={{
          maxHeight: height - 12, maxWidth: "100%", width: "auto", display: "block",
          position: "relative",
          // Hidden rather than unmounted: the <img> has to be in the DOM for the browser to
          // start fetching it at all, and unmounting on load would restart the download.
          opacity: state === "ok" ? 1 : 0,
        }} />
    </button>
  );
}

// ─── Page size ───
// Carolyn, 2026-08-26 37:40: "some companies have 10, 20, 30, 40, 50, 100 — which is
// probably what we need to build into it." Thirty is her default because it is the number
// she said last and the number the tenants she was looking at were already showing.
//
// This pages what is ALREADY IN MEMORY. It is a rendering cap, not a query cap: the reads
// stay whole, so the counts, the KPI tiles and the search still see every row. Paging the
// query instead would make "3 of 412" a lie the moment someone typed in the search box.
const PAGE_SIZES = [10, 20, 30, 50, 100];
const DEFAULT_PAGE_SIZE = 30;

function PageBar({ size, onSize, page, onPage, total, noun = "row" }) {
  const pages = Math.max(1, Math.ceil(total / size));
  const cur = Math.min(page, pages);
  const from = total === 0 ? 0 : (cur - 1) * size + 1;
  const to = Math.min(total, cur * size);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 12, fontSize: 12, color: "#64748B" }}>
      <span>Show</span>
      <select value={size} onChange={(e) => { onSize(Number(e.target.value)); onPage(1); }}
        style={{ ...S.input, width: "auto", padding: "4px 8px", fontSize: 12 }}>
        {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
      <span>{total === 0 ? `No ${noun}s` : `${from}–${to} of ${total} ${noun}${total === 1 ? "" : "s"}`}</span>
      {pages > 1 && (
        <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6 }}>
          <button type="button" disabled={cur <= 1} onClick={() => onPage(cur - 1)}
            style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0", padding: "4px 10px", opacity: cur <= 1 ? 0.45 : 1, cursor: cur <= 1 ? "default" : "pointer" }}>← Prev</button>
          <span style={{ fontWeight: 700, color: "#475569" }}>Page {cur} of {pages}</span>
          <button type="button" disabled={cur >= pages} onClick={() => onPage(cur + 1)}
            style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0", padding: "4px 10px", opacity: cur >= pages ? 0.45 : 1, cursor: cur >= pages ? "default" : "pointer" }}>Next →</button>
        </span>
      )}
    </div>
  );
}

// Remembering the choice is the whole point — a rep who picks 100 wants 100 tomorrow too,
// and re-picking it every morning is how a setting becomes an annoyance. Per table, because
// Contacts and Orders are different-shaped lists. localStorage can throw (private windows,
// blocked site data), so every read and write is guarded and falls back to the default.
function usePageSize(key) {
  const [size, setSize] = useState(() => {
    try {
      const v = Number(window.localStorage.getItem("ss.pageSize." + key));
      return PAGE_SIZES.includes(v) ? v : DEFAULT_PAGE_SIZE;
    } catch (_e) { return DEFAULT_PAGE_SIZE; }
  });
  const set = useCallback((n) => {
    setSize(n);
    try { window.localStorage.setItem("ss.pageSize." + key, String(n)); } catch (_e) { /* a remembered size is a nicety */ }
  }, [key]);
  return [size, set];
}

// ─── Delete a design ───
// Carolyn, 2026-06-24: until now a deletion meant going into Supabase by hand.
//
// Anything past Sent has a real estimate in the tenant's GHL, so it is a billing record and
// takes a typed confirmation (Ahsan's call: allow it, but make them type it). Sent designs
// delete on a single confirm — they cost nothing to recreate.
//
// Reuses AdmOverlay (Esc-to-close, overlay-click, aria-modal) from the Admin section further
// down the file — safe because function declarations hoist, and it means one dialog shell.
function DeleteDesignDialog({ design, onClose, onDeleted }) {
  const st = normStatus(design.status);
  // Drafts are even cheaper than Sent — never submitted, no estimate, no PDF — so they
  // share the single-confirm path (matches portal-settings, which treats any status
  // outside its billing list as "sent" for this same check).
  const needsConfirm = st !== "sent" && st !== "draft";
  const expected = design.ghl_estimate_number ? String(design.ghl_estimate_number) : design.short_code;
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const ready = !busy && (!needsConfirm || typed.trim() === expected);

  const go = async () => {
    if (!ready) return;
    setBusy(true); setErr(null);
    const { data, error } = await sb.functions.invoke("portal-settings", {
      // deleteEstimate is explicit because the server refuses to touch the CRM without
      // it — this page's dialog is what tells the operator the estimate goes too, and the
      // previous build's dialog promised the opposite. The flag is how the server knows
      // which promise the operator actually read.
      body: { action: "delete_design", shortCode: design.short_code, deleteEstimate: true, ...(needsConfirm ? { confirmToken: typed.trim() } : {}) },
    });
    if (error) { setErr(await fnError(error)); setBusy(false); return; }
    onDeleted(data || {});
  };

  return (
    <AdmOverlay onClose={busy ? () => {} : onClose} maxWidth={460} labelledBy="del-design-ttl">
      <div id="del-design-ttl" style={{ fontSize: 17, fontWeight: 700, color: "#991B1B", marginBottom: 10 }}>
        Delete this design?
      </div>
      <div style={{ fontSize: 13.5, color: "#475569", lineHeight: 1.55, marginBottom: 14 }}>
        <strong>{(design.contact || {}).name || "This customer"}</strong>
        {design.ghl_estimate_number ? <> · EST-{design.ghl_estimate_number}</> : null} · {STATUS_LABELS[st]}
        <div style={{ marginTop: 8 }}>
          Removes the design, its full version history and the saved PDFs. This cannot be undone.
        </div>
        {/* The CRM half, stated plainly, because it is the part that reaches outside this
            app. Three genuinely different outcomes, so this says which one applies to THIS
            design rather than one sentence that is wrong two-thirds of the time. The server
            decides for real (it checks the invoice ledger, not just the cached status). */}
        {design.ghl_estimate_number ? (
          (st === "invoiced" || st === "delivered") ? (
            <div style={{ marginTop: 8, color: "#92400E" }}>
              EST-{design.ghl_estimate_number} is <strong>kept</strong> in your CRM — an invoice was created from it.
              Void that invoice there if you want the estimate gone too.
            </div>
          ) : (
            <div style={{ marginTop: 8, color: "#64748B" }}>
              EST-{design.ghl_estimate_number} is <strong>also deleted</strong> from your CRM. The customer and their
              opportunity stay — only the estimate goes.
            </div>
          )
        ) : (
          <div style={{ marginTop: 8, color: "#64748B" }}>
            No estimate has been created in your CRM for this design.
          </div>
        )}
      </div>
      {err && <div style={S.err}>{err}</div>}
      {needsConfirm && (
        <>
          <div style={{ background: "#FEF3C7", border: "1px solid #F59E0B", borderRadius: 8, padding: "10px 14px", color: "#92400E", fontSize: 12.5, marginBottom: 12, lineHeight: 1.5 }}>
            This design is <strong>{STATUS_LABELS[st]}</strong> — a billing record.
          </div>
          <label style={S.lbl}>Type <code>{expected}</code> to confirm</label>
          <input value={typed} onChange={(e) => setTyped(e.target.value)} disabled={busy} autoFocus
            onKeyDown={(e) => { if (e.key === "Enter") go(); }} placeholder={expected}
            style={{ ...S.input, marginBottom: 16 }} />
        </>
      )}
      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", flexWrap: "wrap" }}>
        <button type="button" onClick={onClose} disabled={busy} style={S.btn("#F1F5F9", "#334155")}>Cancel</button>
        <button type="button" onClick={go} disabled={!ready}
          title={!ready ? `Type ${expected} to confirm` : undefined}
          style={{ ...S.btn(ready ? "#DC2626" : "#FCA5A5", "#FFF"), cursor: ready ? "pointer" : "not-allowed" }}>
          {busy ? "Deleting…" : "Delete design"}
        </button>
      </div>
    </AdmOverlay>
  );
}

// Where a quote's building came from, shown behind the building name (Carolyn, 2026-08-02).
// PER VERSION, not per design: one customer can be quoted a lot building (v1 = Inventory)
// and then a fresh custom build (v2 = New) on the same quote.
function SourceChip({ unitId, serial, lifecycle = null }) {
  const inv = Boolean(unitId);
  // "already on the lot" became a lie the day a building could be quoted before it was built,
  // so say where it actually is when we know. Falls back to the old wording when we don't —
  // an operator in view-as cannot read inventory_units (owner-select RLS).
  const stageWord = lifecycle && INV_STAGE_LONG[lifecycle] ? INV_STAGE_LONG[lifecycle] : null;
  return (
    <span title={inv
      ? (stageWord ? `Quoted from building #${serial != null ? serial : "?"} — ${stageWord}` : "Quoted from one of your inventory buildings")
      : "Designed for this customer"}
      style={{ marginLeft: 7, background: inv ? "#DBEAFF" : "#F1F5F9", color: inv ? "#3D3672" : "#475569",
        borderRadius: 12, fontSize: 10.5, fontWeight: 800, padding: "2px 8px", whiteSpace: "nowrap" }}>
      {inv ? (serial != null ? `Inventory #${serial}` : "Inventory") : "New"}
    </span>
  );
}

