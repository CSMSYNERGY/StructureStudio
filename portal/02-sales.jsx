// ── "⋯" — THE ROW ACTIONS THAT DON'T FIT ────────────────────────────────────────────────
// Ahsan, 2026-08-28: "the pipeline view is floating off the screen from the right side. So
// under actions just add two options, Open and PDF … I'll add three dot options, so when I
// click the three dots, other options pop up in the more options."
//
// The Actions cell rendered up to seven inline buttons (Open · PDF · Quote PDF · Copy link ·
// Resend email · Send invoice · Delete), every one `white-space: nowrap`. That column set the
// table's minimum width, so the whole pipeline ran off the right edge of the screen and the
// Status chips fell into the horizontal scrollbar — the table was widest exactly where the
// information matters least.
//
// POSITION: FIXED, MEASURED AT OPEN — NOT ABSOLUTE. The table lives inside `overflow-x:
// auto`, which is a clipping context: an absolutely-positioned menu is cut off at the cell
// edge, and on the last row it would be clipped below the table too. So the menu is measured
// off the trigger's client rect and painted in viewport coordinates, flipping ABOVE the
// button when there is no room beneath it and pulling left when it would cross the right
// edge. Scrolling or resizing CLOSES it rather than chasing the anchor — the same thing every
// native menu does, and one fewer thing to keep in sync.
//
// `items` is a plain array of { key, label, onClick, title?, danger?, disabled?, keepOpen? },
// and FALSY ENTRIES ARE ALLOWED so callers can write `cond && {...}` inline. With nothing to
// show, the trigger itself does not render — a "⋯" that opens an empty box is worse than no
// "⋯" at all.
function RowMenu({ items, label = "More actions" }) {
  const [pos, setPos] = useState(null); // { top, left, width } in viewport px | null = closed
  const btnRef = useRef(null);
  const boxRef = useRef(null);
  const open = !!pos;
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => {
      if (btnRef.current && btnRef.current.contains(e.target)) return; // the trigger toggles itself
      if (boxRef.current && boxRef.current.contains(e.target)) return;
      setPos(null);
    };
    const key = (e) => { if (e.key === "Escape") setPos(null); };
    const shut = () => setPos(null);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    // Capture phase: the scroll that matters is the TABLE's own horizontal one, and a
    // scroll event on an inner element does not bubble to window.
    window.addEventListener("scroll", shut, true);
    window.addEventListener("resize", shut);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
      window.removeEventListener("scroll", shut, true);
      window.removeEventListener("resize", shut);
    };
  }, [open]);
  const shown = (items || []).filter(Boolean);
  if (shown.length === 0) return null;
  const openMenu = () => {
    const r = btnRef.current.getBoundingClientRect();
    const W = 186, H = shown.length * 32 + 10;
    const left = Math.max(8, Math.min(r.right - W, window.innerWidth - W - 8));
    const below = r.bottom + 5;
    const top = below + H > window.innerHeight - 8 ? Math.max(8, r.top - H - 5) : below;
    setPos({ top, left, width: W });
  };
  return (
    <span style={{ display: "inline-block" }}>
      <button ref={btnRef} type="button" aria-haspopup="menu" aria-expanded={open} aria-label={label} title={label}
        onClick={() => (open ? setPos(null) : openMenu())}
        style={{
          background: open ? "#EEF2FF" : "transparent", border: "none", borderRadius: 6, padding: "1px 7px",
          cursor: "pointer", fontFamily: "inherit", fontSize: 16, lineHeight: 1.1, fontWeight: 700,
          color: open ? ACCENT : "#64748B",
        }}>⋯</button>
      {open && (
        <div ref={boxRef} role="menu"
          style={{
            position: "fixed", top: pos.top, left: pos.left, width: pos.width, zIndex: 60,
            background: "#FFF", border: "1px solid #E2E8F0", borderRadius: 8, padding: 5,
            boxShadow: "0 10px 26px rgba(15,23,42,0.16)",
          }}>
          {shown.map((it) => (
            <button key={it.key} type="button" role="menuitem" disabled={!!it.disabled} title={it.title || ""}
              onClick={() => { if (!it.keepOpen) setPos(null); it.onClick(); }}
              style={{
                display: "block", width: "100%", textAlign: "left", background: "transparent", border: "none",
                borderRadius: 6, padding: "6px 8px", fontFamily: "inherit", fontSize: 12.5, fontWeight: 700,
                color: it.disabled ? "#94A3B8" : (it.danger ? "#B91C1C" : "#334155"),
                cursor: it.disabled ? "not-allowed" : "pointer",
              }}
              onMouseEnter={(e) => { if (!it.disabled) e.currentTarget.style.background = it.danger ? "#FEF2F2" : "#F1F5F9"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
              {it.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

// NO SCHEDULING FROM THIS PAGE (Carolyn 2026-08-08). Designs briefly carried an
// "Add to build schedule" action; it moved to ORDERS the same day — "Orders is all sales",
// and it is from Orders that a sold building goes to the Build or Delivery schedule.
function DesignsTable({ clientId, refreshKey = 0, fetchDesigns = null, isAdmin = false, viewingLabel = null, onOpenDesign = null, onOpenRecord = null, crmUnlocked = true, onSeeBilling = null, urlView = null, defaultView = null, onViewChange = null }) {
  // LIST or PIPELINE. Carolyn asked for this twice on 2026-08-24: "I definitely do want to
  // have pipelines, okay, I definitely do want to have pipelines, and so designs, contacts,
  // pipelines ... this may become the pipeline view."
  //
  // It is a VIEW over rows this table already loads, not a second data path — which is
  // exactly why it is cheap and why it lives here rather than in its own tab. The same
  // search, the same facets and the same status chips narrow both renderings, so a filter a
  // builder sets in the list is still set when they flip to the board.
  // The BOARD is part of the built-in CRM ($400/mo, migration 160); the LIST is not, and
  // never becomes so — Carolyn 2026-08-29: "they only get the list view". crmUnlocked
  // defaults TRUE so that any caller that has not been taught about the prop (or an operator
  // path) behaves exactly as before rather than silently locking a tab.
  // ── WHICH VIEW, AND WHO DECIDES ───────────────────────────────────────────────────
  // Two separate asks, and they compose. Carolyn, 2026-08-28 @42:00: "I'm trying to think
  // which I want to have the default. I want them to be able to decide if they want the
  // default. I don't want it to always be list. They can decide to set their default to be
  // pipeline or list, whichever one that they want." And @41:03, on the back button: "if
  // you hit the back button, you lost everything on that screen ... I just don't want it to
  // be like, oh no, you can't click that back button."
  //
  // So: the URL wins when it names a view, the SAVED PREFERENCE fills a bare URL, and list
  // is the fallback for someone who has never set one. Flipping the toggle navigates, which
  // is what makes Back walk between the two instead of leaving the tab.
  //
  // Local state stays as the fallback for any host that does not supply a router, so this
  // component still works mounted anywhere -- the same shape OrdersView uses for openId.
  const [viewLocal, setViewLocal] = useState(null);
  const routed = !!onViewChange;
  const view = routed
    ? (urlView === "pipeline" || urlView === "list" ? urlView : (defaultView === "pipeline" ? "pipeline" : "list"))
    : (viewLocal || (defaultView === "pipeline" ? "pipeline" : "list"));
  const setView = (v) => { if (routed) onViewChange(v); else setViewLocal(v); };
  // A locked tenant can hold no view but "list". Enforced here rather than only at the
  // toggle: `view` also survives in this component across a refresh of the entitlement, and
  // a builder who was mid-board when their subscription lapsed must not keep the board.
  const shownView = crmUnlocked ? view : "list";
  // id -> serial for the Inventory chips (owner-select RLS; absent for operators in
  // view-as, where the chip simply reads "Inventory" without a number).
  const [unitSerials, setUnitSerials] = useState({});
  useEffect(() => {
    let off = false;
    sb.from("inventory_units").select("id, serial").eq("client_id", clientId)
      .then(({ data }) => { if (!off && data) setUnitSerials(Object.fromEntries(data.map((u) => [u.id, u.serial]))); },
            () => {});
    return () => { off = true; };
  }, [clientId]);
  const [rows, setRows] = useState(null); // null = loading
  const [error, setError] = useState(null);
  const [vmap, setVmap] = useState({});         // short_code -> versions (newest first)
  const [expanded, setExpanded] = useState({}); // short_code -> bool (show older versions)
  const [query, setQuery] = useState("");        // free-text search across all fields
  const [pdf, setPdf] = useState(null);          // { url, title } — the pop-up viewer

  const load = useCallback(async () => {
    setError(null);
    // Operator view-as: rows come from operator-portal (service-role, audit-logged).
    // The live status sync is SKIPPED — sync-design-status is owner-JWT-bound and
    // would refresh the operator's own tenant, not the viewed one. Cached statuses show.
    // Inventory masters (status='inventory', migration 075) are lot buildings, not
    // customer estimates — they live on the Inventory tab. Filtered here AFTER fetch so
    // BOTH paths (own-tenant query and operator view-as fetchDesigns) exclude them.
    const notInventory = (r) => r.status !== "inventory";
    if (fetchDesigns) {
      try {
        const { designs, versions } = await fetchDesigns();
        setRows((designs || []).filter(notInventory));
        const map = {};
        (versions || []).forEach((v) => { (map[v.short_code] = map[v.short_code] || []).push(v); });
        setVmap(map);
      } catch (e) { setError(e.message || String(e)); setRows([]); }
      return;
    }
    // The list and its version history are independent reads, so they go out together.
    // Version history (newest first), grouped by design; owner-scoped by RLS. It used to be
    // fetched at the very END of this function — behind the GHL sync below — so the history
    // a row expands to show did not exist until an eight-second call nothing about it needed
    // had finished.
    const [dRes, vRes] = await Promise.all([
      sb.from("designs")
        .select("short_code, created_at, updated_at, status, contact, selections, ghl_estimate_number, image_url, inventory_unit_id, ss_quote_number, ss_quote_pdf_url")
        .eq("client_id", clientId)
        .order("created_at", { ascending: false }),
      sb.from("design_versions")
        .select("short_code, version, created_at, selections, image_url, inventory_unit_id")
        .eq("client_id", clientId)
        .order("version", { ascending: false })
        .then((r) => r, () => ({ data: [] })),
    ]);
    if (dRes.error) { setError(dRes.error.message); setRows([]); return; }
    const list = (dRes.data || []).filter(notInventory);
    setRows(list); // show cached statuses immediately
    const map = {};
    (vRes.data || []).forEach((v) => { (map[v.short_code] = map[v.short_code] || []).push(v); });
    setVmap(map);
    // Refresh fulfillment status from GHL (read-only projection). Non-fatal: if the sync
    // errors or GHL isn't configured, the cached designs.status values above stay shown.
    // LAST on purpose — everything above is already on screen before this starts.
    if (list.length > 0) {
      try {
        const { data: sync } = await sb.functions.invoke("sync-design-status", { body: { shortCodes: list.map((r) => r.short_code) } });
        const statuses = sync && sync.statuses;
        if (statuses) setRows((rs) => (rs || []).map((r) => statuses[r.short_code] ? { ...r, status: statuses[r.short_code] } : r));
      } catch (_e) { /* keep cached statuses */ }
    }
  }, [fetchDesigns]);

  // refreshKey: bumped by Dashboard when the in-portal designer submits a design,
  // so the list refetches without a manual Refresh click.
  useEffect(() => { load(); }, [load, refreshKey]);

  // Status chips. Counts are taken over ALL loaded rows (not the searched subset) so the
  // numbers don't shuffle while someone types — the chips describe the dataset, the search
  // narrows within it.
  const [statusFilter, setStatusFilter] = useState("all");
  const statusCounts = (rows || []).reduce((a, r) => { const k = normStatus(r.status); a[k] = (a[k] || 0) + 1; return a; }, {});
  // Facet filters (building style / size / created date-range / versions). Option lists are
  // derived from ALL loaded rows — same rule as the chip counts above.
  const [fStyle, setFStyle] = useState("all");
  const [fSize, setFSize] = useState("all");
  const [fFrom, setFFrom] = useState("");
  const [fTo, setFTo] = useState("");
  const [fVersions, setFVersions] = useState("all");
  const styleOpts = [...new Set((rows || []).map((r) => titleCase((r.selections || {}).style)).filter(Boolean))].sort();
  const sizeOpts = [...new Set((rows || []).map((r) => String((r.selections || {}).size || "")).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const hasFacets = fStyle !== "all" || fSize !== "all" || !!fFrom || !!fTo || fVersions !== "all";
  const clearFacets = () => { setFStyle("all"); setFSize("all"); setFFrom(""); setFTo(""); setFVersions("all"); };
  // Which design the delete dialog is aimed at (null = closed), plus the outcome banner.
  const [delTarget, setDelTarget] = useState(null);
  const [delMsg, setDelMsg] = useState(null);
  // Which design's Send-invoice request is in flight (null = none). Keyed per short code
  // so one slow send can't disable every other row's button.
  const [invBusyKey, setInvBusyKey] = useState(null);
  const [invMsg, setInvMsg] = useState(null);   // { ok } | { err }

  // Sends the invoice for THIS design. Owner/admin only — the edge fn enforces it
  // server-side too, and it is idempotent: a retry after a failed email re-sends the SAME
  // invoice rather than creating a second one (migration 052).
  //
  // This lives on Designs, not Contacts, and the distinction is the whole point: a contact
  // row groups every design that person ever submitted, so the old button invoiced
  // `acceptedCodes[0]` — "their most recent accepted design" — a guess the operator could
  // neither see nor correct, and one that resolved to a code the server then rejected with
  // "Design not found." A design row IS the thing being invoiced, so the short code is
  // unambiguous and always exists.
  const sendInvoice = async (r) => {
    const code = r.short_code;
    // An SS-mode design carries its own quote number and no GHL estimate — the invoice is
    // issued by StructureStudio (migration 125), so the confirm must not promise "in your
    // CRM" for a document the CRM will never hold.
    const ssMode = !r.ghl_estimate_number && !!r.ss_quote_number;
    const est = r.ghl_estimate_number ? `EST-${r.ghl_estimate_number}` : (r.ss_quote_number || code);
    const who = (r.contact || {}).name || "this customer";
    // Acting as another tenant: name them in the confirm, because this emails a real
    // invoice to THEIR customer, from THEIR account.
    const asOperator = Boolean(viewingLabel);
    const label = asOperator ? `${viewingLabel}'s customer ${who}`.trim() : who;
    const asNote = asOperator ? `\n\nYou are doing this AS ${viewingLabel}.` : "";
    const how = ssMode
      ? "This issues the invoice from StructureStudio (its own invoice number and PDF) and emails it immediately."
      : "This creates the invoice in your CRM and sends it immediately.";
    if (!window.confirm(`Email an invoice to ${label} for ${est}?\n\n${how}${asNote}`)) return;
    setInvBusyKey(code); setInvMsg(null);
    // confirmSend is required server-side in operator mode — the confirm above is
    // client-only, and a mis-scoped script must not be able to email a stranger's customers.
    const { data, error: err } = await sb.functions.invoke("portal-settings", { body: { action: "send_invoice", shortCode: code, ...(asOperator ? { confirmSend: true } : {}) } });
    setInvBusyKey(null);
    if (err) { setInvMsg({ err: await fnError(err) }); return; }
    // SS mode completes the invoice even when the email couldn't go out (paper-first) —
    // say which half happened rather than claiming "sent" for an email that never left.
    //
    // And say where the DESIGN stands, which is not the same answer on both branches.
    // `issuedBy` is the server naming the branch it actually took, and the SS one
    // deliberately leaves the status Accepted (migration 136 — the customer's signature is
    // the only writer of 'invoiced' now). "is now Invoiced" was false there every time: the
    // load() below repaints the row as Accepted under a green banner saying otherwise, and
    // the owner then finds the build board empty, because portal-schedule create_job takes
    // only 'invoiced'/'delivered'. Same words the Orders tab uses for this state.
    const outcome = data && data.issuedBy === "structurestudio"
      ? `${est} is awaiting the customer's signature`
      : `${est} is now Invoiced`;
    setInvMsg(data && data.sent === false
      ? { err: `Invoice ${(data && data.invoiceNumber) || ""} is created and ${outcome}, but the customer was NOT emailed${data.emailReason ? ` (${data.emailReason})` : ""} — print the invoice PDF or copy the customer link.` }
      : { ok: `Invoice ${(data && data.invoiceNumber) || ""} sent — ${outcome}.` });
    load();
  };

  // SS-mode rep tools (migration 122, Carolyn 2026-08-23: rep tools live in all three
  // places — this table, the order detail, and the designer success screen).
  const [resendBusyKey, setResendBusyKey] = useState(null);
  const [copiedKey, setCopiedKey] = useState(null);
  const myQuotesLink = `${window.location.origin}/my-quotes?client=${encodeURIComponent(clientId)}`;
  const copyCustomerLink = (code) => {
    const done = () => { setCopiedKey(code); setTimeout(() => setCopiedKey((k) => (k === code ? null : k)), 2000); };
    // A rejected writeText is NOT a copy: the API exists but can still refuse (permissions
    // policy, unfocused tab), and `.then(done, done)` used to flash "Copied ✓" over a
    // clipboard that still held something else — the rep then pastes the wrong thing to a
    // customer. On rejection, fall back to the same manual prompt no-clipboard browsers get.
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(myQuotesLink).then(done, () => window.prompt("Copy the customer link:", myQuotesLink));
    else window.prompt("Copy the customer link:", myQuotesLink);
  };
  const resendQuoteEmail = async (r) => {
    setResendBusyKey(r.short_code); setInvMsg(null);
    const { data, error: err } = await sb.functions.invoke("portal-settings", { body: { action: "resend_quote_email", shortCode: r.short_code } });
    setResendBusyKey(null);
    if (err) { setInvMsg({ err: await fnError(err) }); return; }
    if (data && data.error) { setInvMsg({ err: data.error }); return; }
    setInvMsg(data && data.sent
      ? { ok: `Quote ${r.ss_quote_number || ""} emailed to the customer.` }
      : { err: `Quote email not sent${data && data.reason ? ` — ${data.reason}` : ""}. Print the PDF or copy the customer link instead.` });
  };

  // Chip filter first, then facets, then the free-text search over what survives.
  const byStatus = statusFilter === "all" ? (rows || []) : (rows || []).filter((r) => normStatus(r.status) === statusFilter);
  const byFacets = byStatus.filter((r) => {
    const sel = r.selections || {};
    if (fStyle !== "all" && titleCase(sel.style) !== fStyle) return false;
    if (fSize !== "all" && String(sel.size || "") !== fSize) return false;
    if (!inDateRange(r.created_at, fFrom, fTo)) return false;
    // "2+ versions" = the rows that show the ▾ versions chip (vmap includes the latest).
    if (fVersions === "multi" && (vmap[r.short_code] || []).length <= 1) return false;
    return true;
  });
  const filtered = byFacets.filter((r) => {
    const st = normStatus(r.status);
    const extra = [r.ghl_estimate_number ? "EST-" + r.ghl_estimate_number : "", r.ss_quote_number || "", STATUS_LABELS[st], fmtDate(r.created_at), titleCase((r.selections || {}).style)].join(" ");
    return rowMatchesQuery(r, query, extra);
  });

  // Column sort. Default = newest first (matches the created_at DESC load order).
  const [sortKey, setSortKey] = useState("date");
  const [sortDir, setSortDir] = useState("desc");
  const onSort = makeOnSort(sortKey, setSortKey, sortDir, setSortDir);
  const sortVal = (r) => {
    const c = r.contact || {}, sel = r.selections || {};
    switch (sortKey) {
      case "date":     return r.created_at;
      case "customer": return c.name;
      case "contact":  return c.email || c.phone;
      case "building": return [titleCase(sel.style), sel.size].filter(Boolean).join(" ");
      // GHL numbers sort numerically; SS quote numbers are prefixed text ("JB-1041") and
      // fall back to string comparison inside sortRows.
      case "estimate": return r.ghl_estimate_number != null ? Number(r.ghl_estimate_number) : (r.ss_quote_number || null);
      case "status":   return STATUS_RANK[normStatus(r.status)];
      default:         return r.created_at;
    }
  };
  const sorted = sortRows(filtered, sortVal, sortDir);

  // Paging applies to the LIST only. A board showing "30 of 400" cards is not a pipeline —
  // the whole point of the board is seeing where everything sits at once, and a column that
  // silently holds back its tail would be read as an empty stage.
  const [pageSize, setPageSize] = usePageSize("designs");
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [query, statusFilter, fStyle, fSize, fFrom, fTo, fVersions, shownView]);
  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const curPage = Math.min(page, pageCount);
  const paged = sorted.slice((curPage - 1) * pageSize, curPage * pageSize);

  return (
    <div style={S.card}>
      <CardHead
        title="Designs"
        count={rows ? ((query || statusFilter !== "all" || hasFacets) ? `${filtered.length} of ${rows.length}` : rows.length) : null}
        right={(
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <div style={{ display: "flex", border: "1px solid #E2E8F0", borderRadius: 8, overflow: "hidden" }}>
              {/* The Pipeline button stays VISIBLE when locked, with a padlock, and routes to
                  Billing instead of switching view. Hiding it would make the thing being sold
                  invisible to the only people who might buy it. */}
              {[["list", "List"], ["pipeline", "Pipeline"]].map(([k, label]) => {
                const locked = k === "pipeline" && !crmUnlocked;
                return (
                  <button key={k}
                    title={locked ? "The pipeline board is part of the built-in CRM" : undefined}
                    onClick={() => { if (!locked) { setView(k); } else if (onSeeBilling) { onSeeBilling(); } }}
                    style={{
                      background: shownView === k ? ACCENT : "#FFF",
                      color: shownView === k ? "#FFF" : (locked ? "#94A3B8" : "#334155"),
                      border: "none", padding: "6px 12px", fontSize: 13, fontWeight: 700,
                      cursor: locked && !onSeeBilling ? "default" : "pointer", fontFamily: "inherit",
                    }}>{locked ? `🔒 ${label}` : label}</button>
                );
              })}
            </div>
            <button onClick={load} style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0", padding: "6px 12px" }}>↻ Refresh</button>
          </div>
        )}
      />
      {rows && rows.length > 0 && (
        <div style={{ display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 320px", minWidth: 260 }}>
            <SearchInput value={query} onChange={setQuery} placeholder="Search designs — name, email, phone, building, estimate #…" />
          </div>
          <FilterBar hasFilters={hasFacets} onClear={clearFacets} shown={filtered.length} total={rows.length} noun="design">
            {styleOpts.length > 1 && <FacetSelect label="Building style" value={fStyle} onChange={setFStyle} options={styleOpts.map((s) => ({ value: s, label: s }))} allLabel="All styles" />}
            {sizeOpts.length > 1 && <FacetSelect label="Size" value={fSize} onChange={setFSize} options={sizeOpts.map((s) => ({ value: s, label: s }))} allLabel="All sizes" />}
            <DateRange label="Created" from={fFrom} to={fTo} onFrom={setFFrom} onTo={setFTo} />
            <FacetSelect label="Versions" value={fVersions} onChange={setFVersions} options={[{ value: "multi", label: "2+ versions" }]} allLabel="All" />
          </FilterBar>
        </div>
      )}
      {rows && rows.length > 0 && <StatusChips counts={statusCounts} value={statusFilter} onChange={setStatusFilter} />}
      {delMsg && <div style={delMsg.err ? S.err : S.okMsg}>{delMsg.err || delMsg.ok}</div>}
      {invMsg && <div style={invMsg.err ? S.err : S.okMsg}>{invMsg.err || invMsg.ok}</div>}
      {error && <div style={S.err}>{error}</div>}
      {/* Grey blocks in the real column shape, not the word "Loading" on an empty card —
          see SkelRows. Carolyn, 2026-08-26, on watching a list arrive: "so let's do that." */}
      {rows === null && !error && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              {["Date", "Customer", "Contact", "Building", "Estimate #", "Status", "Actions"].map((h) => <th key={h} style={S.th}>{h}</th>)}
            </tr></thead>
            <tbody><SkelRows cols={7} rows={6} /></tbody>
          </table>
        </div>
      )}
      {rows && rows.length === 0 && !error && (
        <p style={{ fontSize: 13, color: "#64748B", padding: 12 }}>No designs yet. Share your customer link above — submitted designs show up here.</p>
      )}
      {rows && rows.length > 0 && filtered.length === 0 && (
        <p style={{ fontSize: 13, color: "#64748B", padding: 12 }}>
          {query
            ? <>No designs match “{query}”{statusFilter !== "all" ? <> in <strong>{STATUS_LABELS[statusFilter]}</strong></> : null}{hasFacets ? " with the current filters" : ""}.</>
            : hasFacets
              ? <>No designs match the current filters{statusFilter !== "all" ? <> in <strong>{STATUS_LABELS[statusFilter]}</strong></> : null}. Adjust or <button onClick={clearFacets} style={{ background: "none", border: "none", color: ACCENT, cursor: "pointer", fontWeight: 700, fontSize: 13, padding: 0, fontFamily: "inherit", textDecoration: "underline" }}>clear the filters</button>.</>
              : <>No designs are <strong>{STATUS_LABELS[statusFilter]}</strong> yet.</>}
        </p>
      )}
      {/* ── PIPELINE BOARD ──────────────────────────────────────────────────────────
          Columns are the stage KINDS, and a design's column is DERIVED from the status the
          system can prove — accepted is won, invoiced is invoiced. There is no drag here on
          purpose: dragging implies the rep sets the stage, and `designs.status` is a
          read-only projection that sync-design-status overwrites on every list load, so a
          dragged card would snap back and look broken. Moving a deal by hand needs the
          local crm_stages table, which is the next increment, not this one. */}
      {rows && filtered.length > 0 && shownView === "pipeline" && (
        <div style={{ overflowX: "auto", paddingBottom: 4 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "flex-start", minWidth: "min-content" }}>
            {CRM_STAGES.map((st) => {
              const cards = sorted.filter((r) => (CRM_STAGE_FOR_STATUS[normStatus(r.status)] || "new") === st.kind);
              return (
                <div key={st.kind} style={{ flex: "1 0 190px", minWidth: 190, background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 10, padding: 8 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 7 }}>
                    <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.4, textTransform: "uppercase", color: "#475569" }}>{st.name}</span>
                    <span style={{ fontSize: 11, fontWeight: 800, color: "#94A3B8" }}>{cards.length}</span>
                  </div>
                  {cards.length === 0 && <div style={{ fontSize: 11.5, color: "#CBD5E1", padding: "6px 2px" }}>—</div>}
                  {cards.map((r) => {
                    const c = r.contact || {}; const s = r.selections || {};
                    return (
                      <button key={r.short_code} type="button"
                        onClick={() => (onOpenRecord ? onOpenRecord(r.short_code) : (onOpenDesign && onOpenDesign(r.short_code)))}
                        style={{ display: "block", width: "100%", textAlign: "left", background: "#FFF", border: "1px solid #E2E8F0", borderRadius: 8, padding: "7px 9px", marginBottom: 6, cursor: "pointer", fontFamily: "inherit" }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: "#1E293B", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {c.name || c.email || c.phone || "—"}
                        </div>
                        <div style={{ fontSize: 11.5, color: "#64748B", marginTop: 1 }}>
                          {[titleCase(s.style), s.size].filter(Boolean).join(" ") || r.short_code}
                        </div>
                        <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 3, display: "flex", justifyContent: "space-between", gap: 6 }}>
                          <span>{fmtDate(r.created_at)}</span>
                          {r.ss_quote_number || r.ghl_estimate_number ? <span>#{r.ss_quote_number || r.ghl_estimate_number}</span> : null}
                        </div>
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {rows && filtered.length > 0 && shownView === "list" && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              <SortTh label="Date" col="date" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              <SortTh label="Customer" col="customer" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              <SortTh label="Contact" col="contact" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              <SortTh label="Building" col="building" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              <SortTh label="Estimate #" col="estimate" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              <SortTh label="Status" col="status" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              <th style={S.th}>Actions</th>
            </tr></thead>
            <tbody>
              {paged.map((r) => {
                const c = r.contact || {}; const sel = r.selections || {};
                const vs = vmap[r.short_code] || [];       // newest first
                const older = vs.slice(1);                  // everything below the latest
                const isOpen = !!expanded[r.short_code];
                return (
                  <React.Fragment key={r.short_code}>
                  <tr>
                    <td style={{ ...S.td, whiteSpace: "nowrap" }}>{fmtDate(r.created_at)}</td>
                    <td style={{ ...S.td, fontWeight: 700 }}>{c.name || "—"}</td>
                    <td style={S.td}>
                      <div>{c.email || ""}</div>
                      <div style={{ color: "#64748B", fontSize: 12 }}>{c.phone || ""}</div>
                    </td>
                    <td style={{ ...S.td, whiteSpace: "nowrap" }}>
                      {[titleCase(sel.style), sel.size].filter(Boolean).join(" ") || "—"}
                      <SourceChip unitId={r.inventory_unit_id} serial={unitSerials[r.inventory_unit_id]} />
                      {older.length > 0 && (
                        <button onClick={() => setExpanded((p) => ({ ...p, [r.short_code]: !p[r.short_code] }))}
                          style={{ marginLeft: 8, background: "transparent", border: "none", padding: 0, cursor: "pointer", color: ACCENT, fontSize: 12, fontWeight: 700 }}>
                          {isOpen ? "▴ hide" : `▾ ${vs.length} versions`}
                        </button>
                      )}
                    </td>
                    {/* SS quote numbers render verbatim (prefix included); EST- is GHL's. */}
                    <td style={S.td}>{r.ghl_estimate_number ? `EST-${r.ghl_estimate_number}` : (r.ss_quote_number || "—")}</td>
                    <td style={S.td}>{(() => { const st = normStatus(r.status); const c = STATUS_COLORS[st]; return (
                      <span style={{ whiteSpace: "nowrap" }}>
                        <span style={{ background: c.bg, color: c.fg, borderRadius: 20, padding: "4px 12px", fontSize: 12, fontWeight: 700, whiteSpace: "nowrap" }}>{STATUS_LABELS[st]}</span>
                      </span>
                    ); })()}</td>
                    <td style={{ ...S.td, whiteSpace: "nowrap" }}>
                      {/* Opens IN THE PORTAL designer — never the public page, which now
                          silently captures leads and saves drafts; staff browsing a
                          customer's design there would corrupt that activity. */}
                      <button type="button" onClick={() => onOpenDesign && onOpenDesign(r.short_code)}
                        style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit", fontSize: "inherit", color: ACCENT, fontWeight: 700, marginRight: 10 }}>Open</button>
                      {/* Pop-up, not a new tab — Carolyn 2026-08-26. See PdfModal. */}
                      {ssSafeUrl(r.image_url) && (
                        <button type="button" onClick={() => setPdf({ url: r.image_url, title: `Floor plan — ${c.name || r.short_code}` })}
                          style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit", fontSize: "inherit", color: "#334155", fontWeight: 700 }}>PDF</button>
                      )}
                      {/* EVERYTHING ELSE LIVES BEHIND THE "⋯" — see RowMenu at the top of this
                          file for why (the column was pushing the table off-screen). Each entry
                          keeps the condition, the title text and the busy label it had as an
                          inline button; only the container changed. */}
                      <span style={{ marginLeft: 10, verticalAlign: "middle" }}>
                        <RowMenu label={`More actions for ${c.name || r.short_code}`} items={[
                          // SS-issued quote (migration 122): the printable 3-sheet document plus
                          // the two hand-delivery tools — most lot customers want paper, and a
                          // design with no email address never blocks.
                          r.ss_quote_number && ssSafeUrl(r.ss_quote_pdf_url) && {
                            key: "quote", label: "Quote PDF", title: "Open the printable quote document",
                            onClick: () => setPdf({ url: r.ss_quote_pdf_url, title: `Quote ${r.ss_quote_number} — ${c.name || r.short_code}` }),
                          },
                          // keepOpen, because "Copied ✓" IS the confirmation and it is drawn on
                          // this very item — closing the menu on click would take the only
                          // feedback this action has away with it.
                          r.ss_quote_number && {
                            key: "copy", keepOpen: true,
                            label: copiedKey === r.short_code ? "Copied ✓" : "Copy link",
                            title: "Copy the customer quote-page link (they sign in with their phone)",
                            onClick: () => copyCustomerLink(r.short_code),
                          },
                          // These two report through the invMsg banner above the table, which is
                          // why they close: the outcome is not written on the button.
                          r.ss_quote_number && {
                            key: "resend", disabled: resendBusyKey === r.short_code,
                            label: resendBusyKey === r.short_code ? "Sending…" : "Resend email",
                            title: "Re-send the quote email to the customer",
                            onClick: () => resendQuoteEmail(r),
                          },
                          // Only on an ACCEPTED design — that is the one state where an invoice
                          // is the next step, and it is what the server gates on too. Keyed on
                          // this row's own short code, so what gets invoiced is the design the
                          // menu sits on.
                          isAdmin && normStatus(r.status) === "accepted" && {
                            key: "invoice", disabled: invBusyKey === r.short_code,
                            label: invBusyKey === r.short_code ? "Sending invoice…" : "Send invoice",
                            title: "Create and email the invoice for this accepted estimate",
                            onClick: () => sendInvoice(r),
                          },
                          // Owner/admin only — a team member must not be able to destroy a
                          // customer record. The server re-checks regardless (delete_design is
                          // absent from READ_ACTIONS, so the resolver requires owner/admin).
                          isAdmin && {
                            key: "delete", label: "Delete design", danger: true,
                            title: "Delete this design",
                            onClick: () => setDelTarget(r),
                          },
                        ]} />
                      </span>
                    </td>
                  </tr>
                  {isOpen && older.map((v) => {
                    const vsel = v.selections || {};
                    return (
                      <tr key={r.short_code + "-v" + v.version} style={{ background: "#F8FAFC" }}>
                        <td style={{ ...S.td, whiteSpace: "nowrap", color: "#64748B" }}>{fmtDate(v.created_at)}</td>
                        <td style={S.td}></td>
                        <td style={S.td}></td>
                        <td style={{ ...S.td, whiteSpace: "nowrap", color: "#64748B" }}>↳ v{v.version} · {[titleCase(vsel.style), vsel.size].filter(Boolean).join(" ") || "—"}
                          <SourceChip unitId={v.inventory_unit_id} serial={unitSerials[v.inventory_unit_id]} /></td>
                        <td style={S.td}></td>
                        <td style={S.td}></td>
                        <td style={{ ...S.td, whiteSpace: "nowrap" }}>
                          <button type="button" onClick={() => onOpenDesign && onOpenDesign(r.short_code, v.version)}
                            style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit", fontSize: "inherit", color: ACCENT, fontWeight: 700, marginRight: 10 }}>Open</button>
                          {ssSafeUrl(v.image_url) && (
                            <button type="button" onClick={() => setPdf({ url: v.image_url, title: `Floor plan v${v.version} — ${r.short_code}` })}
                              style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit", fontSize: "inherit", color: "#334155", fontWeight: 700 }}>PDF</button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
          <PageBar size={pageSize} onSize={setPageSize} page={curPage} onPage={setPage} total={sorted.length} noun="design" />
        </div>
      )}
      {pdf && <PdfModal url={pdf.url} title={pdf.title} onClose={() => setPdf(null)} />}
      {delTarget && (
        <DeleteDesignDialog design={delTarget} onClose={() => setDelTarget(null)}
          onDeleted={(res) => {
            const code = delTarget.short_code;
            setDelTarget(null);
            // versionsDeleted counts EVERY design_versions row removed, the current
            // version included (each save writes one — v1 too), while "earlier" here
            // must match the row's ▾ expander, which counts only vs.slice(1). One
            // fewer, and a design saved once has none to mention.
            const earlier = Math.max(0, Number(res.versionsDeleted || 0) - 1);
            const base = `Deleted design ${code}` + (earlier ? ` and ${earlier} earlier version(s)` : "");
            // The CRM half is reported separately because it is the half that can partly fail
            // while the design itself is gone — a bare "Deleted." would hide a leftover
            // estimate in someone else's system.
            const est = res.estimateNumber ? `EST-${res.estimateNumber}` : "its estimate";
            if (res.estimate === "failed") {
              setDelMsg({ err: `${base}, but ${est} could NOT be removed from your CRM (${res.estimateError || "unknown error"}). Delete it there by hand — support has a record.` });
            } else if (res.estimate === "skipped_invoiced") {
              setDelMsg({ ok: `${base}. ${est} was left in your CRM because an invoice was created from it — void that invoice there if you also want the estimate gone.` });
            } else if (res.estimate === "deleted") {
              setDelMsg({ ok: `${base}, along with ${est} in your CRM.` });
            } else {
              setDelMsg({ ok: `${base}.` });
            }
            load();
          }} />
      )}
    </div>
  );
}

// ─── Contact activity helpers (Contacts tab "Details" drawer) ───
const fmtWhen = (s) => { try { return new Date(s).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); } catch (_) { return s || ""; } };
// Human diff between two version ROWS — what the customer changed. Whole rows, not
// just `selections`: paint is not a selections key (the designer saves it as the
// separate p_paint_colors arg, landing in the row's paint_colors column as
// { body, trim } labels), so a selections-only diff can never see a paint change —
// one of the most common revisions. Rows without paint_colors diff as empty, never throw.
function diffVersionSelections(va, vb) {
  const a = (va && va.selections) || {}, b = (vb && vb.selections) || {};
  // selections.cladding holds the designer's stable id; show the label the customer
  // picked (mirrors D3_CLADDING in structure-studio.component.js). Unknown ids pass
  // through raw — a cryptic diff beats a silent one.
  const CLADDING_LABELS = { lap: "Lap Siding", panel: "Panel Siding", agpanel: "Metal", batten: "Board & Batten" };
  const KEYS = [["style", "style"], ["size", "size"], ["roofType", "roof type"], ["roofColor", "roof color"], ["cladding", "cladding"]];
  const parts = [];
  const push = (lbl, av, bv) => { if (av !== bv && (av || bv)) parts.push(`${lbl}: ${av || "—"} → ${bv || "—"}`); };
  for (const [k, lbl] of KEYS) {
    let av = String(a[k] || ""), bv = String(b[k] || "");
    if (k === "cladding") { av = CLADDING_LABELS[av] || av; bv = CLADDING_LABELS[bv] || bv; }
    push(lbl, av, bv);
  }
  const pa = (va && va.paint_colors) || {}, pb = (vb && vb.paint_colors) || {};
  push("body color", String(pa.body || ""), String(pb.body || ""));
  push("trim color", String(pa.trim || ""), String(pb.trim || ""));
  return parts.join(", ");
}
// Merge DB history (design versions) + GHL estimate events into one newest-first timeline.
function buildContactTimeline(act) {
  const ev = [];
  (act.designs || []).forEach((d) => {
    const sel = d.selections || {};
    const label = [titleCase(sel.style), sel.size].filter(Boolean).join(" ") || d.short_code;
    const vers = (act.versions || []).filter((v) => v.short_code === d.short_code); // ascending
    if (vers.length === 0) ev.push({ t: d.created_at, code: d.short_code, text: `Started ${label}` });
    vers.forEach((v, i) => {
      if (i === 0) { ev.push({ t: v.created_at, code: d.short_code, text: `Designed ${label} and requested a quote (v1)` }); return; }
      const diff = diffVersionSelections(vers[i - 1], v); // whole rows — paint_colors sits beside selections
      ev.push({ t: v.created_at, code: d.short_code, text: `Changed the design and resubmitted (v${v.version})${diff ? " — " + diff : ""}` });
    });
    const est = d.ghl_estimate_id ? (act.estimates || {})[d.ghl_estimate_id] : null;
    if (est) {
      const num = est.estimateNumber != null ? `EST-${est.estimateNumber}` : (d.ghl_estimate_number ? `EST-${d.ghl_estimate_number}` : "estimate");
      if (est.createdAt) ev.push({ t: est.createdAt, code: d.short_code, text: `${num} emailed to the customer` });
      if (est.lastVisitedAt) ev.push({ t: est.lastVisitedAt, code: d.short_code, text: `Opened ${num}` });
      // GHL sends estimateActionHistory[].updatedAt as the LOCATION's local time with no
      // timezone suffix, so parsing it as-is lands the event hours off and mis-sorts the
      // timeline (verified live 2026-07-25: an accept stamped "…T02:39:13" against a real
      // "…T07:39:13.211Z"). The estimate's own updatedAt IS zoned, so use it for the event
      // that matches the CURRENT status; older entries fall back to UTC-normalised.
      const zoned = (s) => /(?:Z|[+-]\d{2}:?\d{2})$/.test(String(s || ""));
      const curStatus = String(est.estimateStatus || "").toLowerCase();
      (est.history || []).forEach((h) => {
        const st = String((h && h.estimateStatus) || "").toLowerCase();
        if (!h || !h.updatedAt || !st) return;
        let t = h.updatedAt;
        if (!zoned(t)) t = (st === curStatus && est.updatedAt) ? est.updatedAt : String(t) + "Z";
        if (st === "accepted") ev.push({ t, code: d.short_code, text: `✅ Accepted ${num}` });
        else if (st === "invoiced") ev.push({ t, code: d.short_code, text: `💵 ${num} invoiced` });
        else ev.push({ t, code: d.short_code, text: `${num} ${st}` });
      });
    }
  });
  return ev.filter((e) => e.t).sort((a, b) => (new Date(b.t)) - (new Date(a.t)));
}

// ─── Leads table (contact-grouped view of designs) ───
// Same RLS-scoped designs read as DesignsTable, but grouped by the person
// (normalized phone → email → name) so a repeat shopper collapses into ONE lead
// with a design count + activity dates. Read-only. "Last activity" = the newest
// design's updated_at (portal logins aren't client-readable); status = the
// highest fulfillment stage across that lead's designs.
function LeadsTable({ clientId, fetchDesigns = null, isAdmin = false, onOpenDesign = null, onOpenRecord = null }) {
  // Cache-seeded so returning to Contacts paints the grouped list at once and refreshes
  // behind it (see ssTabCache in 01-core). Operator view-as reads through a different path
  // and is left uncached — those rows are service-role and audit-logged.
  const [rows, setRows] = useState(() => (fetchDesigns ? null : ssCacheGet("rest", "contacts", clientId))); // null = loading
  const [error, setError] = useState(null);
  const [query, setQuery] = useState("");  // free-text search across all fields

  const load = useCallback(async () => {
    setError(null);
    let list;
    let browsing = [];
    // Inventory masters are lot buildings, not contacts — exclude on both paths (they
    // have an empty contact, so they'd otherwise group as a nameless short_code row).
    const notInventoryLead = (r) => r.status !== "inventory";
    // Grouping is a FUNCTION rather than a straight-line block because this list paints
    // TWICE: once on the cached statuses the moment the rows arrive, and again when the
    // GHL sync comes back.
    //
    // Carolyn, 2026-08-26, three separate times: "the contact page always takes a while to
    // load ... this is the only page that takes that long." It was the only slow one
    // because it was the only list that awaited sync-design-status BEFORE its first
    // setRows, so `rows` sat at null — the "Loading…" state — for a whole round-trip over
    // every short code in the tenant. DesignsTable had always painted its cached rows
    // first and synced after (see its load()); this is that same shape, finally.
    //
    // She read the delay as a scale problem and asked for pagination. Pagination is worth
    // having, but it would not have fixed this: the wait was one round-trip, not 30 rows.
    const paint = (rowsIn, browsingIn) => {
      // Group by person: normalized phone, else email, else name (fallback: short_code).
      // normPhone is migration 132's crm_phone_key, in JS: an 11-digit string starting with
      // 1 is a US/Canada number written with its country code, so take the last 10. A bare
      // digit filter is NOT a phone normalizer — it split one customer who typed
      // "+1 707-362-5667" once and "707-362-5667" the next time into two rows, each showing
      // half his designs and half his history, while both linked to the SAME crm_contacts
      // record (the server resolves through crm_phone_key) and opened the same page. The
      // list contradicted the record it links to. Nothing else is guessed at, for 132's
      // reason: collapsing international formats would fuse two genuinely different people.
      const normPhone = (p) => { const d = String(p || "").replace(/\D/g, ""); return d.length === 11 && d[0] === "1" ? d.slice(1) : d; };
      const groups = new Map();
      rowsIn.forEach((r) => { // newest-first
        const c = r.contact || {};
        const key = normPhone(c.phone) || String(c.email || "").trim().toLowerCase() || String(c.name || "").trim().toLowerCase() || r.short_code;
        let g = groups.get(key);
        // topStatus starts at the LOWEST rank ("draft", -1) so the very first row always
        // wins the > comparison below — seeded at "sent", a draft-only contact could never
        // display as Draft (its -1 never beats 0).
        if (!g) { g = { key, contactId: null, name: "", email: "", phone: "", count: 0, firstSeen: r.created_at, lastActivity: r.created_at, latestCode: r.short_code, topStatus: "draft", search: "", codes: [] }; groups.set(key, g); }
        // The real crm_contacts id, once migration 130 has stamped it. Absent until the
        // backfill runs, which is why the record link below is conditional rather than assumed.
        if (!g.contactId && r.contact_id) g.contactId = r.contact_id;
        g.count += 1;
        g.codes.push(r.short_code);                     // newest-first (list order)
        // Accumulate design-level searchable text (building + estimate #) so a lead is
        // findable by those too — they aren't columns here but the requirement is all-fields.
        const gsel = r.selections || {};
        g.search += " " + [titleCase(gsel.style), gsel.size, r.ghl_estimate_number, r.ghl_estimate_number ? "EST-" + r.ghl_estimate_number : ""].filter(Boolean).join(" ");
        if (!g.name && c.name) g.name = c.name;       // newest-first → prefer the most recent non-empty value
        if (!g.email && c.email) g.email = c.email;
        if (!g.phone && c.phone) g.phone = c.phone;
        const act = r.updated_at || r.created_at;
        if (act > g.lastActivity) g.lastActivity = act;
        if (r.created_at < g.firstSeen) g.firstSeen = r.created_at;
        const st = normStatus(r.status);
        // was `RANK[st]`: the refactor that replaced LeadsTable's private RANK copy with the
        // shared STATUS_RANK missed this one usage, so load() threw ReferenceError on the
        // first design row and Contacts sat on "Loading…" forever.
        if (STATUS_RANK[st] > STATUS_RANK[g.topStatus]) g.topStatus = st;
      });
      // Browsing leads join the same list, SUPPRESSED once the person has a real design —
      // matched by normalized phone first, then email, the same identity rules the design
      // grouping itself uses. A browsing lead who later submits simply becomes their design
      // row; the browsing entry disappears rather than duplicating them.
      const groupEmails = new Set([...groups.values()].map((g) => String(g.email || "").trim().toLowerCase()).filter(Boolean));
      browsingIn.forEach((l) => {
        const em = String(l.email || "").trim().toLowerCase();
        // captured_leads.phone_digits is the raw digit filter (capture-lead), so it has to
        // go through the same key or a lead captured as "+1 …" survives as a third row for
        // a person who has already submitted designs.
        if (groups.has(normPhone(l.phone_digits)) || (em && groupEmails.has(em))) return;
        groups.set("lead-" + l.id, {
          key: "lead-" + l.id, browsing: true, source: l.source,
          // A browsing lead is a PERSON too, so its name links to the record like every
          // other row. captured_leads.contact_id is stamped by capture-lead (and by 130's
          // backfill) — before that this was always null, which is why the newest row in
          // the list, the one anybody clicks first, was the one row that did nothing.
          contactId: l.contact_id || null,
          name: l.name || "", email: l.email || "", phone: l.phone || "",
          count: 0, firstSeen: l.created_at, lastActivity: l.updated_at,
          latestCode: null, topStatus: "browsing",
          search: " browsing lead" + (l.source === "details" ? " viewed pricing quote details" : ""),
          codes: [],
        });
      });
      const out = [...groups.values()].sort((a, b) => (b.lastActivity > a.lastActivity ? 1 : b.lastActivity < a.lastActivity ? -1 : 0));
      setRows(out);
      // Cache the GROUPED result, not the raw reads: regrouping is the expensive part of
      // this function and the shape the table renders from. Operator view-as is excluded —
      // those rows come from a service-role path and belong to someone else's tenant.
      if (!fetchDesigns) ssCachePut("rest", "contacts", clientId, out);
    };
    if (fetchDesigns) {
      // Operator view-as: rows from operator-portal (service-role, audit-logged);
      // live status sync skipped (owner-JWT-bound) — cached statuses show.
      try { const res = await fetchDesigns(); list = (res.designs || []).filter(notInventoryLead); browsing = res.capturedLeads || []; }
      catch (e) { setError(e.message || String(e)); setRows([]); return; }
    } else {
    // Both reads at once. They share nothing — browsing leads are matched to designs in
    // `paint` AFTER both are in hand — so awaiting one before starting the other simply
    // added a full network round trip in front of the first paint. On a normal connection
    // that is most of what this tab's wait was.
    //
    // Browsing leads (migration 062): people who passed the public designer's gate or
    // opened quote Details but never submitted. RLS scopes the read to this tenant.
    // Additive — a failure there must never block the design list, which is why its result
    // is read defensively rather than destructured with the designs error.
    const [dRes, clRes] = await Promise.all([
      sb.from("designs")
        .select("short_code, created_at, updated_at, status, contact, selections, ghl_estimate_number, contact_id")
        .eq("client_id", clientId)
        .order("created_at", { ascending: false }),
      sb.from("captured_leads")
        .select("id, name, phone, phone_digits, email, source, created_at, updated_at, contact_id")
        .eq("client_id", clientId).order("updated_at", { ascending: false })
        .then((r) => r, () => ({ data: [] })),
    ]);
    if (dRes.error) { setError(dRes.error.message); setRows([]); return; }
    list = (dRes.data || []).filter(notInventoryLead);
    browsing = clRes.data || [];
    // PAINT NOW, on the cached statuses. Everything below only ever improves them.
    paint(list, browsing);
    // Freshen fulfillment status from GHL (read-only projection); non-fatal. The rows
    // are already on screen by now — this only repaints them, at the tail below.
    if (list.length > 0) {
      try {
        const { data: sync } = await sb.functions.invoke("sync-design-status", { body: { shortCodes: list.map((r) => r.short_code) } });
        const statuses = sync && sync.statuses;
        if (statuses) list = list.map((r) => statuses[r.short_code] ? { ...r, status: statuses[r.short_code] } : r);
      } catch (_e) { /* keep cached statuses */ }
    }
    }
    paint(list, browsing);
  }, [fetchDesigns]);

  useEffect(() => { load(); }, [load]);

  // Status chips. NOTE this filters PEOPLE by their furthest-along design, because
  // `topStatus` is a max over the person's group — "Accepted" here means "has at least one
  // accepted design", not "all their designs are accepted". That is the useful reading for a
  // contact list (it answers "who are my customers?"), and it is why the same component is
  // fed a different bucket set than the Designs table: `browsing` is a synthetic group with
  // no design behind it at all.
  const [statusFilter, setStatusFilter] = useState("all");
  const statusCounts = (rows || []).reduce((a, g) => { a[g.topStatus] = (a[g.topStatus] || 0) + 1; return a; }, {});
  // Facet filters: last-activity date-range + contact-info presence.
  const [fFrom, setFFrom] = useState("");
  const [fTo, setFTo] = useState("");
  const [fContact, setFContact] = useState("all");
  const hasFacets = !!fFrom || !!fTo || fContact !== "all";
  const clearFacets = () => { setFFrom(""); setFTo(""); setFContact("all"); };

  // Chip filter first, then facets, then the free-text search over what survives.
  const byStatus = statusFilter === "all" ? (rows || []) : (rows || []).filter((g) => g.topStatus === statusFilter);
  const byFacets = byStatus.filter((g) => {
    if (!inDateRange(g.lastActivity, fFrom, fTo)) return false;
    const has = !!(g.email || g.phone);
    if (fContact === "has" && !has) return false;
    if (fContact === "missing" && has) return false;
    return true;
  });
  const filtered = byFacets.filter((g) => {
    const extra = [STATUS_LABELS[g.topStatus], fmtDate(g.firstSeen), fmtDate(g.lastActivity)].join(" ");
    return rowMatchesQuery(g, query, extra);
  });

  // Column sort. Default = most-recent activity first (matches the load-time sort).
  const [sortKey, setSortKey] = useState("lastActivity");
  const [sortDir, setSortDir] = useState("desc");
  const onSort = makeOnSort(sortKey, setSortKey, sortDir, setSortDir);
  const sortVal = (g) => {
    switch (sortKey) {
      case "customer":     return g.name;
      case "contact":      return g.email || g.phone;
      case "designs":      return g.count;
      case "firstSeen":    return g.firstSeen;
      case "lastActivity": return g.lastActivity;
      case "status":       return g.browsing ? -2 : STATUS_RANK[g.topStatus]; // browsing < draft (-1) < sent
      default:             return g.lastActivity;
    }
  };
  const sorted = sortRows(filtered, sortVal, sortDir);

  // Paging is the LAST step, over the fully filtered and sorted list, so the counts above
  // ("12 of 340") keep describing the whole tenant rather than the visible page.
  const [pageSize, setPageSize] = usePageSize("contacts");
  const [page, setPage] = useState(1);
  // Any change to what is being listed sends you back to page 1 — staying on page 7 of a
  // search that now returns four contacts shows an empty table and reads as a broken page.
  useEffect(() => { setPage(1); }, [query, statusFilter, fFrom, fTo, fContact]);
  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const curPage = Math.min(page, pageCount);
  const paged = sorted.slice((curPage - 1) * pageSize, curPage * pageSize);

  // ── Details drawer (per contact): what they changed + their estimate activity ──
  const [detailsFor, setDetailsFor] = useState(null); // group key | null
  const [activity, setActivity] = useState(null);     // contact_activity payload
  const [actBusy, setActBusy] = useState(false);
  const [actErr, setActErr] = useState(null);
  // Guards against a stale contact_activity response landing under a different contact:
  // every request stamps this ref, and only the newest one is allowed to render.
  const actReqRef = useRef(0);


  const openDetails = async (g) => {
    if (detailsFor === g.key) { setDetailsFor(null); actReqRef.current += 1; return; }
    const req = ++actReqRef.current;
    setDetailsFor(g.key); setActivity(null); setActErr(null); setActBusy(true);
    const { data, error: err } = await sb.functions.invoke("portal-settings", { body: { action: "contact_activity", codes: g.codes } });
    if (req !== actReqRef.current) return;            // a newer contact was opened — drop this
    setActBusy(false);
    if (err) { setActErr(await fnError(err)); return; }
    setActivity(data);
  };

  // NOTE: Send invoice deliberately does NOT live here. A contact groups every design that
  // person ever submitted, so invoicing from this row meant picking `acceptedCodes[0]` on
  // their behalf — an invisible guess when someone has two accepted designs. It is now a
  // per-row action on the Designs tab, where the short code is unambiguous.

  return (
    <div style={S.card}>
      <CardHead
        title="Contacts"
        count={rows ? ((query || statusFilter !== "all" || hasFacets) ? `${filtered.length} of ${rows.length}` : rows.length) : null}
        desc="Everyone who submitted a design, grouped by contact — repeat visitors collapse into one lead. Read-only."
        right={<button onClick={load} style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0", padding: "6px 12px" }}>↻ Refresh</button>}
      >
        {/* The status dots keep their own semantic colours — green/amber/red mean the same
            thing everywhere and must not be recoloured to fit a header tint. */}
        <span style={{ marginLeft: 6, whiteSpace: "nowrap" }}>
          <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: "#16A34A", margin: "0 4px 0 6px", verticalAlign: "middle" }} />active
          <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: "#F59E0B", margin: "0 4px 0 10px", verticalAlign: "middle" }} />recent
          <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: "#EF4444", margin: "0 4px 0 10px", verticalAlign: "middle" }} />idle
        </span>
      </CardHead>
      {rows && rows.length > 0 && (
        <div style={{ display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 320px", minWidth: 260 }}>
            <SearchInput value={query} onChange={setQuery} placeholder="Search contacts — name, email, phone, status…" />
          </div>
          <FilterBar hasFilters={hasFacets} onClear={clearFacets} shown={filtered.length} total={rows.length} noun="contact">
            <DateRange label="Last activity" from={fFrom} to={fTo} onFrom={setFFrom} onTo={setFTo} />
            <FacetSelect label="Contact info" value={fContact} onChange={setFContact}
              options={[{ value: "has", label: "Has email or phone" }, { value: "missing", label: "No contact info" }]} allLabel="All" />
          </FilterBar>
        </div>
      )}
      {/* `browsing` is passed via `extra` because it is not a designs.status — it is the
          synthetic group built from captured_leads for people who never submitted anything. */}
      {rows && rows.length > 0 && (
        <StatusChips counts={statusCounts} value={statusFilter} onChange={setStatusFilter}
          extra={[["browsing", "Browsing", { fg: "#3D3672" }]]} />
      )}
      {error && <div style={S.err}>{error}</div>}
      {/* The skeleton carries the real table's seven columns, so when the rows land they
          replace grey bars that are already the right shape and nothing shifts under the
          cursor. This is the state Carolyn was describing as "there's nothing there". */}
      {rows === null && !error && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              {["Customer", "Contact", "Designs", "First seen", "Last activity", "Status", "Actions"].map((h) => <th key={h} style={S.th}>{h}</th>)}
            </tr></thead>
            <tbody><SkelRows cols={7} rows={6} /></tbody>
          </table>
        </div>
      )}
      {rows && rows.length === 0 && !error && (
        <p style={{ fontSize: 13, color: "#64748B", padding: 12 }}>No contacts yet. Share your customer link — everyone who submits a design shows up here.</p>
      )}
      {rows && rows.length > 0 && filtered.length === 0 && (
        <p style={{ fontSize: 13, color: "#64748B", padding: 12 }}>
          {query
            ? <>No contacts match “{query}”{statusFilter !== "all" ? <> in <strong>{statusFilter === "browsing" ? "Browsing" : STATUS_LABELS[statusFilter]}</strong></> : null}{hasFacets ? " with the current filters" : ""}.</>
            : hasFacets
              ? <>No contacts match the current filters. Adjust or <button onClick={clearFacets} style={{ background: "none", border: "none", color: ACCENT, cursor: "pointer", fontWeight: 700, fontSize: 13, padding: 0, fontFamily: "inherit", textDecoration: "underline" }}>clear the filters</button>.</>
              : <>No contacts are <strong>{statusFilter === "browsing" ? "Browsing" : STATUS_LABELS[statusFilter]}</strong> yet.</>}
        </p>
      )}
      {rows && filtered.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              <SortTh label="Customer" col="customer" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              <SortTh label="Contact" col="contact" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              <SortTh label="Designs" col="designs" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              <SortTh label="First seen" col="firstSeen" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              <SortTh label="Last activity" col="lastActivity" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              <SortTh label="Status" col="status" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              <th style={S.th}>Actions</th>
            </tr></thead>
            <tbody>
              {paged.map((g) => {
                // Browsing leads get the brand light blue rather than a fulfillment colour —
                // they are interest, not an order state.
                const sc = g.browsing ? { bg: "#DBEAFF", fg: "#3D3672" } : (STATUS_COLORS[g.topStatus] || STATUS_COLORS.sent);
                return (
                  <React.Fragment key={g.key}>
                  <tr>
                    <td style={{ ...S.td, fontWeight: 700 }}>
                      {(() => { const a = activityInfo(g.lastActivity); return <span title={a.label} style={{ display: "inline-block", width: 9, height: 9, borderRadius: "50%", background: a.color, marginRight: 8, verticalAlign: "middle" }} />; })()}
                      {/* THE NAME IS THE LINK. Carolyn, 2026-08-24, describing Pipedrive:
                          "I want it to be very similar to where YOU CLICK THIS CUSTOMER NAME
                          and you pop it up." It was briefly behind a small "Open record"
                          button beside Details, which is not what she demonstrated and not
                          where anyone would look. Falls back to plain text for a contact
                          with no crm_contacts row yet — i.e. before the backfill has run. */}
                      {g.contactId && onOpenRecord ? (
                        <button type="button" onClick={() => onOpenRecord(g.contactId)}
                          title="Open this contact's record"
                          style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit", fontSize: "inherit", fontWeight: 700, color: ACCENT, textAlign: "left" }}>
                          {g.name || "—"}
                        </button>
                      ) : (g.name || "—")}
                    </td>
                    <td style={S.td}>
                      <div>{g.email || ""}</div>
                      <div style={{ color: "#64748B", fontSize: 12 }}>{g.phone || ""}</div>
                    </td>
                    <td style={S.td}>{g.browsing ? "—" : g.count}</td>
                    <td style={{ ...S.td, whiteSpace: "nowrap" }}>{fmtDate(g.firstSeen)}</td>
                    <td style={{ ...S.td, whiteSpace: "nowrap" }}>{fmtDate(g.lastActivity)}</td>
                    <td style={S.td}><span title={g.browsing && g.source === "details" ? "Filled in their contact info and viewed quote details" : g.browsing ? "Entered name and phone at the designer gate" : undefined}
                      style={{ background: sc.bg, color: sc.fg, borderRadius: 20, padding: "4px 12px", fontSize: 12, fontWeight: 700, whiteSpace: "nowrap" }}>{g.browsing ? (g.source === "details" ? "Browsing · saw pricing" : "Browsing") : STATUS_LABELS[g.topStatus]}</span></td>
                    <td style={{ ...S.td, whiteSpace: "nowrap" }}>
                      {g.browsing && <span style={{ color: "#94A3B8", fontSize: 12.5 }}>No design yet</span>}
                      {/* In-portal open — same rule as DesignsTable: never the public page. */}
                      {!g.browsing && <button type="button" onClick={() => onOpenDesign && onOpenDesign(g.latestCode)}
                        style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit", fontSize: "inherit", color: ACCENT, fontWeight: 700 }}>Open latest</button>}
                      {/* The "Open record" button that stood here is gone: the customer NAME
                          is the link now, which is what Carolyn demonstrated. "Details" stays
                          as the quick inline peek that does not leave the list. */}
                      {!g.browsing && (
                        <button type="button" onClick={() => openDetails(g)}
                          style={{ marginLeft: 10, background: "transparent", border: "none", padding: 0, cursor: "pointer", color: "#334155", fontWeight: 700, fontSize: 13, fontFamily: "inherit" }}>
                          {detailsFor === g.key ? "Hide details" : "Details"}
                        </button>
                      )}
                    </td>
                  </tr>
                  {detailsFor === g.key && (
                    <tr>
                      <td colSpan={7} style={{ ...S.td, background: "#F8FAFC" }}>
                        {actBusy && <div style={{ fontSize: 13, color: "#64748B", padding: 8 }}>Loading activity…</div>}
                        {actErr && <div style={{ color: "#B91C1C", fontSize: 13, padding: 8 }}>{actErr}</div>}
                        {activity && (() => {
                          const tl = buildContactTimeline(activity);
                          return (
                            <div style={{ padding: "6px 4px" }}>
                              <div style={{ fontSize: 12, fontWeight: 700, color: "#475569", marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.4 }}>
                                Activity — {g.name || "contact"} · {g.count} design{g.count > 1 ? "s" : ""}
                              </div>
                              {/* An invoice that exists in the CRM but was never emailed —
                                  otherwise this design just looks Invoiced. Send invoice now
                                  lives on the Designs tab, so this points there rather than
                                  at a button that is no longer on this screen. */}
                              {(activity.invoiceSends || []).filter((s) => s.status === "created").map((s) => (
                                <div key={"pend" + s.short_code} style={{ background: "#FFFBEB", border: "1px solid #FDE68A", color: "#92400E", borderRadius: 8, padding: "7px 10px", fontSize: 12.5, fontWeight: 600, marginBottom: 8 }}>
                                  ⚠ Invoice {s.invoice_number || ""} exists in your CRM for {s.short_code} but the email never went out. Open the <strong>Designs</strong> tab and click <strong>Send invoice</strong> on {s.short_code} to retry — it will not create a second invoice.
                                </div>
                              ))}
                              {tl.length === 0 && <div style={{ fontSize: 13, color: "#64748B" }}>No recorded activity yet.</div>}
                              {tl.map((e, i) => (
                                <div key={i} style={{ display: "flex", gap: 12, padding: "5px 0", fontSize: 13, borderBottom: "1px solid #EEF2F7", alignItems: "baseline" }}>
                                  <span style={{ color: "#94A3B8", whiteSpace: "nowrap", minWidth: 130 }}>{fmtWhen(e.t)}</span>
                                  <span style={{ color: "#94A3B8", whiteSpace: "nowrap", fontSize: 11 }}>{e.code}</span>
                                  <span style={{ color: "#1E293B" }}>{e.text}</span>
                                </div>
                              ))}
                              <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 8 }}>
                                Tracks design submissions &amp; changes (version history) and estimate events from your CRM (sent · opened · accepted · invoiced). Pre-submit click tracking in the designer is on the roadmap.
                              </div>
                            </div>
                          );
                        })()}
                      </td>
                    </tr>
                  )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
          <PageBar size={pageSize} onSize={setPageSize} page={curPage} onPage={setPage} total={sorted.length} noun="contact" />
        </div>
      )}
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════════════════════════
// THE MERGED CRM RECORD PAGE — Contacts + Designs, one shell, two contexts.
// ═══════════════════════════════════════════════════════════════════════════════════════
//
// Carolyn walked Pipedrive live on 2026-08-21 and again against our app on 08-24. The
// load-bearing sentence: "the view of being in an opportunity and the view of being in a
// person are different, but they're the same. You get the same look, the same work."
// So: ONE shell, two contexts. Person = Contact, Deal = Design.
//
// Deal is a DESIGN, not an Order. Orders only exist after acceptance, so a pipeline made of
// orders has no top of funnel — every deal would appear already won. A design already
// carries a value, a status ladder, version history, an estimate number, a PDF, an
// acceptance record, change orders and an invoice. An Order becomes a SECTION on the
// design record, not a separate noun.
//
// WHY THIS LIVES IN 02-sales.jsx RATHER THAN A NEW portal/03-crm.jsx. The documented
// convention is to insert a numbered part and renumber every later one, because the
// numeric prefix IS the concatenation index. That is right, and it is also seven git mv's
// across a tree that a second session is committing to every few minutes today — the same
// tree where a sibling commit already swept up this session's uncommitted work once. The
// components below compose DesignsTable and LeadsTable, which are directly above them, so
// this is their topical home either way. If the portal is ever re-split, this block is a
// contiguous slice at a top-level boundary and lifts out cleanly.

// Three registries. A new sidebar section, action tab or history chip is a ROW here, not a
// rewrite — which is the whole point of building the shell rather than two pages.
// The delivery ladder, spelled out here rather than imported from the schedule tab.
//
// ⚠️ 05-schedule.jsx's SCHED_LOAD_STATUS is the same three words, and reaching for it from
// THIS file would throw at runtime: the portal parts are CONCATENATED in numeric order and
// `const` does not hoist, so part 02 reading a part 05 binding hits the temporal dead zone
// the moment a delivery card renders. Preflight's no-undef would not catch it either --
// the name does exist in the bundle, just not yet. Three words are cheaper than that bug.
//
// These are not tenant-editable: delivery has no stages table, only a fixed
// planned|out|delivered CHECK on delivery_loads.
const CRM_LOAD_LABEL = { planned: "Planned", out: "Out for delivery", delivered: "Delivered" };

const CRM_SECTIONS = [
  { key: "summary", title: "Summary", when: () => true },
  { key: "details", title: "Details", when: () => true },
  // ── THE RECIPROCAL EMBED. This pair IS Carolyn's "here is the contact, and the deal is
  // all on the side here ... it's in one place." A Person shows its Deals; a Deal shows
  // its Person. Same shell, mirrored.
  { key: "deals", title: "Deals", when: (c) => c.kind === "contact" },
  // ORDERS. Carolyn, 2026-08-26 33:20: "when you're in contacts, in a contact, I feel like
  // you should see the deal. You should see the orders." Deals were already here; orders
  // are what say whether any of them turned into a sale. Contact-side only — a design's
  // order is the same one row and would just repeat the stage bar above it.
  { key: "orders", title: "Orders", when: (c) => c.kind === "contact" },
  { key: "person", title: "Person", when: (c) => c.kind === "design" },
  // BUILD, DELIVERY, REPAIRS. Carolyn, 2026-08-28 @37:48: "whether you're in a contact or
  // whether you're in a deal, it doesn't matter, you want to be able to see the contact
  // details, the deals, the orders, the build schedule, the delivery schedule ... Repairs
  // also." On BOTH kinds, which is why there is no `when` narrowing here.
  //
  // "If there's nothing, like, because they haven't placed an order, the card just is going
  // to be blank. It'll say build schedule. And it just is nothing." -- so an empty card
  // RENDERS EMPTY rather than disappearing. A card that vanishes reads as "not built".
  { key: "build", title: "Build schedule", when: () => true },
  { key: "delivery", title: "Delivery schedule", when: () => true },
  { key: "repairs", title: "Repairs", when: () => true },
  { key: "overview", title: "Overview", when: () => true },
];

// The ACTION BAR — "up at the top here is things you can do. So this bar is basically
// actions that you can take." Disabled tabs render GREYED WITH A TOOLTIP, never hidden: a
// missing tab reads as "not built", a greyed one reads as "next", and she is showing this
// at a trade show.
const CRM_TABS = [
  // "Not available yet" (the default hint) reads as NOT BUILT, which is the wrong story for
  // a tab that is merely out of this person's reach — it is built, they just cannot write.
  { key: "activity", label: "Activity", enabled: (c) => c.canEdit, hint: "You don't have permission to log activities." },
  { key: "note", label: "Notes", enabled: (c) => c.canEdit, hint: "You don't have permission to add notes." },
  { key: "scheduler", label: "Meeting scheduler", enabled: () => false, hint: "Arrives with the calendar integration." },
  { key: "call", label: "Call", enabled: () => false, hint: "Arrives with the phone integration." },
  // SMS — A REAL CHANNEL NOW, REVERSING A DECISION THIS COMMENT USED TO RECORD.
  //
  // What stood here read "NO SMS OR WHATSAPP TAB, AND THERE IS NOT GOING TO BE ONE" (Ahsan,
  // 2026-08-25: "we are not using Twilio for conversation or campaigns. We are only using
  // Twilio to get the code to log in"). It was written after deleting a greyed WhatsApp tab
  // hinted "arrives when the Twilio account is connected" — a promise nobody intended to
  // keep, sitting on a screen Carolyn shows at a trade show.
  //
  // Carolyn asked for texting on 2026-08-26 (27:02): "and we have calls. We probably need
  // SMS in there, too." Ahsan approved building it properly on 08-27, so this is a working
  // channel — per-tenant Twilio numbers, a send path, an inbound webhook, an opt-out column
  // — and not the greyed promise the old comment was right to delete.
  //
  // WhatsApp is still not a feature, and nothing here reserves a slot for it.
  //
  // FOUR different things disable this tab and it names which one, for the same reason the
  // Email tab's hint is a function: a rep without contacts:edit was once shown "this contact
  // has no email address" while the address sat rendered directly above it. "Not available"
  // sends somebody off editing a contact that is fine.
  //
  // The fourth is the contact with no ROW behind it: a design whose crm_ensure_contact call
  // was swallowed by 133's exception guard carries contact_id null, and the server hands us
  // a contact synthesized from the design's jsonb blob (id null). Texting is the one action
  // in this group that cannot fall back to the short code, so sendSms posted contactId null
  // and the server answered "A text has to be addressed to a contact." — printed underneath
  // the phone number this very tab renders. Same rule, same words as the Person panel.
  {
    key: "sms", label: "SMS",
    enabled: (c) => c.canEdit && !!(c.contact && c.contact.phone && c.contact.id) && !!(c.sms && c.sms.ready),
    hint: (c) => (!c.canEdit
      ? "You don't have permission to text contacts."
      : !(c.contact && c.contact.phone)
        ? "This contact has no phone number on file."
        : !(c.contact && c.contact.id)
          ? "This design predates contact records, so there is no contact to text yet. It gets its own contact the next time this customer submits."
          : "Texting switches on once this account's number clears carrier registration."),
  },
  // Conversations were email ONLY, until the tab above. Email remains the channel that
  // carries a document — a quote, an invoice, anything with a link — and needs an address to
  // write to: a contact with neither an email nor a design is a browsing artefact, and
  // offering a compose box that cannot send is worse than not offering one.
  // The hint is a FUNCTION because two different things disable this tab, and a fixed
  // string told the wrong story: a rep without contacts:edit was shown "this contact has no
  // email address" while the address sat rendered directly above it. A tooltip that blames
  // the data for a permissions problem sends someone off editing a contact that is fine.
  // The hint is a FUNCTION because two different things disable this tab, and a fixed
  // string told the wrong story: a rep without contacts:edit was shown "this contact has no
  // email address" while the address sat rendered directly above it. A tooltip that blames
  // the data for a permissions problem sends someone off editing a contact that is fine.
  {
    key: "email", label: "Email",
    enabled: (c) => c.canEdit && !!(c.contact && c.contact.email),
    hint: (c) => (c.canEdit
      ? "This contact has no email address on file."
      : "You don't have permission to email contacts."),
  },
  // TWO NAMES THAT SAY WHOSE FILES THEY ARE. Carolyn spent the longest stretch of the
  // 2026-08-26 call on this (20:08–26:45): "documents is what we create ... customer files
  // is like customer files", and "I don't want it all mixed together."
  //
  // "Documents" and "Files" are the same word twice — neither tells you which pile you are
  // looking at. Design Documents is what WE generated (quote PDFs, floor plans, invoices);
  // Customer Uploads is what THEY sent us. The names now carry the distinction, so the two
  // can never read as interchangeable tabs.
  // Live since migration 151. The hint it used to carry — "arrives with customer file
  // storage; nothing they send is lost in the meantime, it is still on the email" — was a
  // promise, and this is it kept. Only a contact record has somewhere to put a file: a
  // design's uploads belong to the person, not to one of their quotes.
  {
    key: "files", label: "Customer Uploads",
    enabled: (c) => c.canEdit && !!(c.contact && c.contact.id),
    hint: (c) => (c.canEdit
      ? "This design has no contact record yet, so there is nowhere to file an upload."
      : "You don't have permission to add files to contacts."),
  },
  // NO "Design Documents" TAB. Carolyn, 2026-08-26 24:01, having found the same documents
  // listed both here and in History: "the top part is about things to do. The bottom part is
  // about history … instead of in two places", and at 26:29 — "this shows all of the past
  // emails … all of the past notes, all of the past activities, all of that down here. Up
  // here is where you set what you're going to do."
  //
  // A quote PDF is not something you DO. So the list moved into the History feed under the
  // Documents chip, which now carries the files themselves (crmFeed emits `quote_pdf` and
  // `floor_plan` with a url) instead of only the events describing them.
  { key: "invoice", label: "Invoice", when: (c) => c.kind === "design", enabled: (c) => c.isAdmin && normStatus(c.record && c.record.status) === "accepted" },
];

// History chips. `types` is the SAME vocabulary the server emits (see _shared/crmFeed.ts's
// CRM_FEED_TYPES), so a chip can never ask for a type that does not exist — the
// RANK/STATUS_RANK class of bug, headed off rather than repeated.
const CRM_CHIPS = [
  { key: "all", label: "All", types: null },
  { key: "activities", label: "Activities", types: ["activity"] },
  { key: "notes", label: "Notes", types: ["note"] },
  // Both directions under one chip. Carolyn: "I want to be able to see my emails and only
  // emails in a quick and easy way" — a conversation split across two filters is not that.
  { key: "emails", label: "Emails", types: ["email", "email_in"] },
  // Texts, both directions, one chip — the Emails-chip precedent, and for the same reason.
  // Shown only once the account can actually text: a permanently empty filter teaches
  // people the chip is broken. Mirrors CRM_FEED_TYPES.message; keep the two identical.
  { key: "messages", label: "Messages", types: ["sms", "sms_in"], when: (c) => !!(c.sms && c.sms.ready) },
  // Where the documents live now — ours AND theirs, one list, because "I don't want it all
  // mixed together" was about the two NAMES being interchangeable, not about them being far
  // apart. Mirrors CRM_FEED_TYPES.document; keep the two identical.
  { key: "documents", label: "Documents", types: ["change_order", "invoice_created", "invoice_sent", "quote_pdf", "floor_plan", "customer_file"] },
  { key: "deals", label: "Deals", types: ["design_created", "design_version", "accepted", "quote_opened"], when: (c) => c.kind === "contact" },
  { key: "invoices", label: "Invoices", types: ["invoice_created", "invoice_sent"], when: (c) => c.kind === "design" },
  // Everything that happened, not three types two of which were never emitted — see the
  // CRM_FEED_TYPES.changelog comment in _shared/crmFeed.ts for why this read 0 on Carolyn's
  // screen. Keep the two lists identical.
  { key: "changelog", label: "Changelog", types: ["design_created", "design_version", "accepted", "quote_opened",
    "change_order", "invoice_created", "invoice_sent", "lead_captured", "field_change"] },
];

// The stage bar. Carolyn's own stage names, from her Pipedrive screen.
//
// ⚠️ `kind` is the machine-readable half and the ONLY thing anything keys on. Names are
// tenant-editable and DO get renamed — the Monday "Shipped" -> "Completed" rename stalled
// every feature-request sync for a day, and 087 wrote the same lesson down for the build
// schedule. Automation keys on kind, never on the name.
const CRM_STAGES = [
  { kind: "new", name: "Qualified" },
  { kind: "working", name: "Demo Scheduled" },
  { kind: "quoted", name: "Proposal Made" },
  { kind: "won", name: "Contract Signed" },
  { kind: "invoiced", name: "Invoiced" },
  { kind: "delivered", name: "Delivered" },
];
// Derived from the status the system can PROVE. A rep may not drag a deal into "Won" —
// accepting the quote is what does that. This is what stops a second source of truth for
// revenue existing alongside the real one.
const CRM_STAGE_FOR_STATUS = {
  draft: "new", sent: "quoted", accepted: "won", invoiced: "invoiced", delivered: "delivered",
};

// ⚠️ THE ROWS ARE CHEVRON RAILS NOW, NOT DOTS. Ahsan, 2026-09-02, looking at the shipped
// screen: "instead of the dotted pipeline stages for build and delivery can you do similar
// to the main pipeline stage with the same style and length but different color?" The dots
// won the argument on the call because three rails of stage NAMES read as eighteen words;
// what he saw was that a 7px dot beside a full-width chevron rail reads as a lesser thing,
// not a compact one. So the ladders share one geometry and differ only in hue.
//
// The rail below is the single source of that geometry -- CrmStageBar renders it too, so
// "the same style" cannot drift the next time one of them is touched.
const CRM_RAIL_TONES = {
  // Sales keeps ACCENT on purpose. The rail on a deal IS the sales ladder; giving the
  // contact's sales row a second colour would say the two were different things.
  sales:    { on: ACCENT,    past: "#DDD6FE" },
  // Build and delivery are drawn from the palette the app already owns -- #1B7895 is the
  // header gradient's other stop, not a new colour. An amber delivery row was tried first and
  // it OUT-SHOUTED the sales stage it sits under: at this lightness orange carries far more
  // chroma than the brand purple, so the least important rail read as the loudest.
  build:    { on: "#1B7895", past: "#CFFAFE" },  // brand blue
  delivery: { on: "#15803D", past: "#DCFCE7" },  // green -- the ladder ends in "Delivered"
};
const CRM_RAIL_IDLE = { bg: "#F1F5F9", fg: "#94A3B8" };

// ⚠️ idx === null is NOT STARTED, which is not stage zero -- every chevron stays idle
// rather than filling the first one, because filling it would claim the building is in it.
// A building that has never been scheduled is not "in the first stage".
function CrmChevronRail({ stages, idx = null, tone, title = null }) {
  const t = tone || CRM_RAIL_TONES.sales;
  return (
    <div style={{ display: "flex", gap: 2, flexWrap: "wrap", flex: "1 1 auto", minWidth: 0 }}>
      {stages.map((s, i) => (
        // ⚠️ THE NAME LEADS THE TOOLTIP, and that is not decoration. Build stage names are
        // tenant-authored and uncapped, so a long one can be narrowed by the flex basis until
        // the chevron's clipPath eats its ends; hover is then the only way to read it whole.
        // The dot version carried title={s.name} for exactly that reason and the first draft
        // of this rail dropped it, keeping only the status word.
        <div key={i}
          title={`${s.name} — ${idx == null ? (title || "Not started") : i <= idx ? "Reached" : "Not yet"}`}
          style={{
            // ⚠️ NO minWidth HERE ON PURPOSE. `min-width: 0` would let a chevron shrink past
            // its longest word, and since clipPath crops rather than scrolls, the word would
            // lose its ends with nothing to reveal them. The default `min-width: auto` keeps a
            // min-content floor: the rail wraps to another line instead of cropping. The
            // original CrmStageBar never set it either, so this is parity, not a new rule.
            flex: "1 1 90px", padding: "5px 10px", fontSize: 11, fontWeight: 700, textAlign: "center",
            background: idx == null ? CRM_RAIL_IDLE.bg : i < idx ? t.past : i === idx ? t.on : CRM_RAIL_IDLE.bg,
            color: idx == null ? CRM_RAIL_IDLE.fg : i === idx ? "#FFF" : i < idx ? t.on : CRM_RAIL_IDLE.fg,
            clipPath: "polygon(0 0, calc(100% - 8px) 0, 100% 50%, calc(100% - 8px) 100%, 0 100%, 8px 50%)",
          }}>
          {s.name}
        </div>
      ))}
    </div>
  );
}

// -- THE MULTI-PIPELINE BAR ----------------------------------------------------------
// Carolyn wanted the stage rail repeated for build and delivery -- "we essentially can have
// three rows there" (2026-08-28 @24:48). That is now literally what this is: one rail per
// ladder, same chevrons, same height, same right edge, coloured per ladder.
//
// ⚠️ The chevron rail on a DEAL stays exactly as it was. She said plainly "I like this
// pipeline up here", and this bar carries the ladders it does not already show rather than
// replacing something she praised. A contact has no chevron -- it may have several deals --
// so there it carries all three.
//
// The name is kept from the dot era so every caller and every grep still finds it.
function CrmStageDots({ rows }) {
  const live = (rows || []).filter((r) => r && r.stages && r.stages.length);
  if (!live.length) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 12 }}>
      {live.map((r) => (
        <div key={r.key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 58, flexShrink: 0, fontSize: 11, color: "#94A3B8", fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.3 }}>{r.label}</span>
          <CrmChevronRail stages={r.stages} idx={r.idx} tone={CRM_RAIL_TONES[r.key]}
            title={r.idx == null ? (r.emptyLabel || "Not started") : null} />
        </div>
      ))}
    </div>
  );
}

function CrmStageBar({ status }) {
  const at = CRM_STAGE_FOR_STATUS[normStatus(status)] || "new";
  const idx = Math.max(0, CRM_STAGES.findIndex((s) => s.kind === at));
  return (
    <div style={{ display: "flex", marginBottom: 12 }}>
      <CrmChevronRail stages={CRM_STAGES} idx={idx} tone={CRM_RAIL_TONES.sales} />
    </div>
  );
}

// The record page. One component, two contexts, driven entirely by the registries above.
//
// ⚠️ IT MAKES EXACTLY ONE FETCH, and never a direct sb.from(). designs/payments RLS is
// scoped to current_client_id(), so in operator view-as a direct read returns NOTHING —
// which is precisely why DesignsTable and LeadsTable take a fetchDesigns prop wired to
// operator-portal. Going through portal-settings means resolveTenant handles
// targetClientId and app_operators for free, and there is no second code path to keep true.
function CrmRecord({ kind, recordId, isAdmin = false, canEdit = false, onBack, onNavigate, onOpenDesign , onOpenOrder = null }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [tab, setTab] = useState("note");
  const [chip, setChip] = useState("all");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [mail, setMail] = useState({ subject: "", body: "" });
  const [mailMsg, setMailMsg] = useState(null);
  // ⚠️ These live in the TOP hook block, not beside sendSms below. CrmRecord returns early
  // on `!data`, so a hook declared next to its handler runs only on the renders that get
  // past the guard — React #310, and the whole record page goes white the instant its data
  // arrives. That shipped once (13ca37e) and was caught before release; do not move them.
  const [text, setText] = useState("");
  // Customer Uploads. In the top hook block with the rest — CrmRecord returns early on
  // `!data`, and a hook below that guard is React #310 and a white page (13ca37e).
  const [upBusy, setUpBusy] = useState(false);
  const [upMsg, setUpMsg] = useState(null);
  const [textMsg, setTextMsg] = useState(null);
  // Recording permission a customer gave in person — the third way into the consent record,
  // alongside the designer gate's checkbox and the customer texting first. Needed because the
  // back catalogue predates consent entirely and is otherwise unreachable.
  const [consentOpen, setConsentOpen] = useState(false);
  const [consentTicked, setConsentTicked] = useState(false);
  const [consentNote, setConsentNote] = useState("");
  const [act, setAct] = useState({ kind: "call", subject: "", dueAt: "" });
  // Note/activity/focus save failures. sendEmail already reports through mailMsg, but that
  // renders only inside the Email tab — these controls need their own slot, keyed by control
  // so a note error can't surface under Focus too. Every new attempt clears it first, so a
  // stale failure never outlives the action that follows it.
  const [opErr, setOpErr] = useState(null); // { where: "note" | "activity" | "focus" | "contact", msg }
  const [pdf, setPdf] = useState(null);     // { url, title } — the pop-up viewer
  // The person editor's state. ⚠️ IT MUST BE DECLARED HERE, ABOVE the `if (err)` and
  // `if (!data)` early returns below. A useState placed after them is skipped on the first
  // render (data is null, the component returns early) and runs on the second — React then
  // throws "Rendered more hooks than during the previous render" and the record page blanks
  // the moment its data arrives. The handlers that read this state stay down with the
  // section they serve; only the hook has to live up here.
  const [edit, setEdit] = useState(null);              // { name, phone, email } | null — null = not editing
  const [personOpen, setPersonOpen] = useState(false); // the Person card's drop-down, on a DEAL

  const load = useCallback(async () => {
    setErr(null);
    const { data: d, error } = await sb.functions.invoke("portal-settings", { body: { action: "crm_record", kind, id: recordId } });
    if (error || (d && d.error)) { setErr((error && error.message) || d.error); return; }
    setData(d);
  }, [kind, recordId]);
  useEffect(() => { load(); }, [load]);

  if (err) {
    return (
      <div style={S.card}>
        <div style={S.h2}>Not found</div>
        <p style={{ fontSize: 13, color: "#64748B" }}>{err}</p>
        <button style={S.btn()} onClick={onBack}>Back</button>
      </div>
    );
  }
  if (!data) return <div style={S.card}>Loading…</div>;

  const record = kind === "design" ? (data.designs || [])[0] : data.contact;
  const ctx = { kind, record, isAdmin, canEdit, contact: data.contact, designs: data.designs || [], sms: data.sms || null };
  const cname = (data.contact && (data.contact.name || data.contact.email || data.contact.phone)) || "Unnamed contact";
  const sel = (record && record.selections) || {};
  const title = kind === "design"
    ? ([sel.style, sel.size].filter(Boolean).join(" ") || (record && record.short_code) || "Design")
    : cname;

  const chips = CRM_CHIPS.filter((c) => !c.when || c.when(ctx));
  const active = chips.find((c) => c.key === chip) || chips[0];
  const feed = (data.feed || []).filter((e) => !active.types || active.types.indexOf(e.type) !== -1);

  const saveNote = async () => {
    const body = draft.trim();
    if (!body) return;
    setBusy(true); setOpErr(null);
    const { data: r, error } = await sb.functions.invoke("portal-settings", {
      body: {
        action: "crm_save_note", body,
        contactId: (data.contact && data.contact.id) || null,
        shortCode: kind === "design" ? recordId : null,
      },
    });
    setBusy(false);
    // A silent failure here looked exactly like a save — no message, and the note simply
    // never appeared in History. Say so, and keep the draft: nothing was saved, so clearing
    // the box would destroy the one copy of what they typed.
    const failMsg = (r && r.error) || (error ? await fnError(error) : null);
    if (failMsg) { setOpErr({ where: "note", msg: `Note not saved — ${failMsg}` }); return; }
    setDraft(""); load();
  };

  // ── EDIT THE PERSON, WITHOUT LEAVING THE PERSON ──────────────────────────────────────
  // Carolyn, 2026-08-26 11:19, circling the person card: "I want to be able to click on
  // person and be able to make changes to it right here. I don't want to switch the screen."
  //
  // ⚠️ NEVER a direct sb.from("crm_contacts").update(). This component makes exactly one
  // fetch and no direct table access on purpose: crm_contacts RLS is scoped to
  // current_client_id(), so in operator view-as a direct write silently affects nothing (or
  // the wrong tenant). Everything goes through portal-settings, which resolves the tenant.
  //
  // `edit` itself is declared with the other hooks at the top of this component — see the
  // warning there; it cannot live at this line, below the early returns.
  const startEdit = () => setEdit({
    name: (data.contact && data.contact.name) || "",
    phone: (data.contact && data.contact.phone) || "",
    email: (data.contact && data.contact.email) || "",
    // Address (166). Carolyn, 2026-08-28 @21:01: "We still need like address. You have it in
    // here, but everything that is contact related should be in here." These columns have
    // existed since 130 and were filled in from submitted designs -- the record SHOWED them
    // and only the editor could not touch them, which is why she asked "did you just specify
    // just these?" about name/phone/email.
    street: (data.contact && data.contact.street) || "",
    city: (data.contact && data.contact.city) || "",
    state: (data.contact && data.contact.state) || "",
    zip: (data.contact && data.contact.zip) || "",
  });
  const saveContact = async () => {
    if (!edit) return;
    setBusy(true); setOpErr(null);
    const { data: r, error } = await sb.functions.invoke("portal-settings", {
      body: {
        action: "crm_save_contact",
        id: (data.contact && data.contact.id) || null,
        // Sent as-typed, including "" — the server reads an empty string as "clear this
        // field", which is the one thing the anonymous-submission path cannot do.
        name: edit.name, phone: edit.phone, email: edit.email,
        street: edit.street, city: edit.city, state: edit.state, zip: edit.zip,
      },
    });
    setBusy(false);
    // Keep the form open on failure. Closing it would throw away what they typed, and the
    // duplicate-phone case is one they can actually act on once they have read it.
    const failMsg = (r && r.error) || (error ? await fnError(error) : null);
    if (failMsg) { setOpErr({ where: "contact", msg: failMsg }); return; }
    setEdit(null); load();
  };

  // The Activity tab's write. `crm_save_activity` has existed on the server (and been gated)
  // since 131, with `crm_complete_activity` to tick one off and a Focus block promising
  // "scheduled activities appear here" — but nothing in the UI could ever CREATE one, so the
  // tab was enabled and inert and Focus could only ever be empty. This is that missing half.
  const saveActivity = async () => {
    const subject = act.subject.trim();
    if (!subject) return;
    setBusy(true); setOpErr(null);
    const { data: r, error } = await sb.functions.invoke("portal-settings", {
      body: {
        action: "crm_save_activity", kind: act.kind, subject,
        // A date-only input is midday-anchored, the same trick the payments and change-order
        // screens use: UTC midnight renders as the PREVIOUS day for every US timezone.
        dueAt: act.dueAt ? new Date(act.dueAt + "T12:00:00").toISOString() : null,
        contactId: (data.contact && data.contact.id) || null,
        shortCode: kind === "design" ? recordId : null,
      },
    });
    setBusy(false);
    // Same as saveNote: a silent failure looked like a save, and the activity never showed
    // in Focus. Report it and keep the form filled — nothing was saved.
    const failMsg = (r && r.error) || (error ? await fnError(error) : null);
    if (failMsg) { setOpErr({ where: "activity", msg: `Activity not saved — ${failMsg}` }); return; }
    setAct({ kind: "call", subject: "", dueAt: "" }); load();
  };

  // Texting. Carolyn, 2026-08-26 27:02: "we probably need SMS in there, too."
  //
  // ⚠️ THE BODY CARRIES IDS, NEVER A PHONE NUMBER. The server reads the number off
  // crm_contacts and normalizes it there. Posting a number from here would let anyone with
  // a portal login text any handset from the tenant's registered number.
  // ── UPLOAD A FILE THE CUSTOMER SENT ─────────────────────────────────────────────────
  // Three steps, and the bytes never touch the edge function: ask for a signed URL (which
  // is where the quota is enforced), PUT straight to storage, then record what landed.
  //
  // The bucket has NO storage policies, so this cannot be a direct sb.storage.upload() —
  // that would 403. It also means the same code path works for an operator in view-as,
  // which a tenant-prefix policy would have broken silently. See migration 151.
  const uploadFiles = async (fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setUpBusy(true); setUpMsg(null);
    let ok = 0;
    for (const file of files) {
      try {
        const { data: signed, error: sErr } = await sb.functions.invoke("portal-settings", {
          body: {
            action: "crm_file_sign",
            contactId: (data.contact && data.contact.id) || null,
            name: file.name, size: file.size,
          },
        });
        const failSign = (signed && signed.error) || (sErr ? await fnError(sErr) : null);
        // Stop the whole run on a quota refusal — every following file would fail the same
        // way, and five identical "storage is full" messages is not five pieces of news.
        if (failSign) { setUpMsg({ err: failSign }); break; }

        const up = await sb.storage.from("customer-uploads")
          .uploadToSignedUrl(signed.path, signed.token, file, { contentType: file.type || undefined });
        if (up.error) {
          // The bucket's own MIME allow-list and 25 MB cap answer here, and the raw message
          // is unhelpful ("mime type ... is not supported"), so name the file instead.
          setUpMsg({ err: `"${file.name}" couldn't be uploaded — we take images, PDFs, Word documents and text files, up to 25 MB.` });
          break;
        }

        const { data: att, error: aErr } = await sb.functions.invoke("portal-settings", {
          body: {
            action: "crm_file_attach",
            contactId: (data.contact && data.contact.id) || null,
            shortCode: kind === "design" ? recordId : null,
            path: signed.path, name: file.name, size: file.size, mime: file.type || null,
          },
        });
        const failAtt = (att && att.error) || (aErr ? await fnError(aErr) : null);
        // The object is in the bucket but unlisted. Say so rather than claiming success —
        // an upload nobody can find is worse than one that visibly failed.
        if (failAtt) { setUpMsg({ err: `"${file.name}" uploaded but couldn't be filed — ${failAtt}` }); break; }
        ok += 1;
      } catch (e) {
        setUpMsg({ err: `"${file.name}" couldn't be uploaded.` });
        break;
      }
    }
    setUpBusy(false);
    if (ok) { setUpMsg((m) => (m && m.err) ? m : { ok: `${ok} file${ok === 1 ? "" : "s"} added.` }); load(); }
  };

  const deleteFile = async (f) => {
    if (!window.confirm(`Delete "${f.name}"? This removes the customer's file for good.`)) return;
    setUpBusy(true); setUpMsg(null);
    const { data: r, error } = await sb.functions.invoke("portal-settings", {
      body: { action: "crm_file_delete", id: f.id },
    });
    setUpBusy(false);
    const fail = (r && r.error) || (error ? await fnError(error) : null);
    if (fail) { setUpMsg({ err: fail }); return; }
    load();
  };

  // ⚠️ THE SENTENCE IS THE EVIDENCE. It is stored verbatim as what this person certified, so
  // it has to read as an assertion someone would stand behind — not UI chrome. Same rule the
  // designer gate follows for the customer's own tick.
  const CONSENT_ATTESTATION =
    "I confirm this customer gave us permission to text them about their quote and building, " +
    "and that I recorded it accurately.";

  const recordConsent = async () => {
    if (!consentTicked) return;
    setBusy(true); setTextMsg(null);
    const { data: r, error } = await sb.functions.invoke("portal-settings", {
      body: {
        action: "crm_record_consent",
        contactId: (data.contact && data.contact.id) || null,
        attestation: CONSENT_ATTESTATION,
        note: consentNote.trim() || undefined,
      },
    });
    setBusy(false);
    const fail = (r && r.error) || (error ? await fnError(error) : null);
    if (fail) { setTextMsg({ err: fail }); return; }
    setConsentOpen(false); setConsentTicked(false); setConsentNote("");
    setTextMsg({ ok: "Permission recorded." });
    load();
  };

  const sendSms = async () => {
    const body = text.trim();
    if (!body) return;
    setBusy(true); setTextMsg(null);
    const { data: r, error } = await sb.functions.invoke("portal-settings", {
      body: {
        action: "crm_send_sms", body,
        contactId: (data.contact && data.contact.id) || null,
        shortCode: kind === "design" ? recordId : null,
      },
    });
    setBusy(false);
    // Keep the draft on failure. Nothing was sent, so clearing the box would destroy the
    // one copy of what they wrote — and "they have opted out" is a message worth reading
    // before the words disappear.
    const failMsg = (r && r.error) || (error ? await fnError(error) : null);
    if (failMsg) { setTextMsg({ err: failMsg }); return; }
    setText(""); setTextMsg({ ok: "Sent." }); load();
  };

  const sendEmail = async () => {
    const subject = mail.subject.trim(), body = mail.body.trim();
    if (!subject || !body) return;
    setBusy(true); setMailMsg(null);
    const { data: r, error } = await sb.functions.invoke("portal-settings", {
      body: {
        action: "crm_send_email",
        to: data.contact && data.contact.email,
        subject, body,
        contactId: (data.contact && data.contact.id) || null,
        shortCode: kind === "design" ? recordId : null,
      },
    });
    setBusy(false);
    // The server authors every sentence here — a domain that is not verified yet, a
    // provider that is dark, a bounce. Restating them in the browser is how the two drift.
    const err = (r && r.error) || (error && error.message);
    if (err) { setMailMsg({ err }); return; }
    setMail({ subject: "", body: "" });
    setMailMsg({ ok: "Sent." });
    load();
  };

  const renderSection = (key) => {
    if (key === "summary") {
      // Editing needs a REAL contact row. On an old design record predating the 130
      // backfill the server synthesizes `contact` from the design's jsonb blob with a null
      // id (portal-settings), and there is nothing to write to — so the pencil is absent
      // rather than present and broken.
      const canEditContact = canEdit && kind === "contact" && !!(data.contact && data.contact.id);
      return kind === "contact" ? (
        edit ? (
          <div style={{ fontSize: 13 }}>
            <span style={S.lbl}>Name</span>
            <input style={{ ...S.input, marginBottom: 7 }} value={edit.name} placeholder="Their name"
              onChange={(e) => setEdit((p) => ({ ...p, name: e.target.value }))} />
            <span style={S.lbl}>Email</span>
            <input style={{ ...S.input, marginBottom: 7 }} value={edit.email} placeholder="name@example.com"
              onChange={(e) => setEdit((p) => ({ ...p, email: e.target.value }))} />
            <span style={S.lbl}>Phone</span>
            <input style={{ ...S.input, marginBottom: 7 }} value={edit.phone} placeholder="(816) 555-0100"
              onChange={(e) => setEdit((p) => ({ ...p, phone: e.target.value }))} />
            <span style={S.lbl}>Street</span>
            <input style={{ ...S.input, marginBottom: 7 }} value={edit.street} placeholder="412 Ladder Lane"
              onChange={(e) => setEdit((p) => ({ ...p, street: e.target.value }))} />
            <div style={{ display: "flex", gap: 7 }}>
              <div style={{ flex: "2 1 0", minWidth: 0 }}>
                <span style={S.lbl}>City</span>
                <input style={{ ...S.input, marginBottom: 7, width: "100%", boxSizing: "border-box" }} value={edit.city} placeholder="Springfield"
                  onChange={(e) => setEdit((p) => ({ ...p, city: e.target.value }))} />
              </div>
              <div style={{ flex: "1 1 0", minWidth: 0 }}>
                <span style={S.lbl}>State</span>
                <input style={{ ...S.input, marginBottom: 7, width: "100%", boxSizing: "border-box" }} value={edit.state} placeholder="MO"
                  onChange={(e) => setEdit((p) => ({ ...p, state: e.target.value }))} />
              </div>
              <div style={{ flex: "1 1 0", minWidth: 0 }}>
                <span style={S.lbl}>ZIP</span>
                <input style={{ ...S.input, marginBottom: 7, width: "100%", boxSizing: "border-box" }} value={edit.zip} placeholder="65801"
                  onChange={(e) => setEdit((p) => ({ ...p, zip: e.target.value }))} />
              </div>
            </div>
            {opErr && opErr.where === "contact" && <div style={{ ...S.err, marginBottom: 7 }}>{opErr.msg}</div>}
            <div style={{ display: "flex", gap: 7 }}>
              <button style={{ ...S.btn(ACCENT, "#FFF"), padding: "6px 13px", fontSize: 12.5, opacity: busy ? 0.6 : 1 }}
                disabled={busy} onClick={saveContact}>{busy ? "Saving…" : "Save"}</button>
              <button style={{ ...S.btn("#F1F5F9", "#334155"), padding: "6px 13px", fontSize: 12.5 }}
                disabled={busy} onClick={() => { setEdit(null); setOpErr(null); }}>Cancel</button>
            </div>
            <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 7, lineHeight: 1.5 }}>
              Clearing a field empties it. Every change is recorded under Changelog.
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 13, color: "#475569" }}>
            <div>{data.contact.email || <span style={{ color: "#94A3B8" }}>No email</span>}</div>
            <div>{data.contact.phone || <span style={{ color: "#94A3B8" }}>No phone</span>}</div>
            {canEditContact && (
              <button type="button" onClick={startEdit}
                title="Edit this contact's name, email and phone"
                style={{ background: "none", border: "none", padding: 0, marginTop: 6, cursor: "pointer", fontFamily: "inherit", fontSize: 12.5, fontWeight: 700, color: ACCENT }}>
                ✎ Edit
              </button>
            )}
          </div>
        )
      ) : (
        <div style={{ fontSize: 13, color: "#475569" }}>
          <div>Estimate {record.ss_quote_number || record.ghl_estimate_number || "—"}</div>
        </div>
      );
    }
    if (key === "details") {
      return kind === "contact" ? (
        <div style={{ fontSize: 13, color: "#475569" }}>First seen {fmtDate(data.contact.first_seen_at)}</div>
      ) : (
        <div style={{ fontSize: 13, color: "#475569" }}>{sel.style || "—"} · {sel.size || "—"}</div>
      );
    }
    if (key === "deals") {
      return (
        <div>
          <div style={{ fontSize: 11, color: "#94A3B8", fontWeight: 800, marginBottom: 6 }}>OPEN DEALS ({(data.designs || []).length})</div>
          {(data.designs || []).map((d) => (
            <button key={d.short_code} onClick={() => onNavigate("design", d.short_code)}
              style={{ display: "block", width: "100%", textAlign: "left", background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 6, padding: "7px 9px", marginBottom: 5, cursor: "pointer" }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: ACCENT }}>
                {[(d.selections || {}).style, (d.selections || {}).size].filter(Boolean).join(" ") || d.short_code}
              </div>
              <div style={{ fontSize: 11, color: "#64748B" }}>{fmtDate(d.created_at)}</div>
            </button>
          ))}
          {(data.designs || []).length === 0 && <div style={{ fontSize: 12, color: "#94A3B8" }}>No designs yet.</div>}
        </div>
      );
    }
    // ── THE THREE FULFILMENT CARDS ──────────────────────────────────────────────────
    // ⚠️ ABSENT IS NOT EMPTY, three times over, and each has a different cause:
    //   undefined  -> this person cannot see that area at all (a sales rep holds
    //                 contacts:view and no build_schedule:view), OR the server that supplies
    //                 the field has not been deployed yet. Either way, saying "nothing
    //                 scheduled" would be a claim we cannot support.
    //   []         -> they can see it and there genuinely is nothing.
    // The orders card carries the same distinction for the same reason; this is that rule
    // applied three more times rather than a new idea.
    if (key === "build") {
      if (!data.build) return <div style={{ fontSize: 12, color: "#94A3B8" }}>Not shown for your role.</div>;
      if (!data.build.length) return <div style={{ fontSize: 12, color: "#94A3B8" }}>Not on the build schedule yet.</div>;
      const stageById = new Map((data.stages || []).map((s) => [s.id, s]));
      return (
        <div>
          {data.build.map((j) => {
            const st = stageById.get(j.stage_id);
            return (
              <div key={j.id} style={{ background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 6, padding: "7px 9px", marginBottom: 5 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#1E293B" }}>
                  {st ? st.name : "Unscheduled"}{j.serial ? ` · ${j.serial}` : ""}
                </div>
                <div style={{ fontSize: 11, color: "#64748B" }}>
                  {j.completed_at ? `Built ${fmtDate(j.completed_at)}` : j.due_date ? `Due ${fmtDate(j.due_date)}` : "No date set"}
                </div>
              </div>
            );
          })}
        </div>
      );
    }
    if (key === "delivery") {
      if (!data.delivery) return <div style={{ fontSize: 12, color: "#94A3B8" }}>Not shown for your role.</div>;
      if (!data.delivery.length) return <div style={{ fontSize: 12, color: "#94A3B8" }}>Not scheduled for delivery yet.</div>;
      return (
        <div>
          {data.delivery.map((s) => {
            const L = s.load || null;
            const label = s.delivered_at ? "Delivered" : L ? (CRM_LOAD_LABEL[L.status] || L.status) : "On a load";
            return (
              <div key={s.id} style={{ background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 6, padding: "7px 9px", marginBottom: 5 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#1E293B" }}>{label}{L && L.load_no ? ` · Load #${L.load_no}` : ""}</div>
                <div style={{ fontSize: 11, color: "#64748B" }}>
                  {s.delivered_at ? fmtDate(s.delivered_at) : L && L.load_date ? `Out ${fmtDate(L.load_date)}` : "No date set"}
                </div>
              </div>
            );
          })}
        </div>
      );
    }
    if (key === "repairs") {
      if (!data.repairs) return <div style={{ fontSize: 12, color: "#94A3B8" }}>Not shown for your role.</div>;
      if (!data.repairs.length) return <div style={{ fontSize: 12, color: "#94A3B8" }}>No repairs.</div>;
      return (
        <div>
          {data.repairs.map((r) => (
            <div key={r.id} style={{ background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 6, padding: "7px 9px", marginBottom: 5 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#1E293B" }}>#{r.repair_no} · {r.status}</div>
              <div style={{ fontSize: 11, color: "#64748B" }}>
                {r.description ? String(r.description).slice(0, 90) : "No description"}
                {r.requested_at ? ` · ${fmtDate(r.requested_at)}` : ""}
              </div>
            </div>
          ))}
        </div>
      );
    }
    if (key === "orders") {
      // ⚠️ ABSENT is not EMPTY. The frontend auto-deploys on push; the edge function that
      // supplies `orders` is deployed separately, so between those two moments the field is
      // undefined. Rendering "No orders yet" then would state, on a contact who has bought
      // two buildings, that they have bought nothing — the same class of lie the Orders
      // money-pending state exists to avoid. Undefined says the server is behind; [] says
      // there are genuinely none.
      if (!data.orders) {
        return <div style={{ fontSize: 12, color: "#94A3B8" }}>Orders appear here once the server update lands.</div>;
      }
      const os = data.orders;
      // No link out yet: Orders is its own tab with its own row-click detail, and there is
      // no /portal/orders/<id> route to deep-link to. Showing the order number, what it was
      // for and where it stands answers her question ("have they bought anything, and is it
      // paid") without inventing a route that would then need its own back button.
      return (
        <div>
          {os.map((o) => {
            const d = (data.designs || []).find((x) => x.short_code === o.short_code);
            const what = d ? [(d.selections || {}).style, (d.selections || {}).size].filter(Boolean).join(" ") : "";
            // THE LINK OUT EXISTS NOW. This card used to carry a comment explaining why it
            // could not link anywhere -- "there is no /portal/orders/<id> route to deep-link
            // to" -- which was true until the order detail got its own URL in this change.
            const Tag = onOpenOrder ? "button" : "div";
            return (
              <Tag key={o.id} onClick={onOpenOrder ? () => onOpenOrder(o.id) : undefined}
                style={{ display: "block", width: "100%", textAlign: "left", background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 6, padding: "7px 9px", marginBottom: 5, cursor: onOpenOrder ? "pointer" : "default" }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: onOpenOrder ? ACCENT : "#1E293B" }}>
                  #{o.order_no}{what ? ` · ${what}` : ""}
                </div>
                <div style={{ fontSize: 11, color: "#64748B" }}>
                  {fmtDate(o.ordered_at)}
                  {o.total_cents != null ? ` · $${(o.total_cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : ""}
                </div>
              </Tag>
            );
          })}
          {os.length === 0 && <div style={{ fontSize: 12, color: "#94A3B8" }}>No orders yet. One appears when a quote is signed.</div>}
        </div>
      );
    }
    if (key === "person") {
      if (!data.contact) return <div style={{ fontSize: 12, color: "#94A3B8" }}>No contact linked.</div>;
      // THE CARD OPENS; THE ARROW LEAVES. Ahsan, 2026-08-28: "if I click the card itself it
      // shows a dropdown and in the dropdown it has its personal information, the email,
      // contact and all of that stuff, which should be editable in here … add a small arrow
      // on the right side of the card [that] takes me to the contact page."
      //
      // The whole card used to be one navigate button, so the commonest edit on this screen
      // — fixing a typo in the customer's email before the quote goes out — cost a page
      // change and a page change back, which is the same complaint Carolyn made about the
      // contact side on 08-26. Both destinations survive; they are just no longer the same
      // click. The arrow is a separate <button> rather than a corner of the card because a
      // nested button inside a button is invalid HTML and React will not render it.
      const cid = data.contact.id || null;
      // Same rule as the contact-side pencil: an old design predating the 130 backfill has
      // a SYNTHESIZED contact (id null) built from the design's jsonb blob, and there is no
      // row to write to. The panel still opens and still shows what is on file — it just
      // says why it cannot be edited instead of offering inputs that would 400.
      const canEditContact = canEdit && !!cid;
      const openPanel = () => {
        if (personOpen) { setPersonOpen(false); setEdit(null); setOpErr(null); return; }
        setPersonOpen(true);
        // Opening IS starting the edit when they are allowed to edit — Ahsan asked for the
        // fields to be editable "in here", and a second click on a pencil to reach them is
        // the friction this change exists to remove. Nothing is written until Save.
        if (canEditContact) startEdit();
      };
      const ro = (label, value) => (
        <div style={{ marginBottom: 6 }}>
          <span style={S.lbl}>{label}</span>
          <div style={{ fontSize: 13, color: value ? "#1E293B" : "#94A3B8", fontWeight: 600, wordBreak: "break-word" }}>{value || "—"}</div>
        </div>
      );
      return (
        <div>
          <div style={{ display: "flex", alignItems: "stretch", background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 6, overflow: "hidden" }}>
            <button type="button" onClick={openPanel} aria-expanded={personOpen}
              title={personOpen ? "Hide this person's details" : "Show and edit this person's details"}
              style={{ flex: 1, minWidth: 0, textAlign: "left", background: "transparent", border: "none", padding: "7px 9px", cursor: "pointer", fontFamily: "inherit" }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: ACCENT, display: "flex", alignItems: "center", gap: 5 }}>
                <span style={{ color: "#94A3B8", fontSize: 10 }}>{personOpen ? "▾" : "▸"}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cname}</span>
              </div>
              <div style={{ fontSize: 11, color: "#64748B", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {data.contact.email || data.contact.phone || "—"}
              </div>
            </button>
            {cid && (
              <button type="button" onClick={() => onNavigate("contact", cid)}
                title="Open the full contact record" aria-label={`Open the contact record for ${cname}`}
                style={{ background: "transparent", border: "none", borderLeft: "1px solid #E2E8F0", padding: "0 11px", cursor: "pointer", color: ACCENT, fontSize: 15, fontWeight: 700, fontFamily: "inherit", lineHeight: 1 }}>
                ›
              </button>
            )}
          </div>
          {personOpen && (
            <div style={{ border: "1px solid #E2E8F0", borderTop: "none", borderRadius: "0 0 6px 6px", padding: "9px 9px 8px", marginTop: -1 }}>
              {edit && canEditContact ? (
                <div style={{ fontSize: 13 }}>
                  <span style={S.lbl}>Name</span>
                  <input style={{ ...S.input, marginBottom: 7 }} value={edit.name} placeholder="Their name"
                    onChange={(e) => setEdit((p) => ({ ...p, name: e.target.value }))} />
                  <span style={S.lbl}>Email</span>
                  <input style={{ ...S.input, marginBottom: 7 }} value={edit.email} placeholder="name@example.com"
                    onChange={(e) => setEdit((p) => ({ ...p, email: e.target.value }))} />
                  <span style={S.lbl}>Phone</span>
                  <input style={{ ...S.input, marginBottom: 7 }} value={edit.phone} placeholder="(816) 555-0100"
                    onChange={(e) => setEdit((p) => ({ ...p, phone: e.target.value }))} />
                  <span style={S.lbl}>Street</span>
                  <input style={{ ...S.input, marginBottom: 7 }} value={edit.street} placeholder="412 Ladder Lane"
                    onChange={(e) => setEdit((p) => ({ ...p, street: e.target.value }))} />
                  <div style={{ display: "flex", gap: 7 }}>
                    <div style={{ flex: "2 1 0", minWidth: 0 }}>
                      <span style={S.lbl}>City</span>
                      <input style={{ ...S.input, marginBottom: 7, width: "100%", boxSizing: "border-box" }} value={edit.city} placeholder="Springfield"
                        onChange={(e) => setEdit((p) => ({ ...p, city: e.target.value }))} />
                    </div>
                    <div style={{ flex: "1 1 0", minWidth: 0 }}>
                      <span style={S.lbl}>State</span>
                      <input style={{ ...S.input, marginBottom: 7, width: "100%", boxSizing: "border-box" }} value={edit.state} placeholder="MO"
                        onChange={(e) => setEdit((p) => ({ ...p, state: e.target.value }))} />
                    </div>
                    <div style={{ flex: "1 1 0", minWidth: 0 }}>
                      <span style={S.lbl}>ZIP</span>
                      <input style={{ ...S.input, marginBottom: 7, width: "100%", boxSizing: "border-box" }} value={edit.zip} placeholder="65801"
                        onChange={(e) => setEdit((p) => ({ ...p, zip: e.target.value }))} />
                    </div>
                  </div>
                  {opErr && opErr.where === "contact" && <div style={{ ...S.err, marginBottom: 7 }}>{opErr.msg}</div>}
                  <div style={{ display: "flex", gap: 7 }}>
                    <button style={{ ...S.btn(ACCENT, "#FFF"), padding: "6px 13px", fontSize: 12.5, opacity: busy ? 0.6 : 1 }}
                      disabled={busy} onClick={saveContact}>{busy ? "Saving…" : "Save"}</button>
                    <button style={{ ...S.btn("#F1F5F9", "#334155"), padding: "6px 13px", fontSize: 12.5 }}
                      disabled={busy} onClick={() => { setEdit(null); setOpErr(null); setPersonOpen(false); }}>Cancel</button>
                  </div>
                  <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 7, lineHeight: 1.5 }}>
                    This edits the customer everywhere, not just on this deal. Clearing a field empties it, and every change is recorded under Changelog.
                  </div>
                </div>
              ) : (
                <div>
                  {ro("Name", data.contact.name)}
                  {ro("Email", data.contact.email)}
                  {ro("Phone", data.contact.phone)}
                  {data.contact.first_seen_at && ro("First seen", fmtDate(data.contact.first_seen_at))}
                  {/* Reached two ways: no permission / no contact row (the messages), or a
                      save that just landed — `saveContact` clears `edit` and reloads, so the
                      panel stays open showing the NEW values. That re-read is the receipt;
                      the pencil is here so a second correction doesn't need the card closed
                      and re-opened. */}
                  {canEditContact ? (
                    <button type="button" onClick={startEdit}
                      title="Edit this contact's name, email and phone"
                      style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit", fontSize: 12.5, fontWeight: 700, color: ACCENT }}>
                      ✎ Edit
                    </button>
                  ) : (
                    <div style={{ fontSize: 11, color: "#94A3B8", lineHeight: 1.5 }}>
                      {cid
                        ? "You don't have permission to edit contacts."
                        : "This design predates contact records, so there is nothing here to edit yet. It gets its own contact the next time this customer submits."}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      );
    }
    if (key === "overview") {
      const last = (data.feed || [])[0];
      return (
        <div style={{ fontSize: 13, color: "#475569" }}>
          <div>Created {fmtDate(record && (record.created_at || record.first_seen_at))}</div>
          <div>Last activity {last ? fmtDate(last.at) : "—"}</div>
        </div>
      );
    }
    return null;
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
        <button style={{ ...S.btn("#FFF", ACCENT), border: "1px solid #E2E8F0" }} onClick={onBack}>Back</button>
        <div style={{ fontSize: 20, fontWeight: 800, color: "#1E293B" }}>{title}</div>
        {kind === "design" && onOpenDesign && (
          <div style={{ marginLeft: "auto" }}>
            {/* IN-PORTAL ONLY. Linking to the public ?id= page fires capture-lead and draft
                saves, corrupting the very activity this page reports on. */}
            <button style={S.btn(ACCENT, "#FFF")} onClick={() => onOpenDesign(recordId)}>Open in designer</button>
          </div>
        )}
      </div>
      {kind === "design" && <CrmStageBar status={record.status} />}
      {(() => {
        // SALES: on a contact only (the deal already has its chevron rail above). A contact
        // can hold several deals, so the ladder shown is the one the NEWEST deal is on --
        // designs come back newest-first from crm_record.
        const newest = (data.designs || [])[0];
        const salesIdx = newest
          ? Math.max(0, CRM_STAGES.findIndex((s) => s.kind === (CRM_STAGE_FOR_STATUS[normStatus(newest.status)] || "new")))
          : null;
        // BUILD: the tenant's OWN stages, in their own order. Names are editable, so the
        // ladder is whatever this builder configured, never a hard-coded list.
        const bStages = (data.stages || []).map((s) => ({ name: s.name }));
        const firstJob = (data.build || [])[0];
        const bIdx = firstJob
          ? (() => { const i = (data.stages || []).findIndex((s) => s.id === firstJob.stage_id); return i < 0 ? null : i; })()
          : null;
        // DELIVERY: the fixed three-value ladder on delivery_loads. A stop with a
        // delivered_at is delivered even if its load has not been closed out.
        const stop = (data.delivery || [])[0];
        const dIdx = !stop ? null
          : stop.delivered_at ? 2
          : stop.load ? Math.max(0, ["planned", "out", "delivered"].indexOf(stop.load.status))
          : 0;
        return (
          <CrmStageDots rows={[
            kind === "contact" ? { key: "sales", label: "Sales", stages: CRM_STAGES, idx: salesIdx, emptyLabel: "No deals yet" } : null,
            data.build ? { key: "build", label: "Build", stages: bStages, idx: bIdx, emptyLabel: "Not scheduled" } : null,
            data.delivery ? { key: "delivery", label: "Delivery", stages: [{ name: "Planned" }, { name: "Out" }, { name: "Delivered" }], idx: dIdx, emptyLabel: "Not scheduled" } : null,
          ].filter(Boolean)} />
        );
      })()}

      <div style={{ display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 260px", minWidth: 240, maxWidth: 360 }}>
          {CRM_SECTIONS.filter((s) => s.when(ctx)).map((s) => (
            <div key={s.key} style={{ ...S.card, marginBottom: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.5, textTransform: "uppercase", color: "#94A3B8", marginBottom: 7 }}>{s.title}</div>
              {renderSection(s.key)}
            </div>
          ))}
        </div>

        <div style={{ flex: "3 1 420px", minWidth: 320 }}>
          <div style={S.card}>
            <div style={{ display: "flex", gap: 3, flexWrap: "wrap", borderBottom: "1px solid #E2E8F0", paddingBottom: 7, marginBottom: 9 }}>
              {CRM_TABS.filter((t) => !t.when || t.when(ctx)).map((t) => {
                const on = t.enabled(ctx);
                return (
                  <button key={t.key} disabled={!on}
                    title={on ? "" : (typeof t.hint === "function" ? t.hint(ctx) : (t.hint || "Not available yet"))}
                    onClick={() => { if (on) setTab(t.key); }}
                    style={{
                      background: tab === t.key && on ? "#EEF2FF" : "transparent",
                      color: on ? (tab === t.key ? ACCENT : "#475569") : "#CBD5E1",
                      border: "none", borderRadius: 6, padding: "5px 9px", fontSize: 12,
                      fontWeight: 700, cursor: on ? "pointer" : "not-allowed",
                    }}>{t.label}</button>
                );
              })}
            </div>

            {tab === "sms" && canEdit && data.contact && data.contact.phone && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11.5, color: "#64748B", marginBottom: 5 }}>
                  To <strong>{data.contact.phone}</strong>
                  {data.sms && data.sms.from ? <> — they see <strong>{data.sms.from}</strong>, this account&rsquo;s number.</> : null}
                </div>
                {/* Opted out is not an error state to discover by pressing Send. STOP is a
                    legal instruction, so the composer says so and offers no box. */}
                {data.sms && data.sms.optedOut ? (
                  <div style={{ ...S.err, marginBottom: 0 }}>
                    This customer replied STOP, so we can&rsquo;t text them. They can reply START to that
                    same number to opt back in.
                  </div>
                ) : (data.sms && !data.sms.consented) ? (
                  /* ⚠️ NO PERMISSION ON FILE — say so BEFORE they type, not on Send. Every
                     contact captured before the designer gate had a consent box is in this
                     state, so for now this is most of the back catalogue. The two routes the
                     customer can take are named first, because they are the ones that need no
                     claim from us; recording it by hand is offered last and deliberately
                     framed as an assertion rather than a switch. */
                  <div style={{ border: "1px solid #FDE68A", background: "#FFFBEB", borderRadius: 8, padding: "11px 13px" }}>
                    <div style={{ fontSize: 13, color: "#92400E", fontWeight: 700, marginBottom: 5 }}>
                      We don&rsquo;t have permission to text this customer yet
                    </div>
                    <div style={{ fontSize: 12.5, color: "#78350F", lineHeight: 1.55 }}>
                      They can switch it on themselves by ticking the texting box on your design
                      link, or simply by texting you first — either one is recorded automatically.
                    </div>
                    {!consentOpen ? (
                      <button type="button" onClick={() => setConsentOpen(true)}
                        style={{ ...S.btn("#FFF", "#92400E"), border: "1px solid #FDE68A", marginTop: 9 }}>
                        They already gave permission — record it
                      </button>
                    ) : (
                      <div style={{ marginTop: 10, borderTop: "1px solid #FDE68A", paddingTop: 10 }}>
                        <label style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer" }}>
                          <input type="checkbox" checked={consentTicked}
                            onChange={(e) => setConsentTicked(e.target.checked)}
                            style={{ marginTop: 2, width: 15, height: 15, flex: "0 0 auto", cursor: "pointer" }} />
                          <span style={{ fontSize: 12, color: "#78350F", lineHeight: 1.5 }}>
                            {CONSENT_ATTESTATION}
                          </span>
                        </label>
                        <input value={consentNote} onChange={(e) => setConsentNote(e.target.value)}
                          maxLength={200}
                          placeholder="How they gave it — e.g. asked us at the lot on 12 Aug (optional)"
                          style={{ ...S.input, width: "100%", boxSizing: "border-box", marginTop: 8, fontSize: 12.5 }} />
                        <div style={{ display: "flex", gap: 8, marginTop: 9, alignItems: "center", flexWrap: "wrap" }}>
                          <button type="button" style={S.btn(ACCENT, "#FFF")} disabled={busy || !consentTicked}
                            onClick={recordConsent}>
                            {busy ? "Recording…" : "Record permission"}
                          </button>
                          <button type="button" style={S.btn("#FFF", "#64748B")}
                            onClick={() => { setConsentOpen(false); setConsentTicked(false); setConsentNote(""); }}>
                            Cancel
                          </button>
                          <span style={{ fontSize: 11, color: "#92400E" }}>
                            Recorded against your name.
                          </span>
                        </div>
                      </div>
                    )}
                    {textMsg && textMsg.err && <div style={{ ...S.err, marginTop: 8, marginBottom: 0 }}>{textMsg.err}</div>}
                  </div>
                ) : (
                  <>
                    <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4}
                      maxLength={1600}
                      placeholder="Text this customer…"
                      style={{ ...S.input, width: "100%", boxSizing: "border-box", resize: "vertical" }} />
                    <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 5, flexWrap: "wrap" }}>
                      <button style={S.btn(ACCENT, "#FFF")} disabled={busy || !text.trim()} onClick={sendSms}>
                        {busy ? "Sending…" : "Send text"}
                      </button>
                      {/* Segments, not just characters. One pasted curly quote flips the whole
                          message to UCS-2 and roughly halves the per-segment budget, which is
                          how a one-segment text quietly becomes three billable ones. */}
                      {(() => {
                        const t = text;
                        // GSM-7 is effectively ASCII here; anything above it (a curly
                        // quote, an emoji, an accent) forces the whole message to UCS-2,
                        // roughly halving the per-segment budget. Written as a code scan
                        // rather than a regex so no unicode escape can be mangled on its
                        // way into this file.
                        let uni = false;
                        for (let i = 0; i < t.length; i++) { if (t.charCodeAt(i) > 127) { uni = true; break; } }
                        const per = uni ? 70 : 160, cat = uni ? 67 : 153;
                        const n = t.length === 0 ? 0 : (t.length <= per ? 1 : Math.ceil(t.length / cat));
                        return (
                          <span style={{ fontSize: 11.5, color: n > 1 ? "#92400E" : "#94A3B8" }}>
                            {t.length} character{t.length === 1 ? "" : "s"} · {n} segment{n === 1 ? "" : "s"}
                            {uni ? " (unicode)" : ""}
                          </span>
                        );
                      })()}
                      {textMsg && textMsg.ok && <span style={{ fontSize: 12.5, color: "#065F46", fontWeight: 700 }}>{textMsg.ok}</span>}
                    </div>
                    {textMsg && textMsg.err && <div style={{ ...S.err, marginTop: 7, marginBottom: 0 }}>{textMsg.err}</div>}
                  </>
                )}
              </div>
            )}
            {tab === "email" && canEdit && data.contact && data.contact.email && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11.5, color: "#64748B", marginBottom: 5 }}>
                  To <strong>{data.contact.email}</strong> — replies come back to you, not to a no-reply address.
                </div>
                <input value={mail.subject} onChange={(e) => setMail((p) => ({ ...p, subject: e.target.value }))}
                  placeholder="Subject" style={{ ...S.input, width: "100%", boxSizing: "border-box", marginBottom: 5 }} />
                <textarea value={mail.body} onChange={(e) => setMail((p) => ({ ...p, body: e.target.value }))} rows={5}
                  placeholder="Write to this customer…"
                  style={{ ...S.input, width: "100%", boxSizing: "border-box", resize: "vertical" }} />
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 5 }}>
                  <button style={S.btn(ACCENT, "#FFF")} disabled={busy || !mail.subject.trim() || !mail.body.trim()} onClick={sendEmail}>
                    {busy ? "Sending…" : "Send email"}
                  </button>
                  {mailMsg && mailMsg.ok && <span style={{ fontSize: 12.5, color: "#065F46", fontWeight: 700 }}>{mailMsg.ok}</span>}
                  {mailMsg && mailMsg.err && <span style={{ fontSize: 12.5, color: "#B91C1C", fontWeight: 700 }}>{mailMsg.err}</span>}
                </div>
              </div>
            )}
            {/* ACTIVITY. Kind first, because "call" and "deadline" read completely
                differently in the feed, and the kind is what the icon and label key on.

                NO "meeting" AND NO "lunch" CHIP. Carolyn walked this row on 2026-08-26
                (18:00): "I don't want meeting in there — we have a meeting scheduler",
                and the same for lunch. Meetings belong to the Meeting scheduler tab, and
                two ways to book the same thing is how a calendar drifts out of sync with
                itself. Ahsan confirmed both on 2026-08-27.

                The SERVER still accepts both kinds, on purpose — portal-settings' KINDS,
                labelActivity in _shared/crmFeed.ts, and migration 131's CHECK are all
                untouched. Tenants have meeting and lunch rows already logged, and a chip
                the composer no longer offers is not the same thing as a kind the history
                can no longer render. Removing them server-side would blank those rows. */}
            {tab === "activity" && canEdit && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 6 }}>
                  {["call", "task", "deadline"].map((k) => (
                    <button key={k} type="button" onClick={() => setAct((p) => ({ ...p, kind: k }))}
                      style={{
                        background: act.kind === k ? ACCENT : "#F1F5F9", color: act.kind === k ? "#FFF" : "#475569",
                        border: "none", borderRadius: 999, padding: "3px 11px", fontSize: 11.5, fontWeight: 700,
                        cursor: "pointer", textTransform: "capitalize",
                      }}>{k}</button>
                  ))}
                </div>
                <input value={act.subject} onChange={(e) => setAct((p) => ({ ...p, subject: e.target.value }))}
                  placeholder="What needs doing? e.g. Call back about the loft"
                  style={{ ...S.input, width: "100%", boxSizing: "border-box", marginBottom: 5 }} />
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <input type="date" value={act.dueAt} onChange={(e) => setAct((p) => ({ ...p, dueAt: e.target.value }))}
                    style={{ ...S.input, width: "auto" }} />
                  <span style={{ fontSize: 11.5, color: "#94A3B8" }}>Leave the date blank for an undated task.</span>
                  <button style={S.btn(ACCENT, "#FFF")} disabled={busy || !act.subject.trim()} onClick={saveActivity}>
                    {busy ? "Saving…" : "Save activity"}
                  </button>
                  {opErr && opErr.where === "activity" && <span style={{ fontSize: 12.5, color: "#B91C1C", fontWeight: 700 }}>{opErr.msg}</span>}
                </div>
              </div>
            )}

            {/* DOCUMENTS. Everything this record has actually produced, as links. The tab was
                enabled and rendered nothing, which reads as a broken page rather than an
                empty one — and on a record with a quote there is never nothing to show. */}
            {/* CUSTOMER UPLOADS — the CONTROL only. The list of what has been sent lives in
                the History feed under Documents, with everything else that happened
                (Carolyn 2026-08-26 24:01: "the top part is about things to do. The bottom
                part is about history"). Uploading IS something you do, so the button stays
                here; the files it produces belong down there. */}
            {tab === "files" && canEdit && data.contact && data.contact.id && (
              <div style={{ marginBottom: 12 }}>
                <label style={{
                  display: "inline-block", ...S.btn(ACCENT, "#FFF"),
                  cursor: upBusy ? "default" : "pointer", opacity: upBusy ? 0.6 : 1,
                }}>
                  {upBusy ? "Uploading…" : "Add files"}
                  <input type="file" multiple disabled={upBusy}
                    onChange={(e) => { uploadFiles(e.target.files); e.target.value = ""; }}
                    style={{ display: "none" }} />
                </label>
                <span style={{ fontSize: 11.5, color: "#94A3B8", marginLeft: 9 }}>
                  Images, PDFs, Word documents or text — up to 25&nbsp;MB each. They appear below, under Documents.
                </span>
                {upMsg && upMsg.err && <div style={{ ...S.err, marginTop: 7 }}>{upMsg.err}</div>}
                {upMsg && upMsg.ok && <div style={{ ...S.okMsg, marginTop: 7 }}>{upMsg.ok}</div>}
              </div>
            )}
            {/* INVOICE. Invoicing lives on the order, which is where payments, change orders
                and the schedule already are — a second invoice button on a second screen is
                how two sources of truth for money get built. So this routes rather than
                duplicates, and says plainly what the customer still has to do. */}
            {tab === "invoice" && kind === "design" && (
              <div style={{ marginBottom: 12, background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 8, padding: "10px 13px" }}>
                <div style={{ fontSize: 12.5, color: "#475569" }}>
                  This quote is accepted, so it can be invoiced. Invoicing happens on the order — with the
                  payments, change orders and build schedule for the same building.
                </div>
                <div style={{ fontSize: 11.5, color: "#94A3B8", marginTop: 4 }}>
                  The customer signs the invoice; the order is marked Invoiced once they do.
                </div>
                {/* A LINK, not a navigate() call: `navigate` is a useCallback inside
                    Dashboard (09-shell) and is not in scope in this part — calling it here
                    would throw on click. The route is real, so an anchor is both correct
                    and survives someone reorganising the shell. */}
                <a href="/portal/orders"
                  style={{ ...S.btn(ACCENT, "#FFF"), marginTop: 8, display: "inline-block", textDecoration: "none" }}>
                  Open Orders
                </a>
              </div>
            )}

            {/* S.input, not a bare control. These five composers (email subject + body,
                activity subject + date, and the note box below) spread `S.sel` — a token
                that has never existed in S. The spread of `undefined` is silent, so they
                rendered with the BROWSER's default field: a near-black 2px border in a
                platform whose every other input is a 1px #CBD5E1 hairline. Carolyn,
                2026-09-02: "this black outline ... is sooo annoying." The SMS composer a
                few lines up was written later against the real token, which is why that
                one alone looked right. */}
            {tab === "note" && canEdit && (
              <div style={{ marginBottom: 12 }}>
                <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={2}
                  placeholder="Click here to add a note…"
                  style={{ ...S.input, width: "100%", boxSizing: "border-box", resize: "vertical" }} />
                <button style={{ ...S.btn(ACCENT, "#FFF"), marginTop: 5 }} disabled={busy || !draft.trim()} onClick={saveNote}>
                  {busy ? "Saving…" : "Save note"}
                </button>
                {opErr && opErr.where === "note" && <span style={{ fontSize: 12.5, color: "#B91C1C", fontWeight: 700, marginLeft: 8 }}>{opErr.msg}</span>}
              </div>
            )}

            <div style={{ fontSize: 12, fontWeight: 800, color: "#475569", marginBottom: 6 }}>Focus</div>
            {opErr && opErr.where === "focus" && <div style={{ fontSize: 12.5, color: "#B91C1C", fontWeight: 700, marginBottom: 6 }}>{opErr.msg}</div>}
            {(data.focus || []).length === 0 ? (
              <div style={{ fontSize: 12, color: "#94A3B8", marginBottom: 12 }}>
                No focus items yet. Scheduled activities and pinned notes appear here.
              </div>
            ) : (
              <div style={{ marginBottom: 12 }}>
                {(data.focus || []).map((f) => (
                  <div key={f.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "5px 0" }}>
                    <input type="checkbox" onChange={async (e) => {
                      // The box is uncontrolled, so a failed complete would leave it ticked
                      // while the item stays in Focus — looking done when it isn't. Untick
                      // it and say what happened instead of failing silently.
                      const box = e.target;
                      setOpErr(null);
                      const { data: r, error } = await sb.functions.invoke("portal-settings", { body: { action: "crm_complete_activity", id: f.id, done: true } });
                      const failMsg = (r && r.error) || (error ? await fnError(error) : null);
                      if (failMsg) { box.checked = false; setOpErr({ where: "focus", msg: `Could not complete "${f.subject}" — ${failMsg}` }); return; }
                      load();
                    }} />
                    <span style={{ fontSize: 13, fontWeight: 700, color: "#1E293B" }}>{f.subject}</span>
                    <span style={{ fontSize: 11, color: "#94A3B8" }}>{f.due_at ? fmtDate(f.due_at) : "no due date"}</span>
                  </div>
                ))}
              </div>
            )}

            {/* HISTORY. The filter chips are the thing she kept pointing at: "the best
                thing about it is then down here we can sort it ... I want to be able to see
                my emails and only emails in a quick and easy way like this." */}
            <div style={{ fontSize: 12, fontWeight: 800, color: "#475569", marginBottom: 6 }}>History</div>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 9 }}>
              {chips.map((c) => {
                const n = c.types ? (data.feed || []).filter((e) => c.types.indexOf(e.type) !== -1).length : (data.feed || []).length;
                return (
                  <button key={c.key} onClick={() => setChip(c.key)}
                    style={{
                      background: chip === c.key ? ACCENT : "#F1F5F9", color: chip === c.key ? "#FFF" : "#475569",
                      border: "none", borderRadius: 999, padding: "3px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer",
                    }}>{c.label} ({n})</button>
                );
              })}
            </div>
            {feed.length === 0 ? (
              <div style={{ fontSize: 12, color: "#94A3B8" }}>Nothing here yet.</div>
            ) : feed.map((e) => (
              <div key={e.id} style={{ display: "flex", gap: 9, padding: "7px 0", borderTop: "1px solid #F1F5F9" }}>
                <div style={{ width: 8, height: 8, borderRadius: 99, background: "#CBD5E1", marginTop: 5, flexShrink: 0 }} />
                <div style={{ flex: 1 }}>
                  {/* A note renders as the highlighted card she liked; system events render
                      as plain text. That contrast is what makes a human entry findable in a
                      feed that is mostly machine output. */}
                  {e.type === "email_in" ? (
                    /* A REPLY LOOKS LIKE THE CUSTOMER SPEAKING. Tinted, indented and
                       attributed, so a human message is findable in a feed that is otherwise
                       machine output — the same reason a note is a yellow card. Getting this
                       wrong would bury the one thing in the conversation somebody wrote. */
                    <div style={{ background: "#EFF6FF", border: "1px solid #BFDBFE", borderRadius: 6, padding: "7px 9px" }}>
                      <div style={{ fontSize: 11, fontWeight: 800, color: "#1D4ED8", marginBottom: 2 }}>
                        ↩ {e.actor || "Customer"} replied
                      </div>
                      {e.title && <div style={{ fontSize: 12.5, fontWeight: 700, color: "#1E293B" }}>{e.title}</div>}
                      {e.body && <div style={{ fontSize: 13, color: "#1E293B", whiteSpace: "pre-wrap", marginTop: 2 }}>{e.body}</div>}
                    </div>
                  ) : e.type === "sms_in" ? (
                    /* An arriving TEXT is the customer speaking too, so it gets the same
                       treatment as a reply — a different tint only so the channel is
                       readable at a glance in a mixed conversation. */
                    <div style={{ background: "#F0FDF4", border: "1px solid #BBF7D0", borderRadius: 6, padding: "7px 9px" }}>
                      <div style={{ fontSize: 11, fontWeight: 800, color: "#15803D", marginBottom: 2 }}>
                        💬 {e.actor || "Customer"} texted
                      </div>
                      {e.body && <div style={{ fontSize: 13, color: "#1E293B", whiteSpace: "pre-wrap" }}>{e.body}</div>}
                    </div>
                  ) : e.url ? (
                    /* A DOCUMENT ROW *IS* THE FILE. This is where the Design Documents tab's
                       list went (Carolyn 2026-08-26 24:01) — ours and the customer's, in one
                       timeline. Opens in the pop-up viewer, never a new tab (21:15). */
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <button type="button" onClick={() => setPdf({ url: e.url, title: e.title })}
                        style={{ flex: 1, minWidth: 0, textAlign: "left", background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 6, padding: "6px 9px", cursor: "pointer", fontFamily: "inherit" }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: ACCENT, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {e.type === "customer_file" ? "📎" : "📄"} {e.title}
                        </div>
                        {e.body && <div style={{ fontSize: 11.5, color: "#64748B", marginTop: 1 }}>{e.body}</div>}
                      </button>
                      {/* Only the customer's own uploads can be deleted here. A quote PDF or
                          floor plan is generated paperwork — removing it is a design deletion,
                          which has its own dialog and its own consequences. */}
                      {e.type === "customer_file" && canEdit && e.meta && e.meta.fileId && (
                        <button type="button" disabled={upBusy}
                          onClick={() => deleteFile({ id: e.meta.fileId, name: e.title })}
                          title="Delete this file"
                          style={{ background: "transparent", border: "none", padding: 0, cursor: "pointer", color: "#94A3B8", fontWeight: 700, fontSize: 12 }}
                          onMouseEnter={(ev) => { ev.currentTarget.style.color = "#DC2626"; }}
                          onMouseLeave={(ev) => { ev.currentTarget.style.color = "#94A3B8"; }}>
                          Delete
                        </button>
                      )}
                    </div>
                  ) : e.type === "customer_file" ? (
                    /* The object is gone but the row is not: that the customer sent something
                       is worth seeing even when the file itself has vanished. Delete stays
                       available here — without it a broken row could never be cleared, which
                       is the one state that genuinely has nothing left to look at. */
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: "#94A3B8" }}>📎 {e.title} — file missing</div>
                      {canEdit && e.meta && e.meta.fileId && (
                        <button type="button" disabled={upBusy}
                          onClick={() => deleteFile({ id: e.meta.fileId, name: e.title })}
                          title="Remove this entry"
                          style={{ background: "transparent", border: "none", padding: 0, cursor: "pointer", color: "#94A3B8", fontWeight: 700, fontSize: 12 }}
                          onMouseEnter={(ev) => { ev.currentTarget.style.color = "#DC2626"; }}
                          onMouseLeave={(ev) => { ev.currentTarget.style.color = "#94A3B8"; }}>
                          Delete
                        </button>
                      )}
                    </div>
                  ) : e.type === "note" ? (
                    <div style={{ background: "#FEFCE8", border: "1px solid #FDE68A", borderRadius: 6, padding: "6px 8px", fontSize: 13, color: "#1E293B" }}>{e.body}</div>
                  ) : (
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "#1E293B" }}>{e.title}</div>
                      {e.body && <div style={{ fontSize: 12, color: "#64748B", marginTop: 2 }}>{e.body}</div>}
                    </div>
                  )}
                  <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 2 }}>{fmtDate(e.at)}{e.code ? " · " + e.code : ""}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      {pdf && <PdfModal url={pdf.url} title={pdf.title} onClose={() => setPdf(null)} />}
    </div>
  );
}
