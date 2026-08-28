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
// modal (notes/updates thread + client publishing ONLY - fields are edited in their
// cells), and board configuration
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

// One uniform toolbar control: a 32px pill with its label INSIDE, so search, the three
// facets, the date condition, Group by and Columns all share a height and a baseline.
const PM_CTL = { display: "inline-flex", alignItems: "center", height: 32, boxSizing: "border-box",
  border: "1px solid #CBD5E1", borderRadius: 8, background: "#FFF", fontSize: 12.5, whiteSpace: "nowrap" };
const PM_CTL_SEL = { border: "none", outline: "none", background: "none", fontSize: 12.5, fontWeight: 700,
  color: "#1E293B", fontFamily: "inherit", cursor: "pointer", maxWidth: 170 };
const PM_VIEW_CHIP = { border: "1px solid #CBD5E1", borderRadius: 999, background: "#FFF", color: "#334155",
  padding: "5px 12px", fontSize: 12.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" };
function PMCtl({ label, children }) {
  return (
    <span style={{ ...PM_CTL, padding: "0 8px", gap: 5 }}>
      {label && <span style={{ fontSize: 11, fontWeight: 700, color: "#94A3B8", textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</span>}
      {children}
    </span>
  );
}
// Notes carry a real timestamp, not just a date - a thread of same-day updates is
// unreadable without one (Carolyn 2026-08-27).
function pmStamp(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("en-US",
      { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  } catch (_) { return String(iso); }
}

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

// ── Saved views (Carolyn 2026-08-27: "a save this Filter option, and we give it a
// name so we can easily go to saved views") ──────────────────────────────────────
// A view is the whole working state of the board: search text, facets, the date
// condition, grouping, sort and hidden columns. Stored per board in localStorage —
// per browser, like every other view preference in the portal. Say the word and these
// move to a pm_views table so they follow you between machines and reach the team.
const pmViewsKey = (slug) => "ss_projects_views_" + slug;
// The comparable shape of "what is on screen right now". Null/empty facets are stripped
// so {status:null} and {} are the same view — otherwise clearing a filter by hand would
// stop matching the saved view it actually equals.
function pmSnapshot({ q, facets, whenColId, whenCond, whenA, whenB, whenMonth, whenN, whenUnit, view }) {
  const f = {};
  Object.keys(facets || {}).sort().forEach((k) => { if (facets[k] != null && facets[k] !== "") f[k] = facets[k]; });
  return {
    q: (q || "").trim(),
    facets: f,
    when: whenCond === "any" ? null : { colId: whenColId || null, cond: whenCond, a: whenA || "", b: whenB || "", month: whenMonth || "", n: whenN || "", unit: whenUnit || "days" },
    groupBy: view.groupBy, sortKey: view.sortKey, sortDir: view.sortDir,
    hiddenCols: (view.hiddenCols || []).slice().sort(),
  };
}
// The server rebuilds every snapshot it stores (sanitizeSnap), so a saved view read back
// can differ from the one just sent — an absent `q` becomes "", a dropped column
// disappears from hiddenCols. Compare through the same normaliser or the active-view chip
// never lights for the view you are looking at.
function pmNormSnap(raw) {
  const s = raw || {};
  const f = {};
  Object.keys(s.facets || {}).sort().forEach((k) => { if (s.facets[k] != null && s.facets[k] !== "") f[k] = s.facets[k]; });
  return JSON.stringify({
    q: (s.q || "").trim(),
    facets: f,
    when: s.when && s.when.cond && s.when.cond !== "any"
      ? { colId: s.when.colId || null, cond: s.when.cond, a: s.when.a || "", b: s.when.b || "", month: s.when.month || "", n: s.when.n || "", unit: s.when.unit || "days" }
      : null,
    groupBy: s.groupBy || "groups", sortKey: s.sortKey || "name",
    sortDir: s.sortDir === "desc" ? "desc" : "asc",
    hiddenCols: (s.hiddenCols || []).slice().sort(),
  });
}
// ONE-TIME LIFT: saved views were per-browser localStorage for a few hours on 2026-08-27
// before Carolyn asked for them to be shared. Anything a browser still holds is pushed up
// once and the key dropped, so nobody loses a view they named. Safe to delete this (and
// pmViewsKey) once every operator browser has loaded the board at least once.
async function pmLiftLocalViews(board) {
  let local = [];
  try { local = JSON.parse(localStorage.getItem(pmViewsKey(board.slug)) || "[]"); } catch (_) { return false; }
  if (!Array.isArray(local) || !local.length) return false;
  let allSaved = true;
  for (const v of local) {
    if (!v || typeof v.name !== "string" || !v.snap) continue;
    try { await pmCall({ action: "save_view", boardId: board.id, name: v.name, snap: v.snap }); }
    catch (_) { allSaved = false; /* a failed lift must not block the board */ }
  }
  // Only drop the local copy once every view is safely on the server — clearing it after a
  // failed save would silently destroy the one thing this function exists to rescue. A
  // retained key just means the next load tries again.
  if (allSaved) {
    try { localStorage.removeItem(pmViewsKey(board.slug)); } catch (_) { /* private mode */ }
  }
  return true;
}

// What the pm-attachments bucket accepts (migration 144) — checked here so a rejected
// file says so before it is uploaded, rather than after a 25MB round trip.
const PM_FILE_MIME = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", pdf: "application/pdf",
};
const PM_MAX_FILE = 25 * 1024 * 1024;
const pmExt = (name) => String(name || "").split(".").pop().toLowerCase();
const pmIsImage = (a) => String(a.mime || "").startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp"].includes(pmExt(a.name || a.path));
const pmFileIcon = (a) => (pmIsImage(a) ? "🖼️" : (pmExt(a.name || a.path) === "pdf" ? "📄" : "📎"));

// Upload one file to an item and record it on an update. The signed upload URL comes from
// portal-projects (the bucket has no browser policies at all), the bytes go straight to
// storage, and attach_meta writes the row — so a large screenshot never travels through
// the edge function.
async function pmUploadTo(itemId, updateId, file) {
  const ext = pmExt(file.name);
  const mime = PM_FILE_MIME[ext];
  if (!mime) throw new Error(`"${file.name}" is not a kind of file we can attach (images, video or PDF).`);
  if (file.size > PM_MAX_FILE) throw new Error(`"${file.name}" is larger than 25 MB.`);
  const signed = await pmCall({ action: "upload_attachment", itemId, name: file.name });
  const up = await sb.storage.from("pm-attachments").uploadToSignedUrl(signed.path, signed.token, file, { contentType: mime });
  if (up.error) throw new Error(up.error.message);
  await pmCall({ action: "attach_meta", updateId, path: signed.path, name: file.name, size: file.size, mime });
}

// ── Right-side slide-in panel (replaced the centred popup, Carolyn 2026-08-27) ────
// Same contract as AdmOverlay — Escape, click-outside, aria-modal, body-scroll lock —
// but anchored to the right edge so the board stays visible beside it. The transform is
// driven by state rather than a CSS keyframe so portal.html needs no new stylesheet
// rule, and it is skipped entirely when the viewer asks for reduced motion.
function PMDrawer({ onClose, labelledBy, children }) {
  const [shown, setShown] = useState(false);
  const [instant, setInstant] = useState(false);
  useEffect(() => {
    try { setInstant(window.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch (_) { /* older browser */ }
    const raf = requestAnimationFrame(() => setShown(true));
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    // Counted, NOT saved-and-restored: PdfModal opens on top of this drawer for an
    // attachment and locks the page too, and two independent save/restore pairs leave the
    // page permanently unscrollable when both close together. See ssLockBodyScroll.
    const unlock = ssLockBodyScroll();
    return () => { cancelAnimationFrame(raf); window.removeEventListener("keydown", onKey); unlock(); };
  }, [onClose]);
  return (
    <div onClick={onClose} role="presentation"
      style={{ position: "fixed", inset: 0, background: shown ? "rgba(15,23,42,0.34)" : "rgba(15,23,42,0)", transition: instant ? "none" : "background .18s ease-out", zIndex: 1200, display: "flex", justifyContent: "flex-end" }}>
      <div role="dialog" aria-modal="true" aria-labelledby={labelledBy} onClick={(e) => e.stopPropagation()}
        style={{ background: "#FFF", width: "min(580px, 100%)", height: "100%", display: "flex", flexDirection: "column",
          boxShadow: "-14px 0 40px rgba(15,23,42,.22)",
          transform: shown ? "translateX(0)" : "translateX(100%)",
          transition: instant ? "none" : "transform .18s ease-out" }}>
        {children}
      </div>
    </div>
  );
}

// ── Item panel — NOTES ONLY, in a right-side slide-in (Carolyn 2026-08-27) ────
// "Clicking on the title/name of the item is the only time a popup should appear and it
// should only have the title and ability to add a note/update and then under that we
// should see the rolling list of all the notes/updates/original submission with dates
// and timestamps." — then, having used it: "instead of the popup, lets do a right side
// popin or slide in. Keep the remove from board."
//
// So this is deliberately NOT a form: every field lives in its own cell in the table.
// The one thing that cannot live in a row — a conversation — lives here, and the
// client's original words sit at the bottom of it as the first entry in the thread.
// Header and footer are pinned; only the thread scrolls.
function PMItemPanel({ item, canWrite, onClose, onRename, onArchive }) {
  const [detail, setDetail] = useState(null);      // { updates, submission }
  const [err, setErr] = useState("");
  const [name, setName] = useState(item.name);
  const [compose, setCompose] = useState("");
  const [toClient, setToClient] = useState(false);
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState([]);          // staged for the next post
  const [viewing, setViewing] = useState(null);    // attachment opened in the popup
  const fileRef = useRef(null);

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
      const d = await pmCall({ action: "add_update", itemId: item.id, body, clientVisible: toClient });
      // Files attach to the update that was just created, so a failed upload leaves the
      // note itself intact and says which file did not make it.
      for (const f of files) await pmUploadTo(item.id, d.update.id, f);
      setCompose(""); setToClient(false); setFiles([]);
      if (fileRef.current) fileRef.current.value = "";
      loadDetail();
    } catch (e) { setErr(e.message); loadDetail(); }
    setBusy(false);
  };
  const publishExisting = async (u) => {
    const who = sub ? (sub.client_id || "this client") : "this client";
    if (!window.confirm(`Publish this update to ${who}? They will see it in My Submissions.`)) return;
    try { await pmCall({ action: "publish_update", id: u.id }); loadDetail(); }
    catch (e) { setErr(e.message); }
  };
  const deleteUpdate = async (u) => {
    const warn = u.client_visible ? "Delete this note? The copy the client sees will be removed too." : "Delete this note?";
    if (!window.confirm(warn)) return;
    try { await pmCall({ action: "delete_update", id: u.id }); loadDetail(); }
    catch (e) { setErr(e.message); }
  };

  const tag = (bg, fg, text) => (
    <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: 0.4, borderRadius: 4, padding: "1px 6px", background: bg, color: fg, whiteSpace: "nowrap" }}>{text}</span>
  );

  return (
    <>
    <PMDrawer onClose={onClose} labelledBy="pm-item-title">
      {/* Header — pinned */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 18px", borderBottom: "1px solid #E2E8F0", flexShrink: 0 }}>
        {canWrite ? (
          <input id="pm-item-title" style={{ ...S.input, fontSize: 15.5, fontWeight: 800, flex: 1 }} value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => { if (name.trim() && name !== item.name) onRename(item, name.trim()); }}
            onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); }} />
        ) : (
          <div id="pm-item-title" style={{ fontSize: 15.5, fontWeight: 800, flex: 1 }}>{item.name}</div>
        )}
        {item.feedback_submission_id && tag("#E6F7FA", "#1B7895", "CLIENT")}
        <button type="button" onClick={onClose} aria-label="Close"
          style={{ background: "none", border: "none", color: "#94A3B8", fontSize: 20, fontWeight: 700, cursor: "pointer", lineHeight: 1 }}>✕</button>
      </div>

      {/* Thread — the only scrolling region */}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "14px 18px" }}>
        {err && <div style={S.err}>{err}</div>}

        {canWrite && (
          <div style={{ border: "1px solid #CBD5E1", borderRadius: 10, padding: "10px 12px", marginBottom: 14 }}>
            <textarea rows={3} placeholder="Add a note or update…" style={{ ...S.input, resize: "vertical", fontWeight: 500 }}
              value={compose} onChange={(e) => setCompose(e.target.value)} />
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: item.feedback_submission_id ? "#334155" : "#94A3B8", display: "flex", alignItems: "center", gap: 5 }}
                title={item.feedback_submission_id ? "Publishes this one note to the client's My Submissions feed" : "This item isn't linked to a client submission"}>
                <input type="checkbox" checked={toClient} disabled={!item.feedback_submission_id}
                  onChange={(e) => setToClient(e.target.checked)} />
                Visible to client
              </label>
              <button type="button" onClick={() => fileRef.current && fileRef.current.click()}
                style={{ background: "none", border: "none", color: "#64748B", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                📎 Attach
              </button>
              <input ref={fileRef} type="file" multiple accept="image/*,video/*,.pdf" style={{ display: "none" }}
                onChange={(e) => { setFiles(Array.from(e.target.files || []).slice(0, 10)); }} />
              <button type="button" style={{ ...S.btn(ACCENT, "#FFF"), marginLeft: "auto", padding: "6px 16px", fontSize: 12, opacity: busy || !compose.trim() ? 0.6 : 1 }}
                disabled={busy || !compose.trim()} onClick={post}>{busy ? "Posting…" : "Post"}</button>
            </div>
            {files.length > 0 && (
              <div style={{ marginTop: 7, display: "flex", flexWrap: "wrap", gap: 6 }}>
                {files.map((f, i) => (
                  <span key={f.name + i} style={{ fontSize: 11.5, fontWeight: 600, color: "#334155", background: "#F1F5F9", borderRadius: 6, padding: "3px 8px" }}>
                    {pmFileIcon({ name: f.name })} {f.name}
                    <button type="button" title="Remove" onClick={() => setFiles(files.filter((_, j) => j !== i))}
                      style={{ background: "none", border: "none", color: "#94A3B8", cursor: "pointer", fontSize: 11, padding: "0 0 0 6px" }}>✕</button>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {!detail && !err && <div style={{ color: "#94A3B8", fontSize: 12.5 }}>Loading…</div>}
        {detail && detail.updates.map((u) => (
          <div key={u.id} style={{ borderLeft: `3px solid ${u.client_visible ? "#8ED8CF" : "#E2E8F0"}`, background: u.client_visible ? "#F2FBFA" : "#FFF", borderRadius: 6, padding: "8px 12px", marginBottom: 8, fontSize: 12.8 }}>
            <div style={{ display: "flex", gap: 7, alignItems: "center", marginBottom: 3, flexWrap: "wrap" }}>
              <b style={{ fontSize: 11.5, color: "#334155" }}>{(u.author_email || "?").split("@")[0]}</b>
              <span style={{ fontSize: 11.5, color: "#94A3B8" }}>{pmStamp(u.created_at)}{u.edited_at ? " · edited" : ""}</span>
              {u.client_visible ? tag("#CCF1EC", "#0F766E", "VISIBLE TO CLIENT ✓") : tag("#F1F5F9", "#64748B", "INTERNAL")}
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
              <button key={a.path} type="button" onClick={() => setViewing(a)}
                style={{ display: "inline-block", marginTop: 4, marginRight: 8, fontSize: 12, color: "#1B7895", fontWeight: 600, background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit", textDecoration: "underline", textUnderlineOffset: 2 }}>
                {pmFileIcon(a)} {a.name || "attachment"}
              </button>
            ))}
          </div>
        ))}

        {/* The original submission is the FIRST entry in the thread — oldest, so last. */}
        {sub && (
          <div style={{ borderLeft: "3px solid #1B7895", background: "#F8FAFC", borderRadius: 6, padding: "8px 12px", fontSize: 12.8 }}>
            <div style={{ display: "flex", gap: 7, alignItems: "center", marginBottom: 3, flexWrap: "wrap" }}>
              <b style={{ fontSize: 11.5, color: "#334155" }}>{sub.submitter_name || "?"}</b>
              <span style={{ fontSize: 11.5, color: "#94A3B8" }}>{pmStamp(sub.created_at)}</span>
              {tag("#E6F7FA", "#1B7895", "ORIGINAL REQUEST · " + (sub.client_id || ""))}
            </div>
            <div style={{ whiteSpace: "pre-wrap" }}>{sub.detail || sub.title}</div>
            <div style={{ marginTop: 5, fontSize: 11.5, color: "#64748B" }}>
              {sub.severity ? `Their importance: ${sub.severity} · ` : ""}They currently see: <b>{PM_CLIENT_STATUS[sub.status] || sub.status}</b>
            </div>
            {sub.attachmentUrl && (
              <button type="button" onClick={() => setViewing({ url: sub.attachmentUrl, name: sub.attachment_path || "Their attachment", path: sub.attachment_path })}
                style={{ display: "inline-block", marginTop: 4, fontSize: 12, color: "#1B7895", fontWeight: 600, background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit", textDecoration: "underline", textUnderlineOffset: 2 }}>
                {pmFileIcon({ name: sub.attachment_path || "" })} Their attachment
              </button>
            )}
          </div>
        )}
        {detail && !detail.updates.length && !sub && <div style={{ color: "#94A3B8", fontSize: 12.5 }}>No notes yet.</div>}
      </div>

      {/* Footer — pinned, so Remove never hides below a long thread */}
      {canWrite && (
        <div style={{ padding: "10px 18px", borderTop: "1px solid #E2E8F0", textAlign: "right", flexShrink: 0 }}>
          <button type="button" style={{ background: "none", border: "none", color: "#DC2626", fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}
            onClick={() => { if (window.confirm("Remove this item from the board? (It is archived, not destroyed.)")) { onArchive(item); onClose(); } }}>
            Remove from board
          </button>
        </div>
      )}
    </PMDrawer>

    {/* Attachments open ON THE PAGE (Carolyn 2026-08-27), reusing the same pop-up the
        quotes and invoices use — it already guards the URL, traps Escape and offers the
        new-tab escape hatch when a browser refuses to render a PDF inline.
        ⚠️ Rendered as a SIBLING of the drawer, never inside it: PMDrawer's panel is
        `transform`ed, and a transformed ancestor becomes the containing block for
        `position: fixed`, which laid this out inside the 580px drawer instead of over
        the whole page. */}
    {viewing && (
      <PdfModal url={viewing.url} title={viewing.name || "Attachment"}
        image={pmIsImage(viewing)} onClose={() => setViewing(null)} />
    )}
    </>
  );
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
              {(col.type === "status" || col.type === "dropdown" || col.type === "people") && (
                <button type="button" style={{ background: "none", border: "none", color: "#1B7895", fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}
                  onClick={() => setLabelCol(labelCol === col.id ? null : col.id)}>
                  {labelCol === col.id
                    ? (col.type === "people" ? "Hide people" : "Hide labels")
                    : (col.type === "people" ? "Add / edit people" : "Edit labels")}
                </button>
              )}
              <button type="button" style={{ marginLeft: "auto", background: "none", border: "none", color: "#DC2626", fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}
                onClick={() => { if (window.confirm(`Delete the "${col.name}" column? Its values are removed from every item.`)) run({ action: "delete_column", id: col.id }); }}>Delete</button>
            </div>
            {labelCol === col.id && (col.type === "people"
              ? <PMPeopleEditor onChanged={onChanged} />
              : <PMLabelEditor col={col} run={run} />)}
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

// The people behind the Assignee column (Carolyn 2026-08-27). TWO SEPARATE THINGS on
// purpose, after she asked for the split:
//   * being on this list makes someone ASSIGNABLE — that is all it does, and a name is
//     enough, so a subcontractor or a support person can be assigned work with no login;
//   * "Can open builder accounts" is OPERATOR ACCESS, the real privilege, and it needs a
//     login to attach to. One profile can hold both, which is why they sit on one row.
function PMPeopleEditor({ onChanged }) {
  const [rows, setRows] = useState(null);
  const [me, setMe] = useState(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    pmCall({ action: "list_people" })
      .then((d) => { setRows(d.people || []); setMe(d.me); })
      .catch((e) => setErr(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);

  const run = async (body, after) => {
    setBusy(true); setErr(""); setNote("");
    try { const d = await pmCall(body); load(); if (after) after(d); if (onChanged) onChanged(); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };

  const add = () => {
    if (!name.trim()) return;
    run({ action: "add_person", name: name.trim(), email: email.trim() }, (d) => {
      setName(""); setEmail("");
      setNote(d && d.linked
        ? "Added, and matched to their StructureStudio login — you can give them operator access below."
        : "Added. They can be assigned work now; a matching login is only needed for operator access.");
    });
  };

  return (
    <div style={{ background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 8, padding: "8px 12px", margin: "4px 0 8px" }}>
      {err && <div style={S.err}>{err}</div>}
      {note && <div style={S.okMsg}>{note}</div>}
      {!rows && !err && <div style={{ fontSize: 12, color: "#94A3B8" }}>Loading the team…</div>}

      {rows && rows.length > 0 && (
        <div style={{ display: "flex", gap: 8, fontSize: 10, fontWeight: 800, color: "#94A3B8", textTransform: "uppercase", letterSpacing: 0.4, padding: "2px 0 4px" }}>
          <span style={{ width: 180 }}>Assignable person</span>
          <span style={{ width: 170 }}>Email (for their login)</span>
          <span>Can open builder accounts</span>
        </div>
      )}

      {(rows || []).filter((o) => o.active).map((o) => (
        <div key={o.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px dashed #EEF1F6", fontSize: 12.5, flexWrap: "wrap" }}>
          <span style={{ display: "inline-flex", width: 22, height: 22, borderRadius: "50%", background: pmAvatarColor(o.id), color: "#FFF", fontSize: 9.5, fontWeight: 800, alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            {pmInitials(o)}
          </span>
          <input defaultValue={o.name} style={{ ...S.input, width: 150, padding: "3px 7px", fontSize: 12 }}
            onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== o.name) run({ action: "save_person", id: o.id, name: v }); }} />
          <input defaultValue={o.email || ""} placeholder="no login" style={{ ...S.input, width: 170, padding: "3px 7px", fontSize: 12 }}
            onBlur={(e) => { const v = e.target.value.trim(); if (v !== (o.email || "")) run({ action: "save_person", id: o.id, email: v }); }} />

          <label style={{ fontSize: 11.5, fontWeight: 600, color: o.user_id ? "#334155" : "#94A3B8", display: "inline-flex", alignItems: "center", gap: 4 }}
            title={o.user_id ? "Operator access — they can open ANY builder's account." : "Needs a StructureStudio login first."}>
            <input type="checkbox" checked={!!o.isOperator} disabled={busy || !o.user_id}
              onChange={(ev) => {
                if (ev.target.checked) {
                  if (!window.confirm(`Give ${o.name} operator access? They will be able to open ANY builder's account (read-only until you tick "can edit"). This is separate from being assignable.`)) { load(); return; }
                } else if (!window.confirm(`Remove ${o.name}'s operator access? They stay on the list and can still be assigned work.`)) { load(); return; }
                run({ action: "set_operator_access", id: o.id, enabled: ev.target.checked });
              }} />
            operator
          </label>
          {o.isOperator && (
            <label style={{ fontSize: 11.5, fontWeight: 600, color: "#334155", display: "inline-flex", alignItems: "center", gap: 4 }}
              title="Off means they can look at builders' accounts but change nothing.">
              <input type="checkbox" checked={!!o.canWrite} disabled={busy}
                onChange={(ev) => run({ action: "set_operator_write", id: o.id, canWrite: ev.target.checked })} />
              can edit
            </label>
          )}

          {o.user_id === me
            ? <span style={{ marginLeft: "auto", fontSize: 11, color: "#94A3B8", fontWeight: 700 }}>you</span>
            : (
              <button type="button" disabled={busy}
                onClick={() => { if (window.confirm(`Remove ${o.name} from the assignable list? Work already assigned to them keeps their name, and this does not change their access to builder accounts.`)) run({ action: "remove_person", id: o.id }); }}
                style={{ marginLeft: "auto", background: "none", border: "none", color: "#DC2626", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>Remove</button>
            )}
        </div>
      ))}

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
        <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)}
          style={{ ...S.input, maxWidth: 150, padding: "5px 8px", fontSize: 12.5 }}
          onKeyDown={(e) => { if (e.key === "Enter") add(); }} />
        <input placeholder="their@email.com (optional)" value={email} onChange={(e) => setEmail(e.target.value)}
          style={{ ...S.input, maxWidth: 200, padding: "5px 8px", fontSize: 12.5 }}
          onKeyDown={(e) => { if (e.key === "Enter") add(); }} />
        <button type="button" style={S.btn("#EEF2FF", ACCENT)} disabled={!name.trim() || busy} onClick={add}>＋ Add person</button>
      </div>
      <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 6, lineHeight: 1.45 }}>
        Anyone here can be assigned work — a name is enough, no login needed. <b>Operator</b> is the separate,
        bigger thing: it lets them open any builder's account, so it can only be given to someone whose email
        matches a StructureStudio login.
      </div>
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
  const [savedViews, setSavedViews] = useState([]);
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
      setSavedViews(d.views || []);
      // If this browser still holds pre-sharing local views, push them up and re-read.
      pmLiftLocalViews(b).then((lifted) => {
        if (lifted) pmCall({ action: "get_board", boardId: b.id }).then((d2) => setSavedViews(d2.views || [])).catch(() => {});
      });
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
    people: (data && data.people) || [],
    peopleById: Object.fromEntries(((data && data.people) || []).map((o) => [o.id, o])),
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

  // ── Saved views ────────────────────────────────────────────────────────────
  // The active chip is DERIVED by comparing the board's current state to each saved
  // snapshot rather than remembered in state: every filter control would otherwise have
  // to remember to clear a "currentViewId", and the one that forgot would leave a chip
  // highlighted for a view you were no longer looking at.
  const snapshot = useMemo(
    () => pmSnapshot({ q, facets, whenColId, whenCond, whenA, whenB, whenMonth, whenN, whenUnit, view }),
    [q, facets, whenColId, whenCond, whenA, whenB, whenMonth, whenN, whenUnit, view],
  );
  const activeView = useMemo(() => {
    const here = pmNormSnap(snapshot);
    const hit = savedViews.find((v) => pmNormSnap(v.snap) === here);
    return hit ? hit.id : null;
  }, [snapshot, savedViews]);

  // Anything worth naming: filters OR the way the board is arranged.
  const viewDirty = filtersOn || view.groupBy !== "groups" || view.sortKey !== "name"
    || view.sortDir !== "asc" || (view.hiddenCols || []).length > 0;

  // The toolbar's "Clear filters" does exactly what it says - filters only, leaving the
  // arrangement alone. The "All items" CHIP is a view like any other, so it restores the
  // board's default arrangement too, or it would sit unlit next to the view it just applied.
  const clearFilters = () => {
    setQ(""); setFacets({}); setWhenCond("any"); setWhenA(""); setWhenB(""); setWhenMonth(""); setWhenN("");
  };
  const resetToDefault = () => {
    clearFilters();
    setViewPart({ groupBy: "groups", sortKey: "name", sortDir: "asc", hiddenCols: [] });
  };
  const applyView = (v) => {
    const s = v.snap || {};
    setQ(s.q || "");
    setFacets({ ...(s.facets || {}) });
    if (s.when) {
      setWhenColId(s.when.colId || null); setWhenCond(s.when.cond || "any");
      setWhenA(s.when.a || ""); setWhenB(s.when.b || "");
      setWhenMonth(s.when.month || ""); setWhenN(s.when.n || ""); setWhenUnit(s.when.unit || "days");
    } else { setWhenCond("any"); setWhenA(""); setWhenB(""); setWhenMonth(""); setWhenN(""); }
    setViewPart({
      groupBy: s.groupBy || "groups",
      sortKey: s.sortKey || "name",
      sortDir: s.sortDir === "desc" ? "desc" : "asc",
      hiddenCols: Array.isArray(s.hiddenCols) ? s.hiddenCols : [],
    });
  };
  // Views are SHARED (pm_views, migration 146): saved for the whole operator team, so
  // the server owns them and the response is what lands in state.
  const saveCurrentView = () => {
    const name = (window.prompt("Name this view — everyone on the team will see it", "") || "").trim().slice(0, 60);
    if (!name || !activeBoard) return;
    pmCall({ action: "save_view", boardId: activeBoard.id, name, snap: snapshot })
      .then((d) => setSavedViews((cur) => [...cur.filter((v) => v.id !== d.view.id && v.name !== d.view.name), d.view]))
      .catch((e) => setErr(e.message));
  };
  const deleteView = (v) => {
    pmCall({ action: "delete_view", id: v.id })
      .then(() => setSavedViews((cur) => cur.filter((x) => x.id !== v.id)))
      .catch((e) => setErr(e.message));
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
        {/* Boards are real TABS (Carolyn 2026-08-27): the active one joins the panel
            below it rather than floating as a pill, so the board you are in reads as the
            page you are on. The strip's bottom border IS the top edge of the content. */}
        <div role="tablist" aria-label="Boards"
          style={{ display: "flex", gap: 2, alignItems: "flex-end", flexWrap: "wrap", borderBottom: "2px solid #E2E8F0", margin: "-4px -4px 14px" }}>
          {(boards || []).map((b) => {
            const on = activeBoard && b.id === activeBoard.id;
            return (
              <button key={b.id} type="button" role="tab" aria-selected={on ? "true" : "false"}
                onClick={() => onSub(b.slug)}
                style={{ background: on ? "#FFF" : "none", border: "none", borderBottom: `3px solid ${on ? ACCENT : "transparent"}`,
                  marginBottom: -2, padding: "9px 16px", fontSize: 13.5, fontWeight: on ? 800 : 600,
                  color: on ? ACCENT : "#64748B", cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>
                {b.name}
                <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 700, color: on ? ACCENT : "#94A3B8", opacity: 0.75 }}>
                  {counts[b.id] != null ? counts[b.id] : ""}
                </span>
              </button>
            );
          })}
          {canWrite && (
            newBoardOpen ? (
              <input autoFocus placeholder="Board name — Enter to create"
                style={{ ...S.input, maxWidth: 220, padding: "5px 9px", fontSize: 12.5, margin: "0 0 4px 8px" }}
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
              <button type="button" onClick={() => setNewBoardOpen(true)} title="New board"
                style={{ background: "none", border: "none", padding: "9px 12px", fontSize: 13, fontWeight: 700, color: "#94A3B8", cursor: "pointer", fontFamily: "inherit" }}>＋</button>
            )
          )}
          {canWrite && data && (
            <button type="button" onClick={() => setSettingsOpen(true)}
              style={{ marginLeft: "auto", background: "none", border: "none", padding: "9px 4px 9px 12px", fontSize: 12, fontWeight: 700, color: "#64748B", cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>⚙ Board settings</button>
          )}
        </div>
        {err && <div style={S.err}>{err}</div>}
        {!boards && !err && <div style={{ color: "#94A3B8", fontSize: 13 }}>Loading boards…</div>}
        {/* The board body has its own wait: the first open after new roadmap entries also
            runs the sync, and a silent blank panel reads as a broken screen. */}
        {boards && !data && !err && <div style={{ color: "#94A3B8", fontSize: 13 }}>Loading board…</div>}

        {data && (
          <>
            {/* Saved views sit ABOVE the filters they restore, so the row reads
                "which view am I in" then "how is it filtered". */}
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: "#94A3B8", textTransform: "uppercase", letterSpacing: 0.4, marginRight: 2 }}>Views</span>
              <button type="button" onClick={resetToDefault}
                style={{ ...PM_VIEW_CHIP, background: !viewDirty && !activeView ? ACCENT : "#FFF", color: !viewDirty && !activeView ? "#FFF" : "#334155", borderColor: !viewDirty && !activeView ? ACCENT : "#CBD5E1" }}>
                All items
              </button>
              {savedViews.map((v) => {
                const on = activeView === v.id;
                return (
                  <span key={v.id} style={{ ...PM_VIEW_CHIP, padding: 0, borderColor: on ? ACCENT : "#CBD5E1", background: on ? ACCENT : "#FFF", display: "inline-flex", alignItems: "center", overflow: "hidden" }}>
                    <button type="button" onClick={() => applyView(v)}
                      title={v.created_by_email ? `${v.name} — saved by ${String(v.created_by_email).split("@")[0]}` : v.name}
                      style={{ background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 12.5, fontWeight: 700, color: on ? "#FFF" : "#334155", padding: "5px 4px 5px 12px", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {v.name}
                    </button>
                    <button type="button" title={`Delete the "${v.name}" view`}
                      onClick={() => { if (window.confirm(`Delete the saved view "${v.name}" for everyone? (Only the view — no items are touched.)`)) deleteView(v); }}
                      style={{ background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 12, color: on ? "rgba(255,255,255,.75)" : "#94A3B8", padding: "5px 9px 5px 4px" }}>✕</button>
                  </span>
                );
              })}
              {/* Only offered when there is something to save, and never a duplicate of
                  the view you are already looking at. */}
              {viewDirty && !activeView && (
                <button type="button" onClick={saveCurrentView}
                  style={{ ...PM_VIEW_CHIP, borderStyle: "dashed", color: ACCENT, fontWeight: 700 }}>＋ Save this view</button>
              )}
            </div>

            {/* ONE neat row of same-height controls (Carolyn 2026-08-27). The shared
                FacetSelect stacks an uppercase label ABOVE its select, which put three
                controls at a different height and baseline from the rest of the row —
                so the filters are built here from PMCtl instead. (It also passed "all"
                as the all-value while the filter treats "" as all, so choosing All
                after a filter emptied the board.) */}
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
              <span style={{ ...PM_CTL, padding: "0 10px", gap: 6, minWidth: 190 }}>
                <span style={{ color: "#94A3B8" }}>⌕</span>
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search items…"
                  style={{ border: "none", outline: "none", background: "none", fontSize: 12.5, fontWeight: 600, color: "#1E293B", flex: 1, minWidth: 0, fontFamily: "inherit", height: "100%" }} />
                {q && <button type="button" onClick={() => setQ("")} title="Clear"
                  style={{ background: "none", border: "none", color: "#94A3B8", cursor: "pointer", fontSize: 13, padding: 0 }}>✕</button>}
              </span>

              {facetCols.map((c) => (
                <PMCtl key={c.id} label={c.name}>
                  <select value={facets[c.id] || ""} onChange={(e) => setFacets((f) => ({ ...f, [c.id]: e.target.value || null }))}
                    style={PM_CTL_SEL}>
                    <option value="">All</option>
                    {(pmType(c).groupsFor(c, ctx) || []).map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
                  </select>
                </PMCtl>
              ))}

              {dateCols.length > 0 && (
                <PMCtl label={dateCols.length > 1 ? null : dateCols[0].name}>
                  {dateCols.length > 1 && (
                    <select value={whenColId || ""} onChange={(e) => setWhenColId(e.target.value || null)} style={PM_CTL_SEL}>
                      {dateCols.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  )}
                  <select value={whenCond} onChange={(e) => setWhenCond(e.target.value)} style={PM_CTL_SEL}>
                    {SS_WHEN.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                  </select>
                  {SS_WHEN_PARAM[whenCond] === "date" && <input type="date" value={whenA} onChange={(e) => setWhenA(e.target.value)} style={PM_CTL_SEL} />}
                  {SS_WHEN_PARAM[whenCond] === "date2" && (<>
                    <input type="date" value={whenA} onChange={(e) => setWhenA(e.target.value)} style={PM_CTL_SEL} />
                    <span style={{ color: "#94A3B8" }}>–</span>
                    <input type="date" value={whenB} onChange={(e) => setWhenB(e.target.value)} style={PM_CTL_SEL} />
                  </>)}
                  {SS_WHEN_PARAM[whenCond] === "month" && <input type="month" value={whenMonth} onChange={(e) => setWhenMonth(e.target.value)} style={PM_CTL_SEL} />}
                  {SS_WHEN_PARAM[whenCond] === "count" && (<>
                    <input type="number" min="1" value={whenN} onChange={(e) => setWhenN(e.target.value)} style={{ ...PM_CTL_SEL, width: 52 }} />
                    <select value={whenUnit} onChange={(e) => setWhenUnit(e.target.value)} style={PM_CTL_SEL}>
                      <option value="days">days</option><option value="weeks">weeks</option><option value="months">months</option>
                    </select>
                  </>)}
                </PMCtl>
              )}

              <PMCtl label="Group by">
                <select value={view.groupBy} onChange={(e) => setViewPart({ groupBy: e.target.value })} style={PM_CTL_SEL}>
                  <option value="groups">Groups</option>
                  {groupables.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </PMCtl>

              <span style={{ position: "relative", display: "inline-flex" }}>
                <button type="button" onClick={() => setColsOpen((o) => !o)}
                  style={{ ...PM_CTL, padding: "0 12px", cursor: "pointer", fontWeight: 700, color: "#334155", fontFamily: "inherit" }}>
                  Columns ▾
                </button>
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

              <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12, color: "#64748B", fontWeight: 600, whiteSpace: "nowrap" }}>
                Showing {filtered.length} of {data.items.length}
                {filtersOn && (
                  <button type="button" style={{ background: "none", border: "none", color: "#DC2626", fontWeight: 700, fontSize: 12, cursor: "pointer", padding: 0, fontFamily: "inherit" }}
                    onClick={clearFilters}>
                    Clear filters
                  </button>
                )}
                <button type="button" title="Refresh" style={{ background: "none", border: "none", color: "#64748B", fontWeight: 700, fontSize: 14, cursor: "pointer", padding: 0, opacity: loading ? 0.4 : 1 }}
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
        /* Keyed on id ONLY — deliberately NOT the schedule's id+updated_at remount idiom.
           These fields are prop-driven (no seed-once state), and a remount on every cell
           commit would wipe a half-typed update draft (found live, 2026-08-27). */
        <PMItemPanel key={openItem.id}
          item={openItem} canWrite={canWrite}
          onClose={() => setOpenItemId(null)}
          onRename={onRename} onArchive={onArchive} />
      )}
      {settingsOpen && data && (
        <PMBoardSettings board={data.board} columns={data.columns} groups={data.groups}
          onClose={() => setSettingsOpen(false)} onChanged={reload}
          onArchivedBoard={() => loadBoards().then((bs) => { if (bs && bs.length) onSub(bs[0].slug); })} />
      )}
    </div>
  );
}
