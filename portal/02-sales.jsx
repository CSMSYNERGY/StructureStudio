// NO SCHEDULING FROM THIS PAGE (Carolyn 2026-08-08). Designs briefly carried an
// "Add to build schedule" action; it moved to ORDERS the same day — "Orders is all sales",
// and it is from Orders that a sold building goes to the Build or Delivery schedule.
function DesignsTable({ clientId, refreshKey = 0, fetchDesigns = null, isAdmin = false, viewingLabel = null, onOpenDesign = null, onOpenRecord = null }) {
  // LIST or PIPELINE. Carolyn asked for this twice on 2026-08-24: "I definitely do want to
  // have pipelines, okay, I definitely do want to have pipelines, and so designs, contacts,
  // pipelines ... this may become the pipeline view."
  //
  // It is a VIEW over rows this table already loads, not a second data path — which is
  // exactly why it is cheap and why it lives here rather than in its own tab. The same
  // search, the same facets and the same status chips narrow both renderings, so a filter a
  // builder sets in the list is still set when they flip to the board.
  const [view, setView] = useState("list");
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
    const { data, error: err } = await sb
      .from("designs")
      .select("short_code, created_at, updated_at, status, contact, selections, ghl_estimate_number, image_url, inventory_unit_id, ss_quote_number, ss_quote_pdf_url")
      .eq("client_id", clientId)
      .order("created_at", { ascending: false });
    if (err) { setError(err.message); setRows([]); return; }
    const list = (data || []).filter(notInventory);
    setRows(list); // show cached statuses immediately
    // Refresh fulfillment status from GHL (read-only projection). Non-fatal: if the sync
    // errors or GHL isn't configured, the cached designs.status values above stay shown.
    if (list.length > 0) {
      try {
        const { data: sync } = await sb.functions.invoke("sync-design-status", { body: { shortCodes: list.map((r) => r.short_code) } });
        const statuses = sync && sync.statuses;
        if (statuses) setRows((rs) => (rs || []).map((r) => statuses[r.short_code] ? { ...r, status: statuses[r.short_code] } : r));
      } catch (_e) { /* keep cached statuses */ }
    }
    // Version history (newest first), grouped by design. Owner-scoped by RLS.
    const { data: vdata } = await sb
      .from("design_versions")
      .select("short_code, version, created_at, selections, image_url, inventory_unit_id")
      .eq("client_id", clientId)
      .order("version", { ascending: false });
    const map = {};
    (vdata || []).forEach((v) => { (map[v.short_code] = map[v.short_code] || []).push(v); });
    setVmap(map);
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
    setInvMsg(data && data.sent === false
      ? { err: `Invoice ${(data && data.invoiceNumber) || ""} is created and ${est} is Invoiced, but the customer was NOT emailed${data.emailReason ? ` (${data.emailReason})` : ""} — print the invoice PDF or copy the customer link.` }
      : { ok: `Invoice ${(data && data.invoiceNumber) || ""} sent — ${est} is now Invoiced.` });
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

  return (
    <div style={S.card}>
      <CardHead
        title="Designs"
        count={rows ? ((query || statusFilter !== "all" || hasFacets) ? `${filtered.length} of ${rows.length}` : rows.length) : null}
        right={(
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <div style={{ display: "flex", border: "1px solid #E2E8F0", borderRadius: 8, overflow: "hidden" }}>
              {[["list", "List"], ["pipeline", "Pipeline"]].map(([k, label]) => (
                <button key={k} onClick={() => setView(k)}
                  style={{
                    background: view === k ? ACCENT : "#FFF", color: view === k ? "#FFF" : "#334155",
                    border: "none", padding: "6px 12px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
                  }}>{label}</button>
              ))}
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
      {rows === null && <p style={{ fontSize: 13, color: "#64748B", padding: 12 }}>Loading…</p>}
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
      {rows && filtered.length > 0 && view === "pipeline" && (
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
      {rows && filtered.length > 0 && view === "list" && (
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
              {sorted.map((r) => {
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
                      {ssSafeUrl(r.image_url) && <a href={ssSafeUrl(r.image_url)} target="_blank" rel="noopener noreferrer" style={{ color: "#334155", fontWeight: 700, textDecoration: "none" }}>PDF</a>}
                      {/* SS-issued quote (migration 122): the printable 3-sheet document plus the
                          two hand-delivery tools — most lot customers want paper, and a design
                          with no email address never blocks. */}
                      {r.ss_quote_number && ssSafeUrl(r.ss_quote_pdf_url) && (
                        <a href={ssSafeUrl(r.ss_quote_pdf_url)} target="_blank" rel="noopener noreferrer"
                          title="Open the printable quote document"
                          style={{ color: "#334155", fontWeight: 700, textDecoration: "none", marginLeft: 10 }}>Quote PDF</a>
                      )}
                      {r.ss_quote_number && (
                        <button type="button" onClick={() => copyCustomerLink(r.short_code)}
                          title="Copy the customer quote-page link (they sign in with their phone)"
                          style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit", fontSize: "inherit", color: ACCENT, fontWeight: 700, marginLeft: 10 }}>
                          {copiedKey === r.short_code ? "Copied ✓" : "Copy link"}
                        </button>
                      )}
                      {r.ss_quote_number && (
                        <button type="button" onClick={() => resendQuoteEmail(r)} disabled={resendBusyKey === r.short_code}
                          title="Re-send the quote email to the customer"
                          style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit", fontSize: "inherit", color: ACCENT, fontWeight: 700, marginLeft: 10, opacity: resendBusyKey === r.short_code ? 0.5 : 1 }}>
                          {resendBusyKey === r.short_code ? "Sending…" : "Resend email"}
                        </button>
                      )}
                      {/* Only on an ACCEPTED design — that is the one state where an invoice
                          is the next step, and it is what the server gates on too. Keyed on
                          this row's own short code, so what gets invoiced is the design the
                          button sits on. */}
                      {isAdmin && normStatus(r.status) === "accepted" && (
                        <button type="button" onClick={() => sendInvoice(r)} disabled={invBusyKey === r.short_code}
                          title="Create and email the invoice for this accepted estimate"
                          style={{ ...S.btn("#15803D", "#FFF"), marginLeft: 10, padding: "5px 12px", fontSize: 12, opacity: invBusyKey === r.short_code ? 0.6 : 1 }}>
                          {invBusyKey === r.short_code ? "Sending…" : "Send invoice"}
                        </button>
                      )}
                      {/* Owner/admin only — a team member must not be able to destroy a
                          customer record. The server re-checks regardless (delete_design is
                          absent from READ_ACTIONS, so the resolver requires owner/admin). */}
                      {isAdmin && (
                        <button type="button" onClick={() => setDelTarget(r)} title="Delete this design"
                          aria-label={`Delete design ${r.short_code}`}
                          style={{ marginLeft: 10, background: "transparent", border: "none", padding: 0, cursor: "pointer", color: "#94A3B8", fontWeight: 700, fontSize: 12 }}
                          onMouseEnter={(e) => { e.currentTarget.style.color = "#DC2626"; }}
                          onMouseLeave={(e) => { e.currentTarget.style.color = "#94A3B8"; }}>
                          Delete
                        </button>
                      )}
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
                          {ssSafeUrl(v.image_url) && <a href={ssSafeUrl(v.image_url)} target="_blank" rel="noopener noreferrer" style={{ color: "#334155", fontWeight: 700, textDecoration: "none" }}>PDF</a>}
                        </td>
                      </tr>
                    );
                  })}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
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
  const [rows, setRows] = useState(null); // null = loading
  const [error, setError] = useState(null);
  const [query, setQuery] = useState("");  // free-text search across all fields

  const load = useCallback(async () => {
    setError(null);
    let list;
    let browsing = [];
    // Inventory masters are lot buildings, not contacts — exclude on both paths (they
    // have an empty contact, so they'd otherwise group as a nameless short_code row).
    const notInventoryLead = (r) => r.status !== "inventory";
    if (fetchDesigns) {
      // Operator view-as: rows from operator-portal (service-role, audit-logged);
      // live status sync skipped (owner-JWT-bound) — cached statuses show.
      try { const res = await fetchDesigns(); list = (res.designs || []).filter(notInventoryLead); browsing = res.capturedLeads || []; }
      catch (e) { setError(e.message || String(e)); setRows([]); return; }
    } else {
    const { data, error: err } = await sb
      .from("designs")
      .select("short_code, created_at, updated_at, status, contact, selections, ghl_estimate_number, contact_id")
      .eq("client_id", clientId)
      .order("created_at", { ascending: false });
    if (err) { setError(err.message); setRows([]); return; }
    list = (data || []).filter(notInventoryLead);
    // Browsing leads (migration 062): people who passed the public designer's gate or
    // opened quote Details but never submitted. RLS scopes the read to this tenant.
    // Additive — a failure here must never block the design list.
    try {
      const { data: cl } = await sb.from("captured_leads")
        .select("id, name, phone, phone_digits, email, source, created_at, updated_at")
        .eq("client_id", clientId).order("updated_at", { ascending: false });
      browsing = cl || [];
    } catch (_e) { /* leads are additive */ }
    // Freshen fulfillment status from GHL (read-only projection); non-fatal.
    if (list.length > 0) {
      try {
        const { data: sync } = await sb.functions.invoke("sync-design-status", { body: { shortCodes: list.map((r) => r.short_code) } });
        const statuses = sync && sync.statuses;
        if (statuses) list = list.map((r) => statuses[r.short_code] ? { ...r, status: statuses[r.short_code] } : r);
      } catch (_e) { /* keep cached statuses */ }
    }
    }
    // Group by person: normalized phone, else email, else name (fallback: short_code).
    const normPhone = (p) => String(p || "").replace(/\D/g, "");
    const groups = new Map();
    list.forEach((r) => { // list is newest-first
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
    browsing.forEach((l) => {
      const em = String(l.email || "").trim().toLowerCase();
      if (groups.has(l.phone_digits) || (em && groupEmails.has(em))) return;
      groups.set("lead-" + l.id, {
        key: "lead-" + l.id, browsing: true, source: l.source,
        name: l.name || "", email: l.email || "", phone: l.phone || "",
        count: 0, firstSeen: l.created_at, lastActivity: l.updated_at,
        latestCode: null, topStatus: "browsing",
        search: " browsing lead" + (l.source === "details" ? " viewed pricing quote details" : ""),
        codes: [],
      });
    });
    setRows([...groups.values()].sort((a, b) => (b.lastActivity > a.lastActivity ? 1 : b.lastActivity < a.lastActivity ? -1 : 0)));
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
      {rows === null && <p style={{ fontSize: 13, color: "#64748B", padding: 12 }}>Loading…</p>}
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
              {sorted.map((g) => {
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
const CRM_SECTIONS = [
  { key: "summary", title: "Summary", when: () => true },
  { key: "details", title: "Details", when: () => true },
  // ── THE RECIPROCAL EMBED. This pair IS Carolyn's "here is the contact, and the deal is
  // all on the side here ... it's in one place." A Person shows its Deals; a Deal shows
  // its Person. Same shell, mirrored.
  { key: "deals", title: "Deals", when: (c) => c.kind === "contact" },
  { key: "person", title: "Person", when: (c) => c.kind === "design" },
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
  // NO SMS OR WHATSAPP TAB, AND THERE IS NOT GOING TO BE ONE. Ahsan, 2026-08-25:
  // "we are not using Twilio for conversation or campaigns. We are only using Twilio to get
  // the code to log in. That's it. For conversation, we are using emails."
  //
  // An earlier version of this registry carried a greyed WhatsApp tab hinted "arrives when
  // the Twilio account is connected" — a promise that was never going to be kept, sitting on
  // a screen Carolyn shows at a trade show. A greyed tab says "next"; removing it says "not
  // part of this product", which is the truth. Twilio's only job here is the Verify code
  // that logs a customer into my-quotes, and that needs no phone number, no messaging
  // service and no A2P registration.
  //
  // Conversations ARE email. That is why the Email tab is the one that grows a composer.
  // Email IS the conversation channel (Ahsan, 2026-08-25), so this is the tab that carries
  // a composer. Needs an address to write to — a contact with neither an email nor a design
  // is a browsing artefact, and offering a compose box that cannot send is worse than not
  // offering one.
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
  { key: "files", label: "Files", enabled: () => false, hint: "Needs a contact-scoped storage bucket." },
  { key: "documents", label: "Documents", enabled: () => true },
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
  { key: "documents", label: "Documents", types: ["change_order", "invoice_created", "invoice_sent"] },
  { key: "deals", label: "Deals", types: ["design_created", "design_version", "accepted", "quote_opened"], when: (c) => c.kind === "contact" },
  { key: "invoices", label: "Invoices", types: ["invoice_created", "invoice_sent"], when: (c) => c.kind === "design" },
  { key: "changelog", label: "Changelog", types: ["design_version", "status_change", "lead_captured"] },
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

function CrmStageBar({ status }) {
  const at = CRM_STAGE_FOR_STATUS[normStatus(status)] || "new";
  const idx = Math.max(0, CRM_STAGES.findIndex((s) => s.kind === at));
  return (
    <div style={{ display: "flex", gap: 2, marginBottom: 12, flexWrap: "wrap" }}>
      {CRM_STAGES.map((s, i) => (
        <div key={s.kind} title={i <= idx ? "Reached" : "Not yet"}
          style={{
            flex: "1 1 90px", padding: "5px 10px", fontSize: 11, fontWeight: 700, textAlign: "center",
            background: i < idx ? "#DDD6FE" : i === idx ? ACCENT : "#F1F5F9",
            color: i === idx ? "#FFF" : i < idx ? ACCENT : "#94A3B8",
            clipPath: "polygon(0 0, calc(100% - 8px) 0, 100% 50%, calc(100% - 8px) 100%, 0 100%, 8px 50%)",
          }}>
          {s.name}
        </div>
      ))}
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
function CrmRecord({ kind, recordId, isAdmin = false, canEdit = false, onBack, onNavigate, onOpenDesign }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [tab, setTab] = useState("note");
  const [chip, setChip] = useState("all");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [mail, setMail] = useState({ subject: "", body: "" });
  const [mailMsg, setMailMsg] = useState(null);
  const [act, setAct] = useState({ kind: "call", subject: "", dueAt: "" });
  // Note/activity/focus save failures. sendEmail already reports through mailMsg, but that
  // renders only inside the Email tab — these controls need their own slot, keyed by control
  // so a note error can't surface under Focus too. Every new attempt clears it first, so a
  // stale failure never outlives the action that follows it.
  const [opErr, setOpErr] = useState(null); // { where: "note" | "activity" | "focus", msg }

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
  const ctx = { kind, record, isAdmin, canEdit, contact: data.contact, designs: data.designs || [] };
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
      return kind === "contact" ? (
        <div style={{ fontSize: 13, color: "#475569" }}>
          <div>{data.contact.email || <span style={{ color: "#94A3B8" }}>No email</span>}</div>
          <div>{data.contact.phone || <span style={{ color: "#94A3B8" }}>No phone</span>}</div>
        </div>
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
    if (key === "person") {
      return data.contact ? (
        <button onClick={() => data.contact.id && onNavigate("contact", data.contact.id)}
          style={{ display: "block", width: "100%", textAlign: "left", background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 6, padding: "7px 9px", cursor: data.contact.id ? "pointer" : "default" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: ACCENT }}>{cname}</div>
          <div style={{ fontSize: 11, color: "#64748B" }}>{data.contact.email || data.contact.phone || "—"}</div>
        </button>
      ) : <div style={{ fontSize: 12, color: "#94A3B8" }}>No contact linked.</div>;
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

            {tab === "email" && canEdit && data.contact && data.contact.email && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11.5, color: "#64748B", marginBottom: 5 }}>
                  To <strong>{data.contact.email}</strong> — replies come back to you, not to a no-reply address.
                </div>
                <input value={mail.subject} onChange={(e) => setMail((p) => ({ ...p, subject: e.target.value }))}
                  placeholder="Subject" style={{ ...S.sel, width: "100%", boxSizing: "border-box", marginBottom: 5 }} />
                <textarea value={mail.body} onChange={(e) => setMail((p) => ({ ...p, body: e.target.value }))} rows={5}
                  placeholder="Write to this customer…"
                  style={{ ...S.sel, width: "100%", boxSizing: "border-box", resize: "vertical" }} />
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
                differently in the feed, and the kind is what the icon and label key on. */}
            {tab === "activity" && canEdit && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 6 }}>
                  {["call", "meeting", "task", "deadline", "lunch"].map((k) => (
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
                  style={{ ...S.sel, width: "100%", boxSizing: "border-box", marginBottom: 5 }} />
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <input type="date" value={act.dueAt} onChange={(e) => setAct((p) => ({ ...p, dueAt: e.target.value }))}
                    style={{ ...S.sel, width: "auto" }} />
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
            {tab === "documents" && (
              <div style={{ marginBottom: 12 }}>
                {(() => {
                  const docs = [];
                  (data.designs || []).forEach((d) => {
                    const what = [(d.selections || {}).style, (d.selections || {}).size].filter(Boolean).join(" ") || d.short_code;
                    if (d.ss_quote_pdf_url) docs.push({ k: `q:${d.short_code}`, label: `Quote ${d.ss_quote_number || ""}`.trim() + ` — ${what}`, url: d.ss_quote_pdf_url });
                    if (d.image_url) docs.push({ k: `p:${d.short_code}`, label: `Floor plan — ${what}`, url: d.image_url });
                  });
                  if (docs.length === 0) {
                    return <div style={{ fontSize: 12.5, color: "#94A3B8" }}>No documents yet. A quote PDF appears here as soon as one is sent.</div>;
                  }
                  return docs.map((doc) => (
                    <a key={doc.k} href={doc.url} target="_blank" rel="noopener"
                      style={{
                        display: "block", background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 6,
                        padding: "7px 9px", marginBottom: 5, fontSize: 13, fontWeight: 600, color: ACCENT, textDecoration: "none",
                      }}>📄 {doc.label}</a>
                  ));
                })()}
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

            {tab === "note" && canEdit && (
              <div style={{ marginBottom: 12 }}>
                <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={2}
                  placeholder="Click here to add a note…"
                  style={{ ...S.sel, width: "100%", boxSizing: "border-box", resize: "vertical" }} />
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
    </div>
  );
}
