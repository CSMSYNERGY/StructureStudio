// The merged Contacts & Designs era (2026-08-24 → 08-26, commit 4a54dad) published two
// sub-view URLs: /portal/designs/people and /portal/designs/deals. The 08-26 split makes
// each of those views a whole tab again, so the two legacy subs rewrite themselves —
// "people" is now /portal/contacts, "deals" is now plain /portal/designs.
//
// `replace` so an alias never sits in history and traps the back button on itself.
//
// ⚠️ RECORD SUBS (c-…/d-…) ARE DELIBERATELY NOT TOUCHED HERE. The record dispatch below
// accepts them under either tab, and rewriting one across tabs would be actively harmful:
// the URL-normalising effect nulls a refused tab's sub, so sending a designs-only user's
// /portal/designs/c-<id> over to `contacts` would bounce off the clamp and lose the record
// they were looking at. A legacy record URL renders the record; only the two list views
// need correcting, because only they stopped existing.
function DesignsLegacySub({ sub, navigate }) {
  useEffect(() => {
    if (sub === "people") navigate("contacts", null, true);
    else if (sub === "deals") navigate("designs", null, true);
  }, [sub]);
  return null;
}

// ── Nav rail glyphs ───────────────────────────────────────────────────────────
// MODULE SCOPE, not a Dashboard local. These are ~22 static SVG trees with nothing
// from the component in them, and building them inside the body rebuilt every one of
// them on every render of the shell — a tab switch, a token refresh, a picker toggle.
// Built once at load instead; React elements are immutable, so sharing them is exactly
// what they are for. Keyed by tab id: navItem/soonItem look the glyph up by the same id
// the router uses, so a tab without an entry renders its label with no icon rather than
// throwing.
const ICONS = {
  admin: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>),
  designer: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>,
  quickbooks: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 12a3 3 0 0 1 3-3h1v9"/><path d="M16 12a3 3 0 0 1-3 3h-1V6"/></svg>,
  accounts: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="9" height="14" rx="1"/><rect x="13" y="3" width="9" height="18" rx="1"/><path d="M6 11h1M6 15h1M17 7h1M17 11h1M17 15h1"/></svg>,
  // Kanban columns of descending height — the section is named Pipeline now, and the old
  // staggered grid read as "a dashboard of things" rather than a board of stages.
  designs: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="5" height="18" rx="1"/><rect x="10" y="3" width="5" height="12" rx="1"/><rect x="17" y="3" width="5" height="7" rx="1"/></svg>,
  // Clipboard with a check — the internal boards. NOT kanban columns: "designs" (Pipeline)
  // took that glyph in the same week, and two column icons in one rail read as one thing.
  projects: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="m9 14 2 2 4-4"/></svg>,
  contacts: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>,
  orders: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.27 6.96 12 12.01l8.73-5.05M12 22.08V12"/></svg>,
  pricing: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 21h18"/><path d="M5 21V8l7-5 7 5v13"/><path d="M10 21v-5h4v5"/><path d="M9 9h.01M15 9h.01"/></svg>,
  "layout-pricing": <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M3 12h18M3 18h18"/><path d="M7 3v3M12 3v3M17 3v3"/></svg>,
  colors: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="8" cy="9.5" r="1.3"/><circle cx="15.5" cy="9.5" r="1.3"/><circle cx="16.5" cy="14" r="1.3"/><path d="M12 21a3 3 0 0 1 0-6 2 2 0 0 0 0-4"/></svg>,
  settings: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
  billing: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>,
  "on-demand-pricing": <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2 3 14h9l-1 8 10-12h-9z"/></svg>,
  "build-schedule": <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/></svg>,
  "delivery-schedule": <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 17h4V5H2v12h3"/><path d="M20 17h2v-3.34a4 4 0 0 0-1.17-2.83L19 9h-5v8h1"/><circle cx="7.5" cy="17.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/></svg>,
  "inventory": <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 8V21H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/></svg>,
  "repairs": <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>,
  // Faceted wireframe cube — deliberately NOT the rounded package glyph used by
  // "orders", so the two read as different things in the rail.
  "view-3d": <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2 3 7v10l9 5 9-5V7z"/><path d="m3 7 9 5 9-5"/><path d="M12 12v10"/></svg>,
  "rent-to-own-contracts": <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6M9 17h4"/></svg>,
  "self-serve-display-units": <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>,
  "commissions": <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="19" y1="5" x2="5" y2="19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/></svg>,
  "reports": <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/><line x1="3" y1="20" x2="21" y2="20"/></svg>,
};

function Dashboard({ session }) {
  const [tenant, setTenant] = useState(null);   // { clientId, businessName } | "none" | null(loading)
  // Seeded FROM THE URL, so a refresh or a pasted deep link lands where it says it will.
  // An unknown slug falls back to designs rather than rendering an empty shell.
  const [tab, setTab] = useState(() => {
    const p = ssParsePath();
    return (p.page && TAB_META[p.page]) ? p.page : "designs";
  });
  // The Settings / Admin sub-page, lifted out of those shells so it can live in the URL.
  const [sub, setSub] = useState(() => ssParsePath().sub || null);
  // What the URL ASKED for, held until the role/operator gates have resolved. Without this
  // the clamp below runs on the first render — when isOperator is still false because
  // app_operators hasn't come back — and silently rewrites /portal/admin to designs before
  // the answer arrives. Cleared the moment it is honoured or provably refused.
  const wanted = useRef((() => { const p = ssParsePath(); return p.page && TAB_META[p.page] ? p.page : null; })());

  // Same-document navigation. Anchors and location.assign are deliberately NOT used: the
  // designer and the operator console are keep-mounted, and a real navigation would
  // discard an in-progress design or a half-filled admin form.
  const navigate = useCallback((page, nextSub = null, replace = false) => {
    wanted.current = null;                 // an explicit click supersedes the boot intent
    setTab(page);
    setSub(nextSub);
    try {
      const url = ssPagePath(page, nextSub);
      if (replace) window.history.replaceState({ page, sub: nextSub }, "", url);
      else window.history.pushState({ page, sub: nextSub }, "", url);
    } catch (_e) { /* history unavailable — the app still works, the URL just won't track */ }
  }, []);

  // (Back/forward lives further down, after exitAccount — the popstate handler has to
  // reconcile `viewing` with the restored URL's ?view=, and up here isOperator/viewing/
  // setOpenDesign are still var-hoisted `undefined`, silently, never a throw — the
  // canAdminForUrl comment tells that story.)

  // Designer tab: lazy-mount on first open, then KEEP mounted (display toggle below).
  // A conditional {activeTab==="designer" && …} unmount would discard the user's
  // in-progress design and re-fetch config on every tab switch.
  const [designerOpened, setDesignerOpened] = useState(false);
  // Same lazy-then-keep-mounted treatment for the operator console (see the render).
  const [adminOpened, setAdminOpened] = useState(false);
  // MUST live up here with the other hooks — Dashboard has conditional early returns
  // below (tenant loading/none), and a hook after them changes the hook count between
  // renders (React error #310, blank screen). Keyed on raw `tab`, not the derived
  // activeTab, so the lazy mount latches on the click itself and the host below decides
  // visibility. ⚠️ The old reason given here — "designer is in NONADMIN_TABS so the clamp
  // never rewrites it" — is FALSE and was the excuse behind the dead Open buttons: that
  // holds only on ssCanSeeTab's `!access` branch, and since migration 100 the status call
  // ships a resolved map, so the clamp takes the TAB_AREA.designer branch and DOES rewrite
  // this tab for a title without that area. openInDesigner refuses before navigating now,
  // which is what keeps `tab` off "designer" for those people; a hand-typed /portal/designer
  // still latches this and mounts the host hidden, which costs a fetch and shows nothing.
  useEffect(() => { if (tab === "designer") setDesignerOpened(true); }, [tab]);
  useEffect(() => { if (tab === "admin") setAdminOpened(true); }, [tab]);
  // Bumped when the embedded designer submits, so DesignsTable refetches on next view.
  const [designsRefreshKey, setDesignsRefreshKey] = useState(0);
  // "Open in the portal designer" request ({clientId, code, version, n}) set by the
  // Designs/Contacts Open buttons. Tenant-tagged so a stale request survives a view-as
  // switch harmlessly (filtered at the DesignerTab mount, never hydrating the wrong
  // tenant's designer); `n` gives every click a fresh identity so re-opening the same
  // design re-fires the component's loader effect.
  const [openDesign, setOpenDesign] = useState(null);
  // Bumped when the feedback widget files something, so My Submissions + its tab
  // count pick it up without a page reload.
  const [feedbackKey, setFeedbackKey] = useState(0);
  // ── Operator account switcher (GHL-subaccounts style) ──
  // isOperator only decides whether the Accounts tab SHOWS; every cross-tenant read
  // is re-authorized server-side by the operator-portal edge fn (app_operators check).
  // ── Billing gate ──
  // Entitlement is computed SERVER-SIDE (portal-billing) — the browser can't read the
  // exempt flag, so this state is a rendering hint, not the authority. null = still
  // loading: we do NOT lock during the fetch, or every page load would flash a
  // paywall at paying customers.
  const [entitlement, setEntitlement] = useState(null);

  const [isOperator, setIsOperator] = useState(false);
  useEffect(() => {
    let cancelled = false;
    // ⚠️ A FAILED rpc IS NOT AN ANSWER OF `false`. supabase-js RESOLVES `{data, error}`
    // rather than rejecting, so the old `({ data })` destructure read a 403 or a 5xx as a
    // plain "not an operator" — and since this effect re-runs whenever a new token lands,
    // one bad answer mid-session unmounted AdminShell at the render below and binned the
    // staged work the keep-mounted comment there exists to protect, then remounted it blank
    // on its default sub with nothing recorded anywhere. The 403 is reachable: 051 revoked
    // EXECUTE from anon, and the anon-key refresh window (01-core's invoke wrapper) sends
    // exactly that key. Keep the last known answer on a non-success and let the next auth
    // event ask again — the same "never lock someone out because a call failed" posture as
    // the entitlement fetch. Still fails CLOSED on a cold load, where false is the initial.
    sb.rpc("is_operator").then(({ data, error }) => { if (!cancelled && !error) setIsOperator(!!data); }).catch(() => {});
    return () => { cancelled = true; };
    // ⏱ KEYED ON THE TOKEN, NOT THE SESSION OBJECT — the same reason spelled out on the
    // entitlement effect below. onAuthStateChange mints a NEW session object on every auth
    // event (INITIAL_SESSION, then SIGNED_IN, then each refresh) and PortalApp stores it, so
    // `[session]` re-ran this rpc — and its two siblings, and the profile read — several
    // times over during a single cold boot for one unchanged answer. The token is a string:
    // equal tokens compare equal, a real rotation still re-asks, and the non-answer posture
    // above is untouched.
  }, [session.access_token]);
  // viewing = { clientId, companyName } while an operator has another tenant's portal
  // open. Designs/Contacts then read through operator-portal:get_portal (service-role,
  // audit-logged); statuses shown are the CACHED values (sync-design-status is
  // owner-JWT-bound and must not run against the operator's own tenant).
  const [viewing, setViewing] = useState(null);

  // Fetches the entitlement declared above — split from its useState and placed BELOW
  // `viewing` because Babel compiles const to var, so a `viewing` read above its useState
  // is silently `undefined`, never a throw (the canAdminForUrl comment tells that story).
  // This state is the OPERATOR's OWN entitlement (gateLocked/featureOn depend on that),
  // but portal-billing is in SS_TENANT_SCOPED_FNS: with view-as armed the invoke wrapper
  // injects targetClientId, so a TOKEN_REFRESHED re-render used to store the VIEWED
  // tenant's entitlement here and lock the operator's own portal after Exit (audit
  // 2026-08-20). Skipped while viewing; the `viewing` dep refetches on exit, so nothing
  // goes stale either. Keyed on the token, not the session object — onAuthStateChange
  // mints a new session object on EVERY auth event, token change or not.
  useEffect(() => {
    if (viewing) return;
    let cancelled = false;
    (async () => {
      try {
        const { data } = await sb.functions.invoke("portal-billing", { body: { action: "status" } });
        if (!cancelled && data && data.entitlement) setEntitlement(data.entitlement);
      } catch (_e) { /* leave null — never lock someone out because a call failed */ }
    })();
    return () => { cancelled = true; };
  }, [session.access_token, viewing]);

  // ── SUPPORT OPERATOR (migration 176) ─────────────────────────────────────────
  // A support operator stands in the builder's shoes: the server resolves the VIEWED
  // tenant's owner map instead of the operator god view. The browser has to agree, or the
  // nav offers tabs whose every action 403s — the "disabled UI fails silently" shape, one
  // level up.
  //
  // A SECOND rpc rather than a richer `is_operator`: that one is called by a live page and
  // would break the moment its boolean became a record, and a schema change and a static
  // asset cannot be deployed atomically. Same non-answer posture as its sibling above — a
  // failed call keeps the last known value rather than reading as `false`, because false
  // here means "full operator rights", which is the wrong way to fail.
  const [isSupportOp, setIsSupportOp] = useState(false);
  useEffect(() => {
    let cancelled = false;
    sb.rpc("is_support_operator").then(({ data, error }) => { if (!cancelled && !error) setIsSupportOp(!!data); }).catch(() => {});
    return () => { cancelled = true; };
    // Token-keyed, exactly as is_operator above — see the note there.
  }, [session.access_token]);

  // THE SECOND DOOR INTO PROJECTS (migration 183). True for an operator, and ALSO for a CSM
  // Synergy team member granted the `projects` area on Settings → Team — someone who has no
  // access to any builder's account and should not need one to file a bug.
  //
  // A THIRD rpc, for the same reason there is a second: is_operator is called by a live page
  // and cannot grow a field, because a schema change and a static asset do not deploy
  // atomically. can_open_projects answers both doors server-side so the browser never has to
  // reconstruct the rule — and portal-projects re-checks it regardless, since a nav item is
  // a courtesy and not a control.
  //
  // ⚠️ THREE STATES, NOT TWO: null = still asking, and it is not the same as "no".
  //
  // A plain false start would be safe for RENDERING (no tab is the right way to be wrong) and
  // wrong for ROUTING: the URL-normalising effect below runs before this call returns, would
  // read false as a refusal, and would replaceState a typed /portal/projects away to
  // /portal/designs while the page itself rendered Projects correctly a moment later. That is
  // the precise silent failure the placement comment on that effect was written about, and it
  // only ever showed up on the operator-gated tabs. So `gatesResolved` waits for a real
  // answer, exactly as it already does for `entitlement`.
  //
  // Truthiness still governs display, so null renders nothing. A failed call keeps the last
  // value rather than answering false — same non-answer posture as its two siblings above.
  const [canProjects, setCanProjects] = useState(null);
  useEffect(() => {
    let cancelled = false;
    sb.rpc("can_open_projects").then(({ data, error }) => { if (!cancelled && !error) setCanProjects(!!data); }).catch(() => {});
    return () => { cancelled = true; };
    // Token-keyed, exactly as its two siblings above — see the note on is_operator. The
    // three-state null start is unaffected: nothing here answers sooner or later than it
    // did, it simply stops being asked four more times for the same token.
  }, [session.access_token]);

  // Only ever true INSIDE a tenant. On the operator's own portal a support account is just
  // a normal user of the CSM Synergy tenant, and narrowing there would lock them out of
  // their own account.
  const supportView = !!viewing && isSupportOp;

  // ⚠️ A SEPARATE STATE, NOT `tenant` / `entitlement` — and that separation IS the fix from
  // audit 2026-08-20. Both of those hold the OPERATOR'S OWN values and both effects above
  // skip while viewing, precisely because the invoke wrapper injects targetClientId and a
  // TOKEN_REFRESHED re-render would otherwise overwrite them with the viewed tenant's and
  // lock the operator's own portal after Exit. Writing the viewed values into a third place
  // gets the support view what it needs without reintroducing that bug.
  //
  // Null means NOT LOADED, never "nothing" — the readers below fall back to the operator's
  // own values while it is null, so a slow call shows the old behaviour for a moment rather
  // than flashing an empty portal at Jonathan mid-call.
  const [viewedCtx, setViewedCtx] = useState(null);
  useEffect(() => {
    if (!supportView) { setViewedCtx(null); return; }
    let cancelled = false;
    (async () => {
      try {
        // Both are in SS_TENANT_SCOPED_FNS, so the wrapper injects targetClientId and these
        // answer for the VIEWED tenant — which is exactly what is wanted here and exactly
        // what the two effects above must avoid.
        const [st, bl] = await Promise.all([
          sb.functions.invoke("portal-settings", { body: { action: "status" } }),
          sb.functions.invoke("portal-billing", { body: { action: "status" } }),
        ]);
        if (cancelled) return;
        setViewedCtx({
          access: (st.data && st.data.access) || null,
          entitlement: (bl.data && bl.data.entitlement) || null,
        });
      } catch (_e) { /* leave null — the fallbacks below keep the portal usable */ }
    })();
    return () => { cancelled = true; };
  }, [supportView, viewing && viewing.clientId, session.access_token]);

  // Keep the address bar honest about where you actually are.
  //
  // Placement is doubly constrained, and BOTH constraints bit once.
  //   Below the early returns (tenant loading / no tenant) → the hook count changes
  //     between renders → React error #310 → blank screen.
  //   Above `isOperator`/`viewing`/`entitlement` → Babel compiles const to var, so those
  //     read `undefined` instead of throwing, `undefined` is falsy, and ssClampTab quietly
  //     rewrote /portal/admin and /portal/accounts to /portal/designs while the page
  //     correctly rendered Admin. Silent, and only on the two operator-gated tabs.
  // So: after every state it reads, before the first early return. Do not move it.
  // It recomputes the clamp via ssClampTab rather than reading `activeTab`, which is only
  // available after those returns.
  //
  // Two jobs. (1) A cold load at bare /portal has no page in the path, so write the
  // resolved one in with replaceState — no history entry, because you did not navigate.
  // (2) If the clamp REFUSED the requested page (a team member deep-linking /portal/admin),
  // rewrite the URL to what is really on screen. Leaving the old path up is worse than the
  // bounce: reload and you bounce again, so the link looks half-broken.
  //
  // `wanted` holds the URL's request until the gates have actually resolved, so an operator
  // whose app_operators row is still in flight is not mistaken for a refusal.
  // A support operator is NOT an admin of the tenant they are viewing — the clamp has to
  // apply to them so the access map governs which tabs resolve. Platform operators keep the
  // blanket, which is what stops a subscription lapse locking us out of fixing an account.
  const canAdminForUrl = viewing ? (isOperator && !supportView) : (tenant && tenant !== "none" && (tenant.role === "owner" || tenant.role === "admin"));
  // ⚠️ canProjects belongs in BOTH clamps or a typed /portal/projects gets rewritten away
  // under a team member while the page itself renders correctly — the exact silent,
  // operator-tabs-only failure the placement comment above this block was written about.
  const resolvedTab = ssClampTab(tab, isOperator, !!canAdminForUrl,
    (tenant && tenant !== "none") ? tenant.access : null, supportView, canProjects);
  useEffect(() => {
    if (!tenant || tenant === "none") return;          // nothing routable yet
    const p = ssParsePath();
    const gatesResolved = (isOperator || canAdminForUrl || entitlement !== null) && canProjects !== null;
    if (wanted.current && wanted.current !== resolvedTab && !gatesResolved) return;
    if (wanted.current) wanted.current = null;
    // If the clamp REFUSED the tab, the sub segment belonged to the refused page and must
    // go with it: a team member landing on /portal/admin/billing bounces to designs, where
    // "billing" matches none of that tab's sub branches (c-/d-/deals/people) — the body
    // rendered EMPTY and the rewrite below then published /portal/designs/billing, a URL
    // that reproduces the blank on every reload. Null it and let the re-run write the clean
    // path. Safe to do only HERE, after the wanted/gatesResolved wait above — at clamp time
    // proper (first render) isOperator is still false, and stripping then would cost an
    // operator's /portal/admin/<sub> deep link its sub before the answer arrives.
    if (resolvedTab !== tab && sub !== null) { setSub(null); return; }
    if (p.page === resolvedTab && (p.sub || null) === (sub || null)) return;
    try { window.history.replaceState({ page: resolvedTab, sub }, "", ssPagePath(resolvedTab, sub)); } catch (_e) {}
  }, [resolvedTab, tab, sub, isOperator, canAdminForUrl, entitlement, tenant]);
  const viewingFetch = useCallback(async () => {
    const { data, error } = await sb.functions.invoke("operator-portal", { body: { action: "get_portal", clientId: viewing.clientId } });
    if (error) {
      let msg = error.message;
      try { const ctx = await error.context.json(); if (ctx && ctx.error) msg = ctx.error; } catch (_e) {}
      throw new Error(msg || "Could not load this account.");
    }
    // Backfill the real company name (a ?view= deep link seeds it with the slug).
    if (data.companyName) setViewing((cur) => (cur && cur.clientId === data.clientId && cur.companyName !== data.companyName) ? { ...cur, companyName: data.companyName } : cur);
    return { designs: data.designs || [], versions: data.versions || [], capturedLeads: data.capturedLeads || [] };
  }, [viewing && viewing.clientId]);
  // GHL-subaccounts-style deep link: /portal.html?view=<clientId> (e.g. from the
  // admin console's "Open portal ↗") auto-opens that account once the operator
  // check passes. Non-operators: ignored (and the server rejects reads anyway).
  useEffect(() => {
    if (!isOperator) return;
    const v = (new URLSearchParams(window.location.search).get("view") || "").trim().toLowerCase();
    if (v && /^[a-z0-9][a-z0-9-]*$/.test(v)) {
      setViewing((cur) => cur || { clientId: v, companyName: v });
      // Deliberately does NOT force "designs" any more. ?view= says WHICH tenant; the path
      // says WHICH page. /portal/settings/colors?view=junior-barns has to mean both, or the
      // operator's deep link silently loses half of itself.
    }
  }, [isOperator]);
  const openAccount = (c) => {
    // Switching account remounts the Designer, discarding anything in progress.
    if (designerOpened && !window.confirm("Opening another account will discard the design you have open in the Designer tab. Continue?")) return;
    // A consumed Open request must not survive the switch: the remounted DesignerTab
    // would replay it on mount and silently rehydrate that customer's design (with its
    // live GHL estimate refs) into what the operator expects to be a blank designer.
    setOpenDesign(null);
    ssTargetClientId = c.clientId;              // same tick as the click, before the re-render
    setViewing(c); setTab("designs"); setSub(null);
    // replaceState, not navigate(): entering an account is not a page change, and the path
    // is rebuilt so ?view= rides alongside /portal/designs instead of replacing it.
    try { window.history.replaceState({ page: "designs", sub: null }, "", "/portal/designs?view=" + encodeURIComponent(c.clientId)); } catch (_e) {}
  };
  const exitAccount = () => {
    setOpenDesign(null);                        // same replay guard as openAccount
    ssTargetClientId = null;
    setViewing(null); setTab("accounts"); setSub(null);
    try { window.history.replaceState({ page: "accounts", sub: null }, "", "/portal/accounts"); } catch (_e) {}
  };

  // ── Sidebar account switcher (operators only) ──────────────────────────────────────
  // GHL-style: the current builder at the BOTTOM of the rail, a click opens an upward
  // list of every builder, picking one runs the SAME openAccount the Accounts page uses
  // (Carolyn 2026-08-27: "put it down at the bottom … just do a similar version of
  // GoHighLevel"). Click-toggled with outside-click dismiss, deliberately NOT the
  // hover-only pattern .ss-user-menu uses — that popping over content is the exact thing
  // she flagged ("sometimes it gets in the way. Sometimes I'm trying to click on
  // features"). The client list loads on FIRST open only: an operator who never touches
  // the switcher pays nothing, and the Accounts page keeps its own copy.
  // Hooks HERE, with the others, above Dashboard's early returns (React #310).
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerClients, setPickerClients] = useState(null);  // null = never loaded
  const [pickerQ, setPickerQ] = useState("");
  const pickerRef = useRef(null);
  useEffect(() => {
    if (!pickerOpen || pickerClients !== null) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await sb.functions.invoke("operator-portal", { body: { action: "list_clients" } });
      if (cancelled) return;
      // An error resolves to [] rather than staying null so the menu shows "no accounts"
      // instead of a spinner forever; reopening after a failure retries via the reset below.
      if (error || !data || !Array.isArray(data.clients)) { setPickerClients([]); return; }
      setPickerClients(data.clients);
    })();
    return () => { cancelled = true; };
  }, [pickerOpen, pickerClients]);
  useEffect(() => {
    if (!pickerOpen) return;
    const onDoc = (e) => { if (pickerRef.current && !pickerRef.current.contains(e.target)) setPickerOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [pickerOpen]);
  const pickAccount = (c) => {
    setPickerOpen(false); setPickerQ("");
    if (!viewing || viewing.clientId !== c.clientId) openAccount({ clientId: c.clientId, companyName: c.companyName });
  };

  // Back/forward. Reads the URL rather than the state object, so a hand-edited address
  // and a history entry are treated identically. Every view-as history entry carries its
  // ?view= (ssPagePath preserves search), so `viewing` has to follow the restored URL too:
  // without that, Back across a view-as boundary showed one tenant's data under the OTHER
  // tenant's URL, and ssPagePath then rode the stale ?view= onto every later navigation
  // (audit 2026-08-20). Restoring an entry with ?view= re-enters view-as exactly as a
  // reload of that URL would (the boot effect above); an entry without it exits.
  useEffect(() => {
    const onPop = () => {
      const p = ssParsePath();
      wanted.current = p.page && TAB_META[p.page] ? p.page : null;
      setTab(p.page && TAB_META[p.page] ? p.page : "designs");
      setSub(p.sub || null);
      const v = (new URLSearchParams(window.location.search).get("view") || "").trim().toLowerCase();
      const urlView = (isOperator && v && /^[a-z0-9][a-z0-9-]*$/.test(v)) ? v : null;
      if (urlView !== (viewing ? viewing.clientId : null)) {
        setOpenDesign(null);                    // same replay guard as openAccount/exitAccount
        ssTargetClientId = urlView;             // same tick as the pop, before the re-render
        // Seeded with the slug; viewingFetch backfills the real company name, exactly as
        // the ?view= boot effect does. An unchanged tenant keeps its backfilled object.
        setViewing(urlView ? { clientId: urlView, companyName: urlView } : null);
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [isOperator, viewing]);

  // Keep the transport override in lockstep with `viewing`. Assigned during RENDER, not in
  // an effect: React runs CHILD effects before PARENT effects on mount, so an effect here
  // would let the first fetch of a newly-opened account (SettingsView status, PricingCsv
  // catalog, BillingView status all fire on their own mount) hit the operator's own tenant
  // — the exact bug this whole change exists to fix, only harder to see.
  ssTargetClientId = viewing ? viewing.clientId : null;
  // app_errors rows follow the portal ON SCREEN, in the same tick and for the same reason.
  // ssResolvedClientId (01-core.jsx) is otherwise latched only from a portal-settings /
  // qbo-oauth-connect response, and the `status` effect below deliberately does not run
  // during view-as — so without this line every row an operator generates inside a builder's
  // portal is filed under the operator's own tenant, or under the builder they viewed
  // before, and reads as fact in triage. Assigned here rather than in
  // openAccount/exitAccount/onPop because this is the one place already guaranteed to be in
  // lockstep with `viewing` for all three of them plus the ?view= deep link. `tenant` is the
  // caller's own client_users mapping, so the else branch is what makes EXITING a view-as
  // synchronous too instead of waiting a round trip for the status echo.
  if (viewing) ssResolvedClientId = viewing.clientId;
  else if (tenant && tenant !== "none" && tenant.clientId) ssResolvedClientId = tenant.clientId;
  // Sign-out / unmount must not leave a tenant override armed for the next mount — nor the
  // attribution that override produced. Both globals live in 01-core.jsx, which is module
  // scope shared by the whole page and outlives this component; clearing only the override
  // left ssResolvedClientId holding the tenant that just signed out, so every row written
  // from then on — the login screen's own window.onerror, and whatever the next person to
  // use this browser generates before their own tenant latches — was filed under it. NULL is
  // the honest answer for a page with no tenant on screen: ssLogError falls back to ?client=
  // and then to null, and a null client_id is a gap in triage where a confident wrong one is
  // a lie. The render above re-stamps both on the next mount.
  useEffect(() => () => { ssTargetClientId = null; ssResolvedClientId = null; }, []);

  useEffect(() => {
    // `tenant` describes the operator's OWN account, but the `status` call below is
    // tenant-scoped: with view-as armed the invoke wrapper injects targetClientId, so a
    // TOKEN_REFRESHED re-render used to overwrite tenant.access with the VIEWED tenant's
    // resolved map (audit 2026-08-20). Skipped while viewing — the mount-time value stands
    // — and the `viewing` dep refetches on exit. Token-keyed for the same reason as the
    // entitlement effect above: every auth event mints a new session object.
    // Deliberately NOT the `cancelled` pattern of the siblings: a ?view= deep-link boot
    // sets `viewing` while this run is mid-flight, and cancelling it then would leave
    // tenant null — "Loading your business…" forever. The run must complete; only the
    // injectable status call carries the poisoning risk, so it alone is guarded below.
    if (viewing) return;
    // ⏱ THE BOOTSTRAP `status` CALL IS ISSUED HERE, IN THE EFFECT'S FIRST SYNCHRONOUS TICK,
    // BESIDE the client_users read below rather than two awaits behind it. It never needed
    // that mapping: resolveTenant maps user → tenant server-side from the JWT alone. Stacked
    // sequentially they made boot a strict waterfall — client_users, then client_configs,
    // then status — with nothing on screen but "Loading your business…" until the last hop
    // landed, which is the floor under every "the portal is slow" report.
    //
    // ⚠️ THIS SATISFIES, RATHER THAN DROPS, WHAT THE OLD PLACEMENT WAS GUARDING. The worry
    // was that view-as can arm mid-flight and the wrapper would then inject targetClientId,
    // scoping this call to the VIEWED tenant and poisoning tenant.access with its map (audit
    // 2026-08-20). The wrapper reads ssTargetClientId SYNCHRONOUSLY, before its first await
    // (01-core.jsx says so in as many words), so a call issued in this tick with nothing
    // armed can never be injected by an arming that happens later — the answer is provably
    // the caller's own tenant no matter when it lands. `armedAtIssue` records that in the
    // same tick and is what the branch below tests, instead of re-reading a global whose
    // value at await-time no longer describes this call. Nothing is issued at all when
    // view-as is ALREADY armed, exactly as before.
    const armedAtIssue = ssTargetClientId;
    // `.then(ok, fail)` rather than a bare promise: this is issued before anything awaits it,
    // and an invoke that rejects in the gap would be an unhandled rejection. A failure
    // resolves to the same `{data:null}` shape the wrapper's own no-session guard returns,
    // so the retry branch below reads it identically.
    const bootStatus = armedAtIssue ? null
      : sb.functions.invoke("portal-settings", { body: { action: "status" } })
        .then((r) => r, () => ({ data: null }));
    (async () => {
      // limit(1)+array instead of maybeSingle(): maybeSingle() ERRORS when >1 row
      // matches (a duplicate/multi-tenant client_users row), which would lock the
      // user out of their own dashboard; take the first mapping instead. (audit #F6)
      const { data: cuRows, error } = await sb.from("client_users").select("client_id, role").limit(1);
      let mapping = cuRows && cuRows[0];
      if (error || !mapping) {
        // An empty read is AMBIGUOUS, and the ambiguity is the whole problem: RLS answers
        // "you are not linked to a tenant" and "your request carried no user at all"
        // identically — zero rows, no error. The second case is the anon-key fallback
        // described in 01-core.jsx's invoke wrapper, and telling a real owner "No business
        // linked to this account" then is a falsehood they act on, ringing CSM Synergy
        // about an account that is perfectly fine.
        const { data: ssSess } = await sb.auth.getSession();
        // No token to be had: stay on "Loading your business…" rather than assert something
        // false. This effect is keyed on session.access_token, so it re-runs itself the
        // moment one lands — which is what every one of the 34 logged tabs did.
        if (!ssSess || !ssSess.session) return;
        // A session EXISTS — but that is not enough to trust the read above, because
        // getSession() repairs the very thing it reports on: a rotation still in flight
        // during that read has finished by the time it answers. So the first read's
        // emptiness proves nothing. Ask again now that a token demonstrably exists, and
        // believe only this second answer.
        const retry = await sb.from("client_users").select("client_id, role").limit(1);
        // ⚠️ A FAILED read is not an answer of "no tenant" either, and reading only `.data`
        // erased that distinction. postgrest-js RESOLVES `{data: null, error}` on a dropped
        // connection or a 5xx rather than rejecting, and getSession() answers from local
        // storage with no network at all — so one connectivity blip spanning both reads used
        // to land a real owner on the terminal card above, telling them exactly the falsehood
        // the comment there refuses to tell, with nothing under it but Sign Out. Only a CLEAN
        // read of zero rows may become "none". On a failed one, stay on "Loading your
        // business…": this effect is keyed on session.access_token, so the next token re-runs
        // it. One extra read is the whole budget here — do not add a retry loop.
        if (retry.error) return;
        mapping = retry.data && retry.data[0];
        if (!mapping) { setTenant("none"); return; }
      }
      // Null until something names the business; `mapping.client_id` is the last-resort
      // heading, applied at setTenant. Kept as an explicit null rather than seeded with the
      // slug so "nobody answered" and "this tenant is literally called that" stay distinct —
      // the fallback read below keys off it.
      let businessName = null;
      // Per-area access (migration 100) comes from the SERVER's resolved map, not from
      // client_users.access — that column holds only the deviations from the title preset,
      // and resolving it here would mean a second copy of PRESETS in the browser that
      // drifts the day an area is added. `status` is the "open" bootstrap action precisely
      // so every role can make this call. On failure `access` stays null and ssCanSeeTab
      // falls back to the old role behaviour: a nav that is too generous, never one that is
      // too strict, so a blip can never lock a crew out of their own portal.
      //
      // ⚠️ THAT FALLBACK IS NOT HARMLESS, AND THE OLD SENTENCE HERE ("the server refuses
      // the action either way") IS FALSE FOR THE LISTS IT MATTERS MOST FOR. Pipeline,
      // Contacts and Inventory are not edge-function actions: DesignsTable and LeadsTable
      // read `designs` / `design_versions` / `captured_leads` straight from PostgREST
      // (02-sales.jsx:147, :165, :776) and the inventory picker reads `inventory_units`
      // (02-sales.jsx:115).
      //
      // ⛔ UNENFORCED ON THE SERVER, AND STILL UNENFORCED AFTER THE RETRY BELOW. This needs
      // SQL and cannot be fixed from this file; do not read the retry as having closed it.
      //   WHAT IS UNENFORCED: per-area gating of those reads. Every policy on those four
      //   tables is `client_id = public.current_client_id()` and nothing else
      //   (001_tenancy.sql:35, 031_design_versions.sql:33, 062_captured_leads.sql:37,
      //   075_inventory.sql:101; crm_contacts is the same shape at 130_crm_contacts.sql:78).
      //   Migration 100 added client_users.title + client_users.access and created NO
      //   policy, so the per-area map has no SQL representation whatsoever. Consequence,
      //   independent of anything this file does: a signed-in team member whose Designs and
      //   Contacts switches are 'none' opens devtools, runs sb.from('designs').select('*'),
      //   and RLS hands back every design, contact, phone number and quote figure in the
      //   tenant. _shared/access.ts:12-14 already states the rule ("the UI hiding a tab is a
      //   courtesy, not a control") — for these lists there is simply no control behind it.
      //   WHAT WOULD ENFORCE IT: a RESTRICTIVE policy per table, keyed on the caller's
      //   per-area map and ANDed with the tenant policy. That needs a SECURITY DEFINER
      //   resolver in SQL — say public.current_area_level(area text) — computing the same
      //   two inputs effectiveAccess() does in _shared/access.ts:132 (PRESETS[title] merged
      //   with the client_users.access deviations, owners absolute), then e.g.
      //     create policy designs_area_select on public.designs as restrictive
      //       for select to authenticated
      //       using (public.current_area_level('designs') <> 'none');
      //   one per table with its own area key ('designs' for designs/design_versions,
      //   'contacts' for captured_leads/crm_contacts, 'inventory' for inventory_units).
      //   RESTRICTIVE is load-bearing: a second PERMISSIVE policy ORs in and would WIDEN
      //   access instead of narrowing it. Until that ships, the browser is the only gate for
      //   these lists and this nav is a courtesy, not a boundary.
      //
      // What the retry below fixes is the other, in-app half — and only that half. It is
      // NARROWED, NOT CLOSED: a transient portal-settings failure on a real session no
      // longer leaves `access` null and hands a driver the generous NONADMIN_TABS nav, but
      // the no-session / anon-key return still resolves to `{data:null}` with no map and
      // still falls through to that nav, self-healing only when a token lands (this effect
      // is keyed on session.access_token). The fallback stays GENEROUS on purpose — the
      // file's principle is a nav that is too generous, never one that is too strict, so a
      // blip can never lock a crew out of their own portal — which is exactly why the
      // server-side hole above has to be closed rather than compensated for here.
      let access = null;
      let prefs = null;
      try {
        // Issued at the top of the effect, not here — see the note there for why that is
        // safe against a view-as arming mid-flight. `bootStatus` is null exactly when
        // view-as was ALREADY armed at issue time, which is the case the old
        // `if (!ssTargetClientId)` guard covered: nothing is asked, access stays null (the
        // generous fallback), and the `viewing` dep refetches the real map on exit.
        if (bootStatus) {
          const { data: st } = await bootStatus;
          if (st && st.access) access = st.access;
          // Rides the same bootstrap call as `access` on purpose: a default view that lands
          // a round trip late renders the wrong tab and then jumps, which reads worse than
          // having no setting at all.
          if (st && st.prefs) prefs = st.prefs;
          // …and so does the heading. `status` already reads client_configs server-side and
          // hands back branding.companyName, so the separate client_configs SELECT that used
          // to sit above was a third sequential round trip for a column this response was
          // carrying all along.
          //
          // Guarded on the echoed clientId because the two answers can legitimately name
          // different tenants: limit(1) above takes the FIRST client_users row (audit #F6,
          // duplicate/multi-tenant rows are real), while resolveTenant picks its own. Naming
          // the other business in the topbar would be worse than the slug, so an echo that
          // disagrees falls through to the direct read below. An older backend that echoes no
          // clientId at all still passes — this contract only ever grew.
          if (st && st.branding && st.branding.companyName
              && (!st.clientId || st.clientId === mapping.client_id)) {
            businessName = st.branding.companyName;
          }
          // No map back is a FAILED call, never "this tenant has none": `status` is the open
          // bootstrap action and resolveTenant fills every area for every title. The invoke
          // wrapper RETURNS `{data:null}` rather than throwing — the no-session guard does so
          // explicitly — so the anon-key refresh window reads identically to "pre-migration-100
          // shape" and quietly buys the generous nav above. Same second-answer rule as the
          // client_users read: prove a token exists, then ask once more and believe that. Both
          // failing is rare and self-heals on the next token, but one blip should not be
          // enough. ssTargetClientId is re-read because the await above is another chance for
          // view-as to arm.
          if (!access) {
            const { data: accSess } = await sb.auth.getSession();
            if (accSess && accSess.session && !ssTargetClientId) {
              const again = await sb.functions.invoke("portal-settings", { body: { action: "status" } });
              if (again.data && again.data.access) access = again.data.access;
              if (again.data && again.data.prefs) prefs = again.data.prefs;
              if (again.data && again.data.branding && again.data.branding.companyName
                  && (!again.data.clientId || again.data.clientId === mapping.client_id)) {
                businessName = again.data.branding.companyName;
              }
            }
          }
        }
      } catch (_e) { /* keep the fallback */ }
      // FALLBACK ONLY. Reached when `status` was skipped (view-as already armed), failed
      // both times, or came back for a different tenant than the mapping above named — never
      // on the happy path, where the branding rode the bootstrap call. client_configs is
      // column-structured (no monolithic `config` blob), so this is the dedicated
      // company_name column for the dashboard heading, exactly as before.
      if (!businessName) {
        try {
          const { data: cfg } = await sb.from("client_configs").select("company_name").eq("client_id", mapping.client_id).maybeSingle();
          if (cfg && cfg.company_name) businessName = cfg.company_name;
        } catch (_e) { /* the slug below is a perfectly good heading */ }
      }
      // The boot is over at this line: everything past it renders. Marked so the waterfall
      // this effect used to be stays measurable from a real page rather than from a stopwatch
      // (performance.mark is wrapped because a hardened browser can make it throw, and a
      // measurement must never be the thing that blanks the portal).
      try { performance.mark("ss:tenant-ready"); } catch (_e) {}
      setTenant({ clientId: mapping.client_id, businessName: businessName || mapping.client_id, role: mapping.role || "user", access, prefs });
    })();
  }, [session.access_token, viewing]);

  // ── Warm the schedule and commissions isolates ────────────────────────────────
  // Boot already invokes portal-settings and portal-billing, so those two are usually warm
  // by the time anyone clicks. portal-schedule and portal-commissions are not, and a cold
  // Deno isolate costs ~2.5 SECONDS before the function runs its first query — measured
  // against this project, and the largest single component of "the schedule tab is slow".
  //
  // Fire-and-forget, and deliberately behind a delay: the boot calls (client_users and
  // status in parallel, plus billing and the profile read below) own the first moment of the
  // page, and a warm-up that competes with them would trade a fast first tab for a slow
  // first paint. A module-level flag keeps it to once per page rather than once per
  // Dashboard mount (view-as remounts this component).
  useEffect(() => {
    if (window.__ssWarmed) return undefined;
    window.__ssWarmed = true;
    const t = setTimeout(() => { ssWarmFn("portal-schedule"); ssWarmFn("portal-commissions"); }, 1500);
    return () => clearTimeout(t);
  }, []);

  // ── Who the signed-in person is, and the operator's user editor ────────────────
  // `profile` is the caller's own client_users row. needsDetails drives a one-time nudge:
  // every user predating migration 060 has no name, and until they enter one the portal has
  // been showing their email local-part as their name.
  const [profile, setProfile] = useState(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [nudgeHidden, setNudgeHidden] = useState(false);
  const [editUser, setEditUser] = useState(null);        // operator editing someone else
  const [usersRefreshKey, setUsersRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await sb.functions.invoke("portal-settings", { body: { action: "get_profile" } });
        if (!cancelled && data) setProfile(data);
      } catch (_e) { /* a missing profile must never block the portal */ }
    })();
    return () => { cancelled = true; };
    // Token-keyed, same reason as the three rpcs above (see is_operator). This one was the
    // loudest of the four in a boot trace, because it is a portal-settings INVOKE: every
    // repeat woke the same isolate the tenant effect was already waiting on.
  }, [session.access_token]);

  const signOut = () => sb.auth.signOut();

  // Only owners/admins manage Pricing + Settings; regular team members see only
  // Designs & Leads. Gate both the tabs and the rendered content (so a non-admin
  // can't reach the other views even by forcing the tab state).
  // Null-safe on purpose: the loading/no-tenant early returns sit BELOW setup3d (the
  // last hook), so this line also runs while tenant is still null / "none".
  const isAdmin = !!tenant && tenant !== "none" && (tenant.role === "owner" || tenant.role === "admin");
  // Non-admins are confined to the Designs + Leads lists, the read-only "What's New" tab
  // (product news), and the coming-soon teaser tabs (previews, no data). Everything else is admin-only.

  // While VIEWING another tenant, operator status is the admin grant. isAdmin above
  // describes the operator's role in their OWN client_users row — routinely "user", or
  // absent entirely — so using it here would leave Settings dead in the viewed account,
  // which is exactly the "only two tabs" symptom Carolyn reported.
  // THE LINE THAT UNCLAMPS EVERY TAB. For a support operator it must be false, or
  // ssClampTab returns every tab unmodified and the narrowed access map governs nothing.
  const canAdmin = viewing ? (isOperator && !supportView) : isAdmin;

  // HOISTED above setup3d (2026-08-21). It used to live ~200 lines further down, which is
  // why the 3D calibration editor was never gated on it: setup3d is the last hook and could
  // not read a value declared below itself. See the setup3d memo for what that cost.
  // 3D reads entitlement.GRANTED, not entitlement.features, and that is deliberate.
  //
  // `features.view_3d` is computed by portal-billing, where view_3d falls under the
  // exempt/free-period BLANKET unless that function has the three-branch map (which needs
  // billing_plans.operator_grantable, migration 109). Every tenant predating the billing gate
  // is exempt, so gating on features here would show 3D to essentially all of them the moment
  // a frontend shipped ahead of the backend — which is exactly what happened on 2026-08-19,
  // when this landed on beta before the migration could be applied.
  //
  // `granted` is emitted ONLY by the new portal-billing and only for features an operator
  // actually comped, so this is correct in BOTH worlds: against the old function it is
  // undefined and only operators see 3D; against the new one it honours real grants. It also
  // cannot be widened by a blanket, ever, which is the property that matters for a feature
  // whose whole point is "not all clients need to see it" (Carolyn 2026-08-18).
  //
  // When view_3d goes on sale, add the subscription check here — do NOT fold it back into
  // featureOn, or the blanket returns with it.
  // Support reads the VIEWED tenant's grant, not the operator blanket — otherwise a
  // support account is shown a 3D tab on a builder who was never granted it.
  const view3dUnlocked = supportView
    ? (!viewedCtx || (!!viewedCtx.entitlement && Array.isArray(viewedCtx.entitlement.granted)
        && viewedCtx.entitlement.granted.indexOf("view_3d") !== -1))
    : (isOperator
      || (!viewing && !!entitlement && Array.isArray(entitlement.granted)
          && entitlement.granted.indexOf("view_3d") !== -1));
  // The tenant every surface should read and write. Feeds the clientId props and the
  // remount keys; the invoke wrapper handles the edge functions. Null until the tenant
  // resolves — every real read happens below the early returns.
  const effClientId = viewing ? viewing.clientId : (tenant && tenant !== "none" ? tenant.clientId : null);
  // 3D setup contract handed to the calibration editor, which lives in Settings ->
  // Designer -> 3D since 2026-08-21 (it used to be a bar across the top of the Designer
  // TAB, over every design anyone opened). The editor itself is still rendered by the
  // designer component — it needs the live 3D preview — but the component is mounted
  // there with `calibrationOnly`, so nothing else of the designer comes with it. The I/O
  // lives here because THIS is where the signed-in session is: the component's own
  // supabase client is the anon one and would 401 at resolveTenant. Null unless the user
  // may administer the tenant, which is what keeps a role-"user" salesperson out of it.
  //
  // This is a HOOK, so it must run on EVERY render — same constraint as the replaceState
  // effect above. It used to sit below the tenant-loading early returns: the first render
  // returned before reaching it, the render after the tenant resolved called one hook
  // more, and React threw #310 — a blank portal for everyone (app_errors bb53f026,
  // bcfc2007). The early returns now sit below this memo; keep every hook above them.
  // `view3dUnlocked` is load-bearing here, not decorative. Without it this memo was gated on
  // canAdmin ALONE, so any tenant OWNER without a view_3d grant got a non-null setup3d ->
  // showCal3D true -> the "3D Style Calibration" panel (then a bar across the top of the
  // Designer tab, now the Settings -> Designer -> 3D section), whose preview
  // opens a full editable Structure3DViewer. 3D was reachable by a builder who had not been
  // granted it (found 2026-08-21; shipped 2026-08-04 in 81299d9, so it predates the dock).
  //
  // Operators keep calibration everywhere, which is the point: view3dUnlocked is
  // `isOperator || (!viewing && granted has view_3d)`, so an operator passes on their own
  // portal AND while impersonating a tenant. The operator's PUBLIC-page route
  // (index.html?admin=1) never came through here at all -- showCal3D is `isAdmin ||
  // Boolean(setup3d)` and isAdmin short-circuits it -- so that flow is untouched.
  const setup3d = useMemo(() => (!canAdmin || !view3dUnlocked ? null : {
    onSaveSpec: async (styleValue, d3, d3Photos) => {
      const { data, error } = await sb.functions.invoke("portal-settings", { body: { action: "save_style_d3", styleValue, d3, d3Photos } });
      if (error) throw new Error(error.message || "Save failed");
      if (!data || !data.ok) throw new Error((data && data.error) || "Save failed");
      return data;
    },
    // Reference photos are no longer in the customer-facing config (migration 093 stopped
    // get_config broadcasting a builder's photos of their real buildings to anonymous
    // shoppers), so the editor asks for them here, over the authenticated session.
    // A 10-40MB mesh cannot go through an edge function (it would have to be buffered as
    // base64 inside a 256MB / 2s worker), so the browser writes straight into the PRIVATE
    // `models` bucket with the builder's own session — the same route portal.html already uses
    // for feedback attachments, and the RLS policy in 094 confines it to their own folder.
    //
    // NULL WHILE VIEWING ANOTHER TENANT, which hides the scan card entirely — the designer
    // gates the whole card on this callback. This is the one capability here that does NOT
    // go through portal-settings: it is a DIRECT write into the private bucket with the
    // caller's own session, and 094's insert policy confines that write to the folder named
    // by the CALLER's own client_users row — storage RLS never sees targetClientId, and
    // sb.storage is not in SS_TENANT_SCOPED_FNS. An operator's row names the operator's own
    // tenant, so the path built from the viewed tenant could never match and storage refused
    // every one of these uploads with a raw "new row violates row-level security policy" —
    // a control that cannot work, failing in a language nobody can act on. 151 names this
    // exact trap ("would appear to work in every test done as an owner") and explicitly
    // refuses the tempting cure, a bypass policy on the bucket; the real fix is a signed
    // upload URL minted by portal-settings, where resolveTenant — not the caller's own row —
    // decides the prefix. Until then, offer the control only where it works. The AI calibration and
    // walk-around-video paths beside it all run through portal-settings and are gated on
    // their own callbacks, so they keep working in view-as.
    onUploadModel: viewing ? null : async (file, styleValue) => {
      // supabase-js IGNORES the contentType option when the body is a Blob (it builds a
      // FormData and reads Blob.type), and a .glb usually arrives as application/octet-stream
      // or "". Re-tag it with a zero-copy slice so the stored mime matches the bucket's
      // allow-list instead of failing at the storage gate for an undiagnosable reason.
      const typed = file.slice(0, file.size, "model/gltf-binary");
      const safe = String(styleValue || "style").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
      const path = effClientId + "/" + safe + "-" + Date.now() + ".glb";
      const up = await sb.storage.from("models").upload(path, typed, { contentType: "model/gltf-binary", upsert: false });
      if (up.error) throw new Error(up.error.message || "Upload failed");
      return path;
    },
    onSaveModel: async (styleValue, modelPath, modelMeta) => {
      const { data, error } = await sb.functions.invoke("portal-settings", { body: { action: "save_style_model", styleValue, modelPath, modelMeta } });
      if (error) throw new Error(error.message || "Could not save that scan");
      if (!data || !data.ok) throw new Error((data && data.error) || "Could not save that scan");
      return data;
    },
    onSetModelStatus: async (styleValue, status) => {
      const { data, error } = await sb.functions.invoke("portal-settings", { body: { action: "set_style_model_status", styleValue, status } });
      if (error) throw new Error(error.message || "Could not change that");
      if (!data || !data.ok) throw new Error((data && data.error) || "Could not change that");
      return data;
    },
    onLoadStyle3D: async (styleValue) => {
      const { data, error } = await sb.functions.invoke("portal-settings", { body: { action: "catalog" } });
      if (error || !data || !data.ok) return null;
      const st = (data.styles || []).find((x) => x.key === styleValue);
      return {
        photos: (st && Array.isArray(st.d3_photos)) ? st.d3_photos.filter(Boolean) : [],
        modelStatus: (st && st.model_status) || "none",
        aiReady: data.aiReady !== false,
      };
    },
    onDraftFromPhotos: async (photoUrls, styleValue) => {
      const { data, error } = await sb.functions.invoke("portal-settings", { body: { action: "calibrate_style_ai", photoUrls, styleValue } });
      if (error) throw new Error(error.message || "Drafting failed");
      if (!data || !data.ok || !data.d3) throw new Error((data && data.error) || "Drafting failed");
      return data.d3;
    },
    // Frames the browser cut out of a walk-around video. Same action, same gate, same
    // 10/day meter as the photo draft — `source` only picks the shape-first prompt and
    // raises the frame cap from four to eight.
    //
    // Deliberately a SEPARATE capability rather than an options argument on the call
    // above: this one returns the whole envelope (`frames` proves nothing was silently
    // truncated, `observed` carries what the video showed about doors and vents), and the
    // photo caller wants a bare spec. One function returning two shapes is how the wrong
    // one gets read.
    onDraftFromVideo: async (frameUrls, styleValue) => {
      const { data, error } = await sb.functions.invoke("portal-settings", { body: { action: "calibrate_style_ai", photoUrls: frameUrls, styleValue, source: "video" } });
      if (error) throw new Error(error.message || "Reading the video failed");
      if (!data || !data.ok || !data.d3) throw new Error((data && data.error) || "Reading the video failed");
      return { d3: data.d3, frames: data.frames || 0, observed: data.observed || null };
    },
    // Signed URL (10 min) for the style's stored scan — the re-measure path:
    // an algorithm improvement should never require walking the lot again.
    onLoadModelUrl: async (styleValue) => {
      const { data, error } = await sb.functions.invoke("portal-settings", { body: { action: "style_model_url", styleValue } });
      if (error || !data || !data.ok) return null;
      return data.url || null;
    },
    onUploadPhoto: async (file) => {
      const imageBase64 = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result || "").split(",")[1] || "");
        fr.onerror = () => rej(new Error("Could not read that file."));
        fr.readAsDataURL(file);
      });
      const { data, error } = await sb.functions.invoke("portal-settings", { body: { action: "upload_style_photo", imageBase64, imageContentType: file.type || "image/jpeg" } });
      if (error) throw new Error(error.message || "Upload failed");
      if (!data || !data.ok || !data.url) throw new Error((data && data.error) || "Upload failed");
      return data.url;
    },
    // `viewing` is listed because onUploadModel now reads it. effClientId moves with it in
    // practice, but leaning on that would make a stale upload handler a one-line edit away.
  }), [canAdmin, view3dUnlocked, effClientId, viewing]);

  if (tenant === null) {
    return <div style={{ padding: 40, textAlign: "center", color: "#64748B", fontSize: 14 }}>Loading your business…</div>;
  }
  if (tenant === "none") {
    return (
      <div style={{ maxWidth: 420, margin: "60px auto", padding: "0 16px" }}>
        <div style={{ ...S.card, textAlign: "center" }}>
          <div style={{ ...S.h2, fontSize: 16 }}>No business linked to this account</div>
          <p style={{ fontSize: 13, color: "#64748B", marginBottom: 16 }}>Your login works, but it isn't connected to a business yet. Contact CSM Synergy to finish your setup.</p>
          <button onClick={signOut} style={S.btn("#1E293B", "#FFF")}>Sign Out</button>
        </div>
      </div>
    );
  }

  // isAdmin / canAdmin / effClientId are declared ABOVE the early returns (null-safe),
  // because the hook-order rules require every hook to run before them. Only the per-area
  // map is resolved here — it needs a settled tenant.
  //
  // The caller's resolved per-area map, straight from the status call (migration 100).
  // Operators viewing a tenant have none — their rights come from app_operators — and
  // canAdmin short-circuits every check below for them.
  // Support reads the VIEWED tenant's resolved map. While it is still loading, fall back to
  // the operator's own rather than to null: null clamps to a fallback tab, so the generous
  // direction for a fraction of a second beats bouncing Jonathan off the page he opened.
  const myAccess = supportView
    ? ((viewedCtx && viewedCtx.access) || ((tenant && tenant !== "none") ? tenant.access : null))
    : ((tenant && tenant !== "none") ? tenant.access : null);
  // Designs/Contacts "Open" → load the design INSIDE the portal designer and switch to
  // that tab. Never a link to the public page: it silently captures leads and saves
  // drafts (capture-lead / saveDraftSilently), so staff opening a customer's design
  // there would corrupt the very activity Contacts reports.
  const openInDesigner = (code, version = null, extra = null) => {
    // ⛔ REFUSE OUT LOUD WHEN THE CLAMP WOULD REFUSE THE TAB. TAB_AREA routes "designer"
    // through `designer`, an area neither shipped staff preset carries (crew_leader and
    // driver, _shared/access.ts) — yet every caller of this is ungated: Pipeline "Open",
    // CrmRecord "Open in designer", Inventory "Open" / "Send estimate", and the build-job
    // editor's "Open design", which a Crew Leader is meant to use. Without this the click
    // set `tab` to "designer", the clamp held activeTab on their fallback page, the URL
    // effect quietly put the address bar back, and the button was dead FOREVER — a second
    // click sets the same `tab` and bails out of React entirely. Tested through ssClampTab
    // rather than a hand-rolled check so the two can never disagree; a null map still
    // passes (NONADMIN_TABS holds "designer"), so nothing changes for owners, admins,
    // operators or a tenant predating migration 100.
    if (ssClampTab("designer", isOperator, canAdmin, myAccess, supportView) !== "designer") {
      window.alert("Opening a design in the Designer isn't part of your access. Ask an owner or admin to turn it on under Settings → Team.");
      return;
    }
    // `blank: true` (from "+ New inventory building") carries no code — the designer
    // resets to an empty canvas instead of keeping the previously opened design, which
    // could otherwise be another unit's master with an "Update" button waiting.
    // `extra` carries the inventory fields: { asNew, inventoryUnitId } for "Send
    // estimate" (load the unit's design as a FRESH estimate), or { unit: {...} } for
    // opening a master in update mode. Plain design opens pass nothing.
    setOpenDesign({ clientId: effClientId, code, version, ...(extra || {}), n: Date.now() });
    navigate("designer");
  };

  // "accounts" and "admin" are operator-gated (independent of tenant role) and sit OUTSIDE
  // the role clamp; everything else keeps it. Note "admin" must NOT go in NONADMIN_TABS —
  // that array is the role escape hatch and would hand the operator console to every team
  // member. Content renders are ALSO gated (and the server re-checks regardless).
  const activeTab = ssClampTab(tab, isOperator, canAdmin, myAccess, supportView, canProjects);


  // ── Sidebar layout (fluid, full-width; collapses to an icon rail <900px) ──
  // Signed-in user identity for the sidebar footer. Auth users are email+password
  // (no profile name field), so prefer any metadata name and fall back to the
  // email's local part.
  const meta = session.user.user_metadata || {};
  // client_users.full_name (migration 060) is the real answer now — auth metadata never
  // carried a name on this project, so this used to always fall through to the email's
  // local part. Metadata is kept in the chain in case a future SSO provider supplies one.
  const displayName = (profile && profile.fullName)
    || meta.full_name || meta.name || (session.user.email || "").split("@")[0];
  const initials = displayName.split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
  // The business shown in the topbar is the one being ACTED ON, not the login's own —
  // otherwise an operator sees their own company named in the slot styled as "the account
  // you are in" while the banner names someone else.
  const shownBusiness = viewing ? (viewing.companyName || viewing.clientId) : tenant.businessName;
  const tenantInitials = String(shownBusiness || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");

  // Billing gate. Locked = the required subscription isn't active. Nav stays fully
  // visible (locked items get a padlock) and the CONTENT area shows the gate whatever
  // they click — so they can see the whole product and always land on how to switch it
  // on. Never gate an operator viewing someone else's account: the entitlement loaded
  // here is the operator's own, not the tenant's.
  const gateLocked = !viewing && !!entitlement && entitlement.locked;
  // Scheduling suite (Build Schedule + Delivery Schedule + Repairs — ONE feature,
  // decision 12): live for operators (own tenant or view-as) and for tenants whose
  // entitlement carries schedule_builds. PAY-ONLY (Carolyn 2026-08-04): portal-billing
  // requires a real active/grace subscription for this feature — the exempt and
  // free-period blankets deliberately do NOT cover it, so grandfathered tenants see
  // the teaser like everyone else until they subscribe.
  // Is a PAID ADD-ON switched on for this tenant? The one rule for every billable
  // feature — nothing reads entitlement.features directly any more.
  //
  //   * Operators are never gated (their own tenant or view-as), because the entitlement
  //     loaded here is the OPERATOR's, not the viewed tenant's.
  //   * entitlement === null means "still loading" and must NOT read as off, or every page
  //     load would flash an upgrade card at a paying customer (same reason gateLocked
  //     tolerates null).
  //
  // ⚠️ THE TENANT BRANCH SAYS THE OPPOSITE OF THAT SENTENCE, and it must keep saying it until
  // the server can answer for these keys. Audit 2026-09-06 (F052) proposed making null read as
  // ON, which is the right shape for a gate that is only presentation — but it is NOT the shape
  // for `schedule_builds` and `quickbooks_sync`, where THIS LINE IS THE ONLY ENFORCEMENT
  // ANYWHERE: portal-billing's PAID_ONLY_FEATURES set decides who may subscribe, and nothing
  // re-checks those two on the actions themselves. Null-reads-on would hand every tenant the
  // paid scheduler and QuickBooks for the whole load window, and permanently after one failed
  // status call, because the fetch stores only a SUCCESSFUL answer and is keyed on the access
  // token. Fail-closed on a paid feature beats fail-open; the real repair is a third state
  // (loading, which shows neither the feature nor its upsell) plus a server-side check for
  // those two keys, and that is a bigger change than a boolean.
  // Support resolves the VIEWED tenant's subscription — the whole point of the flag. A null
  // viewedCtx is STILL LOADING, never "off", the same rule the operator branch already uses:
  // flashing an upgrade card at a paying builder mid support call is the worse failure.
  const featureOn = (key) => (supportView
    ? (!viewedCtx || !!(viewedCtx.entitlement && viewedCtx.entitlement.features && viewedCtx.entitlement.features[key]))
    : (isOperator || (!viewing && !!entitlement && !!(entitlement.features && entitlement.features[key]))));
  const schedUnlocked = featureOn("schedule_builds");
  // QuickBooks Sync is a paid add-on ($75/mo) that was SOLD BUT NEVER ENFORCED — the tab was
  // gated on canAdmin alone, so any admin used it free and buying it changed nothing. Gated
  // the same way as scheduling (Carolyn 2026-08-08), and PAY-ONLY on the server, so the
  // exempt/free-period blankets don't hand it to grandfathered tenants either.
  const qboUnlocked = featureOn("quickbooks_sync");
  // Real-Time Pricing ($85/mo, on sale since migration 124, PAY-ONLY server-side since the
  // 2026-08-28 build): the material-cost engine's settings card. Gates the RealTimePricing
  // block inside Settings → Structures; the server re-checks the entitlement on every
  // rtp_* action regardless (_shared/featureCheck.ts).
  const rtpUnlocked = featureOn("on_demand_pricing");
  // Built-in CRM ($400/mo, migration 160): the Contacts tab and the Pipeline BOARD. The
  // pipeline LIST stays free for everyone — Carolyn 2026-08-29, "they only get the list
  // view" — so this gates a view, not a data set, and DesignsTable takes it as a prop.
  //
  // Unlike scheduling and QuickBooks, this feature was already built, shipped and in daily
  // use before it had a price, so turning this on TAKES something away from tenants who
  // have it today. That was the explicit decision, not an oversight. Server side, every
  // crm_* action in portal-settings re-checks the entitlement, so this is presentation
  // over a real gate rather than the only gate.
  const crmUnlocked = featureOn("crm");
  // May THIS person write to each board (migration 100)? Separate from schedUnlocked, which
  // is only whether the tenant has bought the feature. Both must be true before Designs and
  // Inventory offer their schedule entry points.
  const schedCanEdit = canAdmin || !!(myAccess && myAccess.build_schedule === "edit");
  const deliverCanEdit = canAdmin || !!(myAccess && myAccess.delivery_schedule === "edit");
  // Mirrors portal-settings' own gate for send_invoice/push_to_invoice exactly. Presentation
  // only — the server re-checks {area:'orders', level:'edit'} whatever the browser believes.
  const ordersCanEdit = canAdmin || !!(myAccess && myAccess.orders === "edit");
  // Amending a SIGNED order is granted separately from running one (access.ts, 2026-09-01).
  const coCanEdit = canAdmin || !!(myAccess && myAccess.change_orders === "edit");
  const gateGrace = !viewing && !!entitlement && entitlement.state === "grace";
  const graceDaysLeft = gateGrace && entitlement.graceEndsAt
    ? Math.max(0, Math.ceil((Date.parse(entitlement.graceEndsAt) - Date.now()) / 86400000))
    : null;
  // Dated free period: everything works, with a countdown and the real rate. Distinct from
  // grace — nothing has failed here, they simply haven't started paying yet, so the copy must
  // not imply a payment problem.
  const gateTransition = !viewing && !!entitlement && entitlement.state === "transition";
  const transEndsAt = gateTransition && entitlement.transitionEndsAt ? Date.parse(entitlement.transitionEndsAt) : null;
  // Counted in whole CALENDAR days in the viewer's own timezone, which is how people read a
  // deadline. An elapsed-milliseconds ceil() says "9 days" when 8 days and 2 hours remain.
  const transDaysLeft = transEndsAt
    ? Math.max(0, Math.round((new Date(transEndsAt).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000))
    : null;
  const transDateLabel = transEndsAt
    ? new Date(transEndsAt).toLocaleDateString(undefined, { month: "long", day: "numeric" })
    : null;
  const rate = (entitlement && entitlement.requiredRate) || null;

  // Never nag an operator who is looking at someone else's account — the prompt is about
  // the signed-in person's own details, and it would read as if it were the tenant's.
  const showNudge = !viewing && !nudgeHidden && !!profile && profile.needsDetails;
  const fmtRate = (c) => c == null ? null : "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: c % 100 ? 2 : 0 });

  // Real <button>s (not href-less anchors) so the nav stays keyboard- and
  // screen-reader-operable like the old tab bar; .ss-nav styles both alike.
  // Hidden, not padlocked: a padlock means "yours when you upgrade" (the billing gate).
  // A page your access does not include is not something you can buy your way into, so
  // showing it would just be a dead end. accounts/admin are operator-gated separately.
  const navHidden = (id) =>
    id !== "accounts" && id !== "admin" && id !== "projects" && !canAdmin && !ssCanSeeTab(id, myAccess);
  const navItem = (id, label, badge) => navHidden(id) ? null : (
    <button type="button" className={activeTab === id ? "active" : ""}
      title={gateLocked ? `${label} — activate your account to use this` : (badge ? `${label} — ${badge.toLowerCase()}` : label)}
      onClick={() => navigate(id)}>
      {ICONS[id]}
      <span className="lbl">{label}</span>
      {badge && <span className="soon">{badge}</span>}
      {gateLocked && (
        <svg className="lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-label="locked"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
      )}
    </button>
  );
  // Same as navItem but with a status pill — "Soon" by default, or a custom badge
  // (e.g. "In Development") for tabs that are further along than the teaser ones.
  const soonItem = (id, label, badge) => navHidden(id) ? null : (
    <button type="button" className={activeTab === id ? "active" : ""} title={label + " — " + (badge ? badge.toLowerCase() : "coming soon")} onClick={() => navigate(id)}>
      {ICONS[id]}
      <span className="lbl">{label}</span>
      <span className="soon">{badge || "Soon"}</span>
    </button>
  );

  return (
    <div className="ss-shell">
      <aside className="ss-side">
        {/* The real lockup, at full colour on white — which is why the rail is white. The
            wordmark IS the product name, so the name is no longer typed out beside it. */}
        <div className="ss-brand">
          <img className="ss-logo" src="/assets/logo.png" alt="Structure Studio" />
        </div>

        <div className="ss-navlabel">Workspace</div>
        <nav className="ss-nav">
          {navItem("designer", "Designer")}
          {/* TWO items again. Carolyn, 2026-08-26 12:15, having used the merged one: "we have
              contacts as one, and then we have another one that says pipeline ... I would
              rather have more tabs and one specific name on it." Contacts first — a person,
              then what they are quoting. The List | Pipeline board toggle stays INSIDE
              Pipeline (02-sales); it is the section, not a third nav item. */}
          {navItem("contacts", "Contacts")}
          {navItem("designs", "Pipeline")}
          {navItem("inventory", "Inventory")}
          {navItem("orders", "Orders")}
          {/* Scheduling suite — Carolyn 2026-08-04: under Orders, in this order. The In Dev
              badges came off 2026-08-05 (Carolyn); content stays entitlement-gated inside. */}
          {navItem("build-schedule", "Build Schedule")}
          {navItem("delivery-schedule", "Delivery Schedule")}
          {navItem("repairs", "Repairs")}
          {navItem("commissions", "Commissions")}
          {/* QuickBooks has no nav entry any more (Carolyn 2026-08-24): it is a config
              surface, not workspace work, and it is already mounted a second time at
              Settings → QuickBooks — which is where the links people actually hold point
              (/portal/settings/quickbooks). The /portal/quickbooks route, its render
              block and ICONS.quickbooks all stay, so old deep links still land on the
              real page: same treatment 3D Design got below. Its gating is unchanged —
              admins plus settings_quickbooks holders (migration 100), enforced by
              TAB_AREA and the clamp, neither of which reads the nav. */}
        </nav>

        {/* Beta only (Carolyn 2026-08-27, Ahsan's proposal: "Go ahead and do it, yes").
            Production tenants see finished work, not a list of promises; beta is where
            unreleased things are looked at. The routes clamp too (ssClampTab reads the
            same predicate) — hiding a nav item never removed its URL. */}
        {ssIsBetaHost() && (<>
        <div className="ss-navlabel">Coming Soon</div>
        <nav className="ss-nav">
          {/* RealTime Pricing left this group on 2026-08-28 (Carolyn 2026-08-27: "we maybe
              even remove real-time pricing from this here completely now, and put what is
              here down here") — it lives inside Settings → Structures as a real feature
              now. The /portal/on-demand-pricing route and its card stay for old deep
              links, pointing at the settings block: the QuickBooks/3D treatment. */}
          {/* 3D Design has no nav entry any more (Carolyn 2026-08-25): it is live inside
              the Designer (view3d prop) and calibration lives in Settings → Designer, so
              the standalone tab came off the rail. The /portal/view-3d route and its
              render block stay so old deep links still land somewhere sensible. */}
          {soonItem("rent-to-own-contracts", "Rent to Own", "4th Qtr")}
          {soonItem("reports", "Reports", "4th Qtr")}
          {soonItem("self-serve-display-units", "Self Serve Displays", "2027")}
        </nav>
        </>)}

        {(isOperator || canProjects) && (<>
        {/* Labelled for whoever is reading it: a CSM team member with Projects and nothing
            else is not an "Operator", and calling the group that would tell them they hold
            access to every builder's account, which they do not. */}
        <div className="ss-navlabel">{isOperator ? "Operator" : "Internal"}</div>
        <nav className="ss-nav">
          {/* Accounts is the switcher and support needs it — it is how they reach the next
              builder. Admin and Projects are OUR consoles (delete_client lives in one, our
              internal bug board is the other) and a support account standing in a builder's
              shoes has no business in either. ssClampTab refuses the routes too, so a typed
              URL lands on a real page rather than a hidden-but-reachable one. */}
          {isOperator && navItem("accounts", "Accounts")}
          {isOperator && !supportView && navItem("admin", "Admin")}
          {canProjects && !supportView && navItem("projects", "Projects")}
        </nav>
        </>)}

        <div className="ss-spacer"></div>

        {/* Settings pinned at the bottom, just above the footer divider. Was canAdmin-only;
            now anyone holding at least one settings area sees it (migration 100) and each
            card inside gates itself — a person given only Structures gets Settings with
            Structures in it, which is the point of per-area access. */}
        {(canAdmin || ssCanSeeTab("settings", myAccess)) && (
          <nav className="ss-nav" style={{ marginBottom: 10 }}>
            {navItem("settings", "Settings")}
          </nav>
        )}

        <div className="ss-foot">
          {/* Operator account switcher — see the pickerOpen hooks above for the design
              rationale. Keeps the red topbar pill and the Accounts page untouched: this is
              an ADDITIONAL entry point to the same openAccount/exitAccount, not a new
              mechanism. Hidden on the collapsed icon rail (portal.html media query) —
              a 52px-wide tenant list helps nobody; the Accounts page covers that mode. */}
          {isOperator && (
            <div className="ss-switch-wrap" ref={pickerRef}>
              <button type="button" className="ss-switch" onClick={() => setPickerOpen((o) => !o)}
                aria-haspopup="listbox" aria-expanded={pickerOpen}
                title={viewing ? `Viewing ${shownBusiness} — switch account` : "Switch account"}>
                <div className="ss-clogo" aria-hidden="true">{tenantInitials}</div>
                <span className="stext">
                  <span className="sname">{shownBusiness}</span>
                  <span className="srole">{viewing ? "Viewing as operator" : "Your account"}</span>
                </span>
                <svg className="uchev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6"/></svg>
              </button>
              {pickerOpen && (
                <div className="ss-switch-menu" role="listbox" aria-label="Switch account">
                  <input type="search" placeholder="Search builders…" value={pickerQ} autoFocus
                    onChange={(e) => setPickerQ(e.target.value)} />
                  <div className="ss-switch-list">
                    {pickerClients === null && <div className="ss-switch-note">Loading accounts…</div>}
                    {pickerClients !== null && pickerClients
                      .filter((c) => {
                        const q = pickerQ.trim().toLowerCase();
                        return !q || String(c.companyName || "").toLowerCase().includes(q) || String(c.clientId || "").toLowerCase().includes(q);
                      })
                      .map((c) => {
                        const isCur = viewing && viewing.clientId === c.clientId;
                        return (
                          <button type="button" key={c.clientId} role="option" aria-selected={!!isCur}
                            className={isCur ? "cur" : ""} onClick={() => pickAccount(c)}>
                            <span className="ss-clogo sm" aria-hidden="true">{String(c.companyName || c.clientId || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("")}</span>
                            <span className="nm">{c.companyName || c.clientId}</span>
                            {isCur && <span className="vw">Viewing</span>}
                          </button>
                        );
                      })}
                    {pickerClients !== null && pickerClients.length === 0 && <div className="ss-switch-note">No accounts.</div>}
                  </div>
                  {viewing && (
                    <button type="button" className="ss-switch-exit" onClick={() => { setPickerOpen(false); setPickerQ(""); exitAccount(); }}>
                      ← Exit {shownBusiness}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          <button type="button" className="ss-newlink" onClick={() => navigate("releases")} title="New features / Bug fixes">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2l2.35 6.76H21l-5.32 4.02L17.7 20 12 15.6 6.3 20l2.02-7.22L3 8.76h6.65z"/></svg>
            <span>New features / Bug fixes</span>
          </button>
          {/* Hovering (or focusing/tapping) the identity row reveals a small
              flyout menu above it with Sign Out — no standalone button. */}
          <div className="ss-user-wrap">
            <div className="ss-user" title={session.user.email} tabIndex={0} role="button" aria-haspopup="menu" aria-label={`Account menu for ${displayName}`}>
              <div className="ss-avatar">{initials}</div>
              <div className="utext">
                <div className="uname">{displayName}</div>
                <div className="umail">{session.user.email}</div>
              </div>
              <svg className="uchev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6"/></svg>
            </div>
            <div className="ss-user-menu" role="menu">
              {/* Reachable by EVERY role. The Settings tab is owner/admin only, so a
                  "user"-role account would have nowhere else to edit their own details. */}
              <button type="button" className="neutral" onClick={() => setProfileOpen(true)} role="menuitem">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                <span className="mtext">Your details</span>
              </button>
              {/* Carolyn, 2026-07-23: a direct contact option ALONGSIDE the feedback widget.
                  Deliberately worded to route bugs to the widget, because that path is tracked
                  in monday.com and an untracked mailto would quietly drain its volume — which
                  is exactly how Nevin's release complaint got lost in the old email flow.
                  Hidden while an operator is viewing a tenant: the mail would arrive from the
                  operator's own address about someone else's account.
                  A <button> rather than an <a> so the existing `.ss-user-menu button` CSS
                  applies unchanged; `.neutral` opts out of Sign Out's red hover. */}
              {!viewing && (
                <button type="button" className="neutral" role="menuitem"
                  title="Email CSM Synergy about your account — for bugs, use the Feedback button"
                  onClick={() => {
                    const subj = `Structure Studio — ${shownBusiness || "support request"}`;
                    window.location.href = "mailto:support@csmsynergy.com?subject=" + encodeURIComponent(subj);
                  }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/></svg>
                  <span className="mtext">Contact support</span>
                </button>
              )}
              <button type="button" onClick={signOut} role="menuitem">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/></svg>
                <span className="mtext">Sign Out</span>
              </button>
            </div>
          </div>
        </div>
      </aside>

      {/* ss-designer-active pins .ss-main to 100vh and makes .ss-body overflow:hidden — correct
          when the flex:1 designer host is present, but the host only renders when
          `designerOpened && !gateLocked`. A billing-locked tenant clicking Designer (the FIRST nav
          item, so a freshly-gated tenant is very likely to click it first) got BillingGate inside
          that 100vh overflow:hidden shell instead, with no scrollbar — so on a 1366x768 laptop the
          plan cards and the Subscribe button were clipped below the fold and unreachable, on the
          one screen whose entire purpose is "click here to pay". Gate the class on the same
          condition as the host so the gate falls back to a normal scrolling body. */}
      <section className={"ss-main"
        + (activeTab === "designer" && !gateLocked ? " ss-designer-active" : "")
        + (viewing ? " ss-viewing" : "")}>
        <div className="ss-topbar">
          {/* Title AND description, both on the gradient — this is the one header, so there
              is nothing below repeating it. */}
          <div className="ttl">{(TAB_META[activeTab] || [activeTab])[0]}<span>{(TAB_META[activeTab] || [])[1]}</span></div>
          {viewing && (
            <div title="You are acting as this builder. Changes you make here are live in THEIR account. Design statuses show the last cached value — the live GHL refresh only runs for the tenant's own login."
              style={{ display: "flex", alignItems: "center", gap: 10, background: "#FEE2E2", border: "1px solid #DC2626", borderRadius: 9, padding: "6px 12px", fontSize: 12.5, fontWeight: 700, color: "#991B1B", whiteSpace: "nowrap" }}>
              <span>Editing as operator — changes are live</span>
              <button type="button" onClick={exitAccount}
                style={{ background: "#92400E", color: "#FFF", border: "none", borderRadius: 7, padding: "4px 10px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                Exit
              </button>
            </div>
          )}
          <div className="tenant" title={shownBusiness}>
            <div className="ss-clogo" aria-label={`${shownBusiness} logo`}>{tenantInitials}</div>
            <span className="ss-tname">{shownBusiness}</span>
          </div>
        </div>
        <div className="ss-body">
          {/* Keep-mounted designer host — full-bleed sibling of .ss-inner (its 1240px
              max-width would box the designer in); hidden, never unmounted, off-tab. */}
          {designerOpened && !gateLocked && (
            <div className="ss-designer-host" style={{ display: activeTab === "designer" ? "block" : "none" }}>
              {/* No setup3d here on purpose (2026-08-21). The calibration editor is the ONLY
                  thing the designer used it for, and it now lives in Settings -> Designer -> 3D,
                  so passing it would put the yellow bar back over every design people open. */}
              <DesignerTab key={"d-" + effClientId} clientId={effClientId} view3d={view3dUnlocked} onSaved={() => setDesignsRefreshKey((k) => k + 1)}
                openDesign={openDesign && openDesign.clientId === effClientId ? openDesign : null}
                canPushInvoice={ordersCanEdit}
                /* navigate(), not location.assign: the designer host above is kept MOUNTED
                   across tab switches, and a real navigation would throw away whatever is
                   on the canvas. ssClampTab first, same as the record page's Orders link —
                   sending someone to a tab they cannot open is its own dead end. */
                onOpenOrder={ssClampTab("orders", isOperator, canAdmin, myAccess, supportView) === "orders"
                  ? (id) => navigate("orders", "o-" + id) : null} />
            </div>
          )}
          <div className="ss-inner">
            {/* One-time nudge for a user with no name on file. Dismissible: it is a courtesy,
                not a gate — nothing about it should block someone from doing their job. */}
            {showNudge && (
              <div style={{ background: "#F5F3FF", border: "1px solid #C4B5FD", borderRadius: 10, padding: "10px 14px", marginBottom: 14, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#6D28D9" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                <span style={{ fontSize: 12.5, fontWeight: 700, color: "#4C1D95" }}>
                  Add your name and phone number so your team knows who's who.
                </span>
                <button type="button" onClick={() => setProfileOpen(true)}
                  style={{ ...S.btn("#6D28D9", "#FFF"), marginLeft: "auto", padding: "6px 12px", fontSize: 12 }}>Add details</button>
                <button type="button" onClick={() => setNudgeHidden(true)} title="Dismiss"
                  style={{ background: "none", border: "none", color: "#7C3AED", fontSize: 12, fontWeight: 700, cursor: "pointer", padding: "6px 2px" }}>Later</button>
              </div>
            )}
            {/* Dated free period. Nothing has gone wrong — they simply haven't started paying
                yet — so this is deliberately informational (blue) rather than a warning, and
                never says anything about a failed payment. */}
            {gateTransition && (
              <div style={{ background: "#EFF6FF", border: "1px solid #93C5FD", borderRadius: 10, padding: "11px 14px", marginBottom: 14, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="#1D4ED8" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
                <span style={{ fontSize: 12.5, fontWeight: 700, color: "#1E3A8A" }}>
                  {transDaysLeft === 0
                    ? "Your account moves to a paid plan today."
                    : `Your account moves to a paid plan${transDateLabel ? ` on ${transDateLabel}` : ""} — ${transDaysLeft} day${transDaysLeft === 1 ? "" : "s"} left.`}
                  {rate && rate.discountPercent > 0 && (rate.monthlyCents != null || rate.annualCents != null) && (
                    <span style={{ fontWeight: 600 }}>
                      {" "}Your rate: {[rate.monthlyCents != null ? `${fmtRate(rate.monthlyCents)}/mo` : null,
                                       rate.annualCents != null ? `${fmtRate(rate.annualCents)}/yr` : null]
                        .filter(Boolean).join(" or ")} — {rate.discountPercent}% off for life.
                    </span>
                  )}
                </span>
                {/* Both banner CTAs target the Billing sub-tab EXPLICITLY. navigate("settings")
                    leaves sub null, which SettingsShell defaults to its first tab — so "Choose your
                    plan" and "Update payment" both landed on the Structures catalog/pricing-CSV
                    editor with nothing about payment on screen. Unlike the hard-locked state (where
                    BillingGate embeds the picker wherever they click), the transition and grace
                    states rely entirely on these two buttons to reach payment, so a non-technical
                    owner concludes the button is broken and may let the grace period lapse. */}
                {isAdmin && (
                  <button type="button" onClick={() => navigate("settings", "billing")}
                    style={{ ...S.btn("#1D4ED8", "#FFF"), marginLeft: "auto", padding: "6px 12px", fontSize: 12 }}>Choose your plan</button>
                )}
              </div>
            )}
            {/* Grace period: a failed payment hasn't locked them out yet. Everything
                still works — this is the warning that it won't for long. */}
            {gateGrace && (
              <div style={{ background: "#FEF3C7", border: "1px solid #F59E0B", borderRadius: 10, padding: "11px 14px", marginBottom: 14, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="#92400E" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>
                <span style={{ fontSize: 12.5, fontWeight: 700, color: "#92400E" }}>
                  Your last payment didn't go through.
                  {graceDaysLeft !== null && ` Access continues for ${graceDaysLeft} more day${graceDaysLeft === 1 ? "" : "s"}.`}
                </span>
                {isAdmin && (
                  <button type="button" onClick={() => navigate("settings", "billing")}
                    style={{ ...S.btn("#92400E", "#FFF"), marginLeft: "auto", padding: "6px 12px", fontSize: 12 }}>Update payment</button>
                )}
              </div>
            )}
            {gateLocked && <BillingGate reason={entitlement.reason} isAdmin={isAdmin} />}
            {/* THE PIPEDRIVE-STYLE RECORD PAGE. Carolyn, 2026-08-24: "the view of being in
                an opportunity and the view of being in a person are different, but they're
                the same."

                Routed on the `sub` segment: /portal/contacts/c-<uuid> for a contact and
                /portal/designs/d-<code> for a design. The prefix (c-/d-) is what tells the
                two record kinds apart, so ONE shell serves both.

                It accepts a record sub under EITHER tab, which is what keeps the merged
                era's /portal/designs/c-<uuid> links working after the 08-26 split. The tab
                only decides which nav item is highlighted; the prefix decides what renders.
                Do not "tidy" this into a per-tab check — that would 404 every record link
                shared between 08-24 and 08-26. */}
            {/* ⚠️ canEdit WAS `ssCanRead(myAccess, "contacts") === "edit"`, which was ALWAYS
                FALSE: ssCanRead returns a BOOLEAN (01-core), so it compared `true` to the
                string "edit". The whole conversation half of the record page — Activity,
                Notes and the Email composer — was therefore disabled for EVERY user in the
                product, owners and operators included, while the server happily accepted
                those same writes. Worse, the Email tab's hint then blamed the contact ("no
                email address on file") in front of a contact whose address is rendered
                directly above it. Shape copied from schedCanEdit/deliverCanEdit above: an
                admin or owner always holds it, otherwise read the area out of the map. */}
            {/* A CONTACT record (c-) is CRM and needs the subscription; a DESIGN record (d-)
                is not — it is what opens from the free Pipeline list, and its server branch
                reads `designs` only. Same split the portal-settings gate makes, and the two
                must agree or one of them produces a 403 the other never predicted. */}
            {!gateLocked && (activeTab === "designs" || activeTab === "contacts") && sub && /^c-/.test(sub) && !crmUnlocked ? (
              <ComingSoon
                title="Contacts"
                icon={<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="#FFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>}
                blurb="Customer records are part of the built-in CRM — their designs and quotes, your notes, the texts and emails you've traded, and what needs doing next."
                bullets={[
                  "One record per customer: designs, quotes, notes and files",
                  "Text and email them from inside the record — the thread stays",
                  "Follow-up activities so nobody quietly goes cold",
                ]}
                cta={canAdmin ? { label: "Add the CRM — see Billing", onClick: () => navigate("settings", "billing") } : null}
                available
              />
            ) : !gateLocked && (activeTab === "designs" || activeTab === "contacts") && sub && /^[cd]-/.test(sub) ? (
              <CrmRecord
                key={sub}
                kind={sub.charAt(0) === "c" ? "contact" : "design"}
                recordId={sub.slice(2)}
                isAdmin={canAdmin}
                canEdit={canAdmin || !!(myAccess && myAccess.contacts === "edit")}
                /* The DESIGN record reaches this line without a subscription — the branch
                   above turns a CONTACT record away, but a design record is what the free
                   Pipeline list opens and it has to keep working. Its READ is exempt from the
                   server's crm_ gate on purpose; every WRITE on the page is not, so the
                   record used to render with a live Notes box that 403'd on Save. Passing the
                   entitlement lets CrmRecord grey what it cannot save instead. */
                crmUnlocked={crmUnlocked}
                onSeeBilling={canAdmin ? () => navigate("settings", "billing") : null}
                /* Back goes to the list this record belongs to, which after the split is a
                   whole tab rather than a sub-view. */
                onBack={() => navigate(sub.charAt(0) === "c" ? "contacts" : "designs")}
                /* Cross-record hops (the Person card's "›", an entry under OPEN DEALS). The
                   record shell above serves EITHER kind under EITHER tab, so the tab here is
                   cosmetic — which nav item highlights — and switching to one the clamp
                   refuses costs the reader the record entirely: the URL-normalising effect
                   nulls a refused tab's sub and dumps them on a list with no message. That is
                   the hazard the header comment names for legacy record URLs, and a crew
                   leader (designs:view, contacts none) hit it on every click through to a
                   customer. Stay on the tab we are already on when the record's own is
                   refused; the server serves the record either way (crm_record's gate is
                   `any: [contacts view, designs view]`). Asked through ssClampTab so this
                   can never drift from what the router will actually do. */
                onNavigate={(k, id) => {
                  const kindTab = k === "contact" ? "contacts" : "designs";
                  const dest = ssClampTab(kindTab, isOperator, canAdmin, myAccess, supportView) === kindTab ? kindTab : activeTab;
                  navigate(dest, (k === "contact" ? "c-" : "d-") + id);
                }}
                onOpenDesign={(code) => openInDesigner(code)}
                /* The Orders card can link out now that the order detail has a URL.
                   ssClampTab first, because a crew leader may hold the record and not
                   Orders -- and dumping them on a list they cannot read is the same trap
                   the onNavigate comment above documents. */
                onOpenOrder={ssClampTab("orders", isOperator, canAdmin, myAccess, supportView) === "orders"
                  ? (id) => navigate("orders", "o-" + id) : null}
              />
            ) : null}
            {/* The merged era's two sub-views correct themselves; see DesignsLegacySub. */}
            {!gateLocked && activeTab === "designs" && (sub === "people" || sub === "deals") ? (
              <DesignsLegacySub sub={sub} navigate={navigate} />
            ) : null}
            {/* PIPELINE — the designs list, with the List | Pipeline board toggle inside it.
                `sub === "deals"` still renders it, so a legacy /portal/designs/deals link
                shows content immediately instead of a blank frame while the URL normalises.
                Anything unrecognised renders it too — the same treatment SettingsShell gives
                an unknown slug, so a stray segment never leaves the section bodiless. */}
            {!gateLocked && activeTab === "designs" && sub !== "people" && !(sub && /^[cd]-/.test(sub)) && (
              <DesignsTable key={"t-" + effClientId} clientId={effClientId}
                fetchDesigns={viewing ? viewingFetch : null} refreshKey={designsRefreshKey}
                isAdmin={canAdmin} crmUnlocked={crmUnlocked}
                onSeeBilling={() => navigate("settings", "billing")}
                viewingLabel={viewing ? (viewing.companyName || viewing.clientId) : null}
                onOpenRecord={(code) => navigate("designs", "d-" + code)}
                /* /portal/designs/list and /portal/designs/pipeline. A BARE /portal/designs
                   deliberately carries no view of its own so the saved preference can fill
                   it -- pinning it to "list" here would quietly outrank the setting. */
                urlView={sub === "pipeline" || sub === "list" ? sub : null}
                defaultView={(tenant && tenant !== "none" && tenant.prefs && tenant.prefs.designsView) || null}
                onViewChange={(v) => navigate("designs", v)}
                onOpenDesign={openInDesigner} />
            )}
            {/* CONTACTS — its own tab again, at /portal/contacts (was /portal/leads; aliased).
                Behind the built-in CRM subscription since migration 160; the nav item stays
                visible (like Build Schedule) so the locked card can do the selling. */}
            {!gateLocked && activeTab === "contacts" && !(sub && /^[cd]-/.test(sub)) && (
              crmUnlocked ? (
                <LeadsTable key={"t-" + effClientId} clientId={effClientId}
                  fetchDesigns={viewing ? viewingFetch : null} isAdmin={canAdmin}
                  onOpenRecord={(contactId) => navigate("contacts", "c-" + contactId)}
                  onOpenDesign={openInDesigner} />
              ) : (
                <ComingSoon
                  title="Contacts"
                  icon={<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="#FFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>}
                  blurb="Every buyer in one place, with the whole story attached — their designs and quotes, your notes, the calls and texts and emails you've traded, and what needs doing next. The pipeline board comes with it, so you can see who's where at a glance."
                  bullets={[
                    "One record per customer: designs, quotes, notes and files",
                    "Text and email them from inside the record — the thread stays",
                    "Follow-up activities so nobody quietly goes cold",
                    "The pipeline board view, alongside your list",
                  ]}
                  cta={canAdmin ? { label: "Add the CRM — see Billing", onClick: () => navigate("settings", "billing") } : null}
                  available
                />
              )
            )}
            {!gateLocked && activeTab === "accounts" && isOperator && (
              <AccountsTab viewing={viewing} onOpen={openAccount}
                onEditUser={(c, u) => setEditUser({ clientId: c.clientId, companyName: c.companyName, user: u })}
                usersRefreshKey={usersRefreshKey} />
            )}
            {!gateLocked && activeTab === "orders" && (
              /* SHIPPED TO TENANTS 2026-09-01. Until then this was operators-only on their
                 OWN portal and everyone else saw the locked example-data preview below.
                 What had to be true first, named in advance by 154_area_access_rls.sql:84-95:
                 OrdersView read designs through RLS, and its viewers now include titles that
                 hold Orders and NOT Designs — a crew leader, a driver. Both of those reads
                 moved behind portal-settings orders_designs (gated orders:view) in this same
                 change. The designs RLS policy was NOT widened; that shortcut is refused at
                 length in the migration and again in the action header, because
                 designs_ensure_order mints a row for every accepted design and so it would
                 resolve to "every design ever sold".
                 !viewing survives: orders/payments RLS is scoped to current_client_id(), so
                 an operator reading ANOTHER tenant's rows directly still gets nothing — the
                 locked preview stays the honest answer there. */
              (canAdmin || ssCanSeeTab("orders", myAccess) || isOperator) && !viewing
                ? <OrdersView clientId={tenant.clientId}
                    schedOn={schedUnlocked && schedCanEdit} deliverOn={schedUnlocked && deliverCanEdit}
                    coOn={coCanEdit}
                    /* A sold lot building is already waiting in the Delivery Schedule's
                       "to be loaded" pool (the pool is a query over sold units without a
                       sale stop), so this just takes the dispatcher there — no focus/
                       hand-off state to keep in sync. */
                    onScheduleDelivery={() => navigate("delivery-schedule")}
                    /* IN-PORTAL designer, same as every other Open in this app — the public
                       ?id= page silently captures leads/drafts, so staff must never browse
                       a customer's design there. */
                    onOpenDesign={openInDesigner}
                    /* /portal/orders/o-<id>, on the same `<letter>-` sub shape the record
                       pages already use. Opening pushes, closing pops -- so Back closes the
                       order instead of leaving Orders, and an order can finally be linked
                       to. `replace` is deliberately NOT used: the open IS the navigation. */
                    urlOpenId={sub && /^o-/.test(sub) ? sub.slice(2) : null}
                    onOpenChange={(id) => navigate("orders", id ? "o-" + id : null)} />
                : <OrdersPreview />
            )}
            {/* Operator console, native since 2026-07-30 (was an iframe onto admin.html).
                Kept MOUNTED across tab switches, like the designer — the original reason
                (admin.html held the ADMIN_PASSWORD in iframe state, so unmounting
                re-prompted and could trip the per-IP lockout) is gone, but a better one
                replaced it: AdminShell's staged work — ticked item pills, a parsed CSV
                report, a half-filled billing or link-owner form, a chosen style image — is
                all local, and unmount-on-tab-switch would silently bin it.
                Deliberately NOT behind `!gateLocked`: an operator whose OWN tenant is
                billing-locked must still be able to run the console. */}
            {adminOpened && isOperator && !supportView && (
              <div style={{ display: activeTab === "admin" ? "block" : "none" }}>
                <AdminShell onOpenAccount={openAccount}
                  sub={activeTab === "admin" ? sub : null} onSub={(x) => navigate("admin", x)} />
              </div>
            )}
            {/* Internal Projects boards (Monday.com replacement). Operator-gated like
                accounts/admin; ssClampTab bounces everyone else. Deliberately NOT behind
                `!gateLocked` — like the Admin console, an operator whose OWN tenant is
                billing-locked must still reach the internal boards. */}
            {activeTab === "projects" && canProjects && !supportView && (
              <ProjectsTab sub={sub} onSub={(x) => navigate("projects", x)} />
            )}
            {!gateLocked && activeTab === "releases" && (
              <ReleasesView submissionsKey={feedbackKey}
                sub={activeTab === "releases" ? sub : null} onSub={(x) => navigate("releases", x)}
                onNavigate={navigate} canAdmin={canAdmin} />
            )}
            {/* Admits exactly who the server admits: every qbo_* action in portal-settings'
                GATES is gated on settings_quickbooks, and TAB_AREA routes the tab through
                the clamp on that same area — so a settings_quickbooks holder deep-linking
                /portal/quickbooks got a topbar over an empty body while canAdmin alone
                gated this render (audit 2026-08-20). */}
            {!gateLocked && activeTab === "quickbooks" && (canAdmin || ssCanRead(myAccess, "settings_quickbooks")) && (
              qboUnlocked ? (
                <QuickBooksView key={"t-" + effClientId} clientId={effClientId}
                  viewingLabel={viewing ? (viewing.companyName || viewing.clientId) : null} />
              ) : (
                <QuickBooksLocked canAdmin={canAdmin} onSeeBilling={() => navigate("settings", "billing")} />
              )
            )}
            {/* Same admission rule as the nav item and ssClampTab: anyone holding at least
                one settings area gets the shell (migration 100) — a canAdmin-only gate here
                left those people a Settings topbar over an empty body (audit 2026-08-20).
                SettingsShell filters its own sub-tabs by area for non-admins, and
                portal-settings re-checks every action per-area regardless. */}
            {!gateLocked && activeTab === "settings" && (canAdmin || SETTINGS_AREAS.some((a) => ssCanRead(myAccess, a))) && (
              <SettingsShell key={"t-" + effClientId} clientId={effClientId}
                viewingLabel={viewing ? (viewing.companyName || viewing.clientId) : null}
                isOwner={!viewing && tenant.role === "owner"}
                isAdmin={!viewing && (tenant.role === "owner" || tenant.role === "admin")}
                access={viewing ? null : myAccess}
                /* MY VIEW settings are the OPERATOR's own even in view-as: they are the
                   person looking at the screen, and borrowing the viewed builder's owner's
                   layout would be both wrong and a small information leak. So this is NOT
                   nulled under `viewing`, unlike `access` above. */
                prefs={tenant && tenant !== "none" ? tenant.prefs : null}
                onPrefsSaved={(p) => setTenant((t) => (t && t !== "none" ? { ...t, prefs: p } : t))}
                schedUnlocked={schedUnlocked}
                qboUnlocked={qboUnlocked}
                rtpUnlocked={rtpUnlocked}
                setup3d={setup3d}
                sub={sub} onSub={(x) => navigate("settings", x)} />
            )}
            {/* Deep-link landing only — the nav item is gone (2026-08-28) and the real
                feature lives in Settings → Structures. `available` because it HAS shipped:
                without it a sales rep reads a live feature as unbuilt (the ComingSoon
                lesson). The cta deep-links to the settings sub-tab, billing-style. */}
            {!gateLocked && activeTab === "on-demand-pricing" && (
              <ComingSoon
                title="RealTime Pricing"
                available
                icon={<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="#FFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2 3 14h9l-1 8 10-12h-9z"/></svg>}
                blurb="Bring your material costs into Structure Studio and build out every style and size with the exact materials each building needs. Update your costs each month or quarter and every building's price recalculates on its own — so you always know your true, current cost and profit margin. Set it up under Settings → Structures."
                bullets={[
                  "One material cost list; every building prices itself from it",
                  "Update costs monthly or quarterly — building prices refresh automatically",
                  "Know your real build cost and profit margin in real time",
                ]}
                cta={canAdmin ? { label: "Set it up — Settings → Structures", onClick: () => navigate("settings", "structures") } : null}
              />
            )}
            {/* Scheduling suite: live when schedUnlocked (operator, or the tenant's
                entitlement carries schedule_builds); otherwise the available-now card
                pointing admins at Billing. */}
            {!gateLocked && activeTab === "build-schedule" && (
              schedUnlocked ? (
                <BuildScheduleTab key={"bsched-" + effClientId} clientId={effClientId} canAdmin={canAdmin}
                  access={viewing ? null : myAccess}
                  onOpenDesign={(code) => openInDesigner(code)} />
              ) : (
              <ComingSoon
                title="Build Schedule"
                icon={<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="#FFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/></svg>}
                blurb="Follow every building from signed order to finished product. A clear production timeline shows what's queued, what's in progress, and what's ready — so you and your crew always know what's being built and when."
                bullets={[
                  "See every order's build stage at a glance",
                  "Queue, in-progress, and completed views",
                  "Keep the shop floor and the office on the same page",
                ]}
                cta={canAdmin ? { label: "Turn on scheduling — see Billing", onClick: () => navigate("settings", "billing") } : null}
                available
              />
              )
            )}
            {!gateLocked && activeTab === "delivery-schedule" && (
              schedUnlocked ? (
                <DeliveryScheduleTab key={"dsched-" + effClientId} clientId={effClientId} canAdmin={canAdmin}
                  access={viewing ? null : myAccess} />
              ) : (
              <ComingSoon
                title="Delivery Schedule"
                icon={<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="#FFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 17h4V5H2v12h3"/><path d="M20 17h2v-3.34a4 4 0 0 0-1.17-2.83L19 9h-5v8h1"/><circle cx="7.5" cy="17.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/></svg>}
                blurb="Plan every delivery as a truck load — grouped by area, sized to your driver's trailer, with build dates in view. See the week ahead at a glance and never send a building that isn't ready."
                bullets={[
                  "Plan loads by truck day: driver, route, deck space, wide-load flags",
                  "A week-at-a-glance calendar of upcoming drop-offs",
                  "The schedule won't let a building go out before it's built",
                ]}
                cta={canAdmin ? { label: "Turn on scheduling — see Billing", onClick: () => navigate("settings", "billing") } : null}
                available
              />
              )
            )}
            {/* Inventory is a STATUS VIEW (Carolyn 2026-08-08): no scheduling props on
                purpose. Queueing a build lives on the Build Schedule; loads live on the
                Delivery Schedule; a sale follows the customer's invoice. */}
            {!gateLocked && activeTab === "inventory" && (
              <InventoryTable key={"inv-" + effClientId} clientId={effClientId} isAdmin={canAdmin}
                refreshKey={designsRefreshKey}
                onOpenDesign={openInDesigner}
                onSendEstimate={(u) => openInDesigner(u.shortCode, null, { asNew: true, inventoryUnitId: u.id, unitSerial: u.serial, unitLifecycle: u.lifecycle })}
                // Reopens the losing customer's own design UNTIED from the sold building, so
                // the next submit is a fresh build quoted to them. Same path the designer's
                // "Design a new build instead" button already takes.
                onQuoteNewBuild={(e) => openInDesigner(e.shortCode, null, { newBuild: true })}
                onNew={() => openInDesigner(null, null, { blank: true })} />
            )}
            {!gateLocked && activeTab === "repairs" && (
              schedUnlocked ? (
                <RepairsTab key={"reps-" + effClientId} clientId={effClientId} canAdmin={canAdmin}
                  access={viewing ? null : myAccess} />
              ) : (
              <ComingSoon
                title="Repairs"
                icon={<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="#FFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>}
                blurb="Manage repair and service work from request to done. Log a repair, track the job, and keep the full service history with the customer's building."
                bullets={[
                  "Log repair requests in seconds",
                  "Track each job from request to completed",
                  "Service history tied to each building and customer",
                ]}
                cta={canAdmin ? { label: "Turn on scheduling — see Billing", onClick: () => navigate("settings", "billing") } : null}
                available
              />
              )
            )}
            {!gateLocked && activeTab === "view-3d" && (
              view3dUnlocked
                ? <Studio3DStatus clientId={effClientId} canAdmin={canAdmin} navigate={navigate} />
                : <ComingSoon
                    title="3D Design"
                    icon={ICONS["view-3d"]}
                    blurb="Let a shopper turn their floor plan into a real 3D building - their sizes, their roof, their colors - and put that view straight onto the quote."
                    bullets={[
                      "Orbit the building the customer just designed",
                      "Roof profile, cladding, doors and windows in their colors",
                      "The 3D view rides along on the emailed quote",
                    ]}
                  />
            )}
            {!gateLocked && activeTab === "rent-to-own-contracts" && (
              <ComingSoon
                title="Rent to Own"
                icon={<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="#FFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6M9 17h4"/></svg>}
                blurb="Offer rent-to-own without the paperwork headache. Turn any quote into a rent-to-own agreement, set the term, down payment, and monthly schedule, and keep every signed contract organized in one place."
                bullets={[
                  "Turn any quote into a rent-to-own agreement in a click",
                  "Set the term, down payment, and monthly schedule",
                  "Every signed contract stored and easy to find",
                ]}
              />
            )}
            {!gateLocked && activeTab === "self-serve-display-units" && (
              <ComingSoon
                title="Self Serve Displays"
                icon={<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="#FFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>}
                blurb="Put a kiosk right inside a display unit on your lot. Customers walk in, design and estimate their own shed on the spot, and — at the push of a button — reach a live person who can help them through it."
                bullets={[
                  "A walk-in kiosk built into a display unit",
                  "Customers design and estimate their own shed on site",
                  "One-touch access to a live person for help",
                ]}
              />
            )}
            {/* Same guard CommissionTeam applies (08-integrations): portal-commissions
                resolves the tenant from the CALLER's own client_users row and is
                deliberately outside SS_TENANT_SCOPED_FNS, so from view-as this report
                would read — and via compute / approve / mark-paid WRITE — the OPERATOR's
                own ledger under the viewed builder's banner (audit 2026-08-20). A screen
                that quietly does something other than what it says is worse than one
                that is absent. */}
            {!gateLocked && activeTab === "commissions" && (
              viewing ? (
                <div style={{ ...S.card, maxWidth: 860, color: "#64748B", fontSize: 13, lineHeight: 1.6 }}>
                  <div style={{ ...S.h2, marginBottom: 6 }}>Commissions</div>
                  Commissions for <b>{viewing.companyName || viewing.clientId}</b> aren't available
                  from view-as — this report would show and change your own account's ledger
                  instead. Ask an owner there to run it, or use the Admin console.
                </div>
              ) : (
                // Only ever the caller's own tenant (the view-as branch above refuses),
                // but the cache key is explicit rather than implied.
                <CommissionsReport clientId={effClientId} />
              )
            )}
            {!gateLocked && activeTab === "reports" && (
              <ComingSoon
                title="Reports"
                icon={<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="#FFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/><line x1="3" y1="20" x2="21" y2="20"/></svg>}
                blurb="Pull any report you want on your business — sales, leads, customers, revenue, builds delivered, and more. Filter by date range, rep, or building type and export it whenever you need it."
                bullets={[
                  "Sales and revenue over any date range",
                  "Leads and customer activity at a glance",
                  "Builds delivered and pipeline throughput",
                  "Break down by rep, building type, or status",
                  "Export to share or drop into your books",
                ]}
              />
            )}
          </div>
        </div>
      </section>

      {/* Bug / feature intake. Hidden while an operator is viewing someone else's
          account: portal-feedback attributes a submission to the JWT's own tenant,
          which would NOT be the client on screen — filing from here would land the
          ticket under the operator's own business and read as that client's report. */}
      {!viewing && (
        <FeedbackWidget
          clientId={tenant.clientId}
          onSubmitted={() => setFeedbackKey((k) => k + 1)}
        />
      )}

      {/* Operator quick-add: file an item onto a Projects board from anywhere in the
          portal (Carolyn 2026-08-29). Deliberately visible in view-as too — spotting a
          bug while inside a builder's account is exactly when you want it, and unlike
          the Feedback bubble above there is no tenant attribution to get wrong. */}
      {isOperator && !supportView && <PMQuickAdd viewingClientId={viewing ? viewing.clientId : null} />}

      {/* Your own name and phone. Writes via portal-settings save_profile, which keys off the
          verified session's user id — the browser never says whose row to update. */}
      {profileOpen && (
        <ProfileDialog
          initial={profile}
          email={session.user.email}
          onClose={() => setProfileOpen(false)}
          onSaved={(p) => {
            setProfile((prev) => ({ ...(prev || {}), fullName: p.fullName, phone: p.phone, needsDetails: false }));
            setProfileOpen(false);
          }}
        />
      )}

      {/* Operator filling in someone else's details from the Accounts tab. Contact fields
          only — role and tenant are not editable here, since either would move access. */}
      {editUser && (
        <ProfileDialog
          title={`${editUser.user.fullName || editUser.user.email || "User"} — ${editUser.companyName}`}
          initial={{ fullName: editUser.user.fullName, phone: editUser.user.phone }}
          email={editUser.user.email}
          save={async (fullName, phone) => {
            const { data, error } = await sb.functions.invoke("operator-portal", {
              body: { action: "save_user", clientId: editUser.clientId, userId: editUser.user.userId, fullName, phone },
            });
            if (error) {
              let msg = error.message;
              try { const ctx = await error.context.json(); if (ctx && ctx.error) msg = ctx.error; } catch (_e) {}
              throw new Error(msg || "Could not save.");
            }
            if (data && data.error) throw new Error(data.error);
          }}
          onClose={() => setEditUser(null)}
          onSaved={() => { setEditUser(null); setUsersRefreshKey((k) => k + 1); }}
        />
      )}
    </div>
  );
}

// Format a US phone as it is typed: 5551234567 -> (555) 123-4567.
//
// Only when the input is plainly a US number. An explicit non-+1 country code, or more digits
// than a US number holds (an extension, another country), is returned EXACTLY as entered —
// silently reshaping "+44 20 7123 4567" into a US pattern would corrupt a real number, and
// truncating to 10 digits would lose one. Idempotent, so re-formatting its own output is a
// no-op, and it degrades cleanly while typing or backspacing rather than fighting the caret.
function formatPhone(input) {
  const raw = String(input == null ? "" : input);
  const t = raw.trim();
  if (/^\+/.test(t) && !/^\+\s*1\b/.test(t) && !/^\+\s*1\d/.test(t)) return raw;
  const plus1Typed = /^\+\s*1/.test(t);
  let d = raw.replace(/\D/g, "");
  let cc = false;
  if (plus1Typed && d[0] === "1") { d = d.slice(1); cc = true; }
  else if (d.length === 11 && d[0] === "1") { d = d.slice(1); cc = true; }
  if (d.length > 10) return raw;
  const p = cc ? "+1 " : "";
  if (!d) return cc ? "+1 " : "";
  if (d.length <= 3) return p + d;
  if (d.length <= 6) return `${p}(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `${p}(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

// ─── Name + phone editor ───
// One component for two callers: a user editing their OWN details (default save → the
// self-service portal-settings action) and an operator editing someone else's (save injected
// by the caller). Email is shown read-only — changing a login's email is an auth operation,
// not a contact-detail edit, and belongs with the deliberate owner-linking flow.
function ProfileDialog({ initial, email, onClose, onSaved, title, save }) {
  const [fullName, setFullName] = useState((initial && initial.fullName) || "");
  // Format what is already stored too, so an operator-typed or legacy value renders the same
  // as a freshly entered one rather than only tidying up once someone edits it.
  const [phone, setPhone] = useState(formatPhone((initial && initial.phone) || ""));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const submit = async () => {
    const n = fullName.trim();
    if (!n) { setErr("Please enter a name."); return; }
    setBusy(true); setErr(null);
    try {
      if (save) {
        await save(n, phone.trim());
      } else {
        const { data, error } = await sb.functions.invoke("portal-settings", {
          body: { action: "save_profile", fullName: n, phone: phone.trim() },
        });
        if (error) {
          let msg = error.message;
          try { const ctx = await error.context.json(); if (ctx && ctx.error) msg = ctx.error; } catch (_e) {}
          throw new Error(msg || "Could not save.");
        }
        if (data && data.error) throw new Error(data.error);
      }
      onSaved({ fullName: n, phone: phone.trim() });
    } catch (e) {
      setErr(e.message || "Could not save.");
    }
    setBusy(false);
  };

  return (
    <div onClick={() => !busy && onClose()}
      style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.5)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 1000 }}>
      <div onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true"
        style={{ background: "#FFF", borderRadius: 12, padding: 22, maxWidth: 420, width: "100%", boxShadow: "0 20px 50px rgba(0,0,0,0.25)" }}>
        <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 4 }}>{title || "Your details"}</div>
        <div style={{ fontSize: 12.5, color: "#64748B", marginBottom: 14, lineHeight: 1.5 }}>
          Used so your team knows who's who. Your phone number is visible to admins on this
          account and to StructureStudio support — it is never shown to your customers.
        </div>
        {err && <div style={{ background: "#FEF2F2", border: "1px solid #FECACA", color: "#B91C1C", borderRadius: 8, padding: "8px 11px", fontSize: 12.5, marginBottom: 12 }}>{err}</div>}
        <span style={S.lbl}>Name</span>
        <input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Jane Yoder"
          autoFocus style={{ ...S.input, marginBottom: 12 }} />
        <span style={S.lbl}>Phone</span>
        <input value={phone} onChange={(e) => setPhone(formatPhone(e.target.value))} placeholder="(555) 123-4567"
          inputMode="tel" autoComplete="tel" style={{ ...S.input, marginBottom: 12 }} />
        <span style={S.lbl}>Email</span>
        <input value={email || ""} readOnly title="Contact StructureStudio to change the email on a login"
          style={{ ...S.input, marginBottom: 18, background: "#F8FAFC", color: "#94A3B8" }} />
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose} disabled={busy} style={S.btn("#F1F5F9", "#334155")}>Cancel</button>
          <button type="button" onClick={submit} disabled={busy} style={S.btn(busy ? "#9CA3AF" : ACCENT, "#FFF")}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── App root: session + recovery routing ───
function PortalApp() {
  const [session, setSession] = useState(undefined); // undefined = booting
  const [recovery, setRecovery] = useState(false);
  const [expired, setExpired] = useState(false); // session died mid-use (401s) → notice on login
  const [linkError, setLinkError] = useState(null); // dead/expired email link → explain it on login

  useEffect(() => {
    // ── Email-link landing (password reset + invite) ──────────────────────────
    // Supabase reports the outcome of an email link in one of THREE shapes, and
    // this page has to answer all three. Handling only the first is why a reset
    // link looked broken (reported 2026-07-28):
    //
    //   1. implicit success → #access_token=…&type=recovery|invite
    //   2. PKCE success     → ?code=…            (needs exchangeCodeForSession)
    //   3. failure          → #error=access_denied&error_code=otp_expired&…
    //
    // Shape 3 was previously ignored outright: nothing matched `type=recovery`, so
    // `recovery` stayed false and an owner with an expired link landed on a bare
    // login form with no idea why — indistinguishable from a dead link. Now it
    // says so and tells them to request another.
    //
    // Shape 2 is handled because which flow fires depends both on the project's
    // auth settings and on the supabase-js build jsDelivr serves (the CDN tag is
    // unpinned — see CLAUDE.md's CDN version lock note), so this must not bet on
    // one. A `?code=` arrival is always treated as recovery: the portal has no
    // magic-link login, so the only way to get one is a reset or invite mail, and
    // being asked to set a password is the correct outcome for both.
    let cancelled = false;
    const hash = new URLSearchParams(String(window.location.hash || "").replace(/^#/, ""));
    const query = new URLSearchParams(window.location.search || "");
    const pick = (k) => hash.get(k) || query.get(k);

    // Strip the token/code/error out of the visible URL once it has been read, so a
    // refresh can't replay a consumed link and no access token lingers in history.
    const scrubUrl = () => {
      try {
        window.history.replaceState(null, "", window.location.pathname);
      } catch (_e) { /* non-fatal — a stale URL is cosmetic */ }
    };

    const bootstrap = async () => {
      const errCode = pick("error_code");
      const rawErr = pick("error");
      if (errCode || rawErr) {
        const desc = String(pick("error_description") || "").replace(/\+/g, " ");
        const isExpired = /expired/i.test(errCode || "") || /expired/i.test(desc);
        setLinkError(
          isExpired
            ? "That password reset link has expired or was already used. Enter your email below and click “Forgot password?” to get a fresh one."
            : "That password reset link is no longer valid. Enter your email below and click “Forgot password?” to get a new one.",
        );
        ssLogError(SS_ERR_SOURCE, "recovery link rejected: " + (desc || "no description"), errCode || rawErr, { expired: isExpired });
        scrubUrl();
        if (!cancelled) setSession(null);
        return;
      }

      const linkType = pick("type");
      if (linkType === "recovery" || linkType === "invite") setRecovery(true);

      // getSession() resolves after supabase-js has finished its own URL detection,
      // so anything still unconsumed below is genuinely ours to handle.
      let { data } = await sb.auth.getSession();
      const code = query.get("code");
      if (!data.session && code) {
        const res = await sb.auth.exchangeCodeForSession(code);
        if (res.error) {
          setLinkError("That password reset link has expired or was already used. Enter your email below and click “Forgot password?” to get a fresh one.");
          ssLogError(SS_ERR_SOURCE, "recovery code exchange failed: " + res.error.message, "pkce_exchange_failed");
          scrubUrl();
          if (!cancelled) setSession(null);
          return;
        }
        data = res.data;
        setRecovery(true);
      }
      // Arrived on a recovery/invite link but ended up with no session: the token was
      // rejected without Supabase supplying error params (a truncated or rewritten link,
      // a mail client that mangled the fragment). Say so rather than rendering a bare
      // login form — silently doing nothing is the failure this whole block exists to end.
      if ((linkType === "recovery" || linkType === "invite") && !data.session) {
        setRecovery(false);
        setLinkError("That password reset link could not be verified — it may have expired or been altered by your email app. Enter your email below and click “Forgot password?” to get a fresh one.");
        ssLogError(SS_ERR_SOURCE, "recovery link produced no session (type=" + linkType + ")", "recovery_no_session");
      }
      if (linkType || code) scrubUrl();
      if (!cancelled) {
        ssSetCurrentUser(data.session && data.session.user ? data.session.user.id : null);
        setSession(data.session || null);
      }
    };
    bootstrap();

    const { data: sub } = sb.auth.onAuthStateChange((event, sess) => {
      // Who the cached tab payloads belong to. Signing out does NOT reload this page — it
      // swaps to the login view — so without this the next person to sign in on a shared
      // shop computer would inherit the previous one's cached rows, and the commissions
      // ledger is scoped to the CALLER. ssSetCurrentUser clears the cache whenever the id
      // changes, which covers sign-out (null) and a different sign-in alike.
      ssSetCurrentUser(sess && sess.user ? sess.user.id : null);
      setSession(sess || null);
      if (event === "PASSWORD_RECOVERY") setRecovery(true);
      if (event === "SIGNED_IN") { setExpired(false); setLinkError(null); } // fresh login clears both notices
    });
    // Dead-session handler (see ssFetch): only reacts when someone IS signed in —
    // the login screen's anon calls can 401 too and must not loop — and collapses
    // a burst of parallel 401s into a single clean sign-out.
    let handling = false;
    ssOnSessionExpired = async () => {
      if (handling) return;
      handling = true;
      try {
        const { data } = await sb.auth.getSession();
        if (data && data.session) {
          setExpired(true);
          await sb.auth.signOut(); // clears the local session even if the server call fails
        }
      } catch (_e) { /* never let the guard crash the app */ }
      handling = false;
    };
    return () => { cancelled = true; ssOnSessionExpired = null; sub.subscription.unsubscribe(); };
  }, []);

  if (session === undefined) {
    return <div style={{ padding: 60, textAlign: "center", color: "#64748B", fontSize: 14 }}>Loading…</div>;
  }
  if (session && recovery) return <ResetPasswordView onDone={() => { setRecovery(false); window.location.hash = ""; }} />;
  if (!session) return (
    <div style={{ maxWidth: 920, margin: "0 auto" }}>
      {/* Signed out is the one place with room for the COMPLETE lockup, tagline included —
          at 300px the "Streamlined Construction System" line is actually legible, unlike in
          the 212px rail. Centred on the page rather than crammed into a header bar. */}
      <div style={{ display: "flex", justifyContent: "center", padding: "34px 16px 6px" }}>
        <img src="/assets/logo.png" alt="Structure Studio — Streamlined Construction System"
          style={{ width: 300, maxWidth: "78%", height: "auto", display: "block" }} />
      </div>
      {/* linkError wins over the session-expired notice: a dead reset link is the
          more specific, more actionable thing to tell someone who just clicked one. */}
      <LoginView notice={linkError || (expired ? "Your session expired — please sign in again." : null)} />
    </div>
  );
  return <Dashboard session={session} />;
}

ReactDOM.createRoot(document.getElementById("root")).render(<PortalApp />);

// The boot guard's DOMContentLoaded check reads this sentinel: a compiled app
// script that ran to completion is the definition of "the app booted". Without
// it, a 404'd or syntax-broken app artifact was a silent blank page - the one
// failure class the old inline-babel world could not even see.
window.__ssAppBooted = true;
