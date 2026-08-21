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
  // activeTab: "designer" is in NONADMIN_TABS so the clamp never rewrites it.
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
    sb.rpc("is_operator").then(({ data }) => { if (!cancelled) setIsOperator(!!data); }).catch(() => {});
    return () => { cancelled = true; };
  }, [session]);
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
  const canAdminForUrl = viewing ? isOperator : (tenant && tenant !== "none" && (tenant.role === "owner" || tenant.role === "admin"));
  const resolvedTab = ssClampTab(tab, isOperator, !!canAdminForUrl,
    (tenant && tenant !== "none") ? tenant.access : null);
  useEffect(() => {
    if (!tenant || tenant === "none") return;          // nothing routable yet
    const p = ssParsePath();
    const gatesResolved = isOperator || canAdminForUrl || entitlement !== null;
    if (wanted.current && wanted.current !== resolvedTab && !gatesResolved) return;
    if (wanted.current) wanted.current = null;
    if (p.page === resolvedTab && (p.sub || null) === (sub || null)) return;
    try { window.history.replaceState({ page: resolvedTab, sub }, "", ssPagePath(resolvedTab, sub)); } catch (_e) {}
  }, [resolvedTab, sub, isOperator, canAdminForUrl, entitlement, tenant]);
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
  // Sign-out / unmount must not leave a tenant override armed for the next mount.
  useEffect(() => () => { ssTargetClientId = null; }, []);

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
    (async () => {
      // limit(1)+array instead of maybeSingle(): maybeSingle() ERRORS when >1 row
      // matches (a duplicate/multi-tenant client_users row), which would lock the
      // user out of their own dashboard; take the first mapping instead. (audit #F6)
      const { data: cuRows, error } = await sb.from("client_users").select("client_id, role").limit(1);
      const mapping = cuRows && cuRows[0];
      if (error || !mapping) { setTenant("none"); return; }
      let businessName = mapping.client_id;
      // client_configs is now column-structured (no monolithic `config` blob);
      // read the dedicated company_name column for the dashboard heading.
      const { data: cfg } = await sb.from("client_configs").select("company_name").eq("client_id", mapping.client_id).maybeSingle();
      if (cfg && cfg.company_name) {
        businessName = cfg.company_name;
      }
      // Per-area access (migration 100) comes from the SERVER's resolved map, not from
      // client_users.access — that column holds only the deviations from the title preset,
      // and resolving it here would mean a second copy of PRESETS in the browser that
      // drifts the day an area is added. `status` is the "open" bootstrap action precisely
      // so every role can make this call. On failure `access` stays undefined and
      // ssCanSeeTab falls back to the old role behaviour: a nav that is too generous, never
      // one that is too strict, and the server refuses the action either way.
      let access = null;
      try {
        // The status invoke sits two awaited reads deep, so view-as opened mid-flight can
        // have armed the injection by now — and this call scoped to the viewed tenant is
        // exactly the poisoning above. Skip it instead: access stays null (the generous
        // fallback), and the `viewing` dep refetches the real map on exit.
        if (!ssTargetClientId) {
          const { data: st } = await sb.functions.invoke("portal-settings", { body: { action: "status" } });
          if (st && st.access) access = st.access;
        }
      } catch (_e) { /* keep the fallback */ }
      setTenant({ clientId: mapping.client_id, businessName, role: mapping.role || "user", access });
    })();
  }, [session.access_token, viewing]);

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
  }, [session]);

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
  const canAdmin = viewing ? isOperator : isAdmin;

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
  const view3dUnlocked = isOperator
    || (!viewing && !!entitlement && Array.isArray(entitlement.granted)
        && entitlement.granted.indexOf("view_3d") !== -1);
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
    onUploadModel: async (file, styleValue) => {
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
  }), [canAdmin, view3dUnlocked, effClientId]);

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
  const myAccess = (tenant && tenant !== "none") ? tenant.access : null;
  // Designs/Contacts "Open" → load the design INSIDE the portal designer and switch to
  // that tab. Never a link to the public page: it silently captures leads and saves
  // drafts (capture-lead / saveDraftSilently), so staff opening a customer's design
  // there would corrupt the very activity Contacts reports.
  const openInDesigner = (code, version = null, extra = null) => {
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
  const activeTab = ssClampTab(tab, isOperator, canAdmin, myAccess);


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

  const ICONS = {
    admin: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>),
    designer: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>,
    quickbooks: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 12a3 3 0 0 1 3-3h1v9"/><path d="M16 12a3 3 0 0 1-3 3h-1V6"/></svg>,
    accounts: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="9" height="14" rx="1"/><rect x="13" y="3" width="9" height="18" rx="1"/><path d="M6 11h1M6 15h1M17 7h1M17 11h1M17 15h1"/></svg>,
    designs: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>,
    leads: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>,
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
  const featureOn = (key) => isOperator || (!viewing && !!entitlement && !!(entitlement.features && entitlement.features[key]));
  const schedUnlocked = featureOn("schedule_builds");
  // QuickBooks Sync is a paid add-on ($75/mo) that was SOLD BUT NEVER ENFORCED — the tab was
  // gated on canAdmin alone, so any admin used it free and buying it changed nothing. Gated
  // the same way as scheduling (Carolyn 2026-08-08), and PAY-ONLY on the server, so the
  // exempt/free-period blankets don't hand it to grandfathered tenants either.
  const qboUnlocked = featureOn("quickbooks_sync");
  // May THIS person write to each board (migration 100)? Separate from schedUnlocked, which
  // is only whether the tenant has bought the feature. Both must be true before Designs and
  // Inventory offer their schedule entry points.
  const schedCanEdit = canAdmin || !!(myAccess && myAccess.build_schedule === "edit");
  const deliverCanEdit = canAdmin || !!(myAccess && myAccess.delivery_schedule === "edit");
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
    id !== "accounts" && id !== "admin" && !canAdmin && !ssCanSeeTab(id, myAccess);
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
          {navItem("designs", "Designs")}
          {navItem("leads", "Contacts")}
          {navItem("inventory", "Inventory")}
          {navItem("orders", "Orders")}
          {/* Scheduling suite — Carolyn 2026-08-04: under Orders, in this order. The In Dev
              badges came off 2026-08-05 (Carolyn); content stays entitlement-gated inside. */}
          {navItem("build-schedule", "Build Schedule")}
          {navItem("delivery-schedule", "Delivery Schedule")}
          {navItem("repairs", "Repairs")}
          {navItem("commissions", "Commissions")}
          {/* Config surface like Settings, so gated the same way: admins, plus anyone
              holding settings_quickbooks (migration 100) — navHidden reads that area via
              TAB_AREA, the same map the clamp and the content render use, so all three
              surfaces agree (audit 2026-08-20). Kept OUT of NONADMIN_TABS: a plain
              "user" role with no area grant still never sees or reaches it. */}
          {navItem("quickbooks", "QuickBooks")}
        </nav>

        <div className="ss-navlabel">Coming Soon</div>
        <nav className="ss-nav">
          {soonItem("on-demand-pricing", "RealTime Pricing", "3rd Qtr")}
          {/* 3D is gated the same way every paid add-on is: featureOn reads
              entitlement.features, which portal-billing now computes from a THREE-branch
              map. view_3d is `grantable`, so it is deliberately NOT covered by the
              exempt/transition blankets - an operator grant (or a real subscription) is
              the only way in, which is what "not all clients need to see it" requires.
              Operators are never gated by featureOn, so CSM Synergy always sees it. */}
          {view3dUnlocked ? navItem("view-3d", "3D Design", "New") : soonItem("view-3d", "3D Design", "3rd Qtr")}
          {soonItem("rent-to-own-contracts", "Rent to Own", "4th Qtr")}
          {soonItem("reports", "Reports", "4th Qtr")}
          {soonItem("self-serve-display-units", "Self Serve Displays", "2027")}
        </nav>

        {isOperator && (<>
        <div className="ss-navlabel">Operator</div>
        <nav className="ss-nav">
          {navItem("accounts", "Accounts")}
          {navItem("admin", "Admin")}
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
                openDesign={openDesign && openDesign.clientId === effClientId ? openDesign : null} />
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
            {!gateLocked && activeTab === "designs" && (
              <DesignsTable key={"t-" + effClientId} clientId={effClientId}
                fetchDesigns={viewing ? viewingFetch : null} refreshKey={designsRefreshKey}
                isAdmin={canAdmin}
                viewingLabel={viewing ? (viewing.companyName || viewing.clientId) : null}
                onOpenDesign={openInDesigner} />
            )}
            {!gateLocked && activeTab === "leads" && (
              <LeadsTable key={"t-" + effClientId} clientId={effClientId}
                fetchDesigns={viewing ? viewingFetch : null} isAdmin={canAdmin}
                onOpenDesign={openInDesigner} />
            )}
            {!gateLocked && activeTab === "accounts" && isOperator && (
              <AccountsTab viewing={viewing} onOpen={openAccount}
                onEditUser={(c, u) => setEditUser({ clientId: c.clientId, companyName: c.companyName, user: u })}
                usersRefreshKey={usersRefreshKey} />
            )}
            {!gateLocked && activeTab === "orders" && (
              /* Operators get the REAL, interactive Orders on their OWN portal so they can
                 build and test the feature end to end (orders/payments RLS is scoped to
                 current_client_id(), so direct reads/writes only work for one's own tenant —
                 hence !viewing: while viewing ANOTHER tenant the direct-read path would show
                 nothing, so keep the locked preview there). Everyone else sees the locked
                 example-data preview. */
              (isOperator && !viewing)
                ? <OrdersView clientId={tenant.clientId}
                    schedOn={schedUnlocked && schedCanEdit} deliverOn={schedUnlocked && deliverCanEdit}
                    /* A sold lot building is already waiting in the Delivery Schedule's
                       "to be loaded" pool (the pool is a query over sold units without a
                       sale stop), so this just takes the dispatcher there — no focus/
                       hand-off state to keep in sync. */
                    onScheduleDelivery={() => navigate("delivery-schedule")} />
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
            {adminOpened && isOperator && (
              <div style={{ display: activeTab === "admin" ? "block" : "none" }}>
                <AdminShell onOpenAccount={openAccount}
                  sub={activeTab === "admin" ? sub : null} onSub={(x) => navigate("admin", x)} />
              </div>
            )}
            {!gateLocked && activeTab === "releases" && <ReleasesView submissionsKey={feedbackKey} />}
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
                schedUnlocked={schedUnlocked}
                qboUnlocked={qboUnlocked}
                setup3d={setup3d}
                sub={sub} onSub={(x) => navigate("settings", x)} />
            )}
            {!gateLocked && activeTab === "on-demand-pricing" && (
              <ComingSoon
                title="RealTime Pricing"
                icon={<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="#FFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2 3 14h9l-1 8 10-12h-9z"/></svg>}
                blurb="Bring your lumber prices into Structure Studio and we'll build out every style and size with the exact lumber each building needs. Update your lumber costs each month or quarter and every building's price recalculates on its own — so you always know your true, current cost and profit margin."
                bullets={[
                  "Load your lumber prices; we map them to every style and size",
                  "Update costs monthly or quarterly — building prices refresh automatically",
                  "Know your real build cost and profit margin in real time",
                ]}
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
                <CommissionsReport />
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
      if (!cancelled) setSession(data.session || null);
    };
    bootstrap();

    const { data: sub } = sb.auth.onAuthStateChange((event, sess) => {
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
