// ─── Projects tab — CSM Synergy's internal project management (Monday.com replacement) ───
// OPERATOR-ONLY: gated exactly like Accounts/Admin (ssClampTab + the isOperator nav group +
// the content render), and the portal-projects edge function re-checks app_operators on
// every call regardless. Tenants have no read path to any pm_* table — everything a client
// may see is COPIED into feedback_submissions/feedback_comments by the server, never read
// from here.
//
// Boards, groups and columns are user-defined (Carolyn's "Monday but better"): the table
// itself is the generic engine in 09-table-engine.jsx; this file owns data loading, the
// toolbar (search · facets · WHEN date filter · group-by · column visibility), the item
// modal (fields + updates thread + client publishing + activity), and board configuration
// (groups, columns, status labels with their client-status mapping).

// The 8 tenant-facing states a status label may map onto (migration 054's ladder), with
// the SAME display labels MySubmissions uses — so "Client sees: In progress" here reads
// identically to what the builder reads over there.
const PM_CLIENT_STATUS = {
  submitted: "Submitted", in_review: "In review", planned: "Planned",
  in_progress: "In progress", needs_info: "Needs info", shipped: "Completed",
  declined: "Not planned", duplicate: "Already tracked",
};
const PM_SWATCHES = ["#3D3672", "#1B7895", "#0E9F6E", "#2563EB", "#8B5CF6", "#6366F1", "#F59E0B", "#F97316", "#B91C1C", "#BE185D", "#0891B2", "#64748B", "#94A3B8"];
const PM_COL_TYPES = [
  ["status", "Status"], ["people", "People"], ["date", "Date"], ["dropdown", "Dropdown"],
  ["number", "Number"], ["text", "Text"], ["long_text", "Long text"], ["checkbox", "Checkbox"], ["link", "Link"],
];

async function pmCall(body) {
  const { data, error } = await sb.functions.invoke("portal-projects", { body });
  if (error) {
    // supabase-js buries the function's JSON error body; surface its message when present.
    let msg = error.message || "Request failed.";
    try { const j = await error.context?.json?.(); if (j && j.error) msg = j.error; } catch (_) { /* keep msg */ }
    throw new Error(msg);
  }
  if (data && data.error) throw new Error(data.error);
  return data;
}

// Validated per-board view prefs (the ss_sched_segment idiom: try/catch for private mode,
// and validate on read — a stale build's value must never crash the renderer).
const pmViewKey = (slug) => "ss_projects_" + slug;
function pmLoadView(slug, columns) {
  try {
    const raw = JSON.parse(localStorage.getItem(pmViewKey(slug)) || "{}");
    const colIds = new Set(columns.map((c) => c.id));
    return {
      sortKey: raw.sortKey === "name" || colIds.has(raw.sortKey) ? raw.sortKey : "name",
      sortDir: raw.sortDir === "desc" ? "desc" : "asc",
      groupBy: raw.groupBy === "groups" || colIds.has(raw.groupBy) ? raw.groupBy : "groups",
      hiddenCols: Array.isArray(raw.hiddenCols) ? raw.hiddenCols.filter((id) => colIds.has(id)) : [],
    };
  } catch (_) { return { sortKey: "name", sortDir: "asc", groupBy: "groups", hiddenCols: [] }; }
}
function pmSaveView(slug, view) {
  try { localStorage.setItem(pmViewKey(slug), JSON.stringify(view)); } catch (_) { /* private mode */ }
}

// One color-swatch row, used by the group and label editors.
function PMSwatches({ value, onPick }) {
  return (
    <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap", verticalAlign: "middle" }}>
      {PM_SWATCHES.map((c) => (
        <button key={c} type="button" title={c} onClick={() => onPick(c)}
          style={{ width: 16, height: 16, borderRadius: 4, background: c, cursor: "pointer", border: value === c ? "2px solid #1E293B" : "2px solid transparent", padding: 0 }} />
      ))}
    </span>
  );
}

// ── Item modal — the ONE detail surface (decision 25's pattern) ──────────────
function PMItemModal({ item, columns, ctx, canWrite, onClose, onCellCommit, onRename, onArchive, onChanged }) {
  const [detail, setDetail] = useState(null);      // { updates, activity, submission }
  const [err, setErr] = useState("");
  const [name, setName] = useState(item.name);
  const [compose, setCompose] = useState("");
  const [toClient, setToClient] = useState(false);
  const [busy, setBusy] = useState(false);

  const loadDetail = useCallback(() => {
    pmCall({ action: "get_item", id: item.id })
      .then((d) => setDetail(d))
      .catch((e) => setErr(e.message));
  }, [item.id]);
  useEffect(() => { loadDetail(); }, [loadDetail]);

  const sub = detail && detail.submission;
  const post = async () => {
    const body = compose.trim();
    if (!body || busy) return;
    if (toClient) {
      const who = sub ? (sub.client_id || "this client") : "this client";
      if (!window.confirm(`Publish this update to ${who}? They will see it in My Submissions.`)) return;
    }
    setBusy(true); setErr("");
    try {
      await pmCall({ action: "add_update", itemId: item.id, body, clientVisible: toClient });
      setCompose(""); setToClient(false); loadDetail();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const publishExisting = async (u) => {
    const who = sub ? (sub.client_id || "this client") : "this client";
    if (!window.confirm(`Publish this update to ${who}? They will see it in My Submissions.`)) return;
    try { await pmCall({ action: "publish_update", id: u.id }); loadDetail(); }
    catch (e) { setErr(e.message); }
  };
  const deleteUpdate = async (u) => {
    const warn = u.client_visible ? "Delete this update? The copy the client sees will be removed too." : "Delete this update?";
    if (!window.confirm(warn)) return;
    try { await pmCall({ action: "delete_update", id: u.id }); loadDetail(); }
    catch (e) { setErr(e.message); }
  };

  const flabel = { fontSize: 10.5, fontWeight: 700, color: "#64748B", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4, display: "block" };

  return (
    <AdmOverlay onClose={onClose} maxWidth={880} labelledBy="pm-item-title">
      <div style={{ padding: "16px 20px", maxHeight: "82vh", overflowY: "auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          {canWrite ? (
            <input id="pm-item-title" style={{ ...S.input, fontSize: 16, fontWeight: 800, flex: 1 }} value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => { if (name.trim() && name !== item.name) onRename(item, name.trim()); }}
              onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); }} />
          ) : (
            <div id="pm-item-title" style={{ fontSize: 16, fontWeight: 800, flex: 1 }}>{item.name}</div>
          )}
          {item.feedback_submission_id && (
            <span style={{ fontSize: 9.5, fontWeight: 800, color: "#1B7895", background: "#E6F7FA", border: "1px solid #BEE9F1", borderRadius: 4, padding: "2px 6px", letterSpacing: 0.4 }}>CLIENT</span>
          )}
          <button type="button" onClick={onClose} aria-label="Close"
            style={{ background: "none", border: "none", color: "#94A3B8", fontSize: 20, fontWeight: 700, cursor: "pointer" }}>✕</button>
        </div>
        {err && <div style={S.err}>{err}</div>}

        <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: 18 }}>
          <div style={{ minWidth: 0 }}>
            {/* Field grid — every column, always-editable controls (modal = full editors,
                including link and long_text which the table cells defer here). */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginBottom: 16 }}>
              {columns.map((col) => (
                <div key={col.id} style={{ minWidth: 0, gridColumn: (col.type === "long_text" || col.type === "link") ? "1 / -1" : undefined }}>
                  <span style={flabel}>{col.name}</span>
                  {canWrite
                    ? <PMFieldEditor col={col} value={item.values ? item.values[col.id] : null} ctx={ctx}
                        onCommit={(v) => onCellCommit(item, col, v)} />
                    : <div style={{ fontSize: 13 }}>{pmType(col).renderCell(item.values ? item.values[col.id] : null, col, ctx)}</div>}
                </div>
              ))}
            </div>

            <span style={flabel}>Updates</span>
            {canWrite && (
              <div style={{ border: "1px solid #CBD5E1", borderRadius: 10, padding: "10px 12px", marginBottom: 10 }}>
                <textarea rows={2} placeholder="Write an update…" style={{ ...S.input, resize: "vertical", fontWeight: 500 }}
                  value={compose} onChange={(e) => setCompose(e.target.value)} />
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: item.feedback_submission_id ? "#334155" : "#94A3B8", display: "flex", alignItems: "center", gap: 5 }}
                    title={item.feedback_submission_id ? "Publishes this one update to the client's My Submissions feed" : "This item isn't linked to a client submission"}>
                    <input type="checkbox" checked={toClient} disabled={!item.feedback_submission_id}
                      onChange={(e) => setToClient(e.target.checked)} />
                    Visible to client
                  </label>
                  <button type="button" style={{ ...S.btn(ACCENT, "#FFF"), marginLeft: "auto", padding: "6px 14px", fontSize: 12, opacity: busy || !compose.trim() ? 0.6 : 1 }}
                    disabled={busy || !compose.trim()} onClick={post}>Post</button>
                </div>
              </div>
            )}
            {!detail && !err && <div style={{ color: "#94A3B8", fontSize: 12.5 }}>Loading…</div>}
            {detail && !detail.updates.length && <div style={{ color: "#94A3B8", fontSize: 12.5 }}>No updates yet.</div>}
            {detail && detail.updates.map((u) => (
              <div key={u.id} style={{ border: "1px solid", borderColor: u.client_visible ? "#8ED8CF" : "#E2E8F0", background: u.client_visible ? "#F2FBFA" : "#FFF", borderRadius: 10, padding: "9px 12px", marginBottom: 8, fontSize: 12.8 }}>
                <div style={{ fontSize: 11.5, fontWeight: 700, color: "#64748B", marginBottom: 3, display: "flex", gap: 6, alignItems: "center" }}>
                  {(u.author_email || "?").split("@")[0]} · {fmtDate(u.created_at)}
                  <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: 0.4, borderRadius: 4, padding: "1px 6px", background: u.client_visible ? "#CCF1EC" : "#F1F5F9", color: u.client_visible ? "#0F766E" : "#64748B" }}>
                    {u.client_visible ? "VISIBLE TO CLIENT ✓" : "INTERNAL"}
                  </span>
                  {canWrite && !u.client_visible && item.feedback_submission_id && (
                    <button type="button" style={{ background: "none", border: "none", color: "#1B7895", fontSize: 11, fontWeight: 700, cursor: "pointer", padding: 0 }}
                      onClick={() => publishExisting(u)}>Publish to client…</button>
                  )}
                  {canWrite && (
                    <button type="button" style={{ background: "none", border: "none", color: "#DC2626", fontSize: 11, fontWeight: 700, cursor: "pointer", padding: 0, marginLeft: "auto" }}
                      onClick={() => deleteUpdate(u)}>Delete</button>
                  )}
                </div>
                <div style={{ whiteSpace: "pre-wrap" }}>{u.body}</div>
                {(u.attachments || []).map((a) => a.url && (
                  <a key={a.path} href={a.url} target="_blank" rel="noreferrer" style={{ display: "inline-block", marginTop: 4, fontSize: 12, color: "#1B7895", fontWeight: 600 }}>📎 {a.name || "attachment"}</a>
                ))}
              </div>
            ))}
          </div>

          <div style={{ minWidth: 0 }}>
            {sub && (
              <div style={{ background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 10, padding: "11px 13px", marginBottom: 12, fontSize: 12.5 }}>
                <span style={flabel}>Client submission</span>
                <b>{sub.client_id}</b> · {sub.kind === "bug" ? "Issue" : "Feature request"}<br />
                Submitted by {sub.submitter_name || "?"} · {fmtDate(sub.created_at)}<br />
                {sub.severity && <>Their importance: {sub.severity}<br /></>}
                {sub.detail && <div style={{ color: "#64748B", margin: "6px 0", whiteSpace: "pre-wrap" }}>“{sub.detail.slice(0, 400)}{sub.detail.length > 400 ? "…" : ""}”</div>}
                {sub.attachmentUrl && <a href={sub.attachmentUrl} target="_blank" rel="noreferrer" style={{ color: "#1B7895", fontWeight: 600 }}>📎 Their attachment</a>}
                <div style={{ marginTop: 6 }}>
                  Client currently sees: <b>{PM_CLIENT_STATUS[sub.status] || sub.status}</b>
                </div>
              </div>
            )}
            <div style={{ background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 10, padding: "11px 13px", marginBottom: 12 }}>
              <span style={flabel}>Activity</span>
              {detail && detail.activity.length
                ? detail.activity.slice(0, 12).map((a) => (
                  <div key={a.id} style={{ fontSize: 11.5, color: "#64748B", padding: "3px 0", borderBottom: "1px dashed #EEF1F6" }}>
                    {(a.actor_email || "?").split("@")[0]} · {a.action.replace(/_/g, " ")}{a.detail && a.detail.label ? ` → ${a.detail.label}` : ""} · {fmtDate(a.created_at)}
                  </div>
                ))
                : <div style={{ fontSize: 11.5, color: "#94A3B8" }}>—</div>}
            </div>
            {canWrite && (
              <button type="button" style={{ ...S.btn("#FEF2F2", "#DC2626"), border: "1px solid #FECACA", width: "100%" }}
                onClick={() => { if (window.confirm("Remove this item from the board? (It is archived, not destroyed.)")) { onArchive(item); onClose(); } }}>
                Remove from board
              </button>
            )}
          </div>
        </div>
      </div>
    </AdmOverlay>
  );
}

// Always-visible field editor for the modal (the table's cells swap editors in on click;
// the modal just shows the control). Commits on change/blur like the cell editors.
function PMFieldEditor({ col, value, ctx, onCommit }) {
  const [text, setText] = useState(value == null ? "" : (typeof value === "object" ? "" : String(value)));
  const [linkUrl, setLinkUrl] = useState((value && value.url) || "");
  const [linkText, setLinkText] = useState((value && value.text) || "");
  useEffect(() => {
    setText(value == null ? "" : (typeof value === "object" ? "" : String(value)));
    setLinkUrl((value && value.url) || ""); setLinkText((value && value.text) || "");
  }, [value]);
  const sel = { ...S.input, padding: "6px 8px", fontSize: 12.5 };
  if (col.type === "status" || col.type === "dropdown") {
    const opts = col.type === "status" ? (col.settings?.labels || []) : (col.settings?.options || []);
    const cur = col.type === "dropdown" ? ((Array.isArray(value) ? value : [])[0] || "") : (value || "");
    return (
      <select style={sel} value={cur} onChange={(e) => { const v = e.target.value || null; onCommit(col.type === "dropdown" ? (v ? [v] : []) : v); }}>
        <option value="">—</option>
        {opts.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
    );
  }
  if (col.type === "people") {
    const cur = (Array.isArray(value) && value[0]) || "";
    return (
      <select style={sel} value={cur} onChange={(e) => { const v = e.target.value; onCommit(v ? [v] : []); }}>
        <option value="">Unassigned</option>
        {ctx.operators.map((o) => <option key={o.user_id} value={o.user_id}>{(o.email || "").split("@")[0]}</option>)}
      </select>
    );
  }
  if (col.type === "date") return <input type="date" style={sel} value={value || ""} onChange={(e) => onCommit(e.target.value || null)} />;
  if (col.type === "checkbox") return <input type="checkbox" checked={value === true} onChange={(e) => onCommit(e.target.checked)} />;
  if (col.type === "long_text") {
    return <textarea rows={3} style={{ ...sel, resize: "vertical", fontWeight: 500 }} value={text}
      onChange={(e) => setText(e.target.value)} onBlur={() => { if (text !== String(value || "")) onCommit(text); }} />;
  }
  if (col.type === "link") {
    const commit = () => { if (linkUrl.trim()) onCommit({ url: linkUrl.trim(), text: linkText.trim() }); else onCommit(null); };
    return (
      <span style={{ display: "flex", gap: 6 }}>
        <input placeholder="https://…" style={{ ...sel, flex: 2 }} value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} onBlur={commit} />
        <input placeholder="Label" style={{ ...sel, flex: 1 }} value={linkText} onChange={(e) => setLinkText(e.target.value)} onBlur={commit} />
      </span>
    );
  }
  const commit = () => { const v = col.type === "number" ? (text === "" ? null : Number(text)) : text; onCommit(v); };
  return <input type={col.type === "number" ? "number" : "text"} style={sel} value={text}
    onChange={(e) => setText(e.target.value)} onBlur={() => { if (text !== String(value == null ? "" : value)) commit(); }}
    onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); }} />;
}

// ── Board settings modal: name · groups · columns (incl. status labels ↔ client map) ──
function PMBoardSettings({ board, columns, groups, onClose, onChanged, onArchivedBoard }) {
  const [err, setErr] = useState("");
  const [boardName, setBoardName] = useState(board.name);
  const [newGroup, setNewGroup] = useState("");
  const [newColName, setNewColName] = useState("");
  const [newColType, setNewColType] = useState("text");
  const [labelCol, setLabelCol] = useState(null); // status/dropdown column being edited

  const run = async (body, after) => {
    setErr("");
    try { const d = await pmCall(body); if (after) after(d); onChanged(); }
    catch (e) { setErr(e.message); }
  };
  const flabel = { fontSize: 10.5, fontWeight: 700, color: "#64748B", textTransform: "uppercase", letterSpacing: 0.5, margin: "14px 0 5px", display: "block" };
  const rowStyle = { display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px dashed #EEF1F6", fontSize: 12.8 };

  return (
    <AdmOverlay onClose={onClose} maxWidth={640} labelledBy="pm-bs-title">
      <div style={{ padding: "16px 20px", maxHeight: "82vh", overflowY: "auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <b id="pm-bs-title" style={{ fontSize: 15 }}>Board settings</b>
          <button type="button" onClick={onClose} aria-label="Close" style={{ marginLeft: "auto", background: "none", border: "none", color: "#94A3B8", fontSize: 20, fontWeight: 700, cursor: "pointer" }}>✕</button>
        </div>
        {err && <div style={{ ...S.err, marginTop: 8 }}>{err}</div>}

        <span style={flabel}>Board name</span>
        <div style={{ display: "flex", gap: 8 }}>
          <input style={{ ...S.input, maxWidth: 300 }} value={boardName} onChange={(e) => setBoardName(e.target.value)} />
          <button type="button" style={S.btn(ACCENT, "#FFF")} disabled={!boardName.trim() || boardName === board.name}
            onClick={() => run({ action: "update_board", id: board.id, name: boardName.trim() })}>Save</button>
        </div>

        <span style={flabel}>Groups</span>
        {groups.map((g) => (
          <div key={g.id} style={rowStyle}>
            <input style={{ ...S.input, width: 180, padding: "4px 8px", fontSize: 12.5 }} defaultValue={g.name}
              onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== g.name) run({ action: "update_group", id: g.id, name: v }); }} />
            <PMSwatches value={g.color} onPick={(c) => run({ action: "update_group", id: g.id, color: c })} />
            {groups.length > 1 && (
              <button type="button" style={{ marginLeft: "auto", background: "none", border: "none", color: "#DC2626", fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}
                onClick={() => {
                  const dest = groups.find((x) => x.id !== g.id);
                  if (window.confirm(`Delete group "${g.name}"? Its items move to "${dest.name}".`)) {
                    run({ action: "delete_group", id: g.id, moveToGroupId: dest.id });
                  }
                }}>Delete</button>
            )}
          </div>
        ))}
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <input placeholder="New group name" style={{ ...S.input, maxWidth: 220, padding: "5px 8px", fontSize: 12.5 }} value={newGroup} onChange={(e) => setNewGroup(e.target.value)} />
          <button type="button" style={S.btn("#EEF2FF", ACCENT)} disabled={!newGroup.trim()}
            onClick={() => { run({ action: "create_group", boardId: board.id, name: newGroup.trim() }); setNewGroup(""); }}>＋ Add group</button>
        </div>

        <span style={flabel}>Columns</span>
        {columns.map((col) => (
          <div key={col.id}>
            <div style={rowStyle}>
              <input style={{ ...S.input, width: 160, padding: "4px 8px", fontSize: 12.5 }} defaultValue={col.name}
                onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== col.name) run({ action: "update_column", id: col.id, name: v }); }} />
              <span style={{ fontSize: 11, color: "#64748B", fontWeight: 700, width: 70 }}>{(PM_COL_TYPES.find(([t]) => t === col.type) || [col.type, col.type])[1]}</span>
              {(col.type === "status" || col.type === "dropdown") && (
                <button type="button" style={{ background: "none", border: "none", color: "#1B7895", fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}
                  onClick={() => setLabelCol(labelCol === col.id ? null : col.id)}>
                  {labelCol === col.id ? "Hide labels" : "Edit labels"}
                </button>
              )}
              <button type="button" style={{ marginLeft: "auto", background: "none", border: "none", color: "#DC2626", fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}
                onClick={() => { if (window.confirm(`Delete the "${col.name}" column? Its values are removed from every item.`)) run({ action: "delete_column", id: col.id }); }}>Delete</button>
            </div>
            {labelCol === col.id && <PMLabelEditor col={col} run={run} />}
          </div>
        ))}
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <input placeholder="New column name" style={{ ...S.input, maxWidth: 180, padding: "5px 8px", fontSize: 12.5 }} value={newColName} onChange={(e) => setNewColName(e.target.value)} />
          <select style={{ ...S.input, width: 130, padding: "5px 8px", fontSize: 12.5 }} value={newColType} onChange={(e) => setNewColType(e.target.value)}>
            {PM_COL_TYPES.map(([t, l]) => <option key={t} value={t}>{l}</option>)}
          </select>
          <button type="button" style={S.btn("#EEF2FF", ACCENT)} disabled={!newColName.trim()}
            onClick={() => { run({ action: "create_column", boardId: board.id, type: newColType, name: newColName.trim() }); setNewColName(""); }}>＋ Add column</button>
        </div>

        <span style={flabel}>Danger zone</span>
        <button type="button" style={{ ...S.btn("#FEF2F2", "#DC2626"), border: "1px solid #FECACA" }}
          onClick={() => { if (window.confirm(`Archive the "${board.name}" board? It disappears from the switcher (items are kept).`)) run({ action: "archive_board", id: board.id }, () => { onArchivedBoard(); onClose(); }); }}>
          Archive this board
        </button>
      </div>
    </AdmOverlay>
  );
}

// Status-label / dropdown-option editor. Status labels carry the client-status mapping —
// the dial that decides what (if anything) a builder sees when an item lands on a label.
function PMLabelEditor({ col, run }) {
  const isStatus = col.type === "status";
  const list = isStatus ? (col.settings?.labels || []) : (col.settings?.options || []);
  const [rows, setRows] = useState(list);
  useEffect(() => { setRows(isStatus ? (col.settings?.labels || []) : (col.settings?.options || [])); }, [col]);

  const commit = (next, reassign) => {
    const settings = isStatus ? { labels: next } : { options: next, multi: col.settings?.multi === true };
    run({ action: "update_column", id: col.id, settings, reassign });
  };
  const patch = (i, p) => { const next = rows.map((r, j) => (j === i ? { ...r, ...p } : r)); setRows(next); return next; };

  return (
    <div style={{ background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 8, padding: "8px 12px", margin: "4px 0 8px" }}>
      {rows.map((l, i) => (
        <div key={l.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderBottom: "1px dashed #EEF1F6", fontSize: 12.5, flexWrap: "wrap" }}>
          <input style={{ ...S.input, width: 150, padding: "3px 7px", fontSize: 12 }} value={l.label}
            onChange={(e) => patch(i, { label: e.target.value })}
            onBlur={() => commit(rows)} />
          <PMSwatches value={l.color} onPick={(c) => commit(patch(i, { color: c }))} />
          {isStatus && (
            <label style={{ fontSize: 11, color: "#64748B", fontWeight: 600, display: "flex", alignItems: "center", gap: 4 }}>
              client sees →
              <select style={{ ...S.input, width: 130, padding: "3px 6px", fontSize: 11.5, fontStyle: l.client_status ? "normal" : "italic" }}
                value={l.client_status || ""}
                onChange={(e) => commit(patch(i, { client_status: e.target.value || undefined }))}>
                <option value="">nothing changes</option>
                {Object.entries(PM_CLIENT_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
          )}
          {rows.length > 1 && (
            <button type="button" style={{ marginLeft: "auto", background: "none", border: "none", color: "#DC2626", fontSize: 11, fontWeight: 700, cursor: "pointer" }}
              onClick={() => {
                const rest = rows.filter((_, j) => j !== i);
                if (isStatus) {
                  const to = rest[0];
                  if (window.confirm(`Delete "${l.label}"? Items using it move to "${to.label}".`)) {
                    commit(rest, { [l.id]: to.id });
                  }
                } else if (window.confirm(`Delete "${l.label}"?`)) { commit(rest); }
              }}>Delete</button>
          )}
        </div>
      ))}
      <button type="button" style={{ background: "none", border: "none", color: ACCENT, fontSize: 12, fontWeight: 700, cursor: "pointer", padding: "6px 0 2px" }}
        onClick={() => commit([...rows, { label: isStatus ? "New label" : "New option", color: "#64748B" }])}>＋ Add {isStatus ? "label" : "option"}</button>
    </div>
  );
}

// ── The tab ───────────────────────────────────────────────────────────────────
function ProjectsTab({ sub, onSub }) {
  const [boards, setBoards] = useState(null);
  const [counts, setCounts] = useState({});
  const [canWrite, setCanWrite] = useState(false);
  const [data, setData] = useState(null);          // { board, columns, groups, items, operators }
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [facets, setFacets] = useState({});        // colId -> value key
  const [whenCond, setWhenCond] = useState("any");
  const [whenA, setWhenA] = useState(""); const [whenB, setWhenB] = useState("");
  const [whenMonth, setWhenMonth] = useState(""); const [whenN, setWhenN] = useState(""); const [whenUnit, setWhenUnit] = useState("days");
  const [whenColId, setWhenColId] = useState(null);
  const [view, setView] = useState({ sortKey: "name", sortDir: "asc", groupBy: "groups", hiddenCols: [] });
  const [colsOpen, setColsOpen] = useState(false);
  const [openItemId, setOpenItemId] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newBoardOpen, setNewBoardOpen] = useState(false);
  const [newBoardName, setNewBoardName] = useState("");

  const loadBoards = useCallback(() => {
    return pmCall({ action: "list_boards" }).then((d) => {
      setBoards(d.boards); setCounts(d.counts || {}); setCanWrite(!!d.canWrite);
      return d.boards;
    }).catch((e) => { setErr(e.message); return []; });
  }, []);
  useEffect(() => { loadBoards(); }, [loadBoards]);

  const activeBoard = useMemo(() => {
    if (!boards || !boards.length) return null;
    return boards.find((b) => b.slug === sub) || boards[0];
  }, [boards, sub]);

  const loadBoard = useCallback((b) => {
    if (!b) return;
    setLoading(true); setErr("");
    pmCall({ action: "get_board", boardId: b.id }).then((d) => {
      setData(d); setCanWrite(!!d.canWrite);
      setView(pmLoadView(b.slug, d.columns));
      const dateCols = d.columns.filter((c) => c.type === "date");
      setWhenColId((cur) => (dateCols.some((c) => c.id === cur) ? cur : (dateCols[0] ? dateCols[0].id : null)));
    }).catch((e) => setErr(e.message)).finally(() => setLoading(false));
  }, []);
  useEffect(() => { if (activeBoard) loadBoard(activeBoard); }, [activeBoard && activeBoard.id]);

  const reload = useCallback(() => { if (activeBoard) loadBoard(activeBoard); }, [activeBoard, loadBoard]);

  const setViewPart = (p) => setView((v) => {
    const next = { ...v, ...p };
    if (activeBoard) pmSaveView(activeBoard.slug, next);
    return next;
  });

  const ctx = useMemo(() => ({
    operators: (data && data.operators) || [],
    operatorsById: Object.fromEntries(((data && data.operators) || []).map((o) => [o.user_id, o])),
  }), [data]);

  // Optimistic local patch + server call; a failed write reloads so the screen never lies.
  const mutateItem = (id, patch) => setData((d) => d && ({ ...d, items: d.items.map((it) => (it.id === id ? { ...it, ...patch } : it)) }));
  const callOrReload = (body, optimistic) => {
    if (optimistic) optimistic();
    pmCall(body).catch((e) => { setErr(e.message); reload(); });
  };

  const onCellCommit = (item, col, value) => callOrReload(
    { action: "update_item", id: item.id, values: { [col.id]: value } },
    () => mutateItem(item.id, { values: { ...(item.values || {}), [col.id]: value }, updated_at: new Date().toISOString() }),
  );
  const onRename = (item, name) => callOrReload(
    { action: "update_item", id: item.id, name },
    () => mutateItem(item.id, { name }),
  );
  const onArchive = (item) => callOrReload(
    { action: "archive_items", ids: [item.id] },
    () => setData((d) => d && ({ ...d, items: d.items.filter((it) => it.id !== item.id) })),
  );
  const onAddItem = (group, name) => {
    if (view.groupBy !== "groups") return;
    pmCall({ action: "create_item", boardId: data.board.id, groupId: group.key, name })
      .then((d) => setData((cur) => cur && ({ ...cur, items: [...cur.items, d.item] })))
      .catch((e) => { setErr(e.message); reload(); });
  };
  const onDropToGroup = (item, g) => {
    if (view.groupBy === "groups") {
      if (!g.isRealGroup || g.key === item.group_id) return;
      callOrReload({ action: "move_items", ids: [item.id], groupId: g.key },
        () => mutateItem(item.id, { group_id: g.key }));
    } else {
      // Grouped by a column: dropping into a bucket SETS that column's value.
      const col = data.columns.find((c) => c.id === view.groupBy);
      if (!col || g.key === "__none") return;
      let v = g.key;
      if (col.type === "dropdown" || col.type === "people") v = [g.key];
      if (col.type === "checkbox") v = g.key === "yes";
      onCellCommit(item, col, v);
    }
  };
  const onDropOnRow = (item, target) => {
    if (view.groupBy === "groups") {
      pmCall({ action: "reorder_item", id: item.id, beforeId: target.id, groupId: target.group_id })
        .then(reload)
        .catch((e) => { setErr(e.message); reload(); });
    } else {
      // In a column grouping, landing on a row means "same bucket as that row".
      const col = data.columns.find((c) => c.id === view.groupBy);
      if (!col) return;
      const v = target.values ? target.values[col.id] : null;
      onCellCommit(item, col, v);
    }
  };

  // Filters compose: search → facets → WHEN. (The engine's grouping then arranges.)
  const filtered = useMemo(() => {
    if (!data) return [];
    const todayIso = ssLocalIso(new Date());
    const whenParams = { a: whenA, b: whenB, month: whenMonth, n: whenN, unit: whenUnit };
    return data.items.filter((r) => {
      if (q.trim()) {
        const texts = [r.name];
        data.columns.forEach((c) => {
          const v = r.values ? r.values[c.id] : null;
          if (c.type === "status") { const l = pmStatusLabel(c, v); if (l) texts.push(l.label); }
          else if (c.type === "dropdown") (Array.isArray(v) ? v : []).forEach((id) => { const o = pmOption(c, id); if (o) texts.push(o.label); });
          else if (c.type === "people") texts.push(...pmPeopleNames(v, ctx));
          else if (typeof v === "string") texts.push(v);
          else if (v && v.text) texts.push(v.text);
        });
        if (!rowMatchesQuery({ t: texts }, q)) return false;
      }
      for (const [colId, want] of Object.entries(facets)) {
        if (want == null) continue;
        const col = data.columns.find((c) => c.id === colId);
        if (!col) continue;
        const v = r.values ? r.values[colId] : null;
        if (col.type === "people") { if (!(Array.isArray(v) && v.includes(want))) return false; }
        else if (pmType(col).groupKeyOf(v) !== want) return false;
      }
      if (whenCond !== "any" && whenColId) {
        const iso = r.values ? r.values[whenColId] : null;
        // Undated rows ALWAYS survive a date filter (the schedule's rule: the rows most
        // needing a date must never disappear because of one).
        if (iso && !ssWhenMatch(whenCond, whenParams, iso, todayIso)) return false;
      }
      return true;
    });
  }, [data, q, facets, whenCond, whenA, whenB, whenMonth, whenN, whenUnit, whenColId, ctx]);

  const filtersOn = q.trim() !== "" || Object.values(facets).some((v) => v != null) || whenCond !== "any";
  const openItem = openItemId && data ? data.items.find((i) => i.id === openItemId) : null;

  const facetCols = data ? data.columns.filter((c) => pmType(c).facet) : [];
  const dateCols = data ? data.columns.filter((c) => c.type === "date") : [];
  const groupables = data ? data.columns.filter((c) => pmGroupable(c, ctx)) : [];

  const pill = (on) => ({ border: "1px solid", borderColor: on ? ACCENT : "#CBD5E1", background: on ? ACCENT : "#FFF", color: on ? "#FFF" : "#334155", borderRadius: 999, padding: "6px 15px", fontSize: 13, fontWeight: 700, cursor: "pointer" });

  return (
    <div>
      <div style={S.card}>
        {/* Board switcher */}
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
          {(boards || []).map((b) => (
            <button key={b.id} type="button" style={pill(activeBoard && b.id === activeBoard.id)} onClick={() => onSub(b.slug)}>
              {b.name}{counts[b.id] != null ? ` (${counts[b.id]})` : ""}
            </button>
          ))}
          {canWrite && (
            newBoardOpen ? (
              <input autoFocus placeholder="Board name — Enter to create" style={{ ...S.input, maxWidth: 220, padding: "6px 10px", fontSize: 12.5 }}
                value={newBoardName} onChange={(e) => setNewBoardName(e.target.value)}
                onBlur={() => { setNewBoardOpen(false); setNewBoardName(""); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newBoardName.trim()) {
                    pmCall({ action: "create_board", name: newBoardName.trim() })
                      .then((d) => loadBoards().then(() => onSub(d.board.slug)))
                      .catch((er) => setErr(er.message));
                    setNewBoardOpen(false); setNewBoardName("");
                  }
                  if (e.key === "Escape") { setNewBoardOpen(false); setNewBoardName(""); }
                }} />
            ) : (
              <button type="button" style={{ ...pill(false), borderStyle: "dashed", color: "#64748B", fontWeight: 600 }} onClick={() => setNewBoardOpen(true)}>＋ New board</button>
            )
          )}
          <span style={{ marginLeft: "auto" }} />
          {canWrite && data && (
            <button type="button" style={{ ...S.btn("#F1F5F9", "#334155"), padding: "7px 13px", fontSize: 12 }} onClick={() => setSettingsOpen(true)}>⚙ Board settings</button>
          )}
        </div>
        {err && <div style={S.err}>{err}</div>}
        {!boards && !err && <div style={{ color: "#94A3B8", fontSize: 13 }}>Loading boards…</div>}

        {data && (
          <>
            {/* Toolbar: search · facets · WHEN · group-by · columns */}
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
              <div style={{ minWidth: 200 }}><SearchInput value={q} onChange={setQ} placeholder="Search items…" /></div>
              {facetCols.map((c) => (
                <FacetSelect key={c.id} label={c.name} value={facets[c.id] || ""} allLabel={"All"}
                  onChange={(v) => setFacets((f) => ({ ...f, [c.id]: v || null }))}
                  options={(pmType(c).groupsFor(c, ctx) || []).map((g) => ({ value: g.key, label: g.label }))} />
              ))}
              {dateCols.length > 0 && (
                <span style={{ display: "inline-flex", gap: 5, alignItems: "center", fontSize: 12, fontWeight: 700, color: "#334155" }}>
                  {dateCols.length > 1 ? (
                    <select style={{ ...S.input, width: "auto", padding: "5px 7px", fontSize: 12 }} value={whenColId || ""} onChange={(e) => setWhenColId(e.target.value || null)}>
                      {dateCols.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  ) : dateCols[0].name + ":"}
                  <select style={{ ...S.input, width: "auto", padding: "5px 7px", fontSize: 12, fontWeight: 700 }} value={whenCond} onChange={(e) => setWhenCond(e.target.value)}>
                    {SS_WHEN.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                  </select>
                  {SS_WHEN_PARAM[whenCond] === "date" && <input type="date" style={{ ...S.input, width: "auto", padding: "4px 6px", fontSize: 12 }} value={whenA} onChange={(e) => setWhenA(e.target.value)} />}
                  {SS_WHEN_PARAM[whenCond] === "date2" && (<>
                    <input type="date" style={{ ...S.input, width: "auto", padding: "4px 6px", fontSize: 12 }} value={whenA} onChange={(e) => setWhenA(e.target.value)} />
                    <span style={{ color: "#94A3B8" }}>–</span>
                    <input type="date" style={{ ...S.input, width: "auto", padding: "4px 6px", fontSize: 12 }} value={whenB} onChange={(e) => setWhenB(e.target.value)} />
                  </>)}
                  {SS_WHEN_PARAM[whenCond] === "month" && <input type="month" style={{ ...S.input, width: "auto", padding: "4px 6px", fontSize: 12 }} value={whenMonth} onChange={(e) => setWhenMonth(e.target.value)} />}
                  {SS_WHEN_PARAM[whenCond] === "count" && (<>
                    <input type="number" min="1" style={{ ...S.input, width: 64, padding: "4px 6px", fontSize: 12 }} value={whenN} onChange={(e) => setWhenN(e.target.value)} />
                    <select style={{ ...S.input, width: "auto", padding: "4px 6px", fontSize: 12 }} value={whenUnit} onChange={(e) => setWhenUnit(e.target.value)}>
                      <option value="days">days</option><option value="weeks">weeks</option><option value="months">months</option>
                    </select>
                  </>)}
                </span>
              )}
              <label style={{ fontSize: 12, fontWeight: 700, color: "#334155", display: "inline-flex", gap: 5, alignItems: "center" }}>
                Group by
                <select style={{ ...S.input, width: "auto", padding: "5px 7px", fontSize: 12, fontWeight: 700 }} value={view.groupBy}
                  onChange={(e) => setViewPart({ groupBy: e.target.value })}>
                  <option value="groups">Groups</option>
                  {groupables.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
              <span style={{ position: "relative" }}>
                <button type="button" style={{ ...S.btn("#FFF", "#334155"), border: "1px solid #CBD5E1", padding: "6px 12px", fontSize: 12 }} onClick={() => setColsOpen((o) => !o)}>Columns ▾</button>
                {colsOpen && (
                  <div style={{ position: "absolute", top: "110%", left: 0, zIndex: 60, background: "#FFF", border: "1px solid #CBD5E1", borderRadius: 10, boxShadow: "0 12px 30px rgba(20,24,40,.15)", padding: "8px 12px", minWidth: 170 }}>
                    {data.columns.map((c) => (
                      <label key={c.id} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5, fontWeight: 600, padding: "3px 0", cursor: "pointer" }}>
                        <input type="checkbox" checked={!view.hiddenCols.includes(c.id)}
                          onChange={(e) => setViewPart({ hiddenCols: e.target.checked ? view.hiddenCols.filter((x) => x !== c.id) : [...view.hiddenCols, c.id] })} />
                        {c.name}
                      </label>
                    ))}
                  </div>
                )}
              </span>
              <span style={{ marginLeft: "auto", fontSize: 12, color: "#64748B", fontWeight: 600, whiteSpace: "nowrap" }}>
                Showing {filtered.length} of {data.items.length}
                {filtersOn && (
                  <button type="button" style={{ background: "none", border: "none", color: "#DC2626", fontWeight: 700, fontSize: 12, cursor: "pointer" }}
                    onClick={() => { setQ(""); setFacets({}); setWhenCond("any"); setWhenA(""); setWhenB(""); setWhenMonth(""); setWhenN(""); }}>
                    Clear filters
                  </button>
                )}
                <button type="button" title="Refresh" style={{ background: "none", border: "none", color: "#64748B", fontWeight: 700, fontSize: 13, cursor: "pointer", opacity: loading ? 0.4 : 1 }}
                  disabled={loading} onClick={reload}>↻</button>
              </span>
            </div>

            <PMTable
              columns={data.columns} rows={filtered} boardGroups={data.groups} ctx={ctx}
              groupBy={view.groupBy} hiddenCols={new Set(view.hiddenCols)}
              sortKey={view.sortKey} sortDir={view.sortDir}
              onSort={(col) => setViewPart(view.sortKey === col ? { sortDir: view.sortDir === "asc" ? "desc" : "asc" } : { sortKey: col, sortDir: "asc" })}
              canEdit={canWrite}
              onCellCommit={onCellCommit} onDropToGroup={onDropToGroup} onDropOnRow={onDropOnRow}
              onRowOpen={(r) => setOpenItemId(r.id)} onAddItem={onAddItem}
              activeItemId={openItemId} />
          </>
        )}
      </div>

      {openItem && data && (
        <PMItemModal key={openItem.id + ":" + (openItem.updated_at || "")}
          item={openItem} columns={data.columns} ctx={ctx} canWrite={canWrite}
          onClose={() => setOpenItemId(null)}
          onCellCommit={onCellCommit} onRename={onRename} onArchive={onArchive}
          onChanged={reload} />
      )}
      {settingsOpen && data && (
        <PMBoardSettings board={data.board} columns={data.columns} groups={data.groups}
          onClose={() => setSettingsOpen(false)} onChanged={reload}
          onArchivedBoard={() => loadBoards().then((bs) => { if (bs && bs.length) onSub(bs[0].slug); })} />
      )}
    </div>
  );
}
