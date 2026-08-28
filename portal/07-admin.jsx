// ─── Operator Accounts tab ───
// Lists every tenant (operator-portal:list_clients, server-side app_operators gate)
// and opens one with FULL access, GHL-subaccounts style. Every list/view is audit-logged,
// and every cross-tenant read/write is re-authorized server-side against app_operators.
function AccountsTab({ viewing, onOpen, onEditUser, usersRefreshKey = 0 }) {
  const [clients, setClients] = useState(null); // null = loading
  const [error, setError] = useState(null);
  const [query, setQuery] = useState("");
  // Users are fetched PER TENANT, only when a row is expanded — opening the tab must not pull
  // every user's name, email and phone into the browser, and each expansion is audit-logged
  // against the tenant it belongs to. `users[clientId] === undefined` means "not loaded yet".
  const [open, setOpen] = useState({});
  const [users, setUsers] = useState({});
  const [userErr, setUserErr] = useState({});

  // In-flight guard. Expand-all fires one request per tenant at once, and a second click
  // (or a refresh landing mid-expand) would otherwise duplicate every one of them.
  const inFlight = useRef({});

  // Per-user reset state, keyed by userId. Kept per-user rather than as one shared flag so
  // resetting person A doesn't grey out the button next to person B.
  const [resetBusy, setResetBusy] = useState({});
  const [resetInfo, setResetInfo] = useState({});

  const sendReset = async (clientId, u) => {
    if (resetBusy[u.userId]) return;
    setResetBusy((b) => ({ ...b, [u.userId]: true }));
    setResetInfo((r) => ({ ...r, [u.userId]: null }));
    try {
      const { data, error: err } = await sb.functions.invoke("operator-portal", {
        body: { action: "send_reset_link", clientId, userId: u.userId },
      });
      if (err) {
        let msg = err.message;
        try { const ctx = await err.context.json(); if (ctx && ctx.error) msg = ctx.error; } catch (_e) {}
        setResetInfo((r) => ({ ...r, [u.userId]: { error: msg || "Could not send the reset link." } }));
        return;
      }
      setResetInfo((r) => ({ ...r, [u.userId]: data || {} }));
    } finally {
      setResetBusy((b) => { const n = { ...b }; delete n[u.userId]; return n; });
    }
  };

  const loadUsers = useCallback(async (clientId) => {
    if (inFlight.current[clientId]) return;
    inFlight.current[clientId] = true;
    setUserErr((e) => ({ ...e, [clientId]: null }));
    try {
      const { data, error: err } = await sb.functions.invoke("operator-portal", { body: { action: "list_users", clientId } });
      if (err) {
        let msg = err.message;
        try { const ctx = await err.context.json(); if (ctx && ctx.error) msg = ctx.error; } catch (_e) {}
        setUserErr((e) => ({ ...e, [clientId]: msg || "Could not load users." }));
        setUsers((u) => ({ ...u, [clientId]: [] }));
        return;
      }
      setUsers((u) => ({ ...u, [clientId]: Array.isArray(data && data.users) ? data.users : [] }));
    } catch (e) {
      // A REJECTION (not an {error} result) used to leave users[clientId] undefined forever.
      // That was harmless when only a click could call this; the page-scoped effect below
      // retries whenever its guard is still open, so an undefined entry would re-request on
      // every render. Recording the failure closes the guard on every outcome.
      setUserErr((er) => ({ ...er, [clientId]: (e && e.message) || "Could not load users." }));
      setUsers((u) => ({ ...u, [clientId]: [] }));
    } finally {
      // Always released, including on the error path — otherwise one failure would leave
      // that tenant permanently unrefreshable for the rest of the session.
      delete inFlight.current[clientId];
    }
  }, []);

  const toggle = (clientId) => {
    const next = !open[clientId];
    setOpen((o) => ({ ...o, [clientId]: next }));
    if (next && users[clientId] === undefined) loadUsers(clientId);
  };

  const q = query.trim().toLowerCase();
  const filtered = (clients || []).filter((c) => !q || c.clientId.toLowerCase().includes(q) || (c.companyName || "").toLowerCase().includes(q));

  // Expand/collapse acts on what is CURRENTLY FILTERED, not the whole list — after a search
  // for "barns", "Expand all" that also opened every hidden tenant would be a surprise (and
  // would fetch personal details for accounts you are not looking at).
  //
  // The EXPAND STATE stays on `filtered`, so the control still means what it says and paging
  // forward finds those tenants already open. The FETCH does not: it follows what is actually
  // on screen, via the effect below.
  //
  // That split is the whole point, and paging is what forced it. `loadUsers` is an
  // operator-portal `list_users` call that reads names, emails and phones for another tenant
  // and is audit-logged as exactly that. Before the 30-row cap, "expand all" fetching every
  // filtered tenant WAS "the ones you are looking at" — they were all rendered. With the cap,
  // one click on a 340-tenant list fired 340 concurrent cross-tenant PII reads to fill 30
  // visible rows, and the comment above still promised the opposite. Paging redefined
  // "looking at"; this follows it rather than leaving the promise false.
  const expandAll = () => {
    setOpen((o) => {
      const next = { ...o };
      filtered.forEach((c) => { next[c.clientId] = true; });
      return next;
    });
  };
  const collapseAll = () => setOpen({});
  const openCount = filtered.filter((c) => open[c.clientId]).length;

  // Paging at 30, the same rendering cap the tenant-facing lists use (LeadsTable, Designs,
  // Orders). The read stays whole, so the header count, the search and Expand all all still
  // see every tenant — "12 of 340" keeps describing the platform, not the page.
  const [pageSize, setPageSize] = usePageSize("adm-accounts");
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [query]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const curPage = Math.min(page, pageCount);
  // useMemo'd so the effect below does not read like the classic every-render loop. It never
  // was one (its body only calls loadUsers under a guard that closes), but the dep array is
  // load-bearing enough that the next reader should not have to prove that again.
  const paged = useMemo(() => filtered.slice((curPage - 1) * pageSize, curPage * pageSize), [filtered, curPage, pageSize]);

  // Fetch personal details only for rows that are open AND on the current page. Rows do not
  // self-fetch when they scroll into view (only the toggle at :69 and the refresh below do),
  // so without this an "expand all" followed by "Next →" would show open rows that never load.
  useEffect(() => {
    paged.forEach((c) => { if (open[c.clientId] && users[c.clientId] === undefined) loadUsers(c.clientId); });
  }, [paged, open, users, loadUsers]);

  // After an edit, re-fetch the expanded tenants that are ON THIS PAGE — the edited name has to
  // appear without collapsing what the operator was looking at.
  //
  // ⛔ "Expanded" is NOT the bound here, and that was the whole bug. `expandAll` writes `true`
  // for every FILTERED tenant, so on a 340-tenant list `open` holds 340 keys while 30 render.
  // Iterating `open` therefore fired 340 concurrent cross-tenant list_users calls — names,
  // emails and phones for 310 tenants that were never on screen, each one an audit-logged
  // read — every time an operator saved a user, which is the ordinary reason to expand a row
  // at all. It was also strictly worse than the expandAll fan-out it mirrored, because that
  // one at least skipped tenants already loaded and this re-fetched all 340 every save.
  // A ref, because `paged` cannot go in a dep array keyed on usersRefreshKey without
  // re-firing the refresh on every page change.
  const pagedRef = useRef([]);
  useEffect(() => { pagedRef.current = paged; }, [paged]);
  useEffect(() => {
    if (!usersRefreshKey) return;
    pagedRef.current.forEach((c) => { if (open[c.clientId]) loadUsers(c.clientId); });
  }, [usersRefreshKey]);

  const roleChip = (r) => ({
    fontSize: 9.5, fontWeight: 800, textTransform: "uppercase", borderRadius: 5, padding: "1px 5px",
    color: r === "owner" ? "#065F46" : r === "admin" ? "#1E40AF" : "#475569",
    background: r === "owner" ? "#D1FAE5" : r === "admin" ? "#DBEAFE" : "#F1F5F9",
    border: `1px solid ${r === "owner" ? "#6EE7B7" : r === "admin" ? "#93C5FD" : "#E2E8F0"}`,
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error: err } = await sb.functions.invoke("operator-portal", { body: { action: "list_clients" } });
      if (cancelled) return;
      if (err) {
        let msg = err.message;
        try { const ctx = await err.context.json(); if (ctx && ctx.error) msg = ctx.error; } catch (_e) {}
        setError(msg || "Could not load accounts."); setClients([]); return;
      }
      // Null-guard the body: a 200 with no/unexpected payload must show an error, not
      // leave the tab spinning on clients === null forever.
      if (!data || !Array.isArray(data.clients)) {
        setError("Synergy returned no account list — reload to try again."); setClients([]); return;
      }
      setClients(data.clients);
    })();
    return () => { cancelled = true; };
  }, []);


  return (
    <div style={S.card}>
      <CardHead
        title="Builder accounts"
        count={clients ? (query ? `${filtered.length} of ${clients.length}` : clients.length) : null}
        desc="Open any builder's portal and work in it as they would — designs, contacts, structures, options, colours, branding, connection and billing. Changes are LIVE in their account and every action is audit-logged. Design status badges show cached values."
        right={<>
          {/* Acts on the filtered set, and each is disabled when it would do nothing — so the
              control tells you the current state instead of being a pair of dead buttons. */}
          <button type="button" onClick={expandAll} disabled={!filtered.length || openCount === filtered.length}
            title="Show the users under every account listed"
            style={{ ...S.btn("#F1F5F9", openCount === filtered.length || !filtered.length ? "#CBD5E1" : "#334155"), padding: "7px 11px", fontSize: 12 }}>
            Expand all
          </button>
          <button type="button" onClick={collapseAll} disabled={openCount === 0}
            title="Hide all user lists"
            style={{ ...S.btn("#F1F5F9", openCount === 0 ? "#CBD5E1" : "#334155"), padding: "7px 11px", fontSize: 12 }}>
            Collapse all
          </button>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search accounts…"
            style={{ border: "1px solid #E2E8F0", borderRadius: 8, padding: "8px 12px", fontSize: 13, width: 190 }} />
        </>}
      />
      {error && <div style={{ color: "#B91C1C", fontSize: 13, marginBottom: 10 }}>{error}</div>}
      {/* Grey blocks in the row shape, not the word "Loading" on an empty card. This tab is
          REMOUNTED on every visit (09-shell mounts it without a keep-mounted wrapper, unlike
          AdminShell), so the whole list_clients round-trip is paid again each time the
          operator comes back — this is the state they see most. The rows are flex divs
          rather than a table, so SkelRows does not fit and the blocks are built from SkelBar
          in the real row's shape: chevron, 34px tile, name over id, action button. */}
      {clients === null && (
        <div>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 4px", borderBottom: "1px solid #F1F5F9", opacity: 1 - i * 0.11 }}>
              <SkelBar w={15} h={15} style={{ flexShrink: 0 }} />
              <SkelBar w={34} h={34} style={{ borderRadius: 8, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <SkelBar w="40%" h={12} />
                <SkelBar w="24%" h={9} style={{ marginTop: 6 }} />
              </div>
              <SkelBar w={104} h={30} style={{ borderRadius: 8, flexShrink: 0 }} />
            </div>
          ))}
        </div>
      )}
      {clients !== null && !error && filtered.length === 0 && <div style={{ color: "#64748B", fontSize: 13 }}>No accounts match.</div>}
      {paged.map((c) => (
        <div key={c.clientId} style={{ borderBottom: "1px solid #F1F5F9" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 4px" }}>
            {/* The whole identity block toggles, so the hit target is the row rather than a
                6px chevron. aria-expanded so it reads as a disclosure, not a mystery button. */}
            <button type="button" onClick={() => toggle(c.clientId)}
              aria-expanded={!!open[c.clientId]}
              title={open[c.clientId] ? "Hide users" : "Show users"}
              style={{ display: "flex", alignItems: "center", gap: 12, flex: 1, minWidth: 0, background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit", textAlign: "left" }}>
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="#94A3B8" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                style={{ flexShrink: 0, transform: open[c.clientId] ? "rotate(90deg)" : "none", transition: "transform .12s" }}><path d="M9 18l6-6-6-6"/></svg>
              <div style={{ width: 34, height: 34, borderRadius: 8, background: "#F1F5F9", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 800, color: "#475569", flexShrink: 0 }}>
                {(c.companyName || c.clientId).split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase()}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#1E293B" }}>{c.companyName}</div>
                <div style={{ fontSize: 12, color: "#94A3B8" }}>
                  {c.clientId}
                  {c.userCount != null && <> · {c.userCount} {c.userCount === 1 ? "user" : "users"}</>}
                </div>
              </div>
            </button>
            {viewing && viewing.clientId === c.clientId
              ? <span style={{ fontSize: 12, fontWeight: 700, color: "#92400E", background: "#FEF3C7", borderRadius: 7, padding: "5px 10px" }}>Viewing</span>
              : <button type="button" onClick={() => onOpen({ clientId: c.clientId, companyName: c.companyName })} style={S.btn("#1E293B", "#FFF")}>Open portal →</button>}
          </div>
          {open[c.clientId] && (
            <div style={{ padding: "2px 4px 12px 42px" }}>
              {/* The same six columns as the real user table below, so nothing reflows when
                  list_users lands. That read is the genuinely expensive one in this feature —
                  operator-portal does one admin.getUserById per user, sequentially — and
                  Expand all fires one of them per filtered tenant at once. Both are
                  post-paint and operator-initiated, which is already the right shape; this
                  only stops the wait looking like a hang. */}
              {users[c.clientId] === undefined && (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                    <thead><tr>
                      {["Name", "Email", "Phone", "Role", "Last sign-in", ""].map((h, i) => (
                        <th key={i} style={{ textAlign: "left", fontSize: 10.5, fontWeight: 800, letterSpacing: ".05em", textTransform: "uppercase", color: "#94A3B8", padding: "4px 8px 6px 0", whiteSpace: "nowrap" }}>{h}</th>
                      ))}
                    </tr></thead>
                    <tbody><SkelRows cols={6} rows={3} /></tbody>
                  </table>
                </div>
              )}
              {userErr[c.clientId] && <div style={{ fontSize: 12.5, color: "#B91C1C", padding: "6px 0" }}>{userErr[c.clientId]}</div>}
              {Array.isArray(users[c.clientId]) && users[c.clientId].length === 0 && (
                <div style={{ fontSize: 12.5, color: "#94A3B8", padding: "6px 0" }}>No logins linked to this account yet.</div>
              )}
              {Array.isArray(users[c.clientId]) && users[c.clientId].length > 0 && (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                    <thead><tr>
                      {["Name", "Email", "Phone", "Role", "Last sign-in", ""].map((h, i) => (
                        <th key={i} style={{ textAlign: "left", fontSize: 10.5, fontWeight: 800, letterSpacing: ".05em", textTransform: "uppercase", color: "#94A3B8", padding: "4px 8px 6px 0", whiteSpace: "nowrap" }}>{h}</th>
                      ))}
                    </tr></thead>
                    <tbody>
                      {users[c.clientId].map((u) => (
                        <React.Fragment key={u.userId}>
                        <tr style={{ borderTop: "1px solid #F1F5F9" }}>
                          <td style={{ padding: "7px 8px 7px 0", color: u.fullName ? "#1E293B" : "#94A3B8", fontWeight: u.fullName ? 700 : 400 }}>
                            {u.fullName || "— not set —"}
                          </td>
                          <td style={{ padding: "7px 8px 7px 0", color: "#475569" }}>
                            {u.email || <span style={{ color: "#94A3B8" }}>unknown</span>}
                            {u.email && !u.emailConfirmed && (
                              <span title="Has not confirmed their email / set a password yet" style={{ marginLeft: 6, fontSize: 9.5, fontWeight: 800, textTransform: "uppercase", color: "#92400E", background: "#FEF3C7", borderRadius: 5, padding: "1px 5px" }}>pending</span>
                            )}
                          </td>
                          <td style={{ padding: "7px 8px 7px 0", color: u.phone ? "#475569" : "#CBD5E1" }}>{u.phone || "—"}</td>
                          <td style={{ padding: "7px 8px 7px 0", whiteSpace: "nowrap" }}>
                            <span style={roleChip(u.role)}>{u.role}</span>
                            {/* Operator is cross-tenant (app_operators) — a separate badge, never
                                merged into the tenant role, which would misstate who they are. */}
                            {u.isOperator && (
                              <span title="CSM Synergy operator — access spans every tenant, not just this one"
                                style={{ marginLeft: 5, fontSize: 9.5, fontWeight: 800, textTransform: "uppercase", color: "#3730A3", background: "#E0E7FF", border: "1px solid #A5B4FC", borderRadius: 5, padding: "1px 5px" }}>operator</span>
                            )}
                          </td>
                          <td style={{ padding: "7px 8px 7px 0", color: "#94A3B8", whiteSpace: "nowrap" }}>
                            {u.lastSignInAt ? new Date(u.lastSignInAt).toLocaleDateString() : "never"}
                          </td>
                          <td style={{ padding: "7px 0", textAlign: "right", whiteSpace: "nowrap" }}>
                            <button type="button" onClick={() => onEditUser(c, u)}
                              style={{ ...S.btn("#F1F5F9", "#334155"), padding: "4px 9px", fontSize: 11 }}>Edit</button>
                            {/* Disabled without an email rather than hidden: "why is there no
                                button here" is a worse question than a tooltip that answers it. */}
                            <button type="button" onClick={() => sendReset(c.clientId, u)}
                              disabled={!u.email || !!resetBusy[u.userId]}
                              title={u.email
                                ? `Email ${u.email} a link to set a new password`
                                : "This login has no email address, so nothing can be sent to it"}
                              style={{ ...S.btn("#F1F5F9", (!u.email || resetBusy[u.userId]) ? "#CBD5E1" : "#334155"), padding: "4px 9px", fontSize: 11, marginLeft: 5 }}>
                              {resetBusy[u.userId] ? "Sending…" : "Send reset"}
                            </button>
                          </td>
                        </tr>
                        {resetInfo[u.userId] && (
                          <tr>
                            <td colSpan={6} style={{ padding: "0 0 8px 0" }}>
                              {resetInfo[u.userId].error ? (
                                <div style={{ fontSize: 12, color: "#B91C1C" }}>{resetInfo[u.userId].error}</div>
                              ) : (
                                <div style={{ background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 8, padding: "8px 10px" }}>
                                  <div style={{ fontSize: 12, color: resetInfo[u.userId].emailSent ? "#166534" : "#92400E", fontWeight: 600 }}>
                                    {resetInfo[u.userId].note || (resetInfo[u.userId].emailSent ? "Sent." : "Not sent.")}
                                  </div>
                                  {/* The link is shown every time, not only on failure. Email
                                      delivery is the part that has actually failed in onboarding,
                                      and by then the operator has usually closed this row. */}
                                  {resetInfo[u.userId].resetLink && (
                                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
                                      <input readOnly value={resetInfo[u.userId].resetLink}
                                        onFocus={(e) => e.target.select()}
                                        style={{ flex: 1, minWidth: 0, border: "1px solid #E2E8F0", borderRadius: 6, padding: "5px 8px", fontSize: 11, color: "#475569", fontFamily: "ui-monospace, monospace" }} />
                                      <button type="button"
                                        onClick={() => { try { navigator.clipboard.writeText(resetInfo[u.userId].resetLink); } catch (_e) {} }}
                                        style={{ ...S.btn("#F1F5F9", "#334155"), padding: "4px 9px", fontSize: 11, flexShrink: 0 }}>Copy</button>
                                    </div>
                                  )}
                                  {/* Always lands on the production portal, by design — one Supabase
                                      project serves both hosts, so a password set there works on beta
                                      too. Said out loud because a beta operator WILL notice. */}
                                  <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 5 }}>
                                    The link opens app.structurestudiosuite.com/portal — a password set there works everywhere, including beta.
                                  </div>
                                </div>
                              )}
                            </td>
                          </tr>
                        )}
                        </React.Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
      {filtered.length > 0 && (
        <PageBar size={pageSize} onSize={setPageSize} page={curPage} onPage={setPage} total={filtered.length} noun="account" />
      )}
    </div>
  );
}

// ─── Billing gate ───
// Shown INSTEAD of the tab content while a tenant's required subscription isn't
// active. Every nav item stays visible (with a lock) so they can see what the product
// includes, but clicking any of them lands here. For an admin the plan picker is
// embedded directly — the fix sits right where the problem is explained, rather than
// sending them hunting through Settings. A non-admin can't pay, so they get told who can.
const GATE_COPY = {
  never_paid: {
    title: "Activate your account",
    body: "Welcome to StructureStudio. Choose your plan below to switch everything on — your designer link, designs, contacts, and settings all unlock as soon as payment goes through.",
  },
  past_due: {
    title: "Your last payment didn't go through",
    body: "We couldn't process the most recent charge, so the account is on hold. Updating your card below restores access right away.",
  },
  cancelled: {
    title: "Your subscription has ended",
    body: "This account was cancelled. Everything is exactly as you left it — resubscribe below and it all comes straight back.",
  },
  paused: {
    title: "Your subscription is paused",
    body: "Access is on hold while the subscription is paused. Resume below to pick up where you left off.",
  },
};

function BillingGate({ reason, isAdmin }) {
  const c = GATE_COPY[reason] || GATE_COPY.never_paid;
  return (
    <div>
      <div style={{ background: "linear-gradient(135deg, #3D3672 0%, #1B7895 100%)", borderRadius: 14, padding: "22px 24px", color: "#FFF", marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 44, height: 44, borderRadius: 11, background: "rgba(255,255,255,0.14)", border: "1px solid rgba(255,255,255,0.28)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#FFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 20, fontWeight: 800, lineHeight: 1.15 }}>{c.title}</div>
            <div style={{ fontSize: 13, color: "#D6E4F0", marginTop: 4, lineHeight: 1.5 }}>{c.body}</div>
          </div>
        </div>
      </div>
      {isAdmin
        ? <BillingView />
        : (
          <div style={S.card}>
            <div style={S.h2}>Ask your account owner to activate</div>
            <p style={{ fontSize: 13, color: "#64748B", lineHeight: 1.6, margin: 0 }}>
              Only an owner or admin on this account can manage the subscription. Once they activate it,
              everything here switches on for you automatically — nothing for you to redo.
            </p>
          </div>
        )}
    </div>
  );
}

// ─── Dashboard shell ───
// ═══ Operator Admin console (native) ═════════════════════════════════════════
// Ported out of admin.html's iframe on 2026-07-30. Carolyn, 2026-07-29: "can't we just
// bring admin in here instead of iframing it?" / "What I would rather do is like I did
// for settings."
//
// Three things about this port are load-bearing:
//
// 1. It is built from PORTAL's primitives (S, CardHead, SearchInput, PasswordInput), not
//    admin.html's. admin.html declares its own `S`, `ACCENT`, `PasswordInput` and CSV
//    helpers at top level; pasting those in would throw "Identifier 'S' has already been
//    declared", which kills this entire script — not just the Admin tab. So they are not
//    ported at all, and the reuse is also what makes Admin *look* like Settings.
// 2. There is NO password login. A JWT operator is authorized by app_operators membership
//    (_shared/adminAuth.ts). The password survives only as step-up on the three actions
//    whose blast radius is bigger than one tenant.
// 3. The client being administered is deliberately NOT the portal's `viewing` tenant.
//    admin-catalog takes clientId straight from the body with no session cross-check, so
//    binding them would let "open Junior Barns to look at a design" silently re-aim the
//    delete-client confirm. They stay separate, and the chosen client is on screen in the
//    banner next to every destructive control.

// Port of admin.html's api(). Kept (rather than using an inline invoke) for the
// error.context unwrap: supabase-js reports every non-2xx as the opaque "Edge Function
// returned a non-2xx status code", and the real {error} body is only on the raw Response.
// The .clone() matters — the body can only be read once.
async function adminApi(action, body, adminPassword) {
  const { data, error } = await sb.functions.invoke("admin-catalog", {
    body: { action, ...(adminPassword ? { adminPassword } : {}), ...(body || {}) },
    // Only step-up calls opt out of the session-expiry intercept — those are the ones where a
    // 401 means "wrong operator password", not "dead JWT" (see SS_NO_EXPIRY_HEADER). An adminApi
    // call WITHOUT a password still 401s only on a real expiry, so it must keep the guard.
    ...(adminPassword ? { headers: { [SS_NO_EXPIRY_HEADER]: "1" } } : {}),
  });
  if (error) {
    let msg = error.message || "request failed";
    let status = 0;
    try {
      const ctx = error.context;
      if (ctx) {
        status = ctx.status || 0;
        if (typeof ctx.json === "function") {
          const b = await (typeof ctx.clone === "function" ? ctx.clone() : ctx).json();
          if (b && b.error) msg = b.error;
        }
      }
    } catch (_) { /* fall back to the generic message */ }
    const e = new Error(msg);
    e.status = status;
    throw e;
  }
  if (data && data.error) throw new Error(data.error);
  return data;
}

function slugify(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40); }

function DoorIcon({ double = false }) {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="1.5" />
      {double && <line x1="12" y1="3" x2="12" y2="21" />}
      <circle cx={double ? 10.2 : 16.5} cy="12" r="0.9" fill="currentColor" stroke="none" />
      {double && <circle cx="13.8" cy="12" r="0.9" fill="currentColor" stroke="none" />}
    </svg>
  );
}

// A tiny glyph per layout-item kind, so a 40-pill grid is scannable by shape as well as
// by label. Falls back to a dot for anything unrecognised — a new master item must never
// render as a blank.
function layoutItemGlyph(it) {
  const k = String((it && (it.item_key || it.key)) || "").toLowerCase();
  if (k.indexOf("double") !== -1 && k.indexOf("door") !== -1) return <DoorIcon double />;
  if (k.indexOf("door") !== -1) return <DoorIcon />;
  if (k.indexOf("window") !== -1) {
    return (<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="1.5" /><line x1="12" y1="4" x2="12" y2="20" /><line x1="3" y1="12" x2="21" y2="12" /></svg>);
  }
  if (k.indexOf("ramp") !== -1) {
    return (<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 19h18L3 9z" /></svg>);
  }
  if (k.indexOf("loft") !== -1 || k.indexOf("shelf") !== -1) {
    return (<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><line x1="3" y1="8" x2="21" y2="8" /><line x1="3" y1="15" x2="21" y2="15" /><line x1="6" y1="8" x2="6" y2="15" /><line x1="18" y1="8" x2="18" y2="15" /></svg>);
  }
  return (<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="12" cy="12" r="4" /></svg>);
}

// Portal's chip vocabulary (CardHead's count chip, S.card hairlines) rather than
// admin.html's 2px-ACCENT-border pills, which read as buttons rather than state.
function AdmChip({ tone = "neutral", children, title }) {
  const T = {
    on:      { background: "#DBEAFF", color: "#3D3672", border: "1px solid #C3D9F7" },
    good:    { background: "#DCFCE7", color: "#15803D", border: "1px solid #86EFAC" },
    warn:    { background: "#FEF3C7", color: "#92400E", border: "1px solid #FCD34D" },
    danger:  { background: "#FEE2E2", color: "#991B1B", border: "1px solid #FCA5A5" },
    neutral: { background: "#F1F5F9", color: "#64748B", border: "1px solid #E2E8F0" },
  }[tone] || {};
  return <span title={title} style={{ ...T, fontSize: 11, fontWeight: 800, borderRadius: 6, padding: "2px 7px", whiteSpace: "nowrap" }}>{children}</span>;
}

const ADM_ROW = { display: "flex", alignItems: "center", gap: 10, padding: "9px 2px", borderBottom: "1px solid #F1F5F9" };

// Initials tile, same construction as the Accounts tab's — an operator recognises tenants
// by the same mark in both places.
function AdmTile({ name, size = 34 }) {
  return (
    <div style={{ width: size, height: size, borderRadius: Math.round(size / 4), background: "#F1F5F9", display: "flex", alignItems: "center", justifyContent: "center", fontSize: size <= 30 ? 11 : 12, fontWeight: 800, color: "#475569", flexShrink: 0 }}>
      {String(name || "?").split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase()}
    </div>
  );
}

// Which features a discount covers. HOISTED to module scope on purpose: in admin.html this
// was declared inside AdminApp, making it a new component type on every render — its inputs
// remount (and would lose focus) the moment anyone gives it local state.
function FeatureScope({ features, all, setAll, picked, setPicked, disabled }) {
  return (
    <div style={{ marginTop: 8, opacity: disabled ? 0.5 : 1, pointerEvents: disabled ? "none" : "auto" }}>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13, color: "#1E293B" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
          <input type="radio" checked={all} onChange={() => setAll(true)} />
          <span>Every feature</span>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
          <input type="radio" checked={!all} onChange={() => setAll(false)} />
          <span>Only the ones I pick</span>
        </label>
      </div>
      {!all && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px", marginTop: 8, paddingLeft: 2 }}>
          {features.length === 0 && <span style={{ fontSize: 12, color: "#B91C1C" }}>No billable features found.</span>}
          {features.map((f) => (
            <label key={f.feature} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "#334155", cursor: "pointer" }}>
              <input type="checkbox" checked={picked.indexOf(f.feature) !== -1}
                onChange={(e) => setPicked(e.target.checked ? picked.concat([f.feature]) : picked.filter((x) => x !== f.feature))} />
              <span>{f.name}{f.required ? " (required)" : ""}{f.availability === "coming_soon" ? " — soon" : ""}</span>
            </label>
          ))}
        </div>
      )}
      {/* Server semantics (admin-catalog, create_client/set_billing): an EMPTY list is
          stored as null = the discount applies to EVERY feature. An earlier version of this
          warning claimed the exact opposite ("no discount applies anywhere"), which taught
          operators that leaving it empty was the safe choice. */}
      {!all && picked.length === 0 && (
        <div style={{ fontSize: 11.5, color: "#B91C1C", marginTop: 6 }}>
          Pick at least one feature, or choose "Every feature" — saved empty, the list means no restriction, and the discount would apply to every feature.
        </div>
      )}
    </div>
  );
}

// ── Dialogs ──────────────────────────────────────────────────────────────────
// Same overlay shape as ProfileDialog and PricingCsv's modals; position:fixed is safe from
// this depth because no ancestor sets transform/filter/contain.
function AdmOverlay({ onClose, maxWidth = 520, labelledBy, children }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div onClick={onClose} role="presentation"
      style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.5)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 1000 }}>
      <div role="dialog" aria-modal="true" aria-labelledby={labelledBy} onClick={(e) => e.stopPropagation()}
        style={{ background: "#FFF", borderRadius: 12, padding: 22, maxWidth, width: "100%", boxShadow: "0 20px 50px rgba(0,0,0,0.25)" }}>
        {children}
      </div>
    </div>
  );
}

function AdmClientPicker({ clients, current, onPick, onClose }) {
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const term = q.trim().toLowerCase();
  const list = (clients || []).filter((c) => !term
    || String(c.company_name || "").toLowerCase().indexOf(term) !== -1
    || String(c.client_id || "").toLowerCase().indexOf(term) !== -1);
  useEffect(() => { setHi(0); }, [q]);
  const onKey = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setHi((i) => Math.min(i + 1, list.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter" && list[hi]) { e.preventDefault(); onPick(list[hi].client_id); }
  };
  return (
    <AdmOverlay onClose={onClose} labelledBy="adm-picker-ttl">
      <div id="adm-picker-ttl" style={{ fontSize: 17, fontWeight: 800, color: "#1E293B", marginBottom: 4 }}>Choose a builder</div>
      <div style={{ fontSize: 12.5, color: "#64748B", marginBottom: 14 }}>Everything on the builder-scoped tabs is about whoever is selected here.</div>
      <div onKeyDown={onKey}>
        <SearchInput value={q} onChange={setQ} placeholder="Search builders…" />
      </div>
      <div style={{ maxHeight: 380, overflowY: "auto", margin: "0 -4px" }}>
        {list.length === 0 && (
          <div style={{ fontSize: 13, color: "#94A3B8", padding: "14px 6px" }}>
            {term ? `No builders match “${q}”.` : "No builders yet."}
          </div>
        )}
        {list.map((c, i) => (
          <button key={c.client_id} type="button" onMouseEnter={() => setHi(i)} onClick={() => onPick(c.client_id)}
            style={{ ...ADM_ROW, width: "100%", textAlign: "left", font: "inherit", cursor: "pointer", border: "none",
              borderBottom: "1px solid #F1F5F9", background: i === hi ? "#F8FAFC" : "transparent", padding: "9px 6px" }}>
            <AdmTile name={c.company_name || c.client_id} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: "#1E293B" }}>{c.company_name || c.client_id}</div>
              <div style={{ fontSize: 11.5, color: "#94A3B8" }}>{c.client_id}</div>
            </div>
            {c.client_id === current && <AdmChip tone="on">Current</AdmChip>}
            {c.billingExempt ? <AdmChip tone="good" title="Not billed">Comped</AdmChip>
              : c.discountPercent > 0 ? <AdmChip tone="on" title="Account discount">−{c.discountPercent}%</AdmChip> : null}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
        <button type="button" onClick={onClose} style={S.btn("#F1F5F9", "#334155")}>Cancel</button>
      </div>
    </AdmOverlay>
  );
}

// One destructive action = one dialog = one password prompt. There is deliberately no
// second "now enter your password" modal and no cached password: delete_client is terminal
// (the tenant is gone, so "the same action again" cannot happen), so a cache would avoid
// zero prompts and would reintroduce a resident secret.
function AdmDeleteDialog({ client, onClose, onDeleted }) {
  const [typed, setTyped] = useState("");
  const [pwd, setPwd] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [attempts, setAttempts] = useState(0);
  const id = client.client_id;
  const locked = attempts >= 3;
  const ready = typed.trim() === id && pwd.length > 0 && !busy && !locked;
  const submit = async () => {
    if (!ready) return;
    setBusy(true); setErr(null);
    try {
      const r = await adminApi("delete_client", { clientId: id, confirmClientId: typed.trim() }, pwd);
      setPwd("");
      onDeleted(id, r);
    } catch (e) {
      // Split by kind. An auth failure clears the password and asks again; ANY other
      // failure keeps it typed, so a validation error or a 500 never costs the operator a
      // retype — that is the "asked twice for the same action" failure this avoids.
      const authish = e.status === 401 || e.status === 403 || /password/i.test(e.message || "");
      if (authish) { setPwd(""); setAttempts((n) => n + 1); }
      setErr(e.message || "Could not delete this builder.");
      setBusy(false);
    }
  };
  return (
    <AdmOverlay onClose={busy ? () => {} : onClose} maxWidth={460} labelledBy="adm-del-ttl">
      <div id="adm-del-ttl" style={{ fontSize: 17, fontWeight: 700, color: "#991B1B", marginBottom: 10 }}>
        Delete {client.company_name || id} permanently?
      </div>
      <div style={{ fontSize: 13.5, color: "#475569", lineHeight: 1.55, marginBottom: 16 }}>
        This erases <strong>{id}</strong> from nine tables, deletes every login attached to it, and empties
        its stored images and branding. Their designer link stops working immediately. <strong>This cannot
        be undone.</strong> To stop offering the account without destroying its data, set a paused billing
        posture instead.
      </div>
      {err && <div style={S.err}>{err}</div>}
      {locked && (
        <div style={{ background: "#FEF3C7", border: "1px solid #F59E0B", borderRadius: 8, padding: "10px 14px", color: "#92400E", fontSize: 12.5, fontWeight: 600, marginBottom: 12, lineHeight: 1.5 }}>
          Stop. Two more wrong attempts will lock this IP out of the operator password for up to six hours —
          including the break-glass console at <code>/admin</code> and the settings writer, which share the
          same ledger. Close this and check the password before trying again.
        </div>
      )}
      <label style={S.lbl}>Type <code>{id}</code> to confirm</label>
      <input value={typed} onChange={(e) => setTyped(e.target.value)} disabled={busy || locked}
        onKeyDown={(e) => { if (e.key === "Enter") submit(); }} placeholder={id}
        style={{ ...S.input, marginBottom: 12 }} autoFocus />
      <label style={S.lbl}>Operator password</label>
      <PasswordInput value={pwd} onChange={(e) => setPwd(e.target.value)} disabled={busy || locked}
        onKeyDown={(e) => { if (e.key === "Enter") submit(); }} style={{ marginBottom: 4 }} />
      <div style={{ fontSize: 11, color: "#94A3B8", marginBottom: 18 }}>
        Deleting a tenant still asks for the shared password even though you're signed in — its blast radius
        is bigger than the one account.
      </div>
      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", flexWrap: "wrap" }}>
        <button type="button" onClick={onClose} disabled={busy} style={S.btn("#F1F5F9", "#334155")}>Cancel</button>
        <button type="button" onClick={submit} disabled={!ready} title={!ready ? "Type the builder id and the operator password" : undefined}
          style={{ ...S.btn(ready ? "#DC2626" : "#FCA5A5", "#FFF"), cursor: ready ? "pointer" : "not-allowed" }}>
          {busy ? "Deleting…" : "Delete permanently"}
        </button>
      </div>
    </AdmOverlay>
  );
}

// ── Billing (global) ─────────────────────────────────────────────────────────
// Operator revenue dashboard. ONE read (get_billing_overview) returns raw rows and every
// metric is a memo over them, so the KPI cards and the table can never disagree (FramedUp's
// SubscribersPage pattern). MRR counts active + past_due — a grace-period tenant is still
// expected revenue — never cancelled; annual plans are normalized /12. Comped/exempt tenants
// have no subscription rows at all, which keeps them out of MRR structurally; they get their
// own card so they are visible rather than invisible.
// Dates render as UTC calendar dates: gateway billing dates ARE calendar dates, and
// local-zone rendering shifts them a day either side of midnight (FramedUp's billingDay bug).
const admDay = (iso) => iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }) : "—";

function AdmBillingStat({ label, value, sub }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 800, color: "#94A3B8", textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 800, color: "#1E293B", lineHeight: 1.2, marginTop: 2 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: "#64748B", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function AdmBilling() {
  const [data, setData] = useState(null);            // null = loading
  const [err, setErr] = useState(null);
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState(null);        // expanded subscription row
  const [showCancelled, setShowCancelled] = useState(true);

  const load = useCallback(async () => {
    setErr(null);
    try { setData(await adminApi("get_billing_overview")); }
    catch (e) {
      setErr(e.message || "Could not load billing.");
      setData({ subscriptions: [], tenants: [], alerts: { unknown: [], declined30: 0 } });
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const subs = (data && data.subscriptions) || [];
  const tenants = (data && data.tenants) || [];
  const alerts = (data && data.alerts) || { unknown: [], declined30: 0 };

  const report = useMemo(() => {
    const paying = subs.filter((s) => s.status === "active" || s.status === "past_due");
    // Monthly and yearly plans are reported in their own units on their own cards
    // (Carolyn 2026-08-24); the ARR card is the one place they combine (monthly ×12).
    const breakdown = (rows) => {
      const m = new Map();
      for (const s of rows) {
        const k = s.plan_name || s.plan_id;
        m.set(k, (m.get(k) || 0) + (s.price_cents || 0));
      }
      return [...m.entries()].sort((a, b) => b[1] - a[1]);
    };
    const monthly = paying.filter((s) => s.billing_interval !== "annual");
    const annual = paying.filter((s) => s.billing_interval === "annual");
    const monthlyRevenue = monthly.reduce((t, s) => t + (s.price_cents || 0), 0);
    const annualRevenue = annual.reduce((t, s) => t + (s.price_cents || 0), 0);
    return {
      monthly, annual, monthlyRevenue, annualRevenue,
      byPlanMonthly: breakdown(monthly),
      byPlanAnnual: breakdown(annual),
      arr: monthlyRevenue * 12 + annualRevenue,
      active: subs.filter((s) => s.status === "active").length,
      pastDue: subs.filter((s) => s.status === "past_due"),
      cancelled: subs.filter((s) => s.status === "cancelled").length,
      payingBuilders: new Set(paying.map((s) => s.client_id)).size,
      exempt: tenants.filter((t) => t.billing_exempt),
      grantCount: tenants.reduce((t, r) => t + (r.grant_count || 0), 0),
    };
  }, [subs, tenants]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return subs
      .filter((s) => showCancelled || s.status !== "cancelled")
      .filter((s) => !needle || [s.company_name, s.client_id, s.plan_name].some((v) => String(v || "").toLowerCase().indexOf(needle) !== -1));
  }, [subs, q, showCancelled]);

  // Paging sits strictly DOWNSTREAM of the `report` memo above and of `rows`. MRR, ARR, the
  // active/past-due counts and payingBuilders are derived from `subs`, never from the page —
  // deriving a revenue number from 30 visible rows would change what the KPI MEANS, and this
  // is a change to when things paint, not to what they say. The CardHead count stays on
  // rows.length for the same reason.
  const [pageSize, setPageSize] = usePageSize("adm-subscribers");
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [q, showCancelled]);
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const curPage = Math.min(page, pageCount);
  const paged = rows.slice((curPage - 1) * pageSize, curPage * pageSize);

  const statusChip = (s) => {
    if (s.status === "active") return <AdmChip tone="good">Active</AdmChip>;
    if (s.status === "past_due") return <AdmChip tone="warn">Past due</AdmChip>;
    if (s.status === "cancelled") return <AdmChip tone="neutral">Cancelled</AdmChip>;
    return <AdmChip tone="neutral">{s.status || "—"}</AdmChip>;
  };
  const TH = { textAlign: "left", fontSize: 11, fontWeight: 800, color: "#94A3B8", textTransform: "uppercase", letterSpacing: 0.4, padding: "8px 10px", borderBottom: "1px solid #E2E8F0", whiteSpace: "nowrap" };
  const TD = { fontSize: 13, color: "#1E293B", padding: "9px 10px", borderBottom: "1px solid #F1F5F9", whiteSpace: "nowrap" };

  // Tiles then table, in the shape they will occupy, instead of one card whose description
  // reads "Loading subscriptions…" while the whole page is withheld.
  //
  // There is NO fast/slow split to exploit here, deliberately — do not add a second paint.
  // get_billing_overview is the biggest read in this console (a 5-way Promise.all over
  // billing_subscriptions/plans/client_configs/client_settings/feature_grants, then two more
  // sequential reads) and every KPI above is a memo over the SAME rows the table shows.
  // That is what stops the cards and the table disagreeing, so painting the cards early
  // would mean painting provisional revenue, and a provisional MRR is worse than a wait.
  if (data === null) {
    return (
      <div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 12, marginBottom: 12 }}>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} style={{ ...S.card, marginBottom: 0 }}>
              <SkelBar w="58%" h={9} />
              <SkelBar w="70%" h={22} style={{ marginTop: 9 }} />
              <SkelBar w="86%" h={9} style={{ marginTop: 9 }} />
            </div>
          ))}
        </div>
        <div style={S.card}>
          <CardHead title="Subscribers"
            desc="Every subscription across the platform. Amounts are what the gateway actually bills — founding members keep their locked amount when list prices change." />
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>
                <th style={TH}>Builder</th><th style={TH}>Plan</th><th style={TH}>Interval</th>
                <th style={{ ...TH, textAlign: "right" }}>Amount</th><th style={TH}>Status</th>
                <th style={TH}>Started</th><th style={TH}>Renews</th>
              </tr></thead>
              <tbody><SkelRows cols={7} rows={6} widths={["70%", "55%", "40%", "45%", "38%", "50%", "50%"]} /></tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      {err && <div style={S.err}>{err}</div>}

      {/* closed_unknown FIRST and loud: it means a card may have been charged with nothing
          recorded, and that plan's checkout is blocked for that tenant until reconciled. */}
      {alerts.unknown.length > 0 && (
        <div style={{ ...S.card, border: "1px solid #FCA5A5", background: "#FEF2F2" }}>
          <CardHead title={`⚠️ ${alerts.unknown.length} unverified charge${alerts.unknown.length === 1 ? "" : "s"}`}
            desc="A checkout whose outcome could not be confirmed — the card may have been charged with nothing recorded. Reconcile at the gateway; that tenant's checkout for the plan stays blocked until the row is resolved." />
          {alerts.unknown.map((u, i) => (
            <div key={i} style={{ ...ADM_ROW, fontSize: 12.5 }}>
              <span style={{ fontWeight: 700 }}>{u.client_id}</span>
              <span style={{ color: "#64748B" }}>{u.plan_id}</span>
              <span style={{ color: "#991B1B", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{u.detail || "no detail"}</span>
              <span style={{ color: "#94A3B8" }}>{u.sale_txn ? `txn ${u.sale_txn}` : ""} · {admDay(u.created_at)}</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 12, marginBottom: 12 }}>
        <div style={S.card}>
          <AdmBillingStat label="Monthly plans" value={money(report.monthlyRevenue) + "/mo"}
            sub={`${report.monthly.length} monthly subscription${report.monthly.length === 1 ? "" : "s"}`} />
          {report.byPlanMonthly.length > 0 && (
            <div style={{ marginTop: 10, borderTop: "1px solid #F1F5F9", paddingTop: 8 }}>
              {report.byPlanMonthly.map(([name, cents]) => (
                <div key={name} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, color: "#475569", padding: "2px 0" }}>
                  <span>{name}</span><span style={{ fontWeight: 700 }}>{money(cents)}/mo</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div style={S.card}>
          <AdmBillingStat label="Yearly plans" value={money(report.annualRevenue) + "/yr"}
            sub={`${report.annual.length} yearly subscription${report.annual.length === 1 ? "" : "s"}`} />
          {report.byPlanAnnual.length > 0 && (
            <div style={{ marginTop: 10, borderTop: "1px solid #F1F5F9", paddingTop: 8 }}>
              {report.byPlanAnnual.map(([name, cents]) => (
                <div key={name} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, color: "#475569", padding: "2px 0" }}>
                  <span>{name}</span><span style={{ fontWeight: 700 }}>{money(cents)}/yr</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div style={S.card}>
          <AdmBillingStat label="Annual revenue" value={money(report.arr) + "/yr"}
            sub={`all subscriptions · monthly ×12 + yearly · ${report.payingBuilders} paying builder${report.payingBuilders === 1 ? "" : "s"}`} />
        </div>
        <div style={S.card}>
          <AdmBillingStat label="Subscriptions" value={report.active}
            sub={`active · ${report.pastDue.length} past due · ${report.cancelled} cancelled`} />
        </div>
        <div style={S.card}>
          <AdmBillingStat label="Billing health" value={report.pastDue.length === 0 && alerts.unknown.length === 0 ? "OK" : `${report.pastDue.length + alerts.unknown.length} ⚠`}
            sub={`${report.pastDue.length} past due · ${alerts.unknown.length} unverified · ${alerts.declined30} declined in 30 days`} />
          {report.pastDue.map((s) => (
            <div key={s.id} style={{ fontSize: 12.5, color: "#92400E", marginTop: 4 }}>
              {s.company_name} — {s.plan_name}, since {admDay(s.past_due_since)}
            </div>
          ))}
        </div>
        <div style={S.card}>
          <AdmBillingStat label="Comped / exempt" value={report.exempt.length}
            sub={`exempt builders (not in MRR) · ${report.grantCount} feature grant${report.grantCount === 1 ? "" : "s"}`} />
          {report.exempt.slice(0, 6).map((t) => (
            <div key={t.client_id} style={{ fontSize: 12.5, color: "#475569", marginTop: 4 }}>
              {t.company_name || t.client_id}{t.exempt_until ? ` · until ${admDay(t.exempt_until)}` : ""}{t.discount_percent ? ` · ${t.discount_percent}% off` : ""}
            </div>
          ))}
          {report.exempt.length > 6 && <div style={{ fontSize: 12, color: "#94A3B8", marginTop: 4 }}>+{report.exempt.length - 6} more</div>}
        </div>
      </div>

      <div style={S.card}>
        <CardHead title="Subscribers" count={rows.length}
          desc="Every subscription across the platform. Amounts are what the gateway actually bills — founding members keep their locked amount when list prices change."
          right={<button type="button" onClick={load} style={S.btn("#F1F5F9", "#334155")}>Refresh</button>} />
        <SearchInput value={q} onChange={setQ} placeholder="Search builder or plan…" />
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "#64748B", marginBottom: 8, cursor: "pointer" }}>
          <input type="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} />
          <span>Show cancelled</span>
        </label>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              <th style={TH}>Builder</th><th style={TH}>Plan</th><th style={TH}>Interval</th>
              <th style={{ ...TH, textAlign: "right" }}>Amount</th><th style={TH}>Status</th>
              <th style={TH}>Started</th><th style={TH}>Renews</th>
            </tr></thead>
            <tbody>
              {paged.map((s) => (
                <React.Fragment key={s.id}>
                  <tr onClick={() => setOpenId(openId === s.id ? null : s.id)} style={{ cursor: "pointer", background: openId === s.id ? "#F8FAFC" : "transparent" }}>
                    <td style={TD}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <AdmTile name={s.company_name} size={26} />
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 700 }}>{s.company_name}</div>
                          <div style={{ fontSize: 11, color: "#94A3B8" }}>{s.client_id}</div>
                        </div>
                      </div>
                    </td>
                    <td style={TD}>{s.plan_name}</td>
                    <td style={TD}>{s.billing_interval === "annual" ? "Yearly" : s.billing_interval === "monthly" ? "Monthly" : "—"}</td>
                    <td style={{ ...TD, textAlign: "right", fontWeight: 700 }}>
                      {money(s.price_cents)}
                      {s.list_price_cents != null && s.list_price_cents !== s.price_cents &&
                        <span style={{ color: "#94A3B8", fontWeight: 400, textDecoration: "line-through", marginLeft: 6 }}>{money(s.list_price_cents)}</span>}
                    </td>
                    <td style={TD}>{statusChip(s)}</td>
                    <td style={TD}>{admDay(s.created_at)}</td>
                    <td style={TD}>{s.status === "cancelled" ? (s.paid_through ? `paid thru ${admDay(s.paid_through)}` : "—") : admDay(s.paid_through)}</td>
                  </tr>
                  {openId === s.id && (
                    <tr><td colSpan={7} style={{ ...TD, background: "#F8FAFC", fontSize: 12.5, color: "#475569", whiteSpace: "normal" }}>
                      Subscription <code>{s.id}</code> · period {admDay(s.current_period_start)} → {admDay(s.current_period_end)}
                      {s.past_due_since ? <> · past due since {admDay(s.past_due_since)}</> : null}
                      {s.canceled_at ? <> · cancelled {admDay(s.canceled_at)}</> : null}
                      {s.list_price_cents != null && s.list_price_cents !== s.price_cents ? <> · list {money(s.list_price_cents)}, charged {money(s.price_cents)}</> : null}
                    </td></tr>
                  )}
                </React.Fragment>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={7} style={{ ...TD, color: "#94A3B8", textAlign: "center", padding: 24 }}>No subscriptions{q ? " match the search" : " yet"}.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {rows.length > 0 && (
          <PageBar size={pageSize} onSize={setPageSize} page={curPage} onPage={setPage} total={rows.length} noun="subscription" />
        )}
      </div>
    </div>
  );
}

// ── The shell ────────────────────────────────────────────────────────────────
// Seven sub-tabs, split by SCOPE — which is the thing the old flat toolbar hid. "Layout
// Items" wrote one tenant's row while "Master Items" read the platform-wide palette, and
// they sat adjacent in one undifferentiated pill row with nothing saying so. The tab order
// is also the onboarding order: create the client, give the owner a login, give them
// styles, then items, then prices.
const ADM_TABS = [
  ["clients", "Builders",        "Every tenant on the platform — search, create, and open",       "global"],
  ["billing", "Billing",         "Subscribers, revenue and billing health across the platform",   "global"],
  ["account", "Account",        "Owner logins, billing posture, and deletion",                   "client"],
  ["styles",  "Styles & Sizes", "Building styles this builder offers, and the sizes under each",  "client"],
  ["items",   "Items",          "Which placeable layout items this builder gets",                 "client"],
  ["pricing", "Pricing",        "Bulk price and inclusion import/export by CSV",                 "client"],
  ["master",  "Master Catalog", "The global layout-item palette every builder draws from",        "global"],
];

function AdminShell({ onOpenAccount, sub: subProp = null, onSub = null }) {
  const [clients, setClients] = useState(null);   // null = loading
  const [features, setFeatures] = useState([]);
  const [master, setMaster] = useState(null);
  // master carries its OWN error, not bootErr's: after the split below, a failed get_master
  // must neither blank the Builders list nor leave Master Catalog and Items sitting on a
  // skeleton forever for a read that has already failed.
  const [masterErr, setMasterErr] = useState(null);
  const [sel, setSel] = useState("");             // the administered client — NOT `viewing`
  const [subState, setSubState] = useState("clients");
  const setSub = onSub || setSubState;
  // The LAST REAL sub-tab, not ADM_TABS[0], is the fallback when the prop is null — and the
  // prop goes null constantly: 11-shell passes `sub={activeTab === "admin" ? sub : null}` and
  // its navigate() nulls `sub` on every plain nav click. Collapsing to "clients" there flips
  // `needsClient` false, which unmounts AdminClientPanes and bins exactly the staged work the
  // console is kept mounted to protect — 12 ticked items under a "12 unsaved changes" banner,
  // gone because the operator stepped over to Pipeline for ten seconds. Holding the sub keeps
  // the panes mounted while another tab is on screen, and lands the operator back where they
  // left off on the way in (audit 2026-08-28).
  const lastSub = useRef(ADM_TABS[0][0]);
  const sub = (onSub ? subProp : subState) || lastSub.current;
  useEffect(() => { lastSub.current = sub; }, [sub]);
  const [msg, setMsg] = useState(null);           // { ok } | { err }
  const [pickerOpen, setPickerOpen] = useState(false);
  const [bootErr, setBootErr] = useState(null);
  const promptedFor = useRef({});                 // so the picker nags at most once per tab

  // The ok auto-dismiss clears only ITS OWN message: an unconditional setMsg(null) fires 6s
  // after whatever is current — including an error flashed 5s after the save it reports on,
  // gone before anyone could read it. The functional updater checks identity (every flash
  // makes a fresh object), so a superseded timer no-ops instead of clobbering.
  const flash = (m) => { setMsg(m); if (m && m.ok) setTimeout(() => setMsg((cur) => (cur === m ? null : cur)), 6000); };
  const selRow = (clients || []).find((c) => c.client_id === sel) || null;
  const active = ADM_TABS.find((t) => t[0] === sub) || ADM_TABS[0];
  const needsClient = active[3] === "client";

  const loadClients = useCallback(async () => {
    const c = await adminApi("list_clients");
    setClients(c.clients || []);
    setFeatures(c.features || []);
    return c.clients || [];
  }, []);

  // TWO independent awaits, not one Promise.all with a destructured result. The first paint
  // of this console is the Builders list, and that needs list_clients ALONE: `master` feeds
  // Master Catalog and the per-client Items/Pricing panes, none of which can render before a
  // builder is selected — which itself requires the client list. Awaited jointly, the
  // console showed "Loading builders…" and a dead "Choose builder" button until BOTH landed,
  // so any hiccup on get_master delayed a list that never uses it.
  //
  // This is the Contacts defect verbatim (02-sales LeadsTable): a read the first paint does
  // not need, awaited before the first setState. It is not the same magnitude — list_clients
  // is four sequential table reads server-side and get_master is one select, so they already
  // ran concurrently and wall time was max() — but splitting cannot be slower, and it takes
  // get_master off the critical path entirely.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await adminApi("list_clients");
        if (cancelled) return;
        setClients(list.clients || []);
        setFeatures(list.features || []);
        // Restore the last-administered client, but only if it still exists — a tenant
        // deleted in another session must not come back as a selection. Stays on this leg:
        // it reads list.clients.
        try {
          const saved = sessionStorage.getItem("ss.admin.clientId");
          if (saved && (list.clients || []).some((c) => c.client_id === saved)) setSel(saved);
        } catch (_e) { /* private mode */ }
      } catch (e) {
        if (!cancelled) { setBootErr(e.message || "Could not load the operator console."); setClients([]); }
      }
    })();
    // Own catch, own error state — the two failures mean different things and must not merge.
    (async () => {
      try {
        const m = await adminApi("get_master");
        if (cancelled) return;
        setMaster(m);
      } catch (e) {
        if (!cancelled) setMasterErr(e.message || "Could not load the master item catalog.");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const pickClient = (cid) => {
    setSel(cid);
    setMsg(null);
    setPickerOpen(false);
    try { sessionStorage.setItem("ss.admin.clientId", cid); } catch (_e) {}
    if (sub === "clients") setSub("account");
  };

  // Clicking a client-scoped tab with nothing selected opens the picker ONCE. The tab is
  // never disabled — a disabled tab is a dead end that teaches nothing.
  useEffect(() => {
    if (needsClient && !sel && clients && !promptedFor.current[sub]) {
      promptedFor.current[sub] = true;
      setPickerOpen(true);
    }
  }, [sub, sel, clients, needsClient]);

  return (
    <div>
      {/* Banner. Settings' exact treatment, but it earns the repetition of the topbar title
          by carrying the administered client — visible from every sub-tab, so an operator
          can never lose track of who the next write lands on. */}
      <div style={{ background: "linear-gradient(135deg, #3D3672 0%, #1B7895 100%)", borderRadius: 14, padding: "20px 22px", color: "#FFF", marginBottom: 4 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <div style={{ width: 44, height: 44, borderRadius: 11, background: "rgba(255,255,255,0.14)", border: "1px solid rgba(255,255,255,0.28)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, color: "#FFF" }}>
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#FFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 20, fontWeight: 800, lineHeight: 1.15 }}>Admin</div>
            <div style={{ fontSize: 12.5, color: "#D6E4F0", marginTop: 2 }}>The operator console — every tenant's catalog, setup and onboarding. Changes here are live in a builder's account.</div>
          </div>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10, background: "rgba(255,255,255,0.12)", border: "1px solid rgba(255,255,255,0.26)", borderRadius: 10, padding: "8px 12px" }}>
            {selRow ? (
              <>
                <AdmTile name={selRow.company_name || selRow.client_id} size={28} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 800, color: "#FFF", whiteSpace: "nowrap" }}>{selRow.company_name || selRow.client_id}</div>
                  <div style={{ fontSize: 11.5, color: "#C9DCEA" }}>{selRow.client_id}</div>
                </div>
                <button type="button" onClick={() => setPickerOpen(true)}
                  style={{ fontFamily: "inherit", background: "transparent", border: "1px solid rgba(255,255,255,0.4)", color: "#FFF", borderRadius: 8, padding: "5px 10px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                  Change
                </button>
              </>
            ) : (
              <>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#D6E4F0" }}>No builder selected</div>
                <button type="button" onClick={() => setPickerOpen(true)} disabled={!clients}
                  style={{ fontFamily: "inherit", background: "transparent", border: "1px solid rgba(255,255,255,0.4)", color: "#FFF", borderRadius: 8, padding: "5px 10px", fontSize: 12, fontWeight: 700, cursor: "pointer", opacity: clients ? 1 : 0.5 }}>
                  Choose builder
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Sub-navigation. Real <button>s, unlike admin.html's <div onClick> tabs, which were
          not focusable and had no Enter/Space. The divider is the whole point of the
          reorganisation: everything left of it is about one client, everything right of it
          is platform-wide. */}
      <div style={{ display: "flex", gap: 2, flexWrap: "wrap", borderBottom: "2px solid #E2E8F0", marginBottom: 14 }}>
        {ADM_TABS.map(([id, label, , scope], i) => (
          <React.Fragment key={id}>
            {i > 0 && ADM_TABS[i - 1][3] !== scope && (
              <span aria-hidden="true" style={{ width: 1, alignSelf: "stretch", background: "#E2E8F0", margin: "8px 10px 0" }} />
            )}
            <button type="button" onClick={() => setSub(id)} aria-current={sub === id ? "page" : undefined}
              style={{
                background: "none", border: "none", cursor: "pointer", fontFamily: "inherit",
                padding: "12px 14px 10px", fontSize: 13, fontWeight: 700, letterSpacing: 0.2,
                color: sub === id ? ACCENT : "#64748B",
                borderBottom: sub === id ? `2px solid ${ACCENT}` : "2px solid transparent",
                marginBottom: -2,
              }}>
              {label}
            </button>
          </React.Fragment>
        ))}
      </div>
      <div style={{ fontSize: 12, color: "#64748B", margin: "0 0 12px 2px", fontWeight: 600, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span>{active[1]} — {active[2]}</span>
        <AdmChip tone={active[3] === "global" ? "warn" : "neutral"}>
          {active[3] === "global" ? "Platform-wide" : (selRow ? `For ${selRow.company_name || selRow.client_id}` : "Per builder")}
        </AdmChip>
      </div>

      {bootErr && <div style={S.err}>{bootErr}</div>}
      {msg && msg.err && <div style={S.err}>{msg.err}</div>}
      {msg && msg.ok && <div style={S.okMsg}>{msg.ok}</div>}

      {sub === "clients" && (
        <AdmClients clients={clients} features={features} sel={sel}
          onPick={pickClient} onOpenAccount={onOpenAccount} onFlash={flash} onReload={loadClients} />
      )}
      {sub === "billing" && <AdmBilling />}
      {sub === "master" && <AdmMaster master={master} masterErr={masterErr} />}

      {needsClient && !sel && clients && (
        <div style={S.card}>
          <CardHead title="Choose a builder first"
            desc="Styles, items and pricing are per-builder. Pick the tenant you're setting up and this page fills in." />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" onClick={() => setPickerOpen(true)} style={S.btn(ACCENT, "#FFF")}>Choose builder</button>
            <button type="button" onClick={() => setSub("clients")} style={S.btn("#F1F5F9", "#334155")}>Browse all builders</button>
          </div>
        </div>
      )}

      {/* The remount key is the single most important line in this port. Every staged,
          uncommitted thing — ticked item pills, a parsed CSV report, a half-filled billing
          or link-owner form, a chosen style image — lives inside AdminClientPanes, so
          changing client destroys it STRUCTURALLY. In admin.html an effect keyed on
          [sel, cat] wiped the ticks while the UI was still rendering "N unsaved changes". */}
      {needsClient && sel && (
        <AdminClientPanes key={"ac-" + sel} sub={sub} clientId={sel} clientRow={selRow}
          master={master} masterErr={masterErr} features={features} onFlash={flash}
          onReloadClients={loadClients} onDeleted={() => { setSel(""); setSub("clients"); try { sessionStorage.removeItem("ss.admin.clientId"); } catch (_e) {} }} />
      )}

      {pickerOpen && (
        <AdmClientPicker clients={clients || []} current={sel}
          onPick={pickClient} onClose={() => setPickerOpen(false)} />
      )}
    </div>
  );
}

// ── Clients (global) ─────────────────────────────────────────────────────────
function AdmClients({ clients, features, sel, onPick, onOpenAccount, onFlash, onReload }) {
  const [q, setQ] = useState("");
  const [openNew, setOpenNew] = useState(false);
  const [id, setId] = useState("");
  const [company, setCompany] = useState("");
  const [tpl, setTpl] = useState("__none__");
  const [idTouched, setIdTouched] = useState(false);
  const [exempt, setExempt] = useState(false);
  const [discount, setDiscount] = useState("0");
  const [allFeat, setAllFeat] = useState(true);
  const [picked, setPicked] = useState([]);
  const [busy, setBusy] = useState(false);
  const [grantBusy, setGrantBusy] = useState(null);   // client_id mid-save, so only that row disables

  // Is 3D comp-able at all? Same source the Account tab's Early access card uses: a feature is
  // offerable only when its billing_plans rows carry operator_grantable (migration 109), which
  // is FALSE by default and can never be true for a paid-only feature. If 3D is ever put on
  // sale properly, drop the column and this button disappears on its own.
  const can3D = (features || []).some((f) => f.feature === "view_3d" && f.operatorGrantable);
  // LIVE means unexpired: portal-billing ignores an expired grant, so the console must too,
  // or an expired grant shows "3D access [on]" for a tenant who actually has nothing -- and
  // clicking that lying button REVOKED the dead row instead of granting (audit 2026-08-19).
  const grantLive = (g) => !g.expiresAt || Date.parse(g.expiresAt) > Date.now();
  const has3D = (c) => Array.isArray(c.grants) && c.grants.some((g) => g.feature === "view_3d" && grantLive(g));

  // One-click comp/revoke straight from the list, so the common case does not need a trip
  // through Manage -> Account. The Account card still exists and is the place to set an
  // EXPIRY; this button grants open-ended.
  const toggle3D = async (c) => {
    if (grantBusy) return;
    const on = has3D(c);
    setGrantBusy(c.client_id);
    try {
      // set_feature_grants REPLACES this tenant's whole set, so every OTHER grant has to be
      // sent back with it or toggling 3D would silently revoke them. Only view_3d is grantable
      // today, which is exactly why this is easy to get wrong later.
      const cur = Array.isArray(c.grants) ? c.grants : [];
      // BOTH paths strip every existing view_3d row first. The ON path used to concat onto
      // whatever was there, so granting over an EXPIRED leftover row sent two rows with the
      // same (client_id, feature) primary key and the whole save failed (audit 2026-08-19).
      const others = cur.filter((g) => g.feature !== "view_3d");
      const next = on ? others : others.concat([{ feature: "view_3d", expiresAt: null }]);
      await adminApi("set_feature_grants", {
        clientId: c.client_id,
        grants: next.map((g) => ({ feature: g.feature, expiresAt: g.expiresAt || null })),
      });
      const okMsg = on
        ? `3D turned OFF for ${c.company_name || c.client_id}. They see the “coming soon” teaser again.`
        : `3D turned ON for ${c.company_name || c.client_id}. This is a comp — no subscription, no charge.`;
      // The write LANDED; a refresh hiccup after it must not read as "the save failed" --
      // that misreport is how an operator clicks again and undoes their own change.
      try { await onReload(); onFlash({ ok: okMsg }); }
      catch (_e) { onFlash({ ok: okMsg + " (The list did not refresh — reload the page to see it.)" }); }
    } catch (e) { onFlash({ err: e.message }); }
    setGrantBusy(null);
  };

  const term = q.trim().toLowerCase();
  const list = (clients || []).filter((c) => !term
    || String(c.company_name || "").toLowerCase().indexOf(term) !== -1
    || String(c.client_id || "").toLowerCase().indexOf(term) !== -1);

  // Rendering cap only. The count in CardHead stays on the whole filtered list because
  // "12 of 340" is a fact about the platform, and paging must not quietly turn it into a
  // fact about the page. The picker and "Copy catalog from" also keep reading `clients`.
  const [pageSize, setPageSize] = usePageSize("adm-builders");
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [q]);
  const pageCount = Math.max(1, Math.ceil(list.length / pageSize));
  const curPage = Math.min(page, pageCount);
  const paged = list.slice((curPage - 1) * pageSize, curPage * pageSize);

  const slug = id.trim().toLowerCase();
  const taken = (clients || []).some((c) => c.client_id === slug);
  const shapeOk = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(slug);
  const idErr = !slug ? null : taken ? "That builder id is already taken." : !shapeOk ? "Lowercase letters, numbers and hyphens only — it becomes their subdomain." : null;
  const canCreate = slug && company.trim() && !idErr && !busy;

  const create = async () => {
    if (!canCreate) return;
    // A discount is money, so it is REFUSED, not coerced. `Number(discount) || 0` read a
    // typed "50%" as 0, and at 0 with no exemption admin-catalog writes no client_settings
    // row at all — so the founding-customer rate the operator believed they had just set
    // simply did not exist, under a flash that said Created. Same check and same wording as
    // the Account tab's saveBilling, which has validated this all along; only the create
    // path was coercing. Skipped when exempt: the account is non-billable, the field is
    // greyed out beside the checkbox that says so, and the value below is forced to 0
    // (audit 2026-08-28).
    const pctNum = Math.round(Number(discount));
    if (!exempt && (!Number.isFinite(pctNum) || pctNum < 0 || pctNum > 100)) {
      onFlash({ err: "Discount must be a whole number from 0 to 100." });
      return;
    }
    // Same guard as the Account tab's saveBilling: the server stores an EMPTY
    // discountFeatures list as null = the discount applies to EVERY feature (admin-catalog,
    // create_client/set_billing). So "only the ones I pick" with nothing picked would not
    // create no discount — it would silently create an all-features one.
    if (!exempt && pctNum > 0 && !allFeat && picked.length === 0) {
      onFlash({ err: "Choose which features the discount applies to, or select “Every feature”." });
      return;
    }
    setBusy(true);
    try {
      await adminApi("create_client", {
        clientId: slug, companyName: company.trim(), templateClientId: tpl,
        billingExempt: exempt, discountPercent: exempt ? 0 : pctNum,
        discountFeatures: allFeat ? [] : picked,
      });
      await onReload();
      setOpenNew(false); setId(""); setCompany(""); setTpl("__none__"); setIdTouched(false);
      setExempt(false); setDiscount("0"); setAllFeat(true); setPicked([]);
      onFlash({ ok: `Created “${slug}”. Next: give the owner a login on the Account tab, then styles, items and pricing.` });
      onPick(slug);
    } catch (e) { onFlash({ err: e.message }); }
    setBusy(false);
  };

  return (
    <>
      <div style={S.card}>
        <CardHead title="Builder accounts"
          count={clients ? (term ? `${list.length} of ${clients.length}` : clients.length) : null}
          desc="Every tenant on the platform. Manage puts a builder into the tabs above; Open portal takes you into their account as an operator."
          right={<button type="button" onClick={() => setOpenNew((v) => !v)} style={S.btn(ACCENT, "#FFF")}>
            {openNew ? "Cancel" : "+ New builder"}
          </button>} />
        <SearchInput value={q} onChange={setQ} placeholder="Search builders…" />
        {/* This list is what the console opens on, so it is the operator's first paint —
            blocks in the ADM_ROW shape (tile, name over id, two buttons) rather than the word
            "Loading". Since the boot split above it waits on list_clients alone. */}
        {clients === null && (
          <div>
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} style={{ ...ADM_ROW, opacity: 1 - i * 0.11 }}>
                <SkelBar w={34} h={34} style={{ borderRadius: 9, flexShrink: 0 }} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <SkelBar w="38%" h={12} />
                  <SkelBar w="22%" h={9} style={{ marginTop: 6 }} />
                </div>
                <SkelBar w={78} h={28} style={{ borderRadius: 8, flexShrink: 0 }} />
                <SkelBar w={92} h={28} style={{ borderRadius: 8, flexShrink: 0 }} />
              </div>
            ))}
          </div>
        )}
        {clients && list.length === 0 && (
          <div style={{ fontSize: 13, color: "#94A3B8" }}>{term ? `No builders match “${q}”.` : "No builders yet — create the first one above."}</div>
        )}
        {paged.map((c) => (
          <div key={c.client_id} style={ADM_ROW}>
            <AdmTile name={c.company_name || c.client_id} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: "#1E293B" }}>{c.company_name || c.client_id}</div>
              <div style={{ fontSize: 11.5, color: "#94A3B8" }}>{c.client_id}</div>
            </div>
            {c.client_id === sel && <AdmChip tone="on">Selected</AdmChip>}
            {c.billingExempt ? <AdmChip tone="good" title="Not billed">Comped</AdmChip>
              : c.discountPercent > 0 ? <AdmChip tone="on" title="Account discount">−{c.discountPercent}%</AdmChip> : null}
            {can3D && (() => {
              const on = has3D(c);
              const saving = grantBusy === c.client_id;
              return (
                <button type="button" onClick={() => toggle3D(c)} disabled={saving}
                  title={on
                    ? "3D is ON for this builder — click to remove access"
                    : "Switch 3D on for this builder. A comp: no subscription, no charge."}
                  style={{
                    ...S.btn(on ? "#75E6DA" : "#FFFFFF", on ? "#0F4C46" : "#64748B"),
                    border: "1px solid " + (on ? "#4FD1C5" : "#CBD5E1"),
                    padding: "6px 12px", fontSize: 12, whiteSpace: "nowrap",
                    opacity: saving ? 0.6 : 1, cursor: saving ? "default" : "pointer",
                  }}>
                  {saving ? "Saving…" : on ? "3D access ✓" : "3D access"}
                </button>
              );
            })()}
            <button type="button" onClick={() => onPick(c.client_id)} title="Administer this builder"
              style={{ ...S.btn("#FFFFFF", ACCENT), border: "1px solid " + ACCENT, padding: "6px 12px", fontSize: 12 }}>Manage</button>
            {onOpenAccount && (
              <button type="button" onClick={() => onOpenAccount({ clientId: c.client_id, companyName: c.company_name || c.client_id })}
                title="Open their portal and act as them"
                style={{ ...S.btn("#F1F5F9", "#334155"), padding: "6px 12px", fontSize: 12 }}>Open portal</button>
            )}
          </div>
        ))}
        {list.length > 0 && (
          <PageBar size={pageSize} onSize={setPageSize} page={curPage} onPage={setPage} total={list.length} noun="builder" />
        )}
      </div>

      {openNew && (
        <div style={S.card}>
          <CardHead title="Create a builder" desc="The builder id becomes their subdomain and can't be changed afterwards, so get it right here." />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 12 }}>
            <div>
              <label style={S.lbl}>Company name</label>
              <input value={company} autoFocus
                onChange={(e) => { setCompany(e.target.value); if (!idTouched) setId(slugify(e.target.value)); }}
                placeholder="Junior Barns" style={S.input} />
            </div>
            <div>
              <label style={S.lbl}>Builder id</label>
              <input value={id} onChange={(e) => { setIdTouched(true); setId(e.target.value); }}
                placeholder="junior-barns" style={{ ...S.input, borderColor: idErr ? "#DC2626" : "#CBD5E1" }} />
              <div style={{ fontSize: 11, color: idErr ? "#DC2626" : "#94A3B8", marginTop: 6 }}>
                {idErr || (idTouched ? "Used in the customer designer link: ?client=junior-barns." : "Auto-generated from the company name — edit to override.")}
              </div>
            </div>
            <div>
              <label style={S.lbl}>Copy catalog from</label>
              <select value={tpl} onChange={(e) => setTpl(e.target.value)} style={S.input}>
                <option value="__none__">Start empty</option>
                {(clients || []).map((c) => <option key={c.client_id} value={c.client_id}>{c.company_name || c.client_id}</option>)}
              </select>
              <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 6 }}>Copies styles, sizes and items — not designs or settings.</div>
            </div>
          </div>
          <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid #F1F5F9" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#1E293B", cursor: "pointer" }}>
              <input type="checkbox" checked={exempt} onChange={(e) => setExempt(e.target.checked)} />
              <span>Non-billable — CSM Synergy's own, demo or testing account (skips the billing gate)</span>
            </label>
            <div style={{ marginTop: 10, maxWidth: 220, opacity: exempt ? 0.5 : 1, pointerEvents: exempt ? "none" : "auto" }}>
              <label style={S.lbl}>Account discount %</label>
              <input value={discount} onChange={(e) => setDiscount(e.target.value)} inputMode="numeric" style={S.input} />
            </div>
            {!exempt && Number(discount) > 0 && (
              <FeatureScope features={features} all={allFeat} setAll={setAllFeat} picked={picked} setPicked={setPicked} />
            )}
          </div>
          <div style={{ marginTop: 16 }}>
            <button type="button" onClick={create} disabled={!canCreate}
              title={!canCreate ? (idErr || "Enter a company name and a builder id") : undefined}
              style={{ ...S.btn(ACCENT, "#FFF"), opacity: canCreate ? 1 : 0.6, cursor: canCreate ? "pointer" : "not-allowed" }}>
              {busy ? "Creating…" : "Create builder"}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

// ── Master catalog (global, read-only) ───────────────────────────────────────
function AdmMaster({ master, masterErr }) {
  const [q, setQ] = useState("");
  const items = (master && master.layoutItemTypes) || [];
  const term = q.trim().toLowerCase();
  const list = items.filter((i) => !term
    || String(i.label || "").toLowerCase().indexOf(term) !== -1
    || String(i.item_key || "").toLowerCase().indexOf(term) !== -1);
  return (
    <div style={S.card}>
      <CardHead title="Master layout items" count={master ? items.length : null}
        desc="The platform-wide palette. Every builder's Items tab is a selection from this list — nothing here belongs to one tenant, and turning an item on for a builder never edits this." />
      {/* Deliberately NOT paginated. This is a chip cloud the operator scans and narrows with
          the search box below, and a 30-item page boundary would hide items from the very
          search being used to find one. Pagination is for the lists that actually run long —
          Accounts, Builders, Subscribers — not for symmetry.
          The real speed-up for this tab is the AdminShell split: get_master no longer waits
          on list_clients, so the palette paints on its own timeline. */}
      {masterErr && <div style={{ fontSize: 13, color: "#B91C1C" }}>{masterErr}</div>}
      {!master && !masterErr && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {[128, 96, 150, 112, 90, 134, 104, 142, 98, 120].map((w, i) => (
            <SkelBar key={i} w={w} h={31} style={{ borderRadius: 9, opacity: 1 - i * 0.06 }} />
          ))}
        </div>
      )}
      {master && items.length > 0 && <SearchInput value={q} onChange={setQ} placeholder="Search items…" />}
      {master && items.length === 0 && <div style={{ fontSize: 13, color: "#94A3B8" }}>No master items defined yet.</div>}
      {master && items.length > 0 && list.length === 0 && <div style={{ fontSize: 13, color: "#94A3B8" }}>No items match “{q}”.</div>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {list.map((i) => (
          <div key={i.item_key} title={i.item_key}
            style={{ display: "flex", alignItems: "center", gap: 7, border: "1px solid #E2E8F0", background: "#F8FAFC", borderRadius: 9, padding: "7px 11px", fontSize: 12.5, fontWeight: 600, color: "#334155" }}>
            <span style={{ color: "#64748B", display: "flex" }}>{layoutItemGlyph(i)}</span>
            {i.label || i.item_key}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Per-client panes ─────────────────────────────────────────────────────────
// Mounted with key={"ac-" + clientId}. Everything staged and uncommitted lives HERE, so a
// client change destroys it structurally rather than by an effect that races the render.
function AdminClientPanes({ sub, clientId, clientRow, master, masterErr, features, onFlash, onReloadClients, onDeleted }) {
  const [cat, setCat] = useState(null);
  const [catErr, setCatErr] = useState(null);

  const loadCat = useCallback(async () => {
    setCatErr(null);
    try { setCat(await adminApi("get_client_catalog", { clientId })); }
    catch (e) { setCatErr(e.message || "Could not load this builder's catalog."); }
  }, [clientId]);

  useEffect(() => { loadCat(); }, [loadCat]);

  // Write, then report, then refresh — in that order, and refresh failures are swallowed.
  // Ported deliberately from admin.html's act(): a failing get_client_catalog must never
  // mask a write that actually landed.
  const act = async (action, body, okMsg) => {
    try { await adminApi(action, body); }
    catch (e) { onFlash({ err: e.message }); return false; }
    onFlash({ ok: okMsg || "Saved." });
    try { setCat(await adminApi("get_client_catalog", { clientId })); } catch (_e) { /* catches up next action */ }
    return true;
  };

  const label = (clientRow && clientRow.company_name) || clientId;
  const common = { clientId, clientRow, label, cat, setCat, master, masterErr, features, onFlash, act, loadCat, onReloadClients };

  if (catErr && sub !== "account") return <div style={S.err}>{catErr}</div>;

  return (
    <>
      {sub === "account" && <AdmAccount {...common} onDeleted={onDeleted} />}
      {sub === "styles" && <AdmStyles {...common} />}
      {sub === "items" && <AdmItems {...common} />}
      {sub === "pricing" && <AdmPricing {...common} />}
    </>
  );
}

function AdmAccount({ clientId, clientRow, label, features, onFlash, onReloadClients, onDeleted }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("owner");
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkResult, setLinkResult] = useState(null);
  const [reassignFrom, setReassignFrom] = useState(null);
  const [copied, setCopied] = useState(null);

  const [pct, setPct] = useState(String((clientRow && clientRow.discountPercent) ?? 0));
  const [exempt, setExempt] = useState(Boolean(clientRow && clientRow.billingExempt));
  const scoped = Array.isArray(clientRow && clientRow.discountFeatures) ? clientRow.discountFeatures : [];
  const [allFeat, setAllFeat] = useState(scoped.length === 0);
  const [picked, setPicked] = useState(scoped);
  const [until, setUntil] = useState(clientRow && clientRow.exemptUntil ? String(clientRow.exemptUntil).slice(0, 10) : "");
  const [billBusy, setBillBusy] = useState(false);

  // Early access (migration 109): features comped to THIS builder before they go on sale.
  const grantable = (features || []).filter((f) => f.operatorGrantable);
  const rowGrants = Array.isArray(clientRow && clientRow.grants) ? clientRow.grants : [];
  // Only LIVE grants pre-check their boxes -- an expired one is off in portal-billing and
  // must read as off here too (audit 2026-08-19).
  const rowGrantLive = (g) => !g.expiresAt || Date.parse(g.expiresAt) > Date.now();
  const [grantPick, setGrantPick] = useState(rowGrants.filter(rowGrantLive).map((g) => g.feature));
  // Read back through LOCAL date parts, the exact inverse of saveGrants' endOfDay below.
  // expires_at is a timestamptz and comes back as UTC, so slicing the first 10 characters
  // showed the day AFTER the one that was typed everywhere west of Greenwich (Sep 30 stored
  // as 2026-10-01T03:59Z redisplayed as "2026-10-01") — and because `dateEdited` compares
  // against this value, the next feature ticked on top of it was then written with a day of
  // free access nobody granted. Same date-only rule the schedule tab settled on: never slice
  // an instant, build the day from local components (audit 2026-08-28).
  const initialUntil = (() => {
    const withDate = rowGrants.filter(rowGrantLive).find((g) => g.expiresAt);
    return withDate ? ssLocalIso(new Date(withDate.expiresAt)) : "";
  })();
  const [grantUntil, setGrantUntil] = useState(initialUntil);
  const [grantBusy, setGrantBusy] = useState(false);

  const [delOpen, setDelOpen] = useState(false);

  const emailRe = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  const emailOk = emailRe.test(email.trim());

  // `addrOverride` exists for the reassign banner: `email` below is THIS render's closure,
  // so a setEmail(...) in the same click handler is invisible to link() — the request would
  // carry whatever the input held when this render happened. If the operator edited the
  // field after the banner appeared, "Move them" reassigned the WRONG address (or, with the
  // field now invalid, silently no-op'd on the emailOk guard). The banner passes the address
  // it displays, so what the operator read is what gets moved.
  const link = async (reassign, addrOverride) => {
    const addr = (addrOverride != null ? addrOverride : email).trim();
    if (!emailRe.test(addr) || linkBusy) return;
    setLinkBusy(true); setLinkResult(null);
    try {
      const r = await adminApi("link_owner", { clientId, email: addr, role, ...(reassign ? { reassign: true } : {}) });
      const roleLabel = (r && r.role === "user") ? "team member (Designs & Leads only)" : "admin";
      setLinkResult({ email: addr, roleLabel, created: !!(r && r.created), emailSent: !!(r && r.emailSent), setupLink: (r && r.setupLink) || null, movedFrom: reassign && reassignFrom ? reassignFrom.fromClient : null });
      setEmail(""); setReassignFrom(null);
      onFlash({ ok: `“${addr}” ${reassign ? "reassigned to" : "linked to"} ${label} as ${roleLabel}.` });
    } catch (e) {
      const m = e.message || String(e);
      if (/reassign\s*:\s*true/i.test(m)) {
        // Tolerates BOTH wordings: the server said "client" before the 2026-08-02
        // builder rename, and an operator's browser can be running a cached page
        // against a newer function (or vice versa) — a strict match would silently
        // stop naming the tenant in the reassign prompt.
        const hit = /already linked to (?:client|builder) "([^"]+)"/.exec(m);
        setReassignFrom({ email: addr, fromClient: hit ? hit[1] : null });
      } else setReassignFrom(null);
      onFlash({ err: m });
    }
    setLinkBusy(false);
  };

  const copy = async (text) => {
    // admin.html fired this unawaited and flashed success unconditionally — it reported
    // "copied" even when the write rejected. Await it, and the link stays on screen either way.
    try { await navigator.clipboard.writeText(text); setCopied(true); }
    catch (_e) { setCopied(false); }
    setTimeout(() => setCopied(null), 4000);
  };

  const saveBilling = async () => {
    const n = Math.round(Number(pct));
    if (!Number.isFinite(n) || n < 0 || n > 100) { onFlash({ err: "Discount must be a whole number from 0 to 100." }); return; }
    if (n > 0 && !exempt && !allFeat && picked.length === 0) { onFlash({ err: "Choose which features the discount applies to, or select “Every feature”." }); return; }
    setBillBusy(true);
    try {
      const r = await adminApi("set_billing", { clientId, billingExempt: exempt, discountPercent: n, discountFeatures: allFeat ? [] : picked, exemptUntil: until });
      await onReloadClients();
      onFlash({ ok: `Billing saved for ${label}. ${(r && r.note) || ""}`.trim() });
    } catch (e) { onFlash({ err: e.message }); }
    setBillBusy(false);
  };

  const saveGrants = async () => {
    setGrantBusy(true);
    try {
      // A DATE input holds a local calendar day; storing it raw made the grant die at UTC
      // midnight -- the prior EVENING in US timezones. End-of-local-day is what an operator
      // means by "until Aug 30" (audit 2026-08-19).
      const endOfDay = (d) => {
        const [y, m, day] = String(d).split("-").map(Number);
        return new Date(y, m - 1, day, 23, 59, 59, 999).toISOString();
      };
      // The single date field applies to every picked grant ONLY when the operator touched
      // it this visit; untouched, each grant keeps its own stored expiry. One shared input
      // silently rewriting every feature's end date is how a carefully staged preview
      // schedule gets flattened (audit 2026-08-19).
      const dateEdited = grantUntil !== initialUntil;
      const grants = grantPick.map((feature) => {
        const prior = rowGrants.find((g) => g.feature === feature && rowGrantLive(g));
        const expiresAt = dateEdited
          ? (grantUntil ? endOfDay(grantUntil) : null)
          : (prior ? (prior.expiresAt || null) : (grantUntil ? endOfDay(grantUntil) : null));
        return { feature, expiresAt };
      });
      const r = await adminApi("set_feature_grants", { clientId, grants });
      await onReloadClients();
      onFlash({ ok: `Early access saved for ${label}. ${(r && r.note) || ""}`.trim() });
    } catch (e) { onFlash({ err: e.message }); }
    setGrantBusy(false);
  };

  return (
    <>
      <div style={S.card}>
        <CardHead title="Owner logins" desc="Grant someone access to this builder's portal. A new email gets a one-time set-up link; an email already attached to another builder has to be moved deliberately." />
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div style={{ flex: "1 1 240px", minWidth: 200 }}>
            <label style={S.lbl}>Email</label>
            {/* Editing the address retires the reassign banner below: it names ONE specific
                email, and a lingering banner would offer to move somebody the operator is no
                longer typing about. (Programmatic setEmail — the banner's own button, the
                post-link clear — does not fire onChange, so those keep the banner alive.) */}
            <input value={email} onChange={(e) => { setEmail(e.target.value); setReassignFrom(null); }} placeholder="owner@theirbusiness.com"
              onKeyDown={(e) => { if (e.key === "Enter" && emailOk) link(false); }} style={S.input} />
          </div>
          <div style={{ width: 200 }}>
            <label style={S.lbl}>Role</label>
            <select value={role} onChange={(e) => setRole(e.target.value)} style={S.input}>
              <option value="owner">Admin — full access</option>
              <option value="user">Team member — Designs &amp; Leads only</option>
            </select>
          </div>
          <button type="button" onClick={() => link(false)} disabled={!emailOk || linkBusy}
            title={!emailOk ? "Enter a valid email address" : undefined}
            style={{ ...S.btn(ACCENT, "#FFF"), opacity: (!emailOk || linkBusy) ? 0.6 : 1, cursor: emailOk && !linkBusy ? "pointer" : "not-allowed" }}>
            {linkBusy ? "Linking…" : "Link login"}
          </button>
        </div>
        {reassignFrom && (
          <div style={{ background: "#FEF3C7", border: "1px solid #F59E0B", borderRadius: 8, padding: "10px 14px", color: "#92400E", fontSize: 12.5, marginTop: 12, lineHeight: 1.5 }}>
            <strong>{reassignFrom.email}</strong> already belongs to <strong>{reassignFrom.fromClient || "another builder"}</strong>.
            Moving them removes their access to that account.
            <div style={{ marginTop: 8 }}>
              {/* The address goes as an argument — see link(): setEmail alone would not reach
                  this call, which reads the pre-click render's `email`. */}
              <button type="button" onClick={() => { setEmail(reassignFrom.email); link(true, reassignFrom.email); }} disabled={linkBusy}
                style={{ ...S.btn("#92400E", "#FFF"), padding: "6px 12px", fontSize: 12 }}>Move them to {label}</button>
            </div>
          </div>
        )}
        {linkResult && (
          <div style={{ ...S.okMsg, marginTop: 12, marginBottom: 0 }}>
            <div>{linkResult.email} — {linkResult.roleLabel}{linkResult.created ? " · login created" : ""}{linkResult.emailSent ? " · invite emailed" : ""}</div>
            {linkResult.setupLink && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                <input readOnly value={linkResult.setupLink} onFocus={(e) => e.target.select()}
                  style={{ ...S.input, fontFamily: "ui-monospace, monospace", fontSize: 11, fontWeight: 400 }} />
                <button type="button" onClick={() => copy(linkResult.setupLink)} style={{ ...S.btn("#F1F5F9", "#334155"), padding: "7px 12px", fontSize: 12, flexShrink: 0 }}>
                  {copied === true ? "Copied" : copied === false ? "Copy failed" : "Copy"}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <div style={S.card}>
        <CardHead title="Billing posture" desc="An attribute of the account, not of a purchase — it follows them onto every feature they add later." />
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#1E293B", cursor: "pointer" }}>
          <input type="checkbox" checked={exempt} onChange={(e) => setExempt(e.target.checked)} />
          <span>Non-billable — skips the billing gate entirely</span>
        </label>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 12 }}>
          <div style={{ width: 180, opacity: exempt ? 0.5 : 1, pointerEvents: exempt ? "none" : "auto" }}>
            <label style={S.lbl}>Account discount %</label>
            <input value={pct} onChange={(e) => setPct(e.target.value)} inputMode="numeric" style={S.input} />
          </div>
          <div style={{ width: 200 }}>
            <label style={S.lbl}>Free until (optional)</label>
            <input type="date" value={until} onChange={(e) => setUntil(e.target.value)} style={S.input} />
          </div>
        </div>
        {!exempt && Number(pct) > 0 && (
          <FeatureScope features={features} all={allFeat} setAll={setAllFeat} picked={picked} setPicked={setPicked} />
        )}
        <div style={{ marginTop: 16 }}>
          <button type="button" onClick={saveBilling} disabled={billBusy}
            style={{ ...S.btn(ACCENT, "#FFF"), opacity: billBusy ? 0.6 : 1 }}>{billBusy ? "Saving…" : "Save billing"}</button>
        </div>
      </div>

      {/* EARLY ACCESS — Carolyn 2026-08-18: "I would like to be able to see the 3D as I'm
          in beta, but not all clients need to see it." Only features whose billing_plans rows
          carry operator_grantable appear here, so paid-only features can never be listed. */}
      {grantable.length > 0 && (
        <div style={S.card}>
          <CardHead title="Early access"
            desc="Switch a feature on for this builder before it goes on sale. This is a comp, not a purchase: it does not create a subscription and does not charge anything. Unchecking a box revokes it." />
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px", paddingLeft: 2 }}>
            {grantable.map((f) => (
              <label key={f.feature} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "#334155", cursor: "pointer" }}>
                <input type="checkbox" checked={grantPick.indexOf(f.feature) !== -1}
                  onChange={(e) => setGrantPick(e.target.checked ? grantPick.concat([f.feature]) : grantPick.filter((x) => x !== f.feature))} />
                <span>{f.name}{f.availability === "coming_soon" ? " — not on sale yet" : ""}</span>
              </label>
            ))}
          </div>
          <div style={{ marginTop: 12, maxWidth: 260 }}>
            <label style={S.lbl}>Until (optional)</label>
            <input type="date" value={grantUntil} onChange={(e) => setGrantUntil(e.target.value)}
              style={{ ...S.input, width: "100%" }} />
            <div style={{ fontSize: 11.5, color: "#64748B", marginTop: 4 }}>
              Leave empty to keep it on until you revoke it. A date makes the preview end by
              itself, so &ldquo;just for a look&rdquo; does not quietly become free forever.
            </div>
          </div>
          <div style={{ marginTop: 16 }}>
            <button type="button" onClick={saveGrants} disabled={grantBusy}
              style={{ ...S.btn(ACCENT, "#FFF"), opacity: grantBusy ? 0.6 : 1 }}>{grantBusy ? "Saving…" : "Save early access"}</button>
          </div>
        </div>
      )}

      {/* The only tinted card in the shell, which is what makes the tint mean something.
          Last card on the tab, below a scroll — unreachable by accident, and impossible to
          hit while aiming for "Billing", which is exactly what the old button row made easy. */}
      <div style={{ ...S.card, background: "#FEE2E2", border: "1px solid #DC2626" }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: "#991B1B", letterSpacing: 0.3, marginBottom: 6 }}>Danger zone</div>
        <div style={{ fontSize: 12.5, color: "#991B1B", lineHeight: 1.55, marginBottom: 14 }}>
          Deleting {label} erases their catalog, designs, settings, logins and stored images. It cannot be
          undone, and it still asks for the operator password even though you're signed in.
        </div>
        <button type="button" onClick={() => setDelOpen(true)} style={S.btn("#FEF2F2", "#DC2626")}>Delete this builder…</button>
      </div>

      {delOpen && (
        <AdmDeleteDialog client={clientRow || { client_id: clientId }} onClose={() => setDelOpen(false)}
          onDeleted={async (id, r) => {
            setDelOpen(false);
            const parts = (r && r.deleted) ? Object.entries(r.deleted).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(", ") : "";
            await onReloadClients();
            onFlash({ ok: `Deleted “${id}”${parts ? ` (${parts})` : ""}.` });
            onDeleted();
          }} />
      )}
    </>
  );
}

function AdmStyles({ clientId, label, cat, setCat, onFlash, act }) {
  const [name, setName] = useState("");
  const [img, setImg] = useState(null);
  const [fileKey, setFileKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [styleBusy, setStyleBusy] = useState({});   // per-row, not page-wide
  const styles = (cat && cat.buildingStyles) || [];
  const sizes = (cat && cat.buildingSizes) || [];
  const ALLOWED = ["image/jpeg", "image/png", "image/webp", "image/gif"];

  const pickImg = (file) => {
    if (!file) { setImg(null); return; }
    if (ALLOWED.indexOf(file.type) === -1) { onFlash({ err: "Use a JPG, PNG, WEBP or GIF image." }); setFileKey((k) => k + 1); return; }
    if (file.size > 3000000) { onFlash({ err: "Image too large — 3 MB maximum." }); setFileKey((k) => k + 1); return; }
    const r = new FileReader();
    r.onerror = () => onFlash({ err: "Could not read that image." });
    r.onload = () => setImg({ base64: r.result, contentType: file.type || "image/jpeg" });
    r.readAsDataURL(file);
  };

  const toggle = async (row) => {
    setStyleBusy((b) => ({ ...b, [row.key]: true }));
    // Optimistic: one idempotent boolean, and the authoritative refresh follows anyway.
    setCat((c) => ({ ...c, buildingStyles: (c.buildingStyles || []).map((s) => s.key === row.key ? { ...s, active: !s.active } : s) }));
    const ok = await act("save_style", { clientId, styleKey: row.key, active: !row.active },
      `${row.label || row.key} is now ${row.active ? "hidden" : "active"}.`);
    if (!ok) setCat((c) => ({ ...c, buildingStyles: (c.buildingStyles || []).map((s) => s.key === row.key ? { ...s, active: row.active } : s) }));
    setStyleBusy((b) => { const n = { ...b }; delete n[row.key]; return n; });
  };

  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      let imageUrl = null;
      if (img) {
        const up = await adminApi("upload_image", { clientId, base64: img.base64, contentType: img.contentType });
        imageUrl = (up && up.url) || null;
      }
      await adminApi("create_style", { clientId, label: name.trim(), ...(imageUrl ? { imageUrl } : {}) });
      setName(""); setImg(null); setFileKey((k) => k + 1);
      onFlash({ ok: `Added “${name.trim()}”.` });
      setCat(await adminApi("get_client_catalog", { clientId }));
    } catch (e) { onFlash({ err: e.message }); }
    setBusy(false);
  };

  return (
    <>
      <div style={S.card}>
        <CardHead title="Building styles" count={cat ? styles.length : null}
          desc={`What ${label} offers on their design page. Hiding a style stops offering it without touching its sizes or prices.`} />
        {/* No pager here, on purpose: a tenant's style list is a handful of rows (Carolyn's
            tenants run single-digit styles) and the next card down is the add-a-style form,
            so "1–6 of 6 styles" would be furniture rather than help. No second paint either —
            get_client_catalog is one round trip and every row on this tab, including the
            per-style size join below, is derived from it. Skeleton only. */}
        {!cat && [0, 1, 2, 3, 4].map((i) => (
          <div key={i} style={{ ...ADM_ROW, alignItems: "flex-start", opacity: 1 - i * 0.13 }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <SkelBar w="45%" h={12} />
              <SkelBar w="30%" h={9} style={{ marginTop: 6 }} />
            </div>
            <SkelBar w={58} h={20} style={{ borderRadius: 6, flexShrink: 0 }} />
            <SkelBar w={62} h={28} style={{ borderRadius: 8, flexShrink: 0 }} />
          </div>
        ))}
        {cat && styles.length === 0 && <div style={{ fontSize: 13, color: "#94A3B8" }}>No styles yet — add one below.</div>}
        {styles.map((row) => {
          // Sizes join on the style's UUID `id`, NOT its `key`. Getting this wrong is silent:
          // every style renders "0 sizes" while the tenant actually has dozens.
          const mine = sizes.filter((s) => s.style_id === row.id);
          return (
            <div key={row.key} style={{ ...ADM_ROW, alignItems: "flex-start", flexWrap: "wrap" }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: "#1E293B" }}>{row.label || row.key}</div>
                <div style={{ fontSize: 11.5, color: "#94A3B8" }}>
                  {row.key} · {mine.length} size{mine.length === 1 ? "" : "s"}
                  {mine.length > 0 && <> · {mine.slice(0, 6).map((s) => `${s.width_ft}×${s.length_ft}`).join(", ")}{mine.length > 6 ? "…" : ""}</>}
                </div>
              </div>
              <AdmChip tone={row.active ? "good" : "neutral"}>{row.active ? "Active" : "Hidden"}</AdmChip>
              <button type="button" onClick={() => toggle(row)} disabled={!!styleBusy[row.key]} aria-pressed={!!row.active}
                style={{ ...S.btn("#F1F5F9", "#334155"), padding: "6px 12px", fontSize: 12, opacity: styleBusy[row.key] ? 0.6 : 1 }}>
                {styleBusy[row.key] ? "Saving…" : row.active ? "Hide" : "Show"}
              </button>
            </div>
          );
        })}
      </div>

      <div style={S.card}>
        <CardHead title="Add a style" desc="The photo shows on their design page. Sizes and prices come from the Pricing tab once the style exists." />
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div style={{ flex: "1 1 220px", minWidth: 180 }}>
            <label style={S.lbl}>Style name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Lofted Barn"
              onKeyDown={(e) => { if (e.key === "Enter") create(); }} style={S.input} />
          </div>
          <div style={{ flex: "1 1 220px", minWidth: 180 }}>
            <label style={S.lbl}>Photo (optional, max 3 MB)</label>
            <input key={fileKey} type="file" accept="image/*" onChange={(e) => pickImg(e.target.files && e.target.files[0])}
              style={{ ...S.input, padding: 6, fontWeight: 400 }} />
          </div>
          <button type="button" onClick={create} disabled={!name.trim() || busy}
            style={{ ...S.btn(ACCENT, "#FFF"), opacity: (!name.trim() || busy) ? 0.6 : 1 }}>{busy ? "Adding…" : "Add style"}</button>
        </div>
        {img && <div style={{ fontSize: 11.5, color: "#15803D", marginTop: 8 }}>Image ready — it uploads when you add the style.</div>}
      </div>
    </>
  );
}

function AdmItems({ clientId, label, cat, setCat, master, masterErr, onFlash }) {
  const assigned = useMemo(() => new Set(((cat && cat.clientLayoutItems) || []).filter((i) => i.active).map((i) => i.item_key)), [cat]);
  const [staged, setStaged] = useState(null);      // null until cat lands
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (cat) setStaged(new Set(assigned)); }, [cat, assigned]);

  const all = (master && master.layoutItemTypes) || [];
  const term = q.trim().toLowerCase();
  const list = all.filter((i) => !term
    || String(i.label || "").toLowerCase().indexOf(term) !== -1
    || String(i.item_key || "").toLowerCase().indexOf(term) !== -1);

  const sel = staged || new Set();
  const toEnable = all.filter((i) => sel.has(i.item_key) && !assigned.has(i.item_key));
  const toDisable = all.filter((i) => !sel.has(i.item_key) && assigned.has(i.item_key));
  const pending = toEnable.length + toDisable.length;

  const save = async () => {
    if (!pending || busy) return;
    setBusy(true);
    try {
      for (const i of toEnable) await adminApi("toggle_item", { clientId, itemKey: i.item_key, active: true });
      for (const i of toDisable) await adminApi("toggle_item", { clientId, itemKey: i.item_key, active: false });
    } catch (e) {
      // N sequential writes with no transaction: say so rather than implying all-or-nothing.
      onFlash({ err: `${e.message} — some changes may already have been applied; the list below has been refreshed.` });
      try { setCat(await adminApi("get_client_catalog", { clientId })); } catch (_e) {}
      setBusy(false); return;
    }
    onFlash({ ok: `Saved ${pending} change${pending === 1 ? "" : "s"}.` });
    try { setCat(await adminApi("get_client_catalog", { clientId })); } catch (_e) {}
    setBusy(false);
  };

  return (
    <div style={S.card}>
      <CardHead title="Layout items" count={cat && master ? `${sel.size} of ${all.length}` : null}
        desc={`Which items ${label}'s customers can place on a building. Ticking is staged — nothing is written until you save.`}
        right={<>
          {/* Gated on master too, not just cat — the same window the boot split opens for
              AdmPricing. `all` is the MASTER palette, so with master still in flight
              "Select all" would stage the empty set (the exact opposite of its label) and,
              because the seeding effect only re-runs on cat, it would stay empty once the
              palette landed — an unintended mass-disable sitting in the pending banner. */}
          <button type="button" onClick={() => setStaged(new Set(all.map((i) => i.item_key)))} disabled={!cat || !master || busy} style={{ ...S.btn("#F1F5F9", "#334155"), padding: "6px 12px", fontSize: 12 }}>Select all</button>
          <button type="button" onClick={() => setStaged(new Set())} disabled={!cat || !master || busy} style={{ ...S.btn("#F1F5F9", "#334155"), padding: "6px 12px", fontSize: 12 }}>Clear</button>
        </>} />
      {/* Deliberately NOT paginated. The ticks below are STAGED and unsaved — the pending
          banner counts them and the AdminClientPanes remount key exists to protect exactly
          that state — so a page boundary would hide unsaved changes from the banner that is
          counting them. Paging a staged multi-select is a correctness problem in a layout
          costume. The filter box above is the right way to narrow this list.
          After the AdminShell split, cat and master arrive on independent timelines, so this
          skeleton can now be waiting on either one. */}
      {masterErr && <div style={{ fontSize: 13, color: "#B91C1C" }}>{masterErr}</div>}
      {(!cat || !master) && !masterErr && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {[112, 88, 140, 104, 96, 128, 84, 136, 108, 92, 124, 100].map((w, i) => (
            <SkelBar key={i} w={w} h={31} style={{ borderRadius: 9, opacity: 1 - i * 0.05 }} />
          ))}
        </div>
      )}
      {cat && master && (
        <>
          {pending > 0 && (
            <div style={{ background: "#FEF3C7", border: "1px solid #F59E0B", borderRadius: 8, padding: "10px 14px", color: "#92400E", fontSize: 12.5, fontWeight: 600, marginBottom: 12, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span>{pending} unsaved change{pending === 1 ? "" : "s"} for {label}{toEnable.length ? ` · +${toEnable.length}` : ""}{toDisable.length ? ` · −${toDisable.length}` : ""}</span>
              <button type="button" onClick={() => setStaged(new Set(assigned))} disabled={busy}
                style={{ ...S.btn("#FEF3C7", "#92400E"), border: "1px solid #F59E0B", padding: "4px 10px", fontSize: 11.5, marginLeft: "auto" }}>Discard</button>
            </div>
          )}
          {all.length > 12 && <SearchInput value={q} onChange={setQ} placeholder="Filter items…" />}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {list.map((i) => {
              const on = sel.has(i.item_key);
              const changed = on !== assigned.has(i.item_key);
              return (
                <button key={i.item_key} type="button" aria-pressed={on} title={i.item_key}
                  onClick={() => setStaged((prev) => { const n = new Set(prev); n.has(i.item_key) ? n.delete(i.item_key) : n.add(i.item_key); return n; })}
                  style={{
                    display: "flex", alignItems: "center", gap: 7, cursor: "pointer", fontFamily: "inherit",
                    borderRadius: 9, padding: "7px 11px", fontSize: 12.5, fontWeight: 700,
                    background: on ? "#DBEAFF" : "#FFF",
                    color: on ? "#3D3672" : "#64748B",
                    border: changed ? "1px solid #F59E0B" : on ? "1px solid #C3D9F7" : "1px solid #E2E8F0",
                    boxShadow: changed ? "0 0 0 2px #FEF3C7" : "none",
                  }}>
                  <span style={{ display: "flex" }}>{layoutItemGlyph(i)}</span>
                  {i.label || i.item_key}
                </button>
              );
            })}
          </div>
          {list.length === 0 && <div style={{ fontSize: 13, color: "#94A3B8" }}>{term ? `No items match “${q}”.` : "The master catalog is empty."}</div>}
          <div style={{ marginTop: 16 }}>
            <button type="button" onClick={save} disabled={!pending || busy}
              title={!pending ? "No changes to save" : undefined}
              style={{ ...S.btn(ACCENT, "#FFF"), opacity: (!pending || busy) ? 0.6 : 1, cursor: pending && !busy ? "pointer" : "not-allowed" }}>
              {busy ? "Saving…" : pending ? `Save ${pending} change${pending === 1 ? "" : "s"}` : "Save"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function AdmPricing({ clientId, label, cat, setCat, master, masterErr, onFlash }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [fileKey, setFileKey] = useState(0);
  const [warn, setWarn] = useState(null);   // { unmatched[], rows, headers }

  const items = useMemo(() => {
    const active = ((cat && cat.clientLayoutItems) || []).filter((i) => i.active);
    const byKey = {};
    ((master && master.layoutItemTypes) || []).forEach((m) => { byKey[m.item_key] = m.label || m.item_key; });
    return active.map((i) => ({ key: i.item_key, label: byKey[i.item_key] || i.item_key }));
  }, [cat, master]);

  // Both controls below need `master`, not just `cat`. The item COLUMNS in the template come
  // from the master palette (the memo above joins clientLayoutItems against it), so with
  // master still in flight the download is a CSV with ZERO item columns — which an operator
  // reads as "this builder has no items". Until the AdminShell boot split, master had always
  // landed before any pane could mount, so `!cat` alone was accidentally sufficient; it is
  // not any more. Re-importing such a file would not zero anyone's inclusions
  // (import_pricing_csv only touches keys present in the row), but the file is still a false
  // picture, and the rule is that a first paint never shows something read the wrong way.
  const ready = !!cat && !!master;

  const download = () => {
    const headers = ["style", "width", "length", "price"].concat(items.map((i) => i.label)).concat(["active"]);
    const styles = (cat && cat.buildingStyles) || [];
    const sizes = (cat && cat.buildingSizes) || [];
    const inc = (cat && cat.inclusions) || [];
    const rows = sizes.map((s) => {
      // Join on the style's UUID `id` — buildingSizes carries `style_id`, never `style_key`.
      const st = styles.find((x) => x.id === s.style_id);
      const base = [st ? (st.label || st.key) : "", s.width_ft, s.length_ft, s.base_price];
      const counts = items.map((i) => {
        const hit = inc.find((n) => n.size_id === s.id && n.item_key === i.key);
        return hit ? hit.qty : 0;
      });
      return base.concat(counts).concat([s.active === false ? "no" : "yes"]);
    });
    downloadFile(`${clientId}-pricing.csv`, toCSV(headers, rows));
  };

  const doImport = async (rows) => {
    setBusy(true); setWarn(null);
    try {
      const res = await adminApi("import_pricing_csv", { clientId, rows });
      setResult(res);
      setCat(await adminApi("get_client_catalog", { clientId }));
      onFlash({ ok: `Imported ${res.imported || 0} size(s)${res.skipped && res.skipped.length ? `; ${res.skipped.length} row(s) skipped — listed below.` : "."}` });
    } catch (e) { onFlash({ err: e.message }); }
    setBusy(false);
    setFileKey((k) => k + 1);
  };

  const onFile = async (file) => {
    if (!file) return;
    setResult(null);
    let text = "";
    try { text = await file.text(); } catch (_e) { onFlash({ err: "Could not read that file." }); return; }
    const grid = parseCSV(text);
    if (grid.length < 2) { onFlash({ err: "That file has no data rows." }); setFileKey((k) => k + 1); return; }
    const headers = grid[0].map((h) => String(h || "").trim());
    const RESERVED = ["style", "width", "length", "price", "active"];
    const labelToKey = {};
    items.forEach((i) => { labelToKey[i.label.toLowerCase()] = i.key; labelToKey[i.key.toLowerCase()] = i.key; });
    const unmatched = headers.filter((h) => h && RESERVED.indexOf(h.toLowerCase()) === -1 && !labelToKey[h.toLowerCase()]);
    const rows = grid.slice(1).map((r) => {
      const o = { inclusions: {} };
      headers.forEach((h, i) => {
        const v = r[i];
        const lower = String(h || "").toLowerCase();
        if (lower === "style") o.style = v;
        else if (lower === "width") o.width = v;
        else if (lower === "length") o.length = v;
        else if (lower === "price") o.price = v;
        else if (lower === "active") o.active = v;
        else { const k = labelToKey[lower]; if (k) o.inclusions[k] = v; }
      });
      return o;
    });
    // A template exported for a different client imports its prices happily and drops every
    // inclusion column without a word — the old console gave no signal at all, because
    // unmatched columns never reach the server's `skipped` list.
    const styleNames = new Set(((cat && cat.buildingStyles) || []).map((s) => String(s.label || s.key).toLowerCase()));
    const anyStyleMatch = rows.some((r) => styleNames.has(String(r.style || "").toLowerCase()));
    if (!anyStyleMatch) {
      onFlash({ err: `None of the styles in that file match ${label}'s styles — it looks like it was exported for a different builder. Nothing was imported.` });
      setFileKey((k) => k + 1);
      return;
    }
    if (unmatched.length) { setWarn({ unmatched, rows }); return; }
    doImport(rows);
  };

  return (
    <>
      <div style={S.card}>
        <CardHead title="Sizes &amp; prices" desc={`Download ${label}'s current sizes as a spreadsheet, edit it, and upload it back. Columns are one per active layout item, so the file matches whatever the Items tab has switched on.`} />
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <button type="button" onClick={download} disabled={!ready}
            title={!ready ? "Still loading this builder's catalog and the master item palette — the template's item columns come from both, so it can't be built yet." : undefined}
            style={S.btn("#F1F5F9", "#334155")}>Download template</button>
          <div style={{ flex: "1 1 240px", minWidth: 200 }}>
            <label style={S.lbl}>Upload a filled-in file</label>
            <input key={fileKey} type="file" accept=".csv,text/csv" disabled={busy || !ready}
              onChange={(e) => onFile(e.target.files && e.target.files[0])}
              style={{ ...S.input, padding: 6, fontWeight: 400 }} />
          </div>
        </div>
        {/* Two silently dead controls and nothing on screen saying why was the old state of
            this tab. A grey line is not much, but it is honest about what is happening. */}
        {!ready && !masterErr && <SkelBar w="34%" h={10} style={{ marginTop: 12 }} />}
        {masterErr && <div style={{ fontSize: 12.5, color: "#B91C1C", marginTop: 12 }}>{masterErr}</div>}
        {busy && <div style={{ fontSize: 12.5, color: "#64748B", marginTop: 10 }}>Importing…</div>}
        {warn && (
          <div style={{ background: "#FEF3C7", border: "1px solid #F59E0B", borderRadius: 8, padding: "12px 14px", color: "#92400E", fontSize: 12.5, marginTop: 12, lineHeight: 1.55 }}>
            <strong>{warn.unmatched.length} column{warn.unmatched.length === 1 ? "" : "s"}</strong> in this file don't match any item switched on for {label}, and will be ignored:
            <div style={{ marginTop: 6, fontWeight: 700 }}>{warn.unmatched.join(", ")}</div>
            <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
              <button type="button" onClick={() => doImport(warn.rows)} style={{ ...S.btn("#92400E", "#FFF"), padding: "6px 12px", fontSize: 12 }}>Import anyway</button>
              <button type="button" onClick={() => { setWarn(null); setFileKey((k) => k + 1); }} style={{ ...S.btn("#FEF3C7", "#92400E"), border: "1px solid #F59E0B", padding: "6px 12px", fontSize: 12 }}>Cancel</button>
            </div>
          </div>
        )}
        {result && (
          <div style={{ marginTop: 12 }}>
            <div style={S.okMsg}>Imported {result.imported || 0} size(s){result.created ? ` · ${result.created} created` : ""}{result.updated ? ` · ${result.updated} updated` : ""}.</div>
            {result.skipped && result.skipped.length > 0 && (
              <div style={{ fontSize: 12, color: "#92400E", background: "#FEF3C7", border: "1px solid #FCD34D", borderRadius: 8, padding: "10px 14px" }}>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>{result.skipped.length} row(s) skipped</div>
                {result.skipped.slice(0, 12).map((s, i) => <div key={i}>{typeof s === "string" ? s : JSON.stringify(s)}</div>)}
                {result.skipped.length > 12 && <div>…and {result.skipped.length - 12} more.</div>}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

