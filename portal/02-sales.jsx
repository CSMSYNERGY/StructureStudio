// NO SCHEDULING FROM THIS PAGE (Carolyn 2026-08-08). Designs briefly carried an
// "Add to build schedule" action; it moved to ORDERS the same day — "Orders is all sales",
// and it is from Orders that a sold building goes to the Build or Delivery schedule.
function DesignsTable({ clientId, refreshKey = 0, fetchDesigns = null, isAdmin = false, viewingLabel = null, onOpenDesign = null }) {
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
      .select("short_code, created_at, updated_at, status, contact, selections, ghl_estimate_number, image_url, inventory_unit_id")
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
    const est = r.ghl_estimate_number ? `EST-${r.ghl_estimate_number}` : code;
    const who = (r.contact || {}).name || "this customer";
    // Acting as another tenant: name them in the confirm, because this emails a real
    // invoice to THEIR customer, from THEIR account.
    const asOperator = Boolean(viewingLabel);
    const label = asOperator ? `${viewingLabel}'s customer ${who}`.trim() : who;
    const asNote = asOperator ? `\n\nYou are doing this AS ${viewingLabel}.` : "";
    if (!window.confirm(`Email an invoice to ${label} for ${est}?\n\nThis creates the invoice in your CRM and sends it immediately.${asNote}`)) return;
    setInvBusyKey(code); setInvMsg(null);
    // confirmSend is required server-side in operator mode — the confirm above is
    // client-only, and a mis-scoped script must not be able to email a stranger's customers.
    const { data, error: err } = await sb.functions.invoke("portal-settings", { body: { action: "send_invoice", shortCode: code, ...(asOperator ? { confirmSend: true } : {}) } });
    setInvBusyKey(null);
    if (err) { setInvMsg({ err: await fnError(err) }); return; }
    setInvMsg({ ok: `Invoice ${(data && data.invoiceNumber) || ""} sent — ${est} is now Invoiced.` });
    load();
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
    const extra = [r.ghl_estimate_number ? "EST-" + r.ghl_estimate_number : "", STATUS_LABELS[st], fmtDate(r.created_at), titleCase((r.selections || {}).style)].join(" ");
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
      case "estimate": return r.ghl_estimate_number != null ? Number(r.ghl_estimate_number) : null;
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
        right={<button onClick={load} style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0", padding: "6px 12px" }}>↻ Refresh</button>}
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
      {rows && filtered.length > 0 && (
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
                    <td style={S.td}>{r.ghl_estimate_number ? `EST-${r.ghl_estimate_number}` : "—"}</td>
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
function LeadsTable({ clientId, fetchDesigns = null, isAdmin = false, onOpenDesign = null }) {
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
      .select("short_code, created_at, updated_at, status, contact, selections, ghl_estimate_number")
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
      if (!g) { g = { key, name: "", email: "", phone: "", count: 0, firstSeen: r.created_at, lastActivity: r.created_at, latestCode: r.short_code, topStatus: "draft", search: "", codes: [] }; groups.set(key, g); }
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
                      {g.name || "—"}
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

