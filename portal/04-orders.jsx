// ─── Feedback: bug reports + feature requests ───
// Submissions are filed into Monday (Bugs Queue / Feature Requests (Intake)) by the
// `portal-feedback` edge function, which ALSO records them in `feedback_submissions`
// so the submitter can see the thing they sent instead of it vanishing into Monday.
// Status and team replies come back via the `feedback-monday-webhook` function.
//
// This lives in the PORTAL only — never on the public designer. A submission is
// attributed to the signed-in user and their tenant, both resolved server-side from
// the JWT, which is what makes "who filed this, from which client portal" reliable.

// The client-facing status ladder (see migration 054). Monday's internal labels are
// mapped down to these by the sync function — never rendered raw.
const FB_STATUS = {
  submitted:   { label: "Submitted",       bg: "#F1F5F9", fg: "#475569" },
  in_review:   { label: "In review",       bg: "#FEF3C7", fg: "#B45309" },
  planned:     { label: "Planned",         bg: "#EEF2FF", fg: "#4F46E5" },
  in_progress: { label: "In progress",     bg: "#DBEAFE", fg: "#1D4ED8" },
  needs_info:  { label: "Needs your info", bg: "#FEE2E2", fg: "#B91C1C" },
  // The KEY is the stored value (migration 054's check constraint + both sync
  // functions) and must stay "shipped"; only this label is client-facing. Renamed to
  // "Completed" on 2026-07-27 to match what the team now calls it on the Monday board.
  shipped:     { label: "Completed",       bg: "#DCFCE7", fg: "#15803D" },
  declined:    { label: "Not planned",     bg: "#F1F5F9", fg: "#64748B" },
  duplicate:   { label: "Already tracked", bg: "#F3E8FF", fg: "#7E22CE" },
};
// Sort order for the Status column. Deliberately NOT alphabetical — sorting
// "Already tracked / In progress / In review / Not planned / Planned" by name is
// noise. Ascending walks the pipeline, with "Needs your info" pulled to the very top
// because it's the one state that's waiting on the CLIENT rather than on us.
const FB_STATUS_ORDER = ["needs_info", "submitted", "in_review", "planned", "in_progress", "shipped", "declined", "duplicate"];
const FB_STATUS_RANK = FB_STATUS_ORDER.reduce((m, k, i) => { m[k] = i; return m; }, {});

const fbBadge = (status) => {
  const m = FB_STATUS[status] || FB_STATUS.submitted;
  return <span style={{ background: m.bg, color: m.fg, fontSize: 10, fontWeight: 800, borderRadius: 999, padding: "3px 9px", textTransform: "uppercase", letterSpacing: 0.4, whiteSpace: "nowrap" }}>{m.label}</span>;
};

// Severity choices must match the Monday status labels exactly — portal-feedback
// drops any value the board doesn't know rather than erroring the whole push.
const FB_KINDS = {
  bug: {
    icon: "🐛", label: "Report an Issue", blurb: "Something broken or not working as expected",
    titleHint: "What went wrong?", detailHint: "What did you do, what did you expect, and what happened instead?",
    sevLabel: "How badly is this hurting you?",
    severities: ["Critical", "High", "Medium", "Low"], sevDefault: "Medium",
  },
  feature: {
    icon: "✨", label: "Request a Feature", blurb: "An idea or improvement you'd like to see",
    titleHint: "What would you like to be able to do?", detailHint: "Describe the feature and what it would let you get done.",
    sevLabel: "How important is this to you?",
    severities: ["Nice to have", "Would really help", "Critical for me"], sevDefault: "Would really help",
  },
};

const MAX_ATTACH_BYTES = 25 * 1024 * 1024;   // matches the bucket's file_size_limit

function FeedbackForm({ kind, clientId, onSubmitted, onBack }) {
  const cfg = FB_KINDS[kind];
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [severity, setSeverity] = useState(cfg.sevDefault);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (!title.trim()) { setErr("Please give this a short title."); return; }
    if (file && file.size > MAX_ATTACH_BYTES) { setErr("That file is larger than 25 MB — please attach a smaller one."); return; }
    setBusy(true); setErr(null);
    try {
      // Upload first: the storage policy pins the object under this tenant's own
      // prefix, and the edge function re-checks the prefix before trusting the path.
      let attachmentPath = null;
      if (file) {
        const safe = file.name.replace(/[^\w.\-]+/g, "_").slice(-80);
        const path = clientId + "/" + crypto.randomUUID() + "-" + safe;
        const up = await sb.storage.from("feedback-attachments").upload(path, file, { contentType: file.type || undefined });
        if (up.error) throw new Error("Attachment upload failed: " + up.error.message);
        attachmentPath = path;
      }
      const { data, error } = await sb.functions.invoke("portal-feedback", {
        body: { action: "submit", kind, title: title.trim(), detail: detail.trim(), severity, attachmentPath },
      });
      if (error) throw error;
      if (data && data.error) throw new Error(data.error);
      onSubmitted(data && data.submission, data && data.pushed);
    } catch (e2) {
      setErr(e2.message || "Something went wrong — please try again.");
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
      {err && <div style={S.err}>{err}</div>}
      <div>
        <label style={S.lbl}>{cfg.titleHint}</label>
        <input style={S.input} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={250} autoFocus placeholder="A one-line summary" />
      </div>
      <div>
        <label style={S.lbl}>Details</label>
        <textarea style={{ ...S.input, minHeight: 110, fontWeight: 500, resize: "vertical" }}
          value={detail} onChange={(e) => setDetail(e.target.value)} placeholder={cfg.detailHint} />
      </div>
      <div>
        <label style={S.lbl}>{cfg.sevLabel}</label>
        <select style={S.input} value={severity} onChange={(e) => setSeverity(e.target.value)}>
          {cfg.severities.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <div>
        <label style={S.lbl}>Screenshot or video (optional)</label>
        <input type="file" accept="image/png,image/jpeg,image/gif,image/webp,video/mp4,video/quicktime,video/webm"
          onChange={(e) => setFile(e.target.files && e.target.files[0] ? e.target.files[0] : null)}
          style={{ ...S.input, padding: "7px 10px", fontWeight: 500 }} />
        <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 4 }}>A picture of the problem helps us fix it much faster. Max 25 MB.</div>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
        <button type="button" onClick={onBack} disabled={busy} style={{ ...S.btn("#FFF", "#475569"), border: "1px solid #CBD5E1" }}>Back</button>
        <button type="submit" disabled={busy} style={{ ...S.btn(ACCENT, "#FFF"), flex: 1, opacity: busy ? 0.6 : 1, cursor: busy ? "default" : "pointer" }}>
          {busy ? "Sending…" : "Send it"}
        </button>
      </div>
    </form>
  );
}

// Floating launcher + modal. Mounted once by PortalApp; hidden while an operator is
// viewing someone else's account (the submission would be attributed to the operator's
// own tenant, not the one on screen, which would be misleading in both places).
function FeedbackWidget({ clientId, onSubmitted }) {
  const [view, setView] = useState(null);   // null | "menu" | "bug" | "feature" | "done"
  const [pushed, setPushed] = useState(true);

  useEffect(() => {
    if (!view) return;
    const onKey = (e) => { if (e.key === "Escape") setView(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view]);

  if (!view) {
    return (
      <button onClick={() => setView("menu")} aria-label="Send feedback"
        style={{
          position: "fixed", right: 20, bottom: 20, zIndex: 900,
          background: ACCENT, color: "#FFF", border: "none", borderRadius: 999,
          padding: "10px 16px", fontSize: 13.5, fontWeight: 700, cursor: "pointer",
          boxShadow: "0 4px 14px rgba(0,0,0,0.25)", fontFamily: "inherit",
        }}>
        💬 Feedback
      </button>
    );
  }

  const cfg = FB_KINDS[view] || null;
  const heading = view === "done" ? "✅ Thanks — we've got it"
    : cfg ? cfg.icon + " " + cfg.label : "💬 Send us feedback";

  return (
    <div onClick={() => setView(null)} role="dialog" aria-modal="true" aria-label="Send feedback"
      style={{ position: "fixed", inset: 0, zIndex: 999, background: "rgba(15,23,42,0.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ background: "#FFF", borderRadius: 12, overflow: "hidden", width: cfg ? "min(560px, 100%)" : "min(420px, 100%)", maxHeight: "calc(100vh - 32px)", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.35)" }}>
        <div style={{ background: ACCENT, color: "#FFF", padding: "12px 16px", display: "flex", alignItems: "center", gap: 8 }}>
          {cfg && <button onClick={() => setView("menu")} aria-label="Back" style={{ background: "none", border: "none", color: "#FFF", cursor: "pointer", fontSize: 16, padding: 0, lineHeight: 1 }}>←</button>}
          <div style={{ fontSize: 14, fontWeight: 700, flex: 1 }}>{heading}</div>
          <button onClick={() => setView(null)} aria-label="Close" style={{ background: "none", border: "none", color: "#FFF", cursor: "pointer", fontSize: 18, padding: 0, lineHeight: 1 }}>×</button>
        </div>

        {view === "menu" && (
          <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
            {["bug", "feature"].map((k) => (
              <button key={k} onClick={() => setView(k)}
                style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 10, cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}>
                <span style={{ fontSize: 22 }}>{FB_KINDS[k].icon}</span>
                <span>
                  <span style={{ display: "block", fontSize: 14, fontWeight: 700, color: "#0F172A" }}>{FB_KINDS[k].label}</span>
                  <span style={{ display: "block", fontSize: 12, color: "#64748B", marginTop: 2 }}>{FB_KINDS[k].blurb}</span>
                </span>
              </button>
            ))}
            <div style={{ fontSize: 12, color: "#94A3B8", lineHeight: 1.5, marginTop: 2 }}>
              Everything you send shows up under <b>What's New → My Submissions</b>, so you can track where it got to.
            </div>
          </div>
        )}

        {cfg && (
          <FeedbackForm kind={view} clientId={clientId} onBack={() => setView("menu")}
            onSubmitted={(row, wasPushed) => { setPushed(wasPushed !== false); setView("done"); if (onSubmitted) onSubmitted(row); }} />
        )}

        {view === "done" && (
          <div style={{ padding: 20, fontSize: 13.5, color: "#334155", lineHeight: 1.6 }}>
            Your submission is logged and on our board. You can follow it under{" "}
            <b>What's New → My Submissions</b> — the status updates there as we work on it,
            and any reply we post shows up alongside it.
            {!pushed && (
              <div style={{ ...S.err, marginTop: 12, marginBottom: 0 }}>
                Saved — but syncing it to our tracker didn't go through. It's recorded and we'll pick it up; nothing is lost.
              </div>
            )}
            <button onClick={() => setView(null)} style={{ ...S.btn(ACCENT, "#FFF"), marginTop: 16, width: "100%" }}>Done</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── My Submissions: this tenant's bugs + feature requests, with our replies ───
function MySubmissions({ refreshKey }) {
  const [rows, setRows] = useState(null);       // null = loading
  const [comments, setComments] = useState({}); // submission_id -> [comment]
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null);       // expanded submission id
  const [filter, setFilter] = useState("all");  // all | bug | feature
  const [syncing, setSyncing] = useState(false);
  const [tick, setTick] = useState(0);
  // Column sort, same convention as DesignsTable/LeadsTable (SortTh + sortRows).
  // Default = newest first, matching the created_at DESC load order.
  const [sortKey, setSortKey] = useState("date");
  const [sortDir, setSortDir] = useState("desc");
  const onSort = makeOnSort(sortKey, setSortKey, sortDir, setSortDir);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // RLS scopes both reads to this tenant — no client_id filter needed here, and
      // adding one would be a false comfort (the policy is the actual boundary).
      const { data, error: err } = await sb
        .from("feedback_submissions")
        .select("id, kind, title, detail, severity, status, submitter_name, attachment_path, monday_item_id, created_at, status_changed_at")
        .order("created_at", { ascending: false });
      if (cancelled) return;
      if (err) { setError(err.message); setRows([]); return; }
      setRows(data || []);
      const ids = (data || []).map((r) => r.id);
      if (!ids.length) { setComments({}); return; }
      const { data: cs } = await sb
        .from("feedback_comments")
        .select("id, submission_id, author_name, body, created_at")
        .in("submission_id", ids)
        .order("created_at", { ascending: true });
      if (cancelled) return;
      const map = {};
      for (const c of cs || []) (map[c.submission_id] = map[c.submission_id] || []).push(c);
      setComments(map);
    })();
    return () => { cancelled = true; };
  }, [refreshKey, tick]);

  // Belt-and-braces against a webhook that never arrived: pull current state from
  // Monday on demand, then re-read. The webhook is the normal path; this is the button
  // a client presses when they think we've gone quiet.
  const resync = async () => {
    setSyncing(true);
    try { await sb.functions.invoke("portal-feedback", { body: { action: "refresh" } }); } catch (_) {}
    setSyncing(false);
    setTick((t) => t + 1);
  };

  const openAttachment = async (path) => {
    const { data, error: err } = await sb.storage.from("feedback-attachments").createSignedUrl(path, 300);
    if (err || !data) { alert("Couldn't open that attachment."); return; }
    window.open(data.signedUrl, "_blank", "noopener");
  };

  const fmtDT = (iso) => {
    if (!iso) return "";
    try { return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }); }
    catch { return iso; }
  };

  if (error) return <div style={S.err}>Couldn't load your submissions: {error}</div>;
  if (rows === null) return <div style={{ ...S.card, color: "#64748B" }}>Loading your submissions…</div>;

  const shown = filter === "all" ? rows : rows.filter((r) => r.kind === filter);
  const sortVal = (r) => {
    switch (sortKey) {
      case "name":   return r.title || "";
      case "user":   return r.submitter_name || "";
      case "status": return FB_STATUS_RANK[r.status] ?? 99;
      // ISO timestamps sort chronologically as plain strings — see sortRows.
      case "date":
      default:       return r.created_at || "";
    }
  };
  const sorted = sortRows(shown, sortVal, sortDir);

  return (
    <div style={S.card}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <span style={{ ...S.h2, marginBottom: 0 }}>My Submissions</span>
        <span style={{ fontSize: 12, color: "#94A3B8" }}>({rows.length})</span>
        <div style={{ display: "flex", gap: 6, marginLeft: "auto", flexWrap: "wrap" }}>
          {[["all", "All"], ["bug", "🐛 Issues"], ["feature", "✨ Features"]].map(([k, lbl]) => (
            <button key={k} type="button" onClick={() => setFilter(k)}
              style={{ fontFamily: "inherit", fontSize: 12, fontWeight: 700, padding: "5px 11px", borderRadius: 999, cursor: "pointer",
                border: filter === k ? "1px solid " + ACCENT : "1px solid #E2E8F0",
                background: filter === k ? ACCENT : "#FFF", color: filter === k ? "#FFF" : "#475569" }}>{lbl}</button>
          ))}
          <button type="button" onClick={resync} disabled={syncing}
            style={{ fontFamily: "inherit", fontSize: 12, fontWeight: 700, padding: "5px 11px", borderRadius: 999, cursor: syncing ? "default" : "pointer", border: "1px solid #E2E8F0", background: "#FFF", color: "#475569", opacity: syncing ? 0.6 : 1 }}>
            {syncing ? "Checking…" : "↻ Check for updates"}
          </button>
        </div>
      </div>

      {rows.length === 0 ? (
        <div style={{ fontSize: 13, color: "#64748B", padding: "8px 0", lineHeight: 1.6 }}>
          You haven't sent us anything yet. Use the <b>💬 Feedback</b> button in the bottom-right corner
          to report an issue or request a feature — it'll show up here so you can follow what happens to it.
        </div>
      ) : shown.length === 0 ? (
        <div style={{ fontSize: 13, color: "#64748B", padding: "8px 0" }}>Nothing here under this filter.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              <SortTh label="Submission" col="name"   sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              <SortTh label="Submitted by" col="user" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              <SortTh label="Status" col="status"     sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              <SortTh label="Date" col="date"         sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            </tr></thead>
            <tbody>
              {sorted.map((r) => {
                const isOpen = open === r.id;
                const cs = comments[r.id] || [];
                const toggle = () => setOpen(isOpen ? null : r.id);
                return (
                  <React.Fragment key={r.id}>
                  <tr onClick={toggle} tabIndex={0} aria-expanded={isOpen}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } }}
                    style={{ cursor: "pointer", background: isOpen ? "#F8FAFC" : undefined }}>
                    <td style={{ ...S.td, fontWeight: 700 }}>
                      <span style={{ color: ACCENT, fontSize: 11, marginRight: 6 }}>{isOpen ? "▾" : "▸"}</span>
                      <span style={{ marginRight: 6 }}>{r.kind === "bug" ? "🐛" : "✨"}</span>
                      {r.title}
                      {/* Tooltip names the sender rather than saying "from us": the reader
                          IS the client, so "us" scans as their own team — especially next
                          to a Submitted by column that can read "CSM Synergy". */}
                      {cs.length > 0 && (
                        <span title={cs.length + " repl" + (cs.length === 1 ? "y" : "ies") + " from Structure Studio"}
                          style={{ marginLeft: 8, fontSize: 11, fontWeight: 800, color: ACCENT, background: "#EEF2FF", borderRadius: 999, padding: "2px 8px", whiteSpace: "nowrap" }}>
                          💬 {cs.length}
                        </span>
                      )}
                    </td>
                    <td style={{ ...S.td, whiteSpace: "nowrap", color: "#475569" }}>{r.submitter_name}</td>
                    <td style={S.td}>{fbBadge(r.status)}</td>
                    <td style={{ ...S.td, whiteSpace: "nowrap", color: "#64748B" }}>{fmtDT(r.created_at)}</td>
                  </tr>

                  {isOpen && (
                    <tr style={{ background: "#F8FAFC" }}>
                      <td colSpan={4} style={{ ...S.td, paddingTop: 0 }}>
                        {r.detail && <div style={{ fontSize: 13, color: "#475569", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{r.detail}</div>}
                        <div style={{ fontSize: 11.5, color: "#94A3B8", marginTop: 8, display: "flex", gap: 12, flexWrap: "wrap" }}>
                          {r.severity && <span>{r.kind === "bug" ? "Severity" : "Importance"}: <b style={{ color: "#64748B" }}>{r.severity}</b></span>}
                          {r.status_changed_at && <span>Last update: <b style={{ color: "#64748B" }}>{fmtDT(r.status_changed_at)}</b></span>}
                          {r.attachment_path && (
                            <button type="button" onClick={(e) => { e.stopPropagation(); openAttachment(r.attachment_path); }}
                              style={{ background: "none", border: "none", padding: 0, color: ACCENT, fontWeight: 700, fontSize: 11.5, cursor: "pointer", fontFamily: "inherit", textDecoration: "underline" }}>
                              View attachment
                            </button>
                          )}
                        </div>
                        {cs.length > 0 && (
                          <div style={{ marginTop: 12, borderLeft: "3px solid #E2E8F0", paddingLeft: 12, display: "flex", flexDirection: "column", gap: 10 }}>
                            {cs.map((c) => (
                              <div key={c.id}>
                                <div style={{ fontSize: 11, fontWeight: 800, color: "#64748B" }}>
                                  {c.author_name || "Structure Studio"} <span style={{ fontWeight: 600, color: "#94A3B8" }}>· {fmtDT(c.created_at)}</span>
                                </div>
                                <div style={{ fontSize: 13, color: "#334155", lineHeight: 1.6, whiteSpace: "pre-wrap", marginTop: 2 }}>{c.body}</div>
                              </div>
                            ))}
                          </div>
                        )}
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

// ─── What's New: global product changelog (read-only; team-populated) ───
function ReleasesView({ submissionsKey }) {
  const [rows, setRows] = useState(null); // null = loading
  const [error, setError] = useState(null);
  const [subtab, setSubtab] = useState("features"); // features | fixes | roadmap | mine
  const [mineCount, setMineCount] = useState(0);

  useEffect(() => {
    (async () => {
      const { data, error: err } = await sb
        .from("release_notes")
        .select("id, released_at, version, kind, title, detail, status, sort_order, section")
        .order("released_at", { ascending: false })
        .order("sort_order", { ascending: false });
      if (err) { setError(err.message); setRows([]); return; }
      setRows(data || []);
    })();
  }, []);

  // Count only — the list itself is fetched by MySubmissions when that tab opens.
  // RLS scopes this to the signed-in user's tenant.
  useEffect(() => {
    (async () => {
      const { count } = await sb.from("feedback_submissions").select("id", { count: "exact", head: true });
      setMineCount(count || 0);
    })();
  }, [submissionsKey]);

  const fmtDT = (iso) => {
    if (!iso) return "";
    try { return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }); }
    catch { return iso; }
  };

  // Deliberately NO early return on loading/error: that would also hide the My
  // Submissions tab, which has its own data path and must stay reachable even when
  // the release_notes read fails. Both states are rendered inside the tab body below.
  const list = rows || [];
  const features = list.filter((r) => r.kind === "feature");
  const fixes = list.filter((r) => r.kind === "fix");
  const requested = list.filter((r) => r.kind === "requested");

  // 'shipped' deliberately has NO badge — a live feature is just a feature, and badging the
  // normal case would make every entry shout. Everything else says how real it is yet.
  const statusBadge = (status) => {
    const map = {
      // On beta, not yet promoted to main (migration 103). Published the moment the work
      // lands so tenants can watch it coming and try it, and flipped to 'shipped' by the
      // Monday merge workflow — so an entry never claims to be live before it is.
      beta:      { bg: "#FFF7ED", fg: "#C2410C", label: "On beta for testing" },
      roadmap:   { bg: "#EEF2FF", fg: "#4F46E5", label: "On the roadmap" },
      planned:   { bg: "#EEF2FF", fg: "#4F46E5", label: "Planned" },
      requested: { bg: "#FEF3C7", fg: "#B45309", label: "Requested" },
    };
    const m = map[status]; if (!m) return null;
    return <span style={{ background: m.bg, color: m.fg, fontSize: 10, fontWeight: 800, borderRadius: 999, padding: "2px 8px", textTransform: "uppercase", letterSpacing: 0.4, whiteSpace: "nowrap" }}>{m.label}</span>;
  };

  // Which part of the product an entry is about (migration 114). Rendered FIRST on the line so
  // the eye can run down the left edge and skip whole areas — the list is 88 entries and
  // growing, and a label at the end of the title would have to be read to be used.
  //
  // Brand colours, not neutral grey (Carolyn 2026-08-23): light blue ground, ACCENT purple text.
  // #DBEAFF is the light blue already used elsewhere in the portal, and ACCENT is the brand
  // purple from 01-core — the constant rather than a copy of its hex, so a rebrand moves this
  // with everything else. It reads as OURS rather than as a second status badge, which was the
  // worry about colouring it at all; the status badges stay distinguishable because they are
  // orange (beta), indigo (roadmap/planned) and amber (requested), none of which is this blue.
  // An entry with no section renders NOTHING here — '' is the column's default, so an
  // unlabelled entry looks exactly as it did before.
  const sectionChip = (section) => {
    const s = String(section || "").trim();
    if (!s) return null;
    return (
      <span style={{
        background: "#DBEAFF", color: ACCENT, fontSize: 10, fontWeight: 800,
        borderRadius: 5, padding: "2px 7px", letterSpacing: 0.3, whiteSpace: "nowrap",
        textTransform: "uppercase", flexShrink: 0,
      }}>{s}</span>
    );
  };

  const entry = (r) => (
    <div key={r.id} style={{ padding: "12px 0", borderBottom: "1px solid #F1F5F9" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        {sectionChip(r.section)}
        <span style={{ fontSize: 14, fontWeight: 700, color: "#1E293B" }}>{r.title}</span>
        {statusBadge(r.status)}
        <span style={{ marginLeft: "auto", fontSize: 11, color: "#94A3B8", whiteSpace: "nowrap" }}>{fmtDT(r.released_at)}</span>
      </div>
      {r.detail && <div style={{ fontSize: 13, color: "#475569", marginTop: 4, lineHeight: 1.5 }}>{r.detail}</div>}
    </div>
  );

  // Section definitions — one per sub-tab. `empty` shows when that tab has no rows.
  // "mine" is the odd one out: it renders <MySubmissions /> rather than release_notes
  // entries, so it carries its own count instead of a `list`.
  const TABS = [
    { id: "features", label: "New Features", dot: "#10B981", list: features, empty: "No new features yet — check back soon." },
    { id: "fixes",    label: "Bug Fixes",    dot: "#F59E0B", list: fixes,    empty: "No bug fixes to report right now." },
    { id: "roadmap",  label: "Roadmap",      dot: "#6366F1", list: requested, empty: "Nothing on the roadmap yet — check back soon." },
    { id: "mine",     label: "My Submissions", dot: "#7E22CE", count: mineCount },
  ];
  const active = TABS.find((t) => t.id === subtab) || TABS[0];
  const tabCount = (t) => (t.count != null ? t.count : t.list.length);

  return (
    <div>
      <div style={{ ...S.card, background: "linear-gradient(135deg,#3D3672 0%,#1B7895 100%)", color: "#FFF", border: "none", marginBottom: 12 }}>
        <div style={{ fontSize: 18, fontWeight: 800 }}>What's New</div>
        <div style={{ fontSize: 13, opacity: 0.9, marginTop: 4 }}>Updates as they ship to your portal — try them out and send us feedback.</div>
      </div>

      {/* Sub-tab nav: New Features · Bug Fixes · Roadmap */}
      <div role="tablist" style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
        {TABS.map((t) => {
          const on = t.id === subtab;
          return (
            <button key={t.id} type="button" role="tab" aria-selected={on} onClick={() => setSubtab(t.id)}
              style={{
                display: "flex", alignItems: "center", gap: 7, cursor: "pointer", fontFamily: "inherit",
                fontSize: 13, fontWeight: 700, padding: "8px 14px", borderRadius: 999,
                border: on ? "1px solid " + ACCENT : "1px solid #E2E8F0",
                background: on ? ACCENT : "#FFF", color: on ? "#FFF" : "#475569",
              }}>
              <span style={{ width: 9, height: 9, borderRadius: 3, background: t.dot, flexShrink: 0 }} />
              {t.label}
              <span style={{ fontSize: 11, fontWeight: 800, color: on ? "#FFF" : "#94A3B8", opacity: on ? 0.85 : 1 }}>{tabCount(t)}</span>
            </button>
          );
        })}
      </div>

      {subtab === "mine" ? <MySubmissions refreshKey={submissionsKey} />
        : error ? <div style={S.err}>Couldn't load updates: {error}</div>
        : rows === null ? <div style={{ ...S.card, color: "#64748B" }}>Loading updates…</div>
        : rows.length === 0
        ? <div style={{ ...S.card, color: "#64748B" }}>No updates yet — check back soon.</div>
        : (
          <div style={S.card}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <span style={{ width: 10, height: 10, borderRadius: 3, background: active.dot, flexShrink: 0 }} />
              <span style={{ ...S.h2, marginBottom: 0 }}>{active.label}</span>
              <span style={{ fontSize: 12, color: "#94A3B8" }}>({active.list.length})</span>
            </div>
            {active.list.length === 0
              ? <div style={{ fontSize: 13, color: "#64748B", padding: "8px 0" }}>{active.empty}</div>
              : active.list.map(entry)}
          </div>
        )}
    </div>
  );
}

// ─── QuickBooks Sync: the not-switched-on card ───
// One component for BOTH mounts of QuickBooks (the top-level tab and Settings → QuickBooks),
// so the two can never drift into saying different things. Same shape as the scheduling
// teasers: the tab stays visible, this explains what they'd get, and an owner/admin gets a
// button straight to Billing. A non-admin gets no button — they cannot buy it.
function QuickBooksLocked({ canAdmin, onSeeBilling }) {
  return (
    <ComingSoon
      title="QuickBooks Sync"
      icon={<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="#FFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.5 8.5A2.5 2.5 0 0 0 9.5 15H12M14.5 15.5a2.5 2.5 0 0 0 0-6H12"/></svg>}
      blurb="Send your accepted quotes to QuickBooks Online as invoices, without typing them twice. Map each building style and add-on to the right QuickBooks item once, and every invoice lands in your books the way your accountant expects."
      bullets={[
        "Push an invoice to QuickBooks straight from a design",
        "Map styles, sizes and add-ons to your own QuickBooks items",
        "Keep your books matching your quotes, with no re-keying",
      ]}
      cta={canAdmin ? { label: "Turn on QuickBooks Sync — see Billing", onClick: onSeeBilling } : null}
      available
    />
  );
}

// ─── Coming-soon teaser panel ───
// Placeholder for features that aren't built yet, shown to every logged-in user so
// they can see what's on the way. Pure presentation — no data, no side effects.
// `cta` (optional, { label, onClick }) turns the teaser into an AVAILABLE-NOW card: the
// badge flips from "Coming soon" to "Available now" and the footer becomes the button —
// used by billable features that have launched but this tenant hasn't switched on yet.
// `available` says the feature HAS SHIPPED and is simply not switched on for this tenant.
// It has to be separate from `cta`, because only an owner/admin gets a cta — so deriving
// "is it live?" from the button meant a sales rep was told a shipped feature was "Coming
// soon" and that we were still building it. They would repeat that to a customer.
function ComingSoon({ icon, title, blurb, bullets, cta, available = false }) {
  return (
    <div style={{ ...S.card, padding: 0, overflow: "hidden", maxWidth: 720 }}>
      <div style={{ background: "linear-gradient(135deg, #3D3672 0%, #1B7895 100%)", padding: "34px 28px", color: "#FFF", display: "flex", alignItems: "center", gap: 20 }}>
        <div style={{ width: 62, height: 62, borderRadius: 15, background: "rgba(255,255,255,0.15)", border: "1px solid rgba(255,255,255,0.28)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          {icon}
        </div>
        <div style={{ minWidth: 0 }}>
          <span style={{ display: "inline-block", background: "#75E6DA", color: "#22345B", fontSize: 10.5, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", borderRadius: 999, padding: "3px 10px", marginBottom: 9 }}>{(cta || available) ? "Available now" : "Coming soon"}</span>
          <div style={{ fontSize: 22, fontWeight: 800, lineHeight: 1.15 }}>{title}</div>
        </div>
      </div>
      <div style={{ padding: "24px 28px" }}>
        <p style={{ fontSize: 14.5, color: "#334155", lineHeight: 1.6, margin: "0 0 16px" }}>{blurb}</p>
        {bullets && bullets.length > 0 && (
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 10 }}>
            {bullets.map((b, i) => (
              <li key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10, fontSize: 13.5, color: "#475569" }}>
                <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="#1B7895" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}><path d="M20 6 9 17l-5-5"/></svg>
                <span>{b}</span>
              </li>
            ))}
          </ul>
        )}
        {cta ? (
          <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid #F1F5F9" }}>
            <button type="button" onClick={cta.onClick} style={S.btn(ACCENT, "#FFF")}>{cta.label}</button>
          </div>
        ) : (
          <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid #F1F5F9", fontSize: 12.5, color: "#94A3B8", fontWeight: 600 }}>
            {available
              ? "This is ready to go — ask an owner or admin on your account to switch it on."
              : "We're actively building this — it'll appear right here when it's ready, with nothing for you to set up."}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Orders (preview) ───
// Coming-soon preview of the paused Orders & payments feature (the full, wired build lives
// on the wip/orders branch). Renders the finished LIST view with EXAMPLE data behind a
// pointer-events/user-select lock, under a clear "coming soon / work in progress" banner —
// so tenants can see what's coming but cannot interact with it. Intentionally self-contained
// and inert: no data reads, no sb calls, no live wiring. When the real feature ships, this
// whole component is replaced by the live OrdersView.
function OrdersPreview() {
  const pill = (bg, fg, label) => (
    <span style={{ background: bg, color: fg, borderRadius: 20, padding: "4px 11px", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" }}>{label}</span>
  );
  const tile = (label, value, note, accent) => (
    <div style={{ background: "#FFF", border: "1px solid #E2E8F0", borderRadius: 12, padding: "13px 15px", borderLeft: `3px solid ${accent}` }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, color: "#64748B", textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 23, fontWeight: 800, marginTop: 5, letterSpacing: -0.5, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 3 }}>{note}</div>
    </div>
  );
  const th = { textAlign: "left", fontSize: 11, fontWeight: 700, color: "#64748B", textTransform: "uppercase", letterSpacing: 0.5, padding: "8px 10px", borderBottom: "1px solid #E2E8F0", whiteSpace: "nowrap" };
  const td = { fontSize: 13, padding: "12px 10px", borderBottom: "1px solid #F1F5F9" };
  const numTd = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };
  const chip = (label, on) => (
    <span style={{ fontSize: 12, fontWeight: 700, borderRadius: 20, padding: "6px 13px", border: `1px solid ${on ? "#3D3672" : "#E2E8F0"}`, background: on ? "#3D3672" : "#F1F5F9", color: on ? "#FFF" : "#475569" }}>{label}</span>
  );
  const muted = <span style={{ color: "#94A3B8" }}>—</span>;
  const SAMPLE = [
    { no: "1024", name: "Dale Hostetler", phone: "(330) 555-0148", bldg: "Lofted Barn 12×24", date: "Jul 20, 2026", total: "$9,575.00", paid: "$2,000.00", bal: "$7,575.00", balColor: "#1E293B", st: pill("#DBEAFE", "#1E40AF", "Partially paid") },
    { no: "1023", name: "Marcus Webb", phone: "(614) 555-0192", bldg: "Garage 24×32", date: "Jul 18, 2026", total: "$18,400.00", paid: muted, bal: "$18,400.00", balColor: "#1E293B", st: pill("#FFE4E6", "#9F1239", "Awaiting payment") },
    { no: "1022", name: "Owen Brant", phone: "(937) 555-0164", bldg: "Cabin 14×40", date: "Jul 15, 2026", total: <span style={{ color: "#3D3672", fontWeight: 700 }}>Set total</span>, paid: muted, bal: "—", balColor: "#94A3B8", st: pill("#FEF3C7", "#92400E", "Needs invoice") },
    { no: "1021", name: "Rita Colson", phone: "(419) 555-0173", bldg: "Utility Shed 10×16", date: "Jul 12, 2026", total: "$4,300.00", paid: "$4,300.00", bal: "$0.00", balColor: "#94A3B8", st: pill("#DCFCE7", "#166534", "Paid in full") },
    { no: "1020", name: "Gary Aldenmeyer", phone: "(740) 555-0100", bldg: "Lean-To 8×12", date: "Jul 8, 2026", total: "$2,100.00", paid: "$2,600.00", bal: "$500.00 credit", balColor: "#9A3412", st: pill("#FFEDD5", "#9A3412", "Overpaid") },
  ];

  return (
    <div style={{ maxWidth: 1040 }}>
      {/* Coming-soon / work-in-progress banner — the one thing that IS meant to read clearly. */}
      <div style={{ background: "linear-gradient(135deg, #3D3672 0%, #1B7895 100%)", borderRadius: 12, padding: "20px 24px", color: "#FFF", marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 9, flexWrap: "wrap" }}>
          <span style={{ background: "#75E6DA", color: "#22345B", fontSize: 10.5, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", borderRadius: 999, padding: "3px 10px" }}>Coming soon</span>
          <span style={{ background: "rgba(255,255,255,0.15)", border: "1px solid rgba(255,255,255,0.32)", color: "#FFF", fontSize: 10.5, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", borderRadius: 999, padding: "3px 10px" }}>Work in progress</span>
        </div>
        <div style={{ fontSize: 22, fontWeight: 800, lineHeight: 1.15 }}>Orders &amp; payments</div>
        <p style={{ fontSize: 13.5, color: "#D6E4F0", lineHeight: 1.55, margin: "9px 0 0", maxWidth: 660 }}>
          A preview of what's coming: every accepted quote becomes a tracked order — from the sale, through the build, to delivery — with payments and balances in one place. The screen below shows <b style={{ color: "#FFF" }}>example data</b> and isn't switched on yet, so it can't be clicked or edited while we finish building it.
        </p>
      </div>

      {/* Everything below is a locked, non-interactive preview. pointerEvents:none disables
          every click/hover/field; userSelect:none stops text selection; aria-hidden keeps the
          sample figures out of the accessibility tree (the banner above is the real message). */}
      <div aria-hidden="true" style={{ pointerEvents: "none", userSelect: "none", cursor: "default", opacity: 0.96 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(168px, 1fr))", gap: 11, marginBottom: 16 }}>
          {tile("Open balance", "$25,975.00", "across 2 open orders", "#F59E0B")}
          {tile("Collected", "$12,300.00", "6 payments recorded", "#16A34A")}
          {tile("Needs invoice", "1", "accepted, not billed yet", "#92400E")}
          {tile("Awaiting payment", "1", "invoiced, nothing collected", "#9F1239")}
        </div>

        <div style={{ ...S.card }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap", marginBottom: 12 }}>
            <div style={{ ...S.h2, marginBottom: 0, marginRight: 4 }}>Orders (5)</div>
            {chip("All", true)}{chip("Needs invoice")}{chip("Awaiting payment")}{chip("Partially paid")}{chip("Paid in full")}
            <div style={{ marginLeft: "auto", minWidth: 220, flex: "0 1 280px", border: "1px solid #E2E8F0", borderRadius: 8, padding: "8px 12px", fontSize: 13, color: "#94A3B8", background: "#FFF" }}>Search orders — name, building, order #…</div>
            <span style={{ border: "1px solid #E2E8F0", background: "#F1F5F9", color: "#334155", fontWeight: 700, fontSize: 12.5, borderRadius: 8, padding: "8px 12px" }}>↻ Refresh</span>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>
                <th style={th}>Order</th><th style={th}>Customer</th><th style={th}>Building</th><th style={th}>Ordered</th>
                <th style={{ ...th, textAlign: "right" }}>Total</th><th style={{ ...th, textAlign: "right" }}>Paid</th>
                <th style={{ ...th, textAlign: "right" }}>Balance</th><th style={th}>Status</th><th style={th}></th>
              </tr></thead>
              <tbody>
                {SAMPLE.map((r) => (
                  <tr key={r.no}>
                    <td style={{ ...td, fontWeight: 700, whiteSpace: "nowrap" }}>#{r.no}</td>
                    <td style={{ ...td, fontWeight: 700 }}>{r.name}<div style={{ fontSize: 11, color: "#94A3B8", fontWeight: 500 }}>{r.phone}</div></td>
                    <td style={td}>{r.bldg}</td>
                    <td style={{ ...td, whiteSpace: "nowrap" }}>{r.date}</td>
                    <td style={numTd}>{r.total}</td>
                    <td style={numTd}>{r.paid}</td>
                    <td style={{ ...numTd, fontWeight: 800, color: r.balColor }}>{r.bal}</td>
                    <td style={td}>{r.st}</td>
                    <td style={{ ...td, whiteSpace: "nowrap" }}><span style={{ color: "#3D3672", fontWeight: 700, fontSize: 12 }}>Open →</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Orders & payments ───
// An order appears automatically once a design's status reaches accepted (the
// designs_ensure_order trigger, migration 053). This view is the money view:
// what each job is worth, what's been collected, and what's still owed.
//
// Phase 1 is RECORD-ONLY — cash / check / card-taken-elsewhere. Nothing is charged
// here, so no payment gateway is involved; balances are still real. Card charging
// drops in later on the same payments table (its gateway_* columns are already there).
//
// Totals come from the GHL estimate via sync-design-status (GHL applies tax, so our
// pre-tax subtotal is not a safe substitute). When GHL hasn't given us one, the total
// reads "Set total" and the owner types it — we never show a guessed number.
const money = (cents) => cents == null ? "—" : "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Dollars → cents. Returns NaN for anything without a digit: Number("") is 0, so a
// blank or junk field would otherwise read as a legitimate $0.00 and get saved.
const centsFrom = (txt) => {
  const s = String(txt == null ? "" : txt);
  if (!/\d/.test(s)) return NaN;
  const n = Number(s.replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
};
// Today in the LOCAL calendar (en-CA renders YYYY-MM-DD). Not toISOString(), which is
// UTC — that files an evening payment under tomorrow's date for every US timezone.
const todayLocal = () => new Date().toLocaleDateString("en-CA");
const PAY_METHODS = [["cash", "Cash"], ["check", "Check"], ["card", "Card"], ["ach", "Bank / ACH"], ["other", "Other"]];

// ORDERS IS ALL SALES (Carolyn 2026-08-08): "even an inventory building will need delivery
// so it is an ORDER." So this is the ONE page a sold building leaves for the shop or the
// truck — Designs and Inventory report, Orders dispatches. Two routes out, decided by what
// was actually sold:
//   * a custom build (its own design)      -> Build Schedule, then delivery via the pool
//   * a lot building (an inventory sale)   -> straight to Delivery; it is already built
// Both are gated on the design being INVOICED, which is what "sold" means here.
function OrdersView({ clientId, schedOn = false, deliverOn = false, onScheduleDelivery = null, onOpenDesign = null }) {
  const [rows, setRows] = useState(null);   // null = loading; [{order, design, paid}]
  const [error, setError] = useState(null);
  const [schedLinks, setSchedLinks] = useState(null);   // { byDesign, saleDesigns, … }
  const [schedBusy, setSchedBusy] = useState(null);
  const [schedMsg, setSchedMsg] = useState(null);       // { ok } | { err }
  const [openId, setOpenId] = useState(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  // Facet filters: ordered date-range + amount min/max (dollars, against the order total).
  const [fFrom, setFFrom] = useState("");
  const [fTo, setFTo] = useState("");
  const [fMin, setFMin] = useState("");
  const [fMax, setFMax] = useState("");
  const hasFacets = !!fFrom || !!fTo || fMin !== "" || fMax !== "";
  const clearFacets = () => { setFFrom(""); setFTo(""); setFMin(""); setFMax(""); };

  const load = useCallback(async () => {
    setError(null);
    const { data: ords, error: oErr } = await sb
      .from("orders").select("*").eq("client_id", clientId).order("ordered_at", { ascending: false }).limit(2000);
    if (oErr) { setError(oErr.message); setRows([]); return; }
    const list = ords || [];
    const codes = list.map((o) => o.short_code).filter(Boolean);
    // designs + payments are separate reads: orders.short_code is a soft link (a
    // future manual order has none), so there's no FK for PostgREST to embed.
    // ALL payments, voided included — voided rows stay visible in the history (the
    // void dialog promises exactly that); they're excluded from the math below, not
    // from the fetch. Paged to the end: a flat .limit() never fails loudly, it just
    // drops the OLDEST rows (received_at DESC), which understates "paid" and shows
    // an open balance on orders a large tenant has actually settled.
    const fetchAllPayments = async () => {
      const page = 1000; const seen = new Set(); const out = [];
      for (let from = 0; ; from += page) {
        const { data, error: pErr } = await sb.from("payments").select("*").eq("client_id", clientId)
          .order("received_at", { ascending: false }).range(from, from + page - 1);
        if (pErr) return { error: pErr };
        // Dedupe by id: a payment landing mid-pagination (the mount-time GHL sync)
        // shifts the pages and could repeat a row — double-counting real money.
        (data || []).forEach((p) => { if (!seen.has(p.id)) { seen.add(p.id); out.push(p); } });
        if (!data || data.length < page) return { data: out };
      }
    };
    const [{ data: dsn }, paysRes, coRes] = await Promise.all([
      codes.length
        ? sb.from("designs").select("short_code, contact, selections, status, image_url, ghl_estimate_number, ss_quote_number, ss_quote_pdf_url").in("short_code", codes).limit(2000)
        : Promise.resolve({ data: [] }),
      fetchAllPayments(),
      // Pending change orders (migration 126): the row wears an amber chip, and the server
      // 409s an invoice while one is open — the chip is the courtesy half of that rule.
      codes.length
        ? sb.from("change_orders").select("short_code").eq("client_id", clientId).eq("status", "pending_ack").in("short_code", codes)
        : Promise.resolve({ data: [] }),
    ]);
    // A failed payments read must not render every order as unpaid — that's the same
    // silent understatement the paging above exists to prevent.
    if (paysRes.error) { setError(paysRes.error.message); setRows([]); return; }
    const pays = paysRes.data;
    const byCode = {}; (dsn || []).forEach((d) => { byCode[d.short_code] = d; });
    const payByOrder = {}; (pays || []).forEach((p) => { (payByOrder[p.order_id] = payByOrder[p.order_id] || []).push(p); });
    const pendingCo = new Set(((coRes && coRes.data) || []).map((c) => c.short_code));
    setRows(list
      // SS ORDERS ONLY (Carolyn 2026-08-24: "the Orders tab should NOT show any orders
      // from GHL — only the SS invoices/orders"). The designs_ensure_order trigger mints
      // a row for EVERY accepted/invoiced design, GHL-quoted ones included — those rows
      // stay in the table (other code may care), but this tab is the ledger of paperwork
      // StructureStudio issued: the design carries an ss_quote_number, or the order has no
      // design at all (a future manual/walk-in order is SS-native by definition).
      .filter((o) => !o.short_code || (byCode[o.short_code] && byCode[o.short_code].ss_quote_number))
      .map((o) => {
        const ps = payByOrder[o.id] || [];
        return {
          o, d: byCode[o.short_code] || null, pays: ps,
          paid: ps.reduce((s, p) => s + (p.voided_at ? 0 : (p.amount_cents || 0)), 0),
          coPending: pendingCo.has(o.short_code),
        };
      }));
  }, [clientId]);

  // Refresh = re-read the tables. This used to also pull totals/statuses from GHL
  // (sync-design-status over every order's code), but Orders is SS paperwork only now
  // (Carolyn 2026-08-24): the GHL-quoted orders it refreshed are no longer shown, and SS
  // designs are fenced out of that sync by design — so the GHL leg refreshed nothing this
  // tab renders and cost a GHL API read per mount. Statuses on SS orders are written
  // locally (customer-accept / send_invoice) and arrive with the plain read.
  const [syncing, setSyncing] = useState(false);
  const syncFromGhl = useCallback(async () => {
    setSyncing(true);
    await load();
    setSyncing(false);
  }, [load]);

  useEffect(() => { load(); }, [load]);

  // Which buildings are already on the board or on a load, and which orders are lot sales.
  // Only fetched when this person can actually act on it — a read of the schedule is still
  // a read of the schedule.
  const loadSchedLinks = useCallback(async () => {
    if (!schedOn && !deliverOn) return;
    const { data } = await sb.functions.invoke("portal-schedule", { body: { action: "schedule_links" } });
    if (data && !data.error) setSchedLinks(data);
  }, [schedOn, deliverOn, clientId]);
  useEffect(() => { loadSchedLinks(); }, [loadSchedLinks]);

  const addToBuildSchedule = async (r) => {
    setSchedBusy(r.o.id); setSchedMsg(null);
    const { data, error: fnErr } = await sb.functions.invoke("portal-schedule", {
      body: { action: "create_job", source: "order", designShortCode: r.o.short_code },
    });
    setSchedBusy(null);
    // Say so when it fails. This one legitimately refuses — an uninvoiced design, an
    // inventory sale that belongs on a load, or a building already on the board.
    if (!data || data.error) {
      setSchedMsg({ err: (data && data.error) || (fnErr ? await fnError(fnErr) : "Could not add that to the build schedule.") });
      return;
    }
    setSchedMsg({ ok: `${nameOf(r)}'s building is on the Build Schedule.` });
    loadSchedLinks();
  };

  const nameOf = (r) => ((r.d && r.d.contact && r.d.contact.name) || "—");
  const bldgOf = (r) => {
    const sel = (r.d && r.d.selections) || {};
    return [titleCase(sel.style), sel.size].filter(Boolean).join(" ") || "—";
  };

  // The Schedule column. Three questions in order: is it sold yet, is it a lot building or
  // a build, and has it already gone where it's going?
  const schedChipStyle = (bg, fg) => ({ display: "inline-flex", alignItems: "center", gap: 5, background: bg, color: fg, borderRadius: 20, padding: "4px 10px", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" });
  const schedLinkBtn = (label, title, onClick, busy) => (
    <button type="button" onClick={onClick} disabled={busy} title={title}
      style={{ ...S.btn("#FFF", "#475569"), border: "1px solid #CBD5E1", padding: "5px 10px", fontSize: 12 }}>
      {busy ? "Working…" : label}
    </button>
  );
  const schedCell = (r) => {
    const links = schedLinks || {};
    const sale = (links.saleDesigns || {})[r.o.short_code];   // set = this order sold a LOT building
    const job = (links.byDesign || {})[r.o.short_code];       // set = already on the build board
    // SOLD = INVOICED. Before that there is nothing to schedule, and the server refuses too.
    const sold = r.d && (normStatus(r.d.status) === "invoiced" || normStatus(r.d.status) === "delivered");
    if (!sold) return <span style={{ fontSize: 11.5, color: "#94A3B8", fontWeight: 600 }}>Invoice first</span>;

    if (sale) {
      // Already built and sitting on a lot — it never touches the build board, it just
      // needs a truck. Serial shown because that is how the yard refers to it.
      if (sale.onLoad) return <span style={schedChipStyle("#EEF2FF", "#3D3672")}>On a load</span>;
      if (!deliverOn) return <span style={{ fontSize: 11.5, color: "#94A3B8", fontWeight: 600 }}>#{sale.serial} · needs a load</span>;
      return schedLinkBtn("Schedule delivery →", `Building #${sale.serial} is on the lot — take it to the Delivery Schedule`,
        () => onScheduleDelivery && onScheduleDelivery(sale), false);
    }
    if (job) {
      return (
        <span style={schedChipStyle("#F1F5F9", "#334155")}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: job.color || "#94A3B8", display: "inline-block" }}></span>
          {job.stage || "On the board"}
        </span>
      );
    }
    if (!schedOn) return <span style={{ fontSize: 11.5, color: "#94A3B8", fontWeight: 600 }}>Not scheduled</span>;
    return schedLinkBtn("Add to build schedule", "Put this building on the Build Schedule — it takes the next shop serial number",
      () => addToBuildSchedule(r), schedBusy === r.o.id);
  };
  const balOf = (r) => (r.o.total_cents == null ? null : r.o.total_cents - r.paid);
  const stateOf = (r) => {
    const bal = balOf(r);
    if (bal == null) return { key: "nototal", label: "Needs total", bg: "#F1F5F9", fg: "#475569" };
    // Collected more than the total — say so plainly instead of "Paid in full",
    // which would hide that a refund/credit is owed back to the customer.
    if (bal < 0) return { key: "over", label: "Overpaid", bg: "#FFEDD5", fg: "#9A3412" };
    if (bal === 0) return { key: "paid", label: "Paid in full", bg: "#DCFCE7", fg: "#166534" };
    if (r.paid > 0) return { key: "partial", label: "Partially paid", bg: "#DBEAFE", fg: "#1E40AF" };
    // Nothing collected yet — and these are two different jobs. A quote the customer
    // accepted but nobody has billed is the OWNER's move; an invoice that's out and
    // unpaid is the CUSTOMER's. Lumping both under "Unpaid" hides the follow-up.
    return ((r.d && r.d.status) === "accepted")
      ? { key: "needsinvoice", label: "Needs invoice", bg: "#FEF3C7", fg: "#92400E" }
      : { key: "awaiting", label: "Awaiting payment", bg: "#FFE4E6", fg: "#9F1239" };
  };

  const all = rows || [];
  const shown = all.filter((r) => {
    if (filter !== "all" && stateOf(r).key !== filter) return false;
    if (!inDateRange(r.o.ordered_at, fFrom, fTo)) return false;
    // Amount range compares the ORDER TOTAL in dollars; an order with no total yet only
    // shows while no amount bound is set (it has no amount to compare).
    if (fMin !== "" || fMax !== "") {
      const tot = r.o.total_cents == null ? null : r.o.total_cents / 100;
      if (tot == null) return false;
      if (fMin !== "" && tot < Number(fMin)) return false;
      if (fMax !== "" && tot > Number(fMax)) return false;
    }
    const extra = [nameOf(r), bldgOf(r), "#" + r.o.order_no, r.o.short_code,
      (r.d && r.d.ghl_estimate_number) ? "EST-" + r.d.ghl_estimate_number : "", (r.d && r.d.ss_quote_number) || "", stateOf(r).label, fmtDate(r.o.ordered_at)].join(" ");
    return rowMatchesQuery(r.o, query, extra);
  });
  const openRow = openId ? all.find((r) => r.o.id === openId) : null;

  // Summary tiles — only orders with a known total can contribute to money figures.
  const withTotal = all.filter((r) => r.o.total_cents != null);
  const openBalance = withTotal.reduce((s, r) => s + Math.max(0, balOf(r)), 0);
  const collected = all.reduce((s, r) => s + r.paid, 0);
  // Voided rows are fetched (they stay visible in the history) but must not be counted.
  const payCount = all.reduce((s, r) => s + r.pays.filter((p) => !p.voided_at).length, 0);
  const needsInvoice = all.filter((r) => stateOf(r).key === "needsinvoice").length;
  const awaitingCount = all.filter((r) => stateOf(r).key === "awaiting").length;
  const needsTotal = all.filter((r) => r.o.total_cents == null).length;

  if (error) return <div style={S.err}>Couldn't load orders: {error}</div>;
  if (rows === null) return <div style={{ ...S.card, color: "#64748B", fontSize: 13 }}>Loading orders…</div>;

  if (openRow) return <OrderDetail row={openRow} clientId={clientId} onBack={() => setOpenId(null)} onChanged={load} stateOf={stateOf} nameOf={nameOf} bldgOf={bldgOf} balOf={balOf} onOpenDesign={onOpenDesign} />;

  const tile = (label, value, note, accent) => (
    <div style={{ ...S.card, marginBottom: 0, padding: "13px 15px", borderLeft: accent ? `3px solid ${accent}` : S.card.border }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, color: "#64748B", textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 23, fontWeight: 800, marginTop: 5, fontVariantNumeric: "tabular-nums", letterSpacing: -0.5 }}>{value}</div>
      <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 3 }}>{note}</div>
    </div>
  );
  const chip = (id, label) => (
    <button key={id} type="button" onClick={() => setFilter(id)}
      style={{ background: filter === id ? ACCENT : "#F1F5F9", border: `1px solid ${filter === id ? ACCENT : "#E2E8F0"}`, color: filter === id ? "#FFF" : "#475569", fontSize: 12, fontWeight: 700, borderRadius: 20, padding: "6px 13px", cursor: "pointer", fontFamily: "inherit" }}>{label}</button>
  );

  return (
    <div>
      {schedMsg && schedMsg.ok && <div style={S.okMsg}>{schedMsg.ok}</div>}
      {schedMsg && schedMsg.err && <div style={S.err}>{schedMsg.err}</div>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(168px, 1fr))", gap: 11, marginBottom: 16 }}>
        {tile("Open balance", money(openBalance), `across ${withTotal.filter((r) => balOf(r) > 0).length} open orders`, "#F59E0B")}
        {tile("Collected", money(collected), `${payCount} payment${payCount === 1 ? "" : "s"} recorded`, "#16A34A")}
        {tile("Needs invoice", String(needsInvoice), needsInvoice ? "accepted, not billed yet" : "all billed", "#92400E")}
        {tile("Awaiting payment", String(awaitingCount), "invoiced, nothing collected", "#9F1239")}
        {needsTotal > 0 && tile("Needs a total", String(needsTotal), "set it on the order", null)}
      </div>

      <div style={S.card}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap", marginBottom: 12 }}>
          <div style={{ ...S.h2, marginBottom: 0, marginRight: 4 }}>Orders {rows ? (query || filter !== "all" || hasFacets ? `(${shown.length} of ${all.length})` : `(${all.length})`) : ""}</div>
          {chip("all", "All")}{chip("needsinvoice", "Needs invoice")}{chip("awaiting", "Awaiting payment")}{chip("partial", "Partially paid")}{chip("paid", "Paid in full")}
          {needsTotal > 0 && chip("nototal", "Needs total")}
          {all.some((r) => stateOf(r).key === "over") && chip("over", "Overpaid")}
          <div style={{ marginLeft: "auto", minWidth: 240, flex: "0 1 300px" }}>
            <SearchInput value={query} onChange={setQuery} placeholder="Search orders — name, building, order #…" />
          </div>
          <button onClick={syncFromGhl} disabled={syncing} style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0", padding: "6px 12px", opacity: syncing ? 0.6 : 1 }}>{syncing ? "Syncing…" : "↻ Refresh"}</button>
        </div>
        {all.length > 0 && (
          <FilterBar hasFilters={hasFacets} onClear={clearFacets} shown={shown.length} total={all.length} noun="order">
            <DateRange label="Ordered" from={fFrom} to={fTo} onFrom={setFFrom} onTo={setFTo} />
            <div style={FCTRL}><span style={S.lbl}>Amount ($)</span>
              <div style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                <input type="number" min="0" step="any" value={fMin} onChange={(e) => setFMin(e.target.value)} placeholder="Min" style={{ ...S.input, padding: "6px 8px", width: 90 }} />
                <span style={{ color: "#94A3B8", fontSize: 12 }}>–</span>
                <input type="number" min="0" step="any" value={fMax} onChange={(e) => setFMax(e.target.value)} placeholder="Max" style={{ ...S.input, padding: "6px 8px", width: 90 }} />
              </div>
            </div>
          </FilterBar>
        )}

        {all.length === 0 && (
          <p style={{ fontSize: 13, color: "#64748B", padding: 12 }}>
            No orders yet. An order appears here automatically as soon as a customer signs a
            StructureStudio quote. (Quotes and invoices issued through your CRM live in your
            CRM — this page only tracks the paperwork StructureStudio issues.)
          </p>
        )}
        {all.length > 0 && shown.length === 0 && (
          <p style={{ fontSize: 13, color: "#64748B", padding: 12 }}>
            No orders match this filter{hasFacets ? <>. Adjust or <button onClick={clearFacets} style={{ background: "none", border: "none", color: ACCENT, cursor: "pointer", fontWeight: 700, fontSize: 13, padding: 0, fontFamily: "inherit", textDecoration: "underline" }}>clear the filters</button></> : null}.
          </p>
        )}
        {shown.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>
                <th style={S.th}>Order</th><th style={S.th}>Customer</th><th style={S.th}>Building</th><th style={S.th}>Ordered</th>
                <th style={{ ...S.th, textAlign: "right" }}>Total</th><th style={{ ...S.th, textAlign: "right" }}>Paid</th>
                <th style={{ ...S.th, textAlign: "right" }}>Balance</th><th style={S.th}>Status</th>
                {(schedOn || deliverOn) && <th style={S.th}>Schedule</th>}
                <th style={S.th}></th>
              </tr></thead>
              <tbody>
                {shown.map((r) => {
                  const st = stateOf(r); const bal = balOf(r);
                  const numCell = { ...S.td, textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };
                  return (
                    <tr key={r.o.id} onClick={() => setOpenId(r.o.id)} style={{ cursor: "pointer" }}>
                      <td style={{ ...S.td, fontWeight: 700, whiteSpace: "nowrap" }}>#{r.o.order_no}</td>
                      <td style={{ ...S.td, fontWeight: 700 }}>{nameOf(r)}
                        <div style={{ fontSize: 11, color: "#94A3B8", fontWeight: 500 }}>{(r.d && r.d.contact && r.d.contact.phone) || ""}</div></td>
                      <td style={S.td}>{bldgOf(r)}</td>
                      <td style={{ ...S.td, whiteSpace: "nowrap" }}>{fmtDate(r.o.ordered_at)}</td>
                      <td style={numCell}>{r.o.total_cents == null ? <span style={{ color: ACCENT, fontWeight: 700 }}>Set total</span> : money(r.o.total_cents)}</td>
                      <td style={numCell}>{r.paid ? money(r.paid) : <span style={{ color: "#94A3B8" }}>—</span>}</td>
                      <td style={{ ...numCell, fontWeight: bal ? 800 : 600, color: bal === 0 ? "#94A3B8" : bal < 0 ? "#9A3412" : "#1E293B" }}>
                        {bal == null ? "—" : bal < 0 ? `${money(-bal)} credit` : money(bal)}
                      </td>
                      <td style={S.td}>
                        <span style={{ background: st.bg, color: st.fg, borderRadius: 20, padding: "4px 11px", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" }}>{st.label}</span>
                        {r.coPending && (
                          <span title="A change order is awaiting the customer's acknowledgment — invoicing is blocked until they sign or a verbal confirmation is recorded"
                            style={{ background: "#FEF3C7", color: "#B45309", borderRadius: 20, padding: "4px 11px", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap", marginLeft: 6 }}>CO pending</span>
                        )}
                      </td>
                      {(schedOn || deliverOn) && (
                        // stopPropagation throughout: the row itself opens the order detail.
                        <td style={{ ...S.td, whiteSpace: "nowrap" }} onClick={(e) => e.stopPropagation()}>{schedCell(r)}</td>
                      )}
                      <td style={{ ...S.td, whiteSpace: "nowrap" }}><span style={{ color: ACCENT, fontWeight: 700, fontSize: 12 }}>Open →</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// One order: the money detail + payment history + record-a-payment.
/* Change orders (migration 126) — SS-mode orders only (the design carries an SS quote).
   A change to an agreed order needs the customer's acknowledgment: e-signature from their
   quote page, OR the rep's verbal attestation (checkbox + name + conversation date) —
   either/or, Carolyn 2026-08-23. While one is pending, send_invoice 409s server-side.
   Reads/writes are direct RLS (the orders precedent); the guard trigger owns the rules a
   browser must not bypass (co_no assignment, signature acks, frozen-when-acknowledged). */
function ChangeOrdersCard({ clientId, shortCode, orderId, currentTotalCents, onChanged }) {
  const [cos, setCos] = useState(null);        // null = loading
  const [msg, setMsg] = useState(null);        // { ok } | { err }
  const [busy, setBusy] = useState(false);
  // New-CO form
  const [formOpen, setFormOpen] = useState(false);
  const [desc, setDesc] = useState("");
  const [newTotal, setNewTotal] = useState("");
  const [ackPath, setAckPath] = useState("sign");   // 'sign' | 'verbal'
  const [repName, setRepName] = useState("");
  const [convDate, setConvDate] = useState(todayLocal());
  const [note, setNote] = useState("");
  // Per-CO verbal-attestation form
  const [verbalFor, setVerbalFor] = useState(null); // co.id | null
  const [vRep, setVRep] = useState("");
  const [vDate, setVDate] = useState(todayLocal());
  const [vNote, setVNote] = useState("");
  const [vConfirm, setVConfirm] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await sb.from("change_orders")
      .select("*").eq("client_id", clientId).eq("short_code", shortCode)
      .order("co_no", { ascending: false });
    if (error) { setMsg({ err: error.message }); setCos([]); return; }
    setCos(data || []);
  }, [clientId, shortCode]);
  useEffect(() => { load(); }, [load]);

  const applyAckedTotal = async (co) => {
    // The acknowledged total becomes the order's total; 'manual' also shields it from the
    // GHL repricer (sync-design-status skips manual rows).
    if (co.total_after_cents == null) return;
    const { error } = await sb.from("orders")
      .update({ total_cents: co.total_after_cents, total_source: "manual", updated_at: new Date().toISOString() })
      .eq("client_id", clientId).eq("short_code", shortCode);
    if (error) setMsg({ err: `Change recorded, but the order total didn't update: ${error.message}` });
  };

  const createCo = async () => {
    const d = desc.trim();
    if (!d) { setMsg({ err: "Describe the change — this text is what the customer signs off on." }); return; }
    let totalCents = null;
    if (newTotal.trim()) {
      totalCents = centsFrom(newTotal);
      if (!Number.isFinite(totalCents) || totalCents < 0) { setMsg({ err: "Enter the new total as a dollar amount, e.g. 9575.00" }); return; }
    }
    const verbal = ackPath === "verbal";
    if (verbal && (!repName.trim() || !convDate)) { setMsg({ err: "Verbal confirmation needs your name and the date of the conversation." }); return; }
    setBusy(true); setMsg(null);
    const rowBase = {
      client_id: clientId, short_code: shortCode, order_id: orderId || null,
      source: "manual", description: d,
      total_before_cents: currentTotalCents == null ? null : currentTotalCents,
      total_after_cents: totalCents,
    };
    const { data: created, error } = await sb.from("change_orders")
      .insert(verbal
        ? { ...rowBase, status: "acknowledged", ack_method: "verbal", verbal_rep_name: repName.trim(), verbal_conversation_date: convDate, verbal_note: note.trim() || null }
        : rowBase)
      .select("id, co_no, total_after_cents, status").maybeSingle();
    setBusy(false);
    if (error) { setMsg({ err: error.message }); return; }
    setFormOpen(false); setDesc(""); setNewTotal(""); setRepName(""); setNote("");
    if (verbal) {
      await applyAckedTotal(created);
      setMsg({ ok: `CO-${created.co_no} recorded with your verbal confirmation.` });
    } else {
      // Email it for signature right away — a pending CO nobody was told about blocks the
      // invoice forever. sent:false just means print/hand it over; the CO still exists.
      const { data: sent } = await sb.functions.invoke("portal-settings", { body: { action: "send_change_order", changeOrderId: created.id } });
      setMsg(sent && sent.sent
        ? { ok: `CO-${created.co_no} created and emailed to the customer for signature.` }
        : { ok: `CO-${created.co_no} created. Email not sent${sent && sent.reason ? ` (${sent.reason})` : ""} — the customer can sign it from their quote page link.` });
    }
    load(); onChanged();
  };

  const recordVerbal = async (co) => {
    if (!vConfirm) { setMsg({ err: "Tick the confirmation box — it is your attestation." }); return; }
    if (!vRep.trim() || !vDate) { setMsg({ err: "Verbal confirmation needs your name and the date of the conversation." }); return; }
    setBusy(true); setMsg(null);
    const { error } = await sb.from("change_orders")
      .update({ status: "acknowledged", ack_method: "verbal", verbal_rep_name: vRep.trim(), verbal_conversation_date: vDate, verbal_note: vNote.trim() || null })
      .eq("id", co.id).eq("status", "pending_ack");
    setBusy(false);
    if (error) { setMsg({ err: error.message }); return; }
    setVerbalFor(null); setVRep(""); setVNote(""); setVConfirm(false);
    await applyAckedTotal(co);
    setMsg({ ok: `CO-${co.co_no} confirmed verbally.` });
    load(); onChanged();
  };

  const emailCo = async (co) => {
    setBusy(true); setMsg(null);
    const { data, error } = await sb.functions.invoke("portal-settings", { body: { action: "send_change_order", changeOrderId: co.id } });
    setBusy(false);
    if (error || (data && data.error)) { setMsg({ err: (data && data.error) || error.message }); return; }
    setMsg(data && data.sent
      ? { ok: `CO-${co.co_no} emailed to the customer for signature.` }
      : { err: `Email not sent${data && data.reason ? ` (${data.reason})` : ""} — the customer can still sign from their quote page.` });
  };

  const voidCo = async (co) => {
    const reason = window.prompt(`Void CO-${co.co_no}? Give a reason (kept in the record):`);
    if (reason == null) return;
    if (!reason.trim()) { setMsg({ err: "Voiding needs a reason." }); return; }
    const { error } = await sb.from("change_orders")
      .update({ status: "void", void_reason: reason.trim() })
      .eq("id", co.id);
    if (error) { setMsg({ err: error.message }); return; }
    load(); onChanged();
  };

  const chip = (co) => {
    const s = co.status === "pending_ack"
      ? { bg: "#FEF3C7", fg: "#B45309", label: "Awaiting customer" }
      : co.status === "acknowledged"
        ? { bg: "#F0FDF4", fg: "#15803D", label: "Acknowledged" }
        : { bg: "#F1F5F9", fg: "#64748B", label: "Void" };
    return <span style={{ background: s.bg, color: s.fg, borderRadius: 20, padding: "3px 10px", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" }}>{s.label}</span>;
  };

  return (
    <div style={S.card}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <div style={{ ...S.h2, marginBottom: 0 }}>Change orders</div>
        <button type="button" onClick={() => setFormOpen((o) => !o)}
          style={{ ...S.btn("#FFF", ACCENT), border: `1px solid ${ACCENT}`, marginLeft: "auto", padding: "5px 12px", fontSize: 12 }}>
          {formOpen ? "Cancel" : "+ New change order"}
        </button>
      </div>
      {msg && msg.err && <div style={S.err}>{msg.err}</div>}
      {msg && msg.ok && <div style={S.okMsg}>{msg.ok}</div>}

      {formOpen && (
        <div style={{ background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 10, padding: 12, marginBottom: 12 }}>
          <span style={S.lbl}>What changed?</span>
          <textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={3}
            placeholder={'e.g. "Moved delivery to the week of Sept 14" or "Added a 4\' side door, $250"'}
            style={{ ...S.input, resize: "vertical", fontFamily: "inherit" }} />
          <div style={{ marginTop: 10, maxWidth: 220 }}>
            <span style={S.lbl}>New order total (optional)</span>
            <input style={S.input} value={newTotal} onChange={(e) => setNewTotal(e.target.value)} placeholder="e.g. 9575.00" inputMode="decimal" />
          </div>
          <div style={{ display: "flex", gap: 16, marginTop: 12, fontSize: 13, fontWeight: 600, color: "#334155", flexWrap: "wrap" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
              <input type="radio" name="ss-co-ack" checked={ackPath === "sign"} onChange={() => setAckPath("sign")} />
              Send to the customer to e-sign
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
              <input type="radio" name="ss-co-ack" checked={ackPath === "verbal"} onChange={() => setAckPath("verbal")} />
              Customer already confirmed verbally
            </label>
          </div>
          {ackPath === "verbal" && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10, marginTop: 10, maxWidth: 520 }}>
              <div><span style={S.lbl}>Your name</span>
                <input style={S.input} value={repName} onChange={(e) => setRepName(e.target.value)} placeholder="Who spoke with them" /></div>
              <div><span style={S.lbl}>Date of conversation</span>
                <input type="date" style={S.input} value={convDate} onChange={(e) => setConvDate(e.target.value)} /></div>
              <div style={{ gridColumn: "1 / -1" }}><span style={S.lbl}>Note (optional)</span>
                <input style={S.input} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. phone call, spoke with Dave" /></div>
            </div>
          )}
          <button type="button" onClick={createCo} disabled={busy}
            style={{ ...S.btn(ACCENT, "#FFF"), marginTop: 12, padding: "8px 16px", fontSize: 13, opacity: busy ? 0.6 : 1 }}>
            {busy ? "Saving…" : (ackPath === "verbal" ? "Record change with verbal confirmation" : "Create & send for signature")}
          </button>
        </div>
      )}

      {cos === null && <p style={{ fontSize: 13, color: "#64748B", padding: "6px 0" }}>Loading…</p>}
      {cos && cos.length === 0 && !formOpen && (
        <p style={{ fontSize: 13, color: "#64748B", padding: "6px 0" }}>
          None. If this order changes after the customer signed, record it here — they
          acknowledge it with a signature, or you record their verbal OK.
        </p>
      )}
      {cos && cos.map((co) => (
        <div key={co.id} style={{ borderTop: "1px solid #F1F5F9", padding: "10px 0", opacity: co.status === "void" ? 0.6 : 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <b style={{ fontSize: 13 }}>CO-{co.co_no}</b>
            <span style={{ fontSize: 11, color: "#94A3B8", fontWeight: 600 }}>{co.source === "design_edit" ? "From design revision" : "Manual"} · {fmtDate(co.created_at)}</span>
            {chip(co)}
            {(co.total_before_cents != null || co.total_after_cents != null) && (
              <span style={{ fontSize: 12.5, fontWeight: 700, marginLeft: "auto" }}>
                {co.total_before_cents != null ? money(co.total_before_cents) : "—"} → {co.total_after_cents != null ? money(co.total_after_cents) : "—"}
              </span>
            )}
          </div>
          <div style={{ fontSize: 12.5, color: "#334155", whiteSpace: "pre-wrap", marginTop: 6 }}>{co.description}</div>
          {co.status === "acknowledged" && (
            <div style={{ fontSize: 12, color: "#15803D", fontWeight: 600, marginTop: 6 }}>
              {co.ack_method === "verbal"
                /* verbal_conversation_date is DATE-ONLY: parsed bare it reads as UTC
                   midnight and renders the previous local day. Midday anchor, the same
                   trick recordPayment and the schedule use. */
                ? `Verbal — ${co.verbal_rep_name}, conversation on ${fmtDate(co.verbal_conversation_date + "T12:00:00")}${co.verbal_note ? ` (${co.verbal_note})` : ""}`
                : `Signed by the customer${co.acknowledged_at ? ` · ${fmtDate(co.acknowledged_at)}` : ""}`}
            </div>
          )}
          {co.status === "void" && co.void_reason && (
            <div style={{ fontSize: 12, color: "#64748B", marginTop: 6 }}>Voided — {co.void_reason}</div>
          )}
          {co.status === "pending_ack" && (
            <div style={{ marginTop: 8 }}>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                <button type="button" onClick={() => emailCo(co)} disabled={busy}
                  style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: ACCENT, fontWeight: 700, fontSize: 12.5 }}>Email to customer</button>
                <button type="button" onClick={() => { setVerbalFor(verbalFor === co.id ? null : co.id); setVConfirm(false); }}
                  style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: ACCENT, fontWeight: 700, fontSize: 12.5 }}>Record verbal confirmation</button>
                <button type="button" onClick={() => voidCo(co)}
                  style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "#94A3B8", fontWeight: 700, fontSize: 12.5 }}>Void</button>
              </div>
              {verbalFor === co.id && (
                <div style={{ background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 10, padding: 12, marginTop: 8 }}>
                  <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12.5, fontWeight: 600, color: "#334155" }}>
                    <input type="checkbox" checked={vConfirm} onChange={(e) => setVConfirm(e.target.checked)} style={{ marginTop: 2 }} />
                    The customer confirmed this change in a conversation with me.
                  </label>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10, marginTop: 10, maxWidth: 520 }}>
                    <div><span style={S.lbl}>Your name</span>
                      <input style={S.input} value={vRep} onChange={(e) => setVRep(e.target.value)} /></div>
                    <div><span style={S.lbl}>Date of conversation</span>
                      <input type="date" style={S.input} value={vDate} onChange={(e) => setVDate(e.target.value)} /></div>
                    <div style={{ gridColumn: "1 / -1" }}><span style={S.lbl}>Note (optional)</span>
                      <input style={S.input} value={vNote} onChange={(e) => setVNote(e.target.value)} placeholder="e.g. phone call, spoke with Dave" /></div>
                  </div>
                  <button type="button" onClick={() => recordVerbal(co)} disabled={busy}
                    style={{ ...S.btn(ACCENT, "#FFF"), marginTop: 10, padding: "7px 14px", fontSize: 12.5, opacity: busy ? 0.6 : 1 }}>
                    {busy ? "Saving…" : "Confirm"}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/* ─── The invoice-style order document (migration 127) ─────────────────────────────────
   SS-mode orders render the ORDER itself "between an invoice and a PDF" (Carolyn
   2026-08-24): letterhead, the priced line items from designs.estimate_lines — the same
   snapshot every PDF renders from, so screen and paper can't disagree — with roof,
   cladding and paint as LIVE dropdowns. Changing one stages a change (dryRun price
   preview from the server's catalog math), raises the change order the customer must
   acknowledge, and can be discarded (void_change_order restores the as-signed design
   from snapshot_before). Totals show the current numbers plus the amendment trail. */

// De-render the snapshot's GHL-flavored HTML for display — MUST match
// _shared/estimateLines.ts `deHtml` (the server is the authority; this is presentation).
const ssDeHtml = (s) => String(s || "")
  .replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, "")
  .replace(/<br\s*\/?>/gi, "\n")
  .replace(/<[^>]*>/g, "")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
  .trim();
const ssRound2 = (n) => Math.round(n * 100) / 100;
// Totals over the snapshot — MUST match _shared/estimateLines.ts `totalFromSnapshot`.
const ssSnapTotals = (snap) => {
  const lines = (snap && Array.isArray(snap.lines)) ? snap.lines : [];
  let subtotal = 0;
  for (const li of lines) subtotal += ssRound2((Number(li.qty) || 0) * (Number(li.amount) || 0));
  subtotal = ssRound2(subtotal);
  const discount = Number(snap && snap.discount) || 0;
  const total = Math.max(0, discount > 0 ? ssRound2(subtotal - discount) : subtotal);
  return { subtotal, discount, total };
};
const ssUsd = (n) => {
  if (n == null || !isFinite(Number(n))) return "—";
  const v = ssRound2(Number(n));
  const [int, frac] = Math.abs(v).toFixed(2).split(".");
  return `${v < 0 ? "-" : ""}$${int.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${frac}`;
};
// The offered cladding set — mirrors the designer's D3_CLADDING_CHOICES (batten is a
// legacy render-only value; it shows as its label if a row carries it, but isn't offered).
const SS_CLADDING = [["", "Builder's standard"], ["lap", "Lap Siding"], ["panel", "Panel Siding"], ["agpanel", "Metal"]];
const ssCladdingLabel = (id) => (SS_CLADDING.find((c) => c[0] === String(id || "")) || [["", ""], `${id}`])[1] || String(id);

function OrderDocumentCard({ clientId, o, st, doc, busyExt, onMsg, onChanged, onOpenDesign = null, onPreview = null }) {
  const [draft, setDraft] = useState(null);      // null = viewing; else the six attrs
  const [preview, setPreview] = useState(null);  // dryRun result { totalBefore, totalAfter, description }
  const [previewErr, setPreviewErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const debounceRef = useRef(null);

  if (!doc || !doc.design) {
    return <div style={S.card}><p style={{ fontSize: 13, color: "#64748B" }}>Loading the order…</p></div>;
  }
  const { design, acceptances, cos, paperwork } = doc;
  const biz = (paperwork && paperwork.business) || {};
  const colors = (paperwork && paperwork.colors) || [];
  const invoice = (paperwork && paperwork.invoice) || null;
  const snap = design.estimate_lines || { lines: [], discount: 0 };
  const lines = Array.isArray(snap.lines) ? snap.lines : [];
  const sel = design.selections || {};
  const pc = design.paint_colors || {};
  const locked = ["invoiced", "delivered"].includes(String(design.status || ""));
  const acceptance = (acceptances || []).find((a) => a.subject === "quote") || null;
  const ackedCos = (cos || []).filter((c) => c.status === "acknowledged")
    .sort((a, b) => String(a.acknowledged_at || "").localeCompare(String(b.acknowledged_at || "")));
  const pendingCo = (cos || []).find((c) => c.status === "pending_ack" && c.source === "design_edit") || null;

  const cur = {
    roofType: String(sel.roofType || "").trim(),
    roofColor: String(sel.roofColor || "").trim(),
    cladding: String(sel.cladding || ""),
    paintStatus: (sel.paint && String(sel.paint).toLowerCase() === "painted") ? "Paint" : "Unpaint",
    paintBody: String(pc.body || "").trim(),
    paintTrim: String(pc.trim || "").trim(),
  };
  const eff = draft || cur;

  // Palette slices for the dropdowns. A stored value missing from today's palette still
  // renders — a renamed color must not silently rewrite a signed order. An EMPTY stored
  // value gets an explicit "(not chosen)" option: without one the browser displays the
  // first option while the select's value stays "", and what the rep sees isn't what
  // would be staged.
  const colorOpts = (flag, current) => {
    const opts = colors.filter((c) => c[flag] === true && !c.allow_custom).map((c) => c.label);
    if (current && !opts.some((l) => l.toLowerCase() === current.toLowerCase())) opts.unshift(current);
    if (!current) opts.unshift("");
    return opts;
  };
  const optLabel = (l) => (l === "" ? "(not chosen)" : l);
  const roofTypes = [["Shingle", colors.some((c) => c.shingle === true)], ["Metal", colors.some((c) => c.metal === true)]]
    .filter(([, ok]) => ok).map(([t]) => t);

  const queuePreview = (next) => {
    setDraft(next); setPreview(null); setPreviewErr(null);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      const { data, error } = await sb.functions.invoke("portal-settings", {
        body: { action: "stage_order_attribute_change", shortCode: o.short_code, attrs: next, dryRun: true },
      });
      if (error || (data && data.error)) { setPreviewErr((data && data.error) || error.message); return; }
      setPreview(data);
    }, 450);
  };
  const change = (k, v) => {
    const next = { ...eff, [k]: v };
    if (k === "roofType" && v !== eff.roofType) {
      // The designer's rule: a type change resets the color to that type's first offering.
      const flag = String(v).toLowerCase() === "metal" ? "metal" : "shingle";
      const first = colors.find((c) => c[flag] === true && !c.allow_custom);
      next.roofColor = first ? first.label : "";
    }
    queuePreview(next);
  };
  const discardDraft = () => { setDraft(null); setPreview(null); setPreviewErr(null); if (debounceRef.current) clearTimeout(debounceRef.current); };

  const stage = async () => {
    setBusy(true); onMsg(null);
    const { data, error } = await sb.functions.invoke("portal-settings", {
      body: { action: "stage_order_attribute_change", shortCode: o.short_code, attrs: eff },
    });
    if (error || (data && data.error)) { setBusy(false); onMsg({ err: (data && data.error) || error.message }); return; }
    let note;
    if (data.changeOrderId) {
      const { data: sent } = await sb.functions.invoke("portal-settings", { body: { action: "send_change_order", changeOrderId: data.changeOrderId } });
      note = sent && sent.sent
        ? { ok: `Change order CO-${data.coNo} staged and emailed to the customer for signature.` }
        : { ok: `Change order CO-${data.coNo} staged. Email not sent${sent && sent.reason ? ` (${sent.reason})` : ""} — they can sign from their quote page link.` };
    } else {
      note = { ok: "Quote updated — the customer hasn't signed yet, so no change order was needed." };
    }
    setBusy(false); discardDraft(); onMsg(note); onChanged();
  };

  const discardStaged = async () => {
    if (!pendingCo) return;
    if (!window.confirm(`Discard the staged change (CO-${pendingCo.co_no}) and restore the order as the customer signed it?`)) return;
    setBusy(true); onMsg(null);
    const { data, error } = await sb.functions.invoke("portal-settings", {
      body: { action: "void_change_order", changeOrderId: pendingCo.id, reason: "Discarded from the order screen — restored to the signed configuration" },
    });
    setBusy(false);
    if (error || (data && data.error)) { onMsg({ err: (data && data.error) || error.message }); return; }
    onMsg({ ok: `CO-${pendingCo.co_no} discarded${data.reverted ? " — the order is back to what the customer signed" : ""}.` });
    onChanged();
  };

  const selStyle = { fontFamily: "inherit", fontSize: 12, padding: "5px 8px", border: "1px solid #CBD5E1", borderRadius: 7, background: "#FFF", color: "#1E293B", maxWidth: 170 };
  const th = { fontSize: 10.5, fontWeight: 700, color: "#94A3B8", letterSpacing: 0.5, textTransform: "uppercase", textAlign: "left", padding: "10px 0 6px" };
  const td = { fontSize: 13, color: "#1E293B", padding: "9px 0", borderTop: "1px solid #F1F5F9", verticalAlign: "top" };
  const optionRows = (label, control) => (
    <tr key={label}>
      <td style={td}>
        <div style={{ fontWeight: 700 }}>{label}</div>
        <div style={{ marginTop: 6, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>{control}</div>
      </td>
      <td style={{ ...td, textAlign: "center", color: "#94A3B8" }}>—</td>
      <td style={{ ...td, textAlign: "right" }}></td>
    </tr>
  );

  const totals = ssSnapTotals(snap);
  const ssInvoicePdf = invoice && invoice.issued_by === "structurestudio" && invoice.invoice_pdf_url ? invoice.invoice_pdf_url : null;
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(cur);
  const anyBusy = busy || busyExt;

  // The amendment trail: signed total + acknowledged CO snapshots — never re-summed line
  // items, so double-counting is structurally impossible.
  const trail = [];
  if (acceptance && acceptance.total != null) {
    let running = Number(acceptance.total);
    trail.push({ label: `Signed ${fmtDate(acceptance.accepted_at)}`, amountText: ssUsd(running), tone: "base" });
    for (const c of ackedCos) {
      if (c.total_after_cents == null) {
        trail.push({ label: `CO-${c.co_no} · ${fmtDate(c.acknowledged_at)}`, amountText: "no price change", tone: "base" });
      } else {
        const after = c.total_after_cents / 100;
        const delta = ssRound2(after - running);
        running = after;
        trail.push({ label: `CO-${c.co_no} · ${fmtDate(c.acknowledged_at)}`, amountText: `${delta >= 0 ? "+" : "-"}${ssUsd(Math.abs(delta))} → ${ssUsd(after)}`, tone: "base" });
      }
    }
    trail.push({ label: "Current total", amountText: o.total_cents == null ? "—" : money(o.total_cents), tone: "final" });
    if (pendingCo && pendingCo.total_after_cents != null) {
      trail.push({ label: `Pending CO-${pendingCo.co_no} (awaiting sign-off)`, amountText: `→ ${ssUsd(pendingCo.total_after_cents / 100)}`, tone: "pending" });
    }
  }

  return (
    <div style={{ ...S.card, padding: "20px 24px" }}>
      {/* Letterhead */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, borderBottom: "2px solid #CBD5E1", paddingBottom: 13 }}>
        <div>
          <div style={{ fontSize: 17, fontWeight: 800, color: "#1E293B" }}>{biz.name || "—"}</div>
          <div style={{ fontSize: 11.5, color: "#64748B", marginTop: 2 }}>
            {[biz.phone, biz.website].filter(Boolean).join(" · ")}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 14, fontWeight: 800, letterSpacing: 0.5, color: "#1E293B" }}>ORDER · {design.ss_quote_number}</div>
          <div style={{ fontSize: 11.5, color: "#64748B", marginTop: 2 }}>
            Ordered {fmtDate(o.ordered_at)}
            {invoice && invoice.invoice_number ? ` · Invoice ${invoice.invoice_number}` : " · not yet invoiced"}
          </div>
          <span style={{ display: "inline-block", marginTop: 6, background: st.bg, color: st.fg, borderRadius: 20, padding: "3px 11px", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" }}>{st.label}</span>
        </div>
      </div>

      {pendingCo && (
        <div style={{ background: "#FEF3C7", border: "1px solid #FDE68A", borderRadius: 8, padding: "9px 13px", marginTop: 12, fontSize: 12.5, color: "#B45309", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <b>CO-{pendingCo.co_no} is awaiting the customer's sign-off</b> — the values below include it; invoicing is blocked until they sign or you record their verbal OK.
          <button type="button" onClick={discardStaged} disabled={anyBusy}
            style={{ marginLeft: "auto", background: "none", border: "none", padding: 0, cursor: "pointer", color: "#B45309", fontWeight: 700, fontSize: 12, textDecoration: "underline", fontFamily: "inherit" }}>
            Discard staged change
          </button>
        </div>
      )}

      {/* Line items */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 4 }}>
        <thead><tr><th style={th}>Item</th><th style={{ ...th, textAlign: "center", width: 46 }}>Qty</th><th style={{ ...th, textAlign: "right", width: 92 }}>Amount</th></tr></thead>
        <tbody>
          {lines.map((li, i) => {
            const kind = String(li.kind || "");
            const lineTotal = ssRound2((Number(li.qty) || 0) * (Number(li.amount) || 0));
            let descCell = null;
            if (!locked && kind === "paint") {
              descCell = (
                <div style={{ marginTop: 6, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <select style={selStyle} value={eff.paintStatus} onChange={(e) => change("paintStatus", e.target.value)}>
                    <option value="Paint">Painted</option><option value="Unpaint">Unpainted</option>
                  </select>
                  {eff.paintStatus === "Paint" && (
                    <>
                      <span style={{ fontSize: 11.5, color: "#64748B" }}>Body</span>
                      <select style={selStyle} value={eff.paintBody} onChange={(e) => change("paintBody", e.target.value)}>
                        {colorOpts("siding", eff.paintBody).map((l) => <option key={l} value={l}>{optLabel(l)}</option>)}
                      </select>
                      <span style={{ fontSize: 11.5, color: "#64748B" }}>Trim</span>
                      <select style={selStyle} value={eff.paintTrim} onChange={(e) => change("paintTrim", e.target.value)}>
                        {colorOpts("trim", eff.paintTrim).map((l) => <option key={l} value={l}>{optLabel(l)}</option>)}
                      </select>
                    </>
                  )}
                </div>
              );
            } else if (!locked && kind === "roof") {
              descCell = (
                <div style={{ marginTop: 6, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <select style={selStyle} value={eff.roofType} onChange={(e) => change("roofType", e.target.value)}>
                    {!eff.roofType && <option value="">Select…</option>}
                    {roofTypes.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                  {eff.roofType && (
                    <select style={selStyle} value={eff.roofColor} onChange={(e) => change("roofColor", e.target.value)}>
                      {colorOpts(String(eff.roofType).toLowerCase() === "metal" ? "metal" : "shingle", eff.roofColor).map((l) => <option key={l} value={l}>{optLabel(l)}</option>)}
                    </select>
                  )}
                </div>
              );
            }
            return (
              <React.Fragment key={i}>
                <tr>
                  <td style={td}>
                    <div style={{ fontWeight: 700 }}>{li.name || "—"}</div>
                    {descCell || (li.desc ? <div style={{ fontSize: 12, color: "#64748B", whiteSpace: "pre-wrap", marginTop: 2 }}>{ssDeHtml(li.desc)}</div> : null)}
                  </td>
                  <td style={{ ...td, textAlign: "center" }}>{Number(li.qty) === 1 && (kind === "paint" || kind === "roof") ? "—" : (li.qty ?? "—")}</td>
                  <td style={{ ...td, textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{ssUsd(lineTotal)}</td>
                </tr>
                {kind === "building" && optionRows("Cladding",
                  locked
                    ? <span style={{ fontSize: 12, color: "#64748B" }}>{ssCladdingLabel(cur.cladding)}</span>
                    : (
                      <select style={selStyle} value={eff.cladding} onChange={(e) => change("cladding", e.target.value)}>
                        {SS_CLADDING.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                      </select>
                    ))}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>

      {/* Staged-change banner (dryRun preview) */}
      {dirty && (
        <div style={{ background: "#FEF3C7", border: "1px solid #FDE68A", borderRadius: 8, padding: "10px 14px", marginTop: 10 }}>
          {previewErr && <div style={{ fontSize: 12.5, fontWeight: 700, color: "#B91C1C" }}>{previewErr}</div>}
          {!previewErr && !preview && <div style={{ fontSize: 12.5, fontWeight: 700, color: "#B45309" }}>Pricing the change…</div>}
          {!previewErr && preview && (
            <>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: "#B45309" }}>
                This changes the order {ssUsd(preview.totalBefore)} → {ssUsd(preview.totalAfter)}
                {preview.totalBefore != null && preview.totalAfter != null && (
                  <> ({preview.totalAfter - preview.totalBefore >= 0 ? "+" : "-"}{ssUsd(Math.abs(ssRound2(preview.totalAfter - preview.totalBefore)))})</>
                )}
              </div>
              <div style={{ fontSize: 12, color: "#92400E", whiteSpace: "pre-wrap", marginTop: 4 }}>{preview.description}</div>
              <div style={{ fontSize: 12, color: "#B45309", marginTop: 4 }}>
                {design.accepted_at ? "The customer must sign off before this order can be invoiced." : "The customer hasn't signed yet — this just updates the quote."}
              </div>
            </>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button type="button" onClick={stage} disabled={anyBusy || !preview}
              style={{ ...S.btn(ACCENT, "#FFF"), padding: "7px 14px", fontSize: 12.5, opacity: anyBusy || !preview ? 0.6 : 1 }}>
              {busy ? "Staging…" : (design.accepted_at ? "Stage & send for signature" : "Update the quote")}
            </button>
            <button type="button" onClick={discardDraft} disabled={anyBusy}
              style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0", padding: "7px 14px", fontSize: 12.5 }}>Discard</button>
          </div>
        </div>
      )}

      {/* Totals + the amendment trail */}
      <div style={{ borderTop: "2px solid #CBD5E1", marginTop: 10, paddingTop: 9 }}>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 40, fontSize: 13, padding: "2px 0", color: "#64748B" }}>
          <span>Subtotal</span><span style={{ minWidth: 92, textAlign: "right", color: "#1E293B", fontVariantNumeric: "tabular-nums" }}>{ssUsd(totals.subtotal)}</span>
        </div>
        {totals.discount > 0 && (
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 40, fontSize: 13, padding: "2px 0", color: "#64748B" }}>
            <span>Discount</span><span style={{ minWidth: 92, textAlign: "right", color: "#1E293B", fontVariantNumeric: "tabular-nums" }}>-{ssUsd(totals.discount)}</span>
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 40, fontSize: 16, fontWeight: 800, padding: "5px 0 2px", color: "#1E293B" }}>
          <span>Total</span><span style={{ minWidth: 92, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{ssUsd(totals.total)}</span>
        </div>
        {trail.length > 0 && (
          <div style={{ background: "#F8FAFC", border: "1px solid #F1F5F9", borderRadius: 8, padding: "8px 12px", marginTop: 8 }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "#94A3B8", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 3 }}>Amendment trail</div>
            {trail.map((t, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12, padding: "2px 0",
                color: t.tone === "pending" ? "#B45309" : t.tone === "final" ? "#1E293B" : "#64748B",
                fontWeight: t.tone === "final" ? 800 : 500,
                borderTop: t.tone === "final" ? "1px solid #E2E8F0" : "none",
                marginTop: t.tone === "final" ? 3 : 0, paddingTop: t.tone === "final" ? 4 : 2 }}>
                <span>{t.label}</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{t.amountText}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* THE INVOICE STEP — the missing rung Carolyn hit (2026-08-25: "I see no way for
          creating that into an invoice"). The ladder is: QUOTE (the signed offer, SST-…)
          → this order → INVOICE (the bill, SSI-…). One clear affordance per state. */}
      {!ssInvoicePdf && !locked && (
        design.accepted_at
          ? (pendingCo
            ? <div style={{ background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 8, padding: "9px 13px", marginTop: 12, fontSize: 12.5, color: "#64748B" }}>
                <b style={{ color: "#B45309" }}>Ready to invoice once CO-{pendingCo.co_no} is acknowledged</b> — the customer signs it from their quote page, or record their verbal OK below.
              </div>
            : <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
                <button type="button" disabled={anyBusy}
                  onClick={async () => {
                    const totalTxt = o.total_cents != null ? money(o.total_cents) : ssUsd(totals.total);
                    if (!window.confirm(`Create invoice for ${design.ss_quote_number} (${totalTxt}) and email it to the customer?\n\nThe invoice gets its own number and PDF; the order is marked Invoiced.`)) return;
                    setBusy(true); onMsg(null);
                    const { data, error } = await sb.functions.invoke("portal-settings", { body: { action: "send_invoice", shortCode: o.short_code } });
                    setBusy(false);
                    if (error || (data && data.error)) { onMsg({ err: (data && data.error) || error.message }); return; }
                    onMsg(data && data.sent === false
                      ? { err: `Invoice ${data.invoiceNumber || ""} created and the order is Invoiced, but the customer was NOT emailed${data.emailReason ? ` (${data.emailReason})` : ""} — print it or copy the customer link.` }
                      : { ok: `Invoice ${(data && data.invoiceNumber) || ""} sent — this order is now Invoiced.` });
                    onChanged();
                  }}
                  style={{ ...S.btn("#059669", "#FFF"), padding: "9px 18px", fontSize: 13, opacity: anyBusy ? 0.6 : 1 }}>
                  {busy ? "Working…" : "Create & send invoice"}
                </button>
                <span style={{ fontSize: 11.5, color: "#94A3B8" }}>Signed {fmtDate(design.accepted_at)} — the invoice takes the next number in your sequence.</span>
              </div>)
          : <div style={{ background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 8, padding: "9px 13px", marginTop: 12, fontSize: 12.5, color: "#64748B" }}>
              <b>Quote sent — awaiting the customer's signature.</b> Invoicing unlocks when they sign from their quote page (Copy customer link below, or hand them your phone).
            </div>
      )}

      {/* Action row. The documents open IN A POPUP (Carolyn 2026-08-25), not a tab —
          the viewer's own toolbar carries print/download. */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", borderTop: "1px solid #F1F5F9", marginTop: 12, paddingTop: 12 }}>
        {(() => {
          const docBtn = (label, url, title) => (
            <button type="button" onClick={() => (onPreview ? onPreview(url, title) : window.open(url, "_blank"))}
              style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0", cursor: "pointer" }}>{label}</button>
          );
          return (
            <>
              {ssInvoicePdf
                ? docBtn("Print invoice", ssInvoicePdf, `Invoice ${invoice.invoice_number || ""}`)
                : (design.ss_quote_pdf_url && docBtn("Print quote", design.ss_quote_pdf_url, `Quote ${design.ss_quote_number}`))}
              {ssInvoicePdf && design.ss_quote_pdf_url && docBtn("Quote (PDF)", design.ss_quote_pdf_url, `Quote ${design.ss_quote_number}`)}
              {design.image_url && docBtn("Floor plan", design.image_url, "Floor plan")}
            </>
          );
        })()}
        {/* IN-PORTAL designer, never the public ?id= page — staff browsing there fires
            capture-lead/draft saves and corrupts the tenant's Contacts activity. */}
        {o.short_code && onOpenDesign && (
          <button type="button" onClick={() => onOpenDesign(o.short_code)}
            style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0", cursor: "pointer" }}>Open design</button>
        )}
        <button type="button"
          onClick={(e) => {
            const link = `${window.location.origin}/my-quotes?client=${encodeURIComponent(clientId)}`;
            const btn = e.currentTarget;
            const done = () => { btn.textContent = "Copied ✓"; setTimeout(() => { btn.textContent = "Copy customer link"; }, 2000); };
            if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(done, done);
            else window.prompt("Copy the customer link:", link);
          }}
          style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0", cursor: "pointer" }}>Copy customer link</button>
        <button type="button" disabled={anyBusy}
          onClick={async () => {
            setBusy(true); onMsg(null);
            const { data: res, error: err } = await sb.functions.invoke("portal-settings", { body: { action: "resend_quote_email", shortCode: o.short_code } });
            setBusy(false);
            if (err || (res && res.error)) { onMsg({ err: (res && res.error) || err.message }); return; }
            onMsg(res && res.sent
              ? { ok: `Quote ${design.ss_quote_number} emailed to the customer.` }
              : { err: `Quote email not sent${res && res.reason ? ` — ${res.reason}` : ""}. Print the PDF or copy the customer link instead.` });
          }}
          style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0", cursor: "pointer", opacity: anyBusy ? 0.6 : 1 }}>Resend quote email</button>
      </div>
      {locked && (
        <div style={{ fontSize: 11.5, color: "#94A3B8", marginTop: 8 }}>
          This order is invoiced — its options are frozen. Changes go through a manual change order below.
        </div>
      )}
    </div>
  );
}

function OrderDetail({ row, clientId, onBack, onChanged, stateOf, nameOf, bldgOf, balOf, onOpenDesign = null }) {
  const { o, d } = row;
  const [payOpen, setPayOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("cash");
  const [reference, setReference] = useState("");
  const [when, setWhen] = useState(todayLocal);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [totalDraft, setTotalDraft] = useState(o.total_cents == null ? "" : (o.total_cents / 100).toFixed(2));
  const [editTotal, setEditTotal] = useState(o.total_cents == null);
  const bal = balOf(row); const st = stateOf(row);

  // SS-mode orders (the design carries an SS quote) render the invoice-style order
  // document (migration 127), which needs the FULL design row (the list query stays
  // narrow), the signatures, the change orders, and the order_paperwork projection
  // (letterhead + colors + the service-role-only invoice_sends fields).
  const ssMode = !!(d && d.ss_quote_number);
  const [ssDoc, setSsDoc] = useState(null);
  const [ssReload, setSsReload] = useState(0);
  useEffect(() => {
    if (!ssMode || !o.short_code) return;
    let alive = true;
    (async () => {
      const [dRes, aRes, cRes, pRes] = await Promise.all([
        sb.from("designs")
          .select("short_code, status, accepted_at, ss_quote_number, ss_quote_pdf_url, ss_quote_sent_at, image_url, plan_image_url, view3d_image_url, estimate_lines, selections, paint_colors, contact")
          .eq("client_id", clientId).eq("short_code", o.short_code).maybeSingle(),
        sb.from("design_acceptances")
          .select("subject, signer_name, accepted_at, total")
          .eq("client_id", clientId).eq("short_code", o.short_code),
        sb.from("change_orders")
          .select("id, co_no, source, status, total_after_cents, acknowledged_at")
          .eq("client_id", clientId).eq("short_code", o.short_code),
        sb.functions.invoke("portal-settings", { body: { action: "order_paperwork", shortCode: o.short_code } }),
      ]);
      if (!alive) return;
      setSsDoc({
        design: dRes.data || null,
        acceptances: aRes.data || [],
        cos: cRes.data || [],
        paperwork: (pRes.data && !pRes.data.error) ? pRes.data : null,
      });
    })();
    return () => { alive = false; };
  }, [ssMode, o.short_code, clientId, ssReload]);
  const changedAll = () => { onChanged(); setSsReload((k) => k + 1); };
  // In-portal document viewer (Carolyn 2026-08-25: PDFs open in a popup, not another
  // tab). Browsers render PDFs (and images) natively in an iframe; the viewer's own
  // toolbar carries print/download, and an escape hatch opens the real tab.
  const [pdfView, setPdfView] = useState(null);   // { url, title } | null
  const ssDesign = ssDoc && ssDoc.design;
  const ssAcceptance = ssDoc && (ssDoc.acceptances || []).find((a) => a.subject === "quote");
  const ssInvoice = ssDoc && ssDoc.paperwork && ssDoc.paperwork.invoice;

  const saveTotal = async () => {
    const cents = centsFrom(totalDraft);
    if (!Number.isFinite(cents) || cents <= 0) { setMsg({ err: "Enter a dollar amount, e.g. 9575.00" }); return; }
    setBusy(true); setMsg(null);
    const { error } = await sb.from("orders")
      .update({ total_cents: cents, total_source: "manual", updated_at: new Date().toISOString() }).eq("id", o.id);
    setBusy(false);
    if (error) { setMsg({ err: error.message }); return; }
    setEditTotal(false); onChanged();
  };

  const recordPayment = async () => {
    const cents = centsFrom(amount);
    if (!Number.isFinite(cents) || cents <= 0) { setMsg({ err: "Enter an amount greater than zero." }); return; }
    // The date input can be cleared to "" — new Date("T12:00:00") is Invalid, and
    // .toISOString() on it throws AFTER setBusy(true), wedging the button on
    // "Saving…" for the rest of the mount. Validate it up front like the amount.
    const received = new Date(when + "T12:00:00");
    if (!when || Number.isNaN(received.getTime())) { setMsg({ err: "Pick the date the payment was received." }); return; }
    setBusy(true); setMsg(null);
    let uid = null;
    try { const { data } = await sb.auth.getUser(); uid = data && data.user ? data.user.id : null; } catch (_e) {}
    const { error } = await sb.from("payments").insert({
      client_id: clientId, order_id: o.id, amount_cents: cents, method,
      reference: reference.trim() || null,
      received_at: received.toISOString(),
      created_by: uid,
    });
    setBusy(false);
    if (error) { setMsg({ err: error.message }); return; }
    setPayOpen(false); setAmount(""); setReference(""); setMethod("cash");
    setMsg({ ok: "Payment recorded." });
    onChanged();
  };

  const voidPayment = async (p) => {
    if (!window.confirm(`Void this ${money(p.amount_cents)} payment? It stays in the history, marked voided.`)) return;
    const { error } = await sb.from("payments")
      .update({ voided_at: new Date().toISOString(), void_reason: "voided in portal" }).eq("id", p.id);
    if (error) { setMsg({ err: error.message }); return; }
    onChanged();
  };

  const unvoidPayment = async (p) => {
    const { error } = await sb.from("payments")
      .update({ voided_at: null, void_reason: null }).eq("id", p.id);
    if (error) { setMsg({ err: error.message }); return; }
    onChanged();
  };

  const kv = (k, v) => (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12.5, padding: "6px 0" }}>
      <span style={{ color: "#64748B" }}>{k}</span><span style={{ fontWeight: 700, textAlign: "right" }}>{v}</span>
    </div>
  );

  return (
    <div>
      <button type="button" onClick={onBack}
        style={{ background: "none", border: "none", color: ACCENT, fontSize: 12.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", padding: 0, marginBottom: 12 }}>← All orders</button>
      {msg && msg.err && <div style={S.err}>{msg.err}</div>}
      {msg && msg.ok && <div style={S.okMsg}>{msg.ok}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.5fr) minmax(0,1fr)", gap: 14, alignItems: "start" }} className="ss-order-grid">
        <div>
          {ssMode ? (
            /* The invoice-style order document (migration 127) — letterhead, the priced
               lines with live roof/cladding/paint dropdowns, the amendment trail, and the
               action row. It replaces the old thin header card for SS orders. */
            <OrderDocumentCard clientId={clientId} o={o} st={st} doc={ssDoc}
              busyExt={busy} onMsg={setMsg} onChanged={changedAll} onOpenDesign={onOpenDesign}
              onPreview={(url, title) => setPdfView({ url, title })} />
          ) : (
            <div style={S.card}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 12 }}>
                <div>
                  <div style={S.h2}>Order #{o.order_no} · {nameOf(row)}</div>
                  <div style={{ fontSize: 12, color: "#64748B", marginTop: 3 }}>
                    Ordered {fmtDate(o.ordered_at)} · {bldgOf(row)}
                    {d && d.ghl_estimate_number ? ` · EST-${d.ghl_estimate_number}` : ""}
                  </div>
                </div>
                <span style={{ marginLeft: "auto", background: st.bg, color: st.fg, borderRadius: 20, padding: "4px 12px", fontSize: 11.5, fontWeight: 700, whiteSpace: "nowrap" }}>{st.label}</span>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {d && d.image_url && (
                  <button type="button" onClick={() => setPdfView({ url: d.image_url, title: "Floor plan" })}
                    style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0", cursor: "pointer" }}>View floor plan (PDF)</button>
                )}
                {/* IN-PORTAL designer, never the public ?id= page (capture-lead/draft saves). */}
                {o.short_code && onOpenDesign && (
                  <button type="button" onClick={() => onOpenDesign(o.short_code)}
                    style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0", cursor: "pointer" }}>Open design</button>
                )}
              </div>
            </div>
          )}

          {/* SS-mode orders (the design carries an SS quote) get change orders. CRM-mode
              orders don't — the decision was SS-only (Carolyn 2026-08-23). */}
          {ssMode && o.short_code && (
            <ChangeOrdersCard clientId={clientId} shortCode={o.short_code} orderId={o.id}
              currentTotalCents={o.total_cents} onChanged={changedAll} />
          )}

          <div style={S.card}>
            <div style={{ ...S.h2, marginBottom: 8 }}>Payments</div>
            {row.pays.length === 0 && <p style={{ fontSize: 13, color: "#64748B", padding: "6px 0" }}>Nothing recorded yet.</p>}
            {row.pays.map((p) => {
              const dead = !!p.voided_at;
              return (
                <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderBottom: "1px solid #F1F5F9", fontSize: 12.5, opacity: dead ? 0.65 : 1 }}>
                  <div style={{ width: 26, height: 26, borderRadius: "50%", background: dead ? "#F1F5F9" : "#DCFCE7", color: dead ? "#64748B" : "#166534", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    {dead
                      ? <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
                      : <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>}
                  </div>
                  <div>
                    <b style={{ textDecoration: dead ? "line-through" : "none" }}>{(PAY_METHODS.find((m) => m[0] === p.method) || [, p.method])[1]}</b>
                    {p.gateway === "ghl" && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.5, background: "#EDE9FE", color: "#5B21B6", borderRadius: 5, padding: "2px 6px" }}>Synergy/GHL</span>}
                    {dead && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.5, background: "#F1F5F9", color: "#64748B", borderRadius: 5, padding: "2px 6px" }}>Voided</span>}
                    <div style={{ fontSize: 11, color: "#94A3B8" }}>{fmtDate(p.received_at)}{p.reference ? ` · ${p.reference}` : ""}{dead ? ` · voided ${fmtDate(p.voided_at)}` : ""}</div>
                  </div>
                  <div style={{ marginLeft: "auto", fontWeight: 800, fontVariantNumeric: "tabular-nums", textDecoration: dead ? "line-through" : "none", color: dead ? "#94A3B8" : "#1E293B" }}>{money(p.amount_cents)}</div>
                  {/* Imported payments are read-only here — GHL owns them, and a local
                      void would silently come back (or diverge) on the next sync. */}
                  {p.gateway
                    ? <span title="Recorded in Synergy/GHL — manage it there" style={{ color: "#CBD5E1", fontSize: 12, fontWeight: 700 }}>—</span>
                    : <button type="button" onClick={() => (dead ? unvoidPayment(p) : voidPayment(p))} title={dead ? "Restore this payment" : "Void this payment"}
                        style={{ background: "none", border: "none", color: "#94A3B8", cursor: "pointer", fontSize: 12, fontWeight: 700, fontFamily: "inherit" }}>{dead ? "Restore" : "Void"}</button>}
                </div>
              );
            })}
          </div>
        </div>

        <div>
          <div style={{ background: "linear-gradient(135deg, #3D3672 0%, #1B7895 100%)", color: "#FFF", borderRadius: 12, padding: "16px 18px", marginBottom: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6, color: "#CFE0EC" }}>{bal != null && bal < 0 ? "Credit owed back" : "Balance due"}</div>
            <div style={{ fontSize: 29, fontWeight: 800, margin: "4px 0 2px", fontVariantNumeric: "tabular-nums", letterSpacing: -0.7 }}>
              {bal == null ? "—" : bal < 0 ? `${money(-bal)} credit` : money(bal)}
            </div>
            <div style={{ fontSize: 11.5, color: "#D6E4F0" }}>
              {o.total_cents == null
                ? (ssMode ? "The total arrives when the customer signs the quote" : "Set this order's total to track a balance")
                : `${money(row.paid)} of ${money(o.total_cents)} collected`}
            </div>
            {ssMode && o.total_cents != null && (
              <div style={{ borderTop: "1px solid rgba(255,255,255,0.22)", marginTop: 10, paddingTop: 6 }}>
                {[["Total", money(o.total_cents)], ["Paid", money(row.paid)], ["Balance", bal == null ? "—" : money(bal)]].map(([k, v]) => (
                  <div key={k} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "3px 0", color: "#D6E4F0" }}>
                    <span>{k}</span><span style={{ fontWeight: 700, color: "#FFF", fontVariantNumeric: "tabular-nums" }}>{v}</span>
                  </div>
                ))}
                <div style={{ fontSize: 10.5, color: "#B9CFE0", marginTop: 4, lineHeight: 1.45 }}>
                  Set by the signed quote and acknowledged change orders — no hand editing.
                </div>
              </div>
            )}
            {o.total_cents != null && (
              <button type="button" onClick={() => { setPayOpen(true); setAmount(bal > 0 ? (bal / 100).toFixed(2) : ""); }}
                style={{ ...S.btn("#75E6DA", "#22345B"), marginTop: 13 }}>Record a payment</button>
            )}
          </div>

          {/* SS orders derive their total (accept → CO acks → invoice); the hand-typed
              editor stays ONLY for design-less manual orders (Carolyn 2026-08-24). */}
          {!ssMode && (
            <div style={S.card}>
              <div style={{ ...S.h2, marginBottom: 8 }}>Order total</div>
              {editTotal ? (
                <>
                  <span style={S.lbl}>Total (from your estimate)</span>
                  <input style={S.input} value={totalDraft} onChange={(e) => setTotalDraft(e.target.value)} placeholder="9575.00" />
                  <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                    <button onClick={saveTotal} disabled={busy} style={{ ...S.btn(ACCENT, "#FFF"), opacity: busy ? 0.6 : 1 }}>{busy ? "Saving…" : "Save total"}</button>
                    {o.total_cents != null && <button onClick={() => { setEditTotal(false); setTotalDraft((o.total_cents / 100).toFixed(2)); }} style={S.btn("#F1F5F9", "#334155")}>Cancel</button>}
                  </div>
                  <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 8, lineHeight: 1.5 }}>
                    Totals fill in automatically from the accepted estimate. Type one here if it hasn't come through yet — your number always wins.
                  </div>
                </>
              ) : (
                <>
                  {kv("Total", money(o.total_cents))}
                  {kv("Paid", money(row.paid))}
                  {kv("Balance", bal == null ? "—" : money(bal))}
                  <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 6 }}>
                    {o.total_source === "ghl" ? "From the accepted estimate" : o.total_source === "manual" ? "Entered by you" : "Not set yet"}
                    {" · "}<button type="button" onClick={() => setEditTotal(true)} style={{ background: "none", border: "none", color: ACCENT, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", fontSize: 11, padding: 0 }}>Edit</button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Floor plan + 3D as IMAGES, side by side in one card (Carolyn 2026-08-25).
              Thumbnails, not posters: capped height, natural aspect; the click opens the
              full-size plan/picture. Saved by the designer on every submit; older designs
              without one fall back to the plan PDF link. */}
          {ssMode && ssDesign && (
            <div style={{ ...S.card, padding: 12 }}>
              <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 10 }}>
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0 2px 6px" }}>
                    <span style={{ fontSize: 10.5, fontWeight: 700, color: "#94A3B8", letterSpacing: 0.5, textTransform: "uppercase" }}>Floor plan</span>
                    {ssDesign.image_url && (
                      <button type="button" onClick={() => setPdfView({ url: ssDesign.image_url, title: "Floor plan" })}
                        style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: 10.5, color: ACCENT, fontWeight: 700, fontFamily: "inherit" }}>Full ↗</button>
                    )}
                  </div>
                  {/* Both frames match at 280 tall (Carolyn 2026-08-25); clicks open the
                      in-portal viewer popup, never another tab. */}
                  {ssDesign.plan_image_url
                    ? <button type="button" title="Open the full plan"
                        onClick={() => setPdfView({ url: ssDesign.image_url || ssDesign.plan_image_url, title: "Floor plan" })}
                        style={{ display: "flex", alignItems: "center", justifyContent: "center", background: "#FFF", border: "1px solid #E2E8F0", borderRadius: 8, padding: 5, height: 280, width: "100%", cursor: "pointer" }}>
                        <img src={ssDesign.plan_image_url} alt="Floor plan"
                          style={{ maxHeight: 268, maxWidth: "100%", width: "auto", display: "block" }} />
                      </button>
                    : <div style={{ display: "flex", alignItems: "center", background: "#F8FAFC", border: "1px dashed #E2E8F0", borderRadius: 8, padding: 8, height: 280 }}>
                        <p style={{ fontSize: 11, color: "#94A3B8", lineHeight: 1.45 }}>Appears after the next quote submit{ssDesign.image_url ? " — the PDF has it today" : ""}.</p>
                      </div>}
                </div>
                <div>
                  <div style={{ padding: "0 2px 6px" }}>
                    <span style={{ fontSize: 10.5, fontWeight: 700, color: "#94A3B8", letterSpacing: 0.5, textTransform: "uppercase" }}>3D view</span>
                  </div>
                  {ssDesign.view3d_image_url
                    ? <button type="button" title="Open the 3D picture"
                        onClick={() => setPdfView({ url: ssDesign.view3d_image_url, title: "3D view" })}
                        style={{ display: "flex", alignItems: "center", justifyContent: "center", background: "#FFF", border: "1px solid #E2E8F0", borderRadius: 8, padding: 5, height: 280, width: "100%", cursor: "pointer" }}>
                        <img src={ssDesign.view3d_image_url} alt="3D view"
                          style={{ maxHeight: 268, maxWidth: "100%", width: "auto", display: "block" }} />
                      </button>
                    : <div style={{ display: "flex", alignItems: "center", background: "#F8FAFC", border: "1px dashed #E2E8F0", borderRadius: 8, padding: 8, height: 280 }}>
                        <p style={{ fontSize: 11, color: "#94A3B8", lineHeight: 1.45 }}>Open the design, click 🧊 3D View, then resubmit to capture one.</p>
                      </div>}
                </div>
              </div>
            </div>
          )}

          <div style={S.card}>
            <div style={{ ...S.h2, marginBottom: 8 }}>Customer</div>
            {kv("Name", nameOf(row))}
            {kv("Phone", (d && d.contact && d.contact.phone) || "—")}
            {kv("Email", (d && d.contact && d.contact.email) || "—")}
            {ssMode && ssDesign && ssDesign.contact && (() => {
              const c = ssDesign.contact || {};
              const line2 = [c.city, c.state].filter(Boolean).join(", ") + (c.zip ? ` ${c.zip}` : "");
              const addr = [c.street, line2].filter((s) => s && String(s).trim()).join(", ");
              return (
                <>
                  {kv("Address", addr || "—")}
                  {ssAcceptance && kv("Signed", `${fmtDate(ssAcceptance.accepted_at)} · ${ssAcceptance.signer_name || ""}`)}
                  {addr && (
                    <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr)}`} target="_blank" rel="noopener"
                      style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0", textDecoration: "none", display: "block", textAlign: "center", marginTop: 8, fontSize: 12 }}>
                      📍 View property
                    </a>
                  )}
                </>
              );
            })()}
          </div>

          {ssMode && ssDesign && (
            <div style={S.card}>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: "#94A3B8", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 6 }}>Paper trail</div>
              {kv("Quote", `${ssDesign.ss_quote_number}${ssDesign.ss_quote_sent_at ? ` · sent ${fmtDate(ssDesign.ss_quote_sent_at)}` : " · not emailed"}`)}
              {kv("Signed", ssAcceptance ? fmtDate(ssAcceptance.accepted_at) : "not yet")}
              {kv("Change orders", (() => {
                const cs = (ssDoc && ssDoc.cos) || [];
                const acked = cs.filter((c) => c.status === "acknowledged").length;
                const pend = cs.filter((c) => c.status === "pending_ack").length;
                if (!cs.length) return "none";
                return `${acked} acknowledged${pend ? ` · ${pend} pending` : ""}`;
              })())}
              {kv("Invoice", ssInvoice && ssInvoice.invoice_number
                ? `${ssInvoice.invoice_number} · ${fmtDate(ssInvoice.updated_at || ssInvoice.created_at)}`
                : "not yet issued")}
            </div>
          )}
        </div>
      </div>

      {pdfView && (
        <div onClick={(e) => { if (e.target === e.currentTarget) setPdfView(null); }}
          style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 1200 }}>
          <div style={{ background: "#FFF", borderRadius: 14, width: "min(900px, 96vw)", height: "min(88vh, 1100px)", boxShadow: "0 24px 60px rgba(0,0,0,0.3)", overflow: "hidden", display: "flex", flexDirection: "column" }}>
            <div style={{ background: ACCENT, color: "#FFF", padding: "12px 16px", display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
              <div style={{ fontSize: 14.5, fontWeight: 800 }}>{pdfView.title}</div>
              <a href={pdfView.url} target="_blank" rel="noopener"
                style={{ marginLeft: "auto", color: "#CFE0EC", fontSize: 12, fontWeight: 700, textDecoration: "none" }}>Open in tab ↗</a>
              <button type="button" onClick={() => setPdfView(null)}
                style={{ background: "rgba(255,255,255,0.16)", border: "none", color: "#FFF", width: 26, height: 26, borderRadius: 7, cursor: "pointer", fontSize: 15, fontFamily: "inherit", lineHeight: 1 }}>×</button>
            </div>
            {/* The browser's own viewer: its toolbar carries print + download. */}
            <iframe src={pdfView.url} title={pdfView.title} style={{ flex: 1, width: "100%", border: "none", background: "#525659" }} />
          </div>
        </div>
      )}

      {payOpen && (
        <div onClick={(e) => { if (e.target === e.currentTarget) setPayOpen(false); }}
          style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.5)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, zIndex: 1200 }}>
          <div style={{ background: "#FFF", borderRadius: 14, maxWidth: 430, width: "100%", boxShadow: "0 24px 60px rgba(0,0,0,0.3)", overflow: "hidden" }}>
            <div style={{ background: ACCENT, color: "#FFF", padding: "15px 18px", display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ fontSize: 15.5, fontWeight: 800 }}>Record a payment</div>
              <button type="button" onClick={() => setPayOpen(false)}
                style={{ marginLeft: "auto", background: "rgba(255,255,255,0.16)", border: "none", color: "#FFF", width: 26, height: 26, borderRadius: 7, cursor: "pointer", fontSize: 15, fontFamily: "inherit", lineHeight: 1 }}>×</button>
            </div>
            <div style={{ padding: "17px 18px" }}>
              <span style={S.lbl}>Amount</span>
              <input style={{ ...S.input, fontSize: 20, fontWeight: 800 }} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" autoFocus />
              {bal > 0 && (
                <div style={{ display: "flex", gap: 6, marginTop: 7 }}>
                  <button type="button" onClick={() => setAmount((bal / 100).toFixed(2))} style={{ ...S.btn("#F1F5F9", "#334155"), padding: "4px 10px", fontSize: 11, border: "1px solid #E2E8F0" }}>Full balance</button>
                  <button type="button" onClick={() => setAmount((Math.round(bal / 2) / 100).toFixed(2))} style={{ ...S.btn("#F1F5F9", "#334155"), padding: "4px 10px", fontSize: 11, border: "1px solid #E2E8F0" }}>Half</button>
                </div>
              )}
              <div style={{ marginTop: 13 }}><span style={S.lbl}>Method</span>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {PAY_METHODS.map(([id, label]) => (
                    <button key={id} type="button" onClick={() => setMethod(id)}
                      style={{ flex: "1 1 auto", background: method === id ? "#EDE9FE" : "#F8FAFC", border: `1.5px solid ${method === id ? ACCENT : "#E2E8F0"}`, color: method === id ? ACCENT : "#475569", fontSize: 12, fontWeight: 700, borderRadius: 8, padding: "9px 6px", cursor: "pointer", fontFamily: "inherit" }}>{label}</button>
                  ))}
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 13 }}>
                <div><span style={S.lbl}>Received on</span><input type="date" style={S.input} value={when} onChange={(e) => setWhen(e.target.value)} /></div>
                <div><span style={S.lbl}>Reference</span><input style={S.input} value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Check # / note" /></div>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "flex-start", background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 8, padding: "9px 11px", fontSize: 11.5, color: "#475569", lineHeight: 1.45, marginTop: 12 }}>
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="#64748B" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}><circle cx="12" cy="12" r="9"/><path d="M12 8v5l3 2"/></svg>
                <div>You're recording money you already collected — no card is charged here. Taking cards in the portal is coming next.</div>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 15 }}>
                <button onClick={recordPayment} disabled={busy} style={{ ...S.btn("#059669", "#FFF"), flex: 1, opacity: busy ? 0.6 : 1 }}>{busy ? "Saving…" : "Record payment"}</button>
                <button onClick={() => setPayOpen(false)} style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0" }}>Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


// ─── Inventory tab (migration 075) ───
// One row per PHYSICAL building on a sales lot. The master design behind a unit is a
// designs row with status='inventory' (excluded from Designs/Contacts and from the GHL
// sync). All reads/writes go through portal-settings, so operator view-as works via the
// sb.functions targetClientId injection and writes get the server-side can_write gate.
const invMoney = (cents) => cents == null ? "—" :
  "$" + (cents / 100).toLocaleString(undefined, { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 });
// Estimate statuses that mean a customer has committed. Still used to spot which of a
// building's estimates is the buyer, and to warn on the others — but NOT to decide sold-ness
// any more: that is stored now (see invSold above the fold).
const INV_SOLD_EST = new Set(["accepted", "invoiced", "delivered"]);
function InventoryTable({
  clientId, refreshKey = 0, isAdmin = false,
  onOpenDesign = null, onSendEstimate = null, onNew = null, onQuoteNewBuild = null,
}) {
  // A STATUS VIEW, deliberately (Carolyn 2026-08-08): "NO SCHEDULING EVER HAPPENS FROM THE
  // INVENTORY PAGE. It should only state the status." The build status follows the Build and
  // Delivery schedules; the sale follows the customer's invoice (or a recorded payment). The
  // first build of this page had Queue build / Add to a load / Mark sold buttons here — every
  // one of them was a second place to do something that already had a home, and the sell
  // button let a building be sold with no invoice behind it. The one write left on this page
  // is the admin-only Release under a SOLD chip, because a sale correction IS a status
  // change and there is no invoice-void anywhere in this product to do it for us.
  const [rows, setRows] = useState(null);      // null = loading
  const [locations, setLocations] = useState([]);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState("");
  // One filter object rather than three loose states, so "no contradictory combination is
  // reachable" is enforceable in one place (see setBucket / setStage below).
  const [filt, setFilt] = useState({ bucket: "all", stage: "all", sale: "any" });
  const [locFilter, setLocFilter] = useState("all");
  const [expanded, setExpanded] = useState({});  // unit id -> estimates drawer open
  const [busyId, setBusyId] = useState(null);
  const [msg, setMsg] = useState(null);          // { ok } | { err }

  const load = useCallback(async () => {
    setError(null);
    const { data, error: err } = await sb.functions.invoke("portal-settings", { body: { action: "list_inventory" } });
    if (err || !data || data.error) {
      setError((data && data.error) || (err ? await fnError(err) : "Could not load inventory."));
      setRows([]); return;
    }
    const units = data.units || [];
    setRows(units);
    setLocations(data.locations || []);
    // list_inventory reports each estimate's CACHED designs.status, and nothing else on this
    // tab talks to GHL. sync-design-status is ALSO the safety-net sale path: an invoice the
    // tenant raised directly in GoHighLevel (or a GHL "paid") is what it notices and records.
    // So this re-loads afterwards rather than patching statuses locally — a sale it just
    // persisted, the buyer's name and the recomputed stage all have to come from the server
    // to agree. Additive: any failure just leaves what we already rendered.
    const codes = units.flatMap((u) => (u.estimates || []).map((e) => e.shortCode)).filter(Boolean);
    if (codes.length) {
      try {
        const { data: sync } = await sb.functions.invoke("sync-design-status", { body: { shortCodes: codes } });
        if (sync && sync.statuses) {
          const { data: fresh } = await sb.functions.invoke("portal-settings", { body: { action: "list_inventory" } });
          if (fresh && fresh.units) { setRows(fresh.units); setLocations(fresh.locations || []); }
        }
      } catch (_e) { /* what we already rendered stands */ }
    }
  }, [clientId]);
  useEffect(() => { load(); }, [load, refreshKey]);

  // Three semantic buckets. A rep's real questions are "what can I sell today", "what's
  // coming", "what's spoken for" — the full-stage detail lives one control away.
  const bucketOf = (u) => invSold(u) ? "sold" : (invSellable(u) ? "sellable" : "production");
  const counts = (rows || []).reduce((a, u) => {
    a[bucketOf(u)] = (a[bucketOf(u)] || 0) + 1;
    a.stage[invStage(u)] = (a.stage[invStage(u)] || 0) + 1;
    return a;
  }, { stage: {} });
  const anyFilterOn = filt.bucket !== "all" || filt.stage !== "all" || filt.sale !== "any"
    || locFilter !== "all" || !!query.trim();
  const clearFilters = () => { setFilt({ bucket: "all", stage: "all", sale: "any" }); setLocFilter("all"); setQuery(""); };
  // Picking a stage clears the bucket and vice versa: they are two views of the same axis, so
  // holding both at once is how you get an empty table that looks like a bug.
  const setBucket = (b) => setFilt((f) => ({ ...f, bucket: b, stage: "all" }));
  const setStage = (s) => setFilt((f) => ({ ...f, stage: s, bucket: "all" }));

  const filtered = (rows || []).filter((u) => {
    if (filt.bucket !== "all" && bucketOf(u) !== filt.bucket) return false;
    if (filt.stage !== "all" && invStage(u) !== filt.stage) return false;
    if (filt.sale === "for_sale" && invSold(u)) return false;
    if (filt.sale === "sold" && !invSold(u)) return false;
    if (locFilter !== "all" && String(u.locationId || "") !== locFilter) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    const hay = ["#" + u.serial, String(u.serial), titleCase(u.style || ""), u.size || "", u.locationName || "",
      u.roofType || "", u.roofColor || "", u.bodyColor || "", u.trimColor || "", u.soldFirstName || "",
      ...(u.estimates || []).map((e) => (e.name || "") + " " + (e.estimateNumber ? "EST-" + e.estimateNumber : ""))].join(" ").toLowerCase();
    return hay.includes(q);
  });

  const invoke = async (body, okMsg) => {
    const { data, error: err } = await sb.functions.invoke("portal-settings", { body });
    if (err || !data || data.error) {
      setMsg({ err: (data && data.error) || (err ? await fnError(err) : "That didn't save.") });
      return false;
    }
    if (okMsg) setMsg({ ok: okMsg });
    return data;
  };
  // The one correction path for a sale. It exists because there is NO invoice-void anywhere
  // in this product — a CRM-side void is invisible to us — so without it one mis-clicked
  // invoice would take a building out of sellable stock permanently. The server records which
  // design it was released from and refuses to auto-re-sell from that same design; a new
  // estimate can still sell the building, which is the real re-sale case anyway.
  const release = async (u) => {
    const reason = window.prompt(
      `Put building #${u.serial} back on the market?\n\n`
      + `This does NOT void or change the invoice in your CRM — there is no way to do that from `
      + `here. It only makes the building available to quote again.\n\nWhy is it being released?`);
    if (reason === null) return;                      // cancelled
    if (!reason.trim()) { setMsg({ err: "Releasing a sold building needs a reason." }); return; }
    setBusyId(u.id); setMsg(null);
    await invoke({ action: "unsell_inventory", unitId: u.id, reason: reason.trim() },
      `#${u.serial} is available again.`);
    setBusyId(null); load();
  };
  const del = async (u) => {
    if (!window.confirm(`Delete building #${u.serial}? Its floor plan and version history are removed. Estimates already sent to customers are kept (they just lose the Inventory label).`)) return;
    setBusyId(u.id); setMsg(null);
    // ONE call: delete_inventory removes the unit AND its master design (row, versions,
    // PDFs) server-side. Two calls meant a failed/abandoned second request stranded an
    // invisible orphan master that no screen could ever list or clean up.
    const r = await invoke({ action: "delete_inventory", unitId: u.id });
    if (r) {
      setMsg(r.masterDeleted === false
        ? { err: `Building #${u.serial} was removed from inventory, but its saved floor plan could not be deleted — support has been notified.` }
        : { ok: `Building #${u.serial} deleted.` });
    }
    setBusyId(null); load();
  };

  // ALWAYS rendered, even at zero. The old version hid a chip whose count was 0 while the
  // filter stayed applied — so clearing the last sold building while filtered to Sold made the
  // chip vanish and left the table stuck on "No buildings match" with no control to undo it.
  // These are fixed categories, not data-derived keys: a zero on "For sale" is real
  // information about the lot, not a dead feature.
  const chip = (k, label, n, on) => (
    <button key={k} type="button" aria-pressed={on} onClick={() => setBucket(k)}
      style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer", fontFamily: "inherit",
        fontSize: 12, fontWeight: 700, borderRadius: 16, padding: "5px 12px",
        background: on ? "#1E293B" : "#FFF", color: on ? "#FFF" : "#475569",
        border: `1px solid ${on ? "#1E293B" : "#E2E8F0"}` }}>
      {label}<span style={{ fontSize: 10.5, opacity: 0.75 }}>{n}</span>
    </button>
  );
  const selStyle = { fontSize: 12, fontWeight: 700, color: "#334155", border: "1px solid #E2E8F0",
    background: "#FFF", borderRadius: 9, padding: "6px 10px" };
  const linkBtn = (extra) => ({ background: "none", border: "none", padding: 0, cursor: "pointer",
    fontFamily: "inherit", fontSize: "inherit", fontWeight: 700, marginRight: 10, ...extra });
  const tag = { background: "#DBEAFF", color: "#3D3672", borderRadius: 12, fontSize: 10.5, fontWeight: 800, padding: "2px 9px", whiteSpace: "nowrap" };

  // ── The Status cell: the ENTIRE state of a building, and the page's whole job ───────
  // One lifecycle chip (pure projection of the Build/Delivery schedules — there is no
  // hand-set value to annotate any more), a SOLD — Dave chip when an invoice or payment has
  // claimed it, and — admin only — the Release link under it. Nothing on this page writes to
  // any schedule, so this cell can never disagree with the boards: it is the same facts.
  const statusCell = (u) => {
    const meta = invStageMeta(u);
    const c = INV_GROUP_COLORS[meta.group];
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <span title={INV_STAGE_LONG[invStage(u)]}
            style={{ background: c.bg, color: c.fg, borderRadius: 20, padding: "4px 12px",
              fontSize: 12, fontWeight: 700, whiteSpace: "nowrap" }}>
            {meta.label}
          </span>
          {invSold(u) && (
            <span title={u.soldAt ? "Sold " + fmtDate(u.soldAt) : undefined}
              style={{ background: INV_SALE_COLORS.bg, color: INV_SALE_COLORS.fg, borderRadius: 14,
              padding: "3px 9px", fontSize: 10.5, fontWeight: 800, letterSpacing: 0.4, whiteSpace: "nowrap" }}>
              {invSoldLabel(u)}
            </span>
          )}
        </div>
        {invSold(u) && isAdmin && (
          <button type="button" disabled={busyId === u.id} onClick={() => release(u)}
            title="Put this building back on the market. Does not touch the invoice in your CRM."
            style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit",
              fontSize: 11, fontWeight: 700, color: "#94A3B8", textAlign: "left" }}>
            Release
          </button>
        )}
      </div>
    );
  };

  return (
    <div style={S.card}>
      {/* `count` follows the DesignsTable precedent: it must agree with the table, and the
          `rows ?` guard kills the phantom 0 that used to render during load. */}
      <CardHead title="Inventory"
        count={rows ? (anyFilterOn ? `${filtered.length} of ${rows.length}` : rows.length) : null}
        right={<>
          <button type="button" onClick={load} style={S.btn("#F1F5F9", "#334155")}>↻ Refresh</button>
          {onNew && <button type="button" onClick={onNew} style={S.btn(ACCENT, "#FFF")}>+ New building request</button>}
        </>} />
      <input value={query} onChange={(e) => setQuery(e.target.value)}
        placeholder="Search inventory — serial #, building, location, customer…"
        style={{ ...S.input, width: "100%", boxSizing: "border-box", marginBottom: 11 }} />
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 13, alignItems: "center" }}>
        {chip("all", "All", (rows || []).length, filt.bucket === "all" && filt.stage === "all")}
        {chip("sellable", "For sale", counts.sellable || 0, filt.bucket === "sellable")}
        {chip("production", "In production", counts.production || 0, filt.bucket === "production")}
        {chip("sold", "Sold", counts.sold || 0, filt.bucket === "sold")}
        {/* The full-stage detail, one control away from the buckets. A zero-count stage
            renders disabled rather than disappearing — "none right now" is information. */}
        <select value={filt.stage} onChange={(e) => setStage(e.target.value)} style={selStyle}>
          <option value="all">All stages</option>
          {Object.keys(INV_STAGES).map((k) => (
            <option key={k} value={k} disabled={!(counts.stage[k] || 0)}>
              {INV_STAGE_LONG[k]}{counts.stage[k] ? ` (${counts.stage[k]})` : ""}
            </option>
          ))}
        </select>
        <select value={filt.sale} onChange={(e) => setFilt((f) => ({ ...f, sale: e.target.value }))} style={selStyle}>
          <option value="any">Sold or not</option>
          <option value="for_sale">Not sold</option>
          <option value="sold">Sold</option>
        </select>
        {anyFilterOn && (
          <button type="button" onClick={clearFilters}
            style={{ ...linkBtn({ color: "#64748B", fontSize: 12 }), marginRight: 0 }}>Clear filters</button>
        )}
        {locations.length > 0 && (
          <select value={locFilter} onChange={(e) => setLocFilter(e.target.value)}
            style={{ ...selStyle, marginLeft: "auto" }}>
            <option value="all">📍 All locations</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        )}
      </div>
      {msg && msg.ok && <div style={{ background: "#F0FDF4", border: "1px solid #BBF7D0", color: "#15803D", borderRadius: 8, padding: "8px 12px", fontSize: 13, fontWeight: 600, marginBottom: 10 }}>{msg.ok}</div>}
      {msg && msg.err && <div style={{ ...S.err, marginBottom: 10 }}>{msg.err}</div>}
      {error && <div style={S.err}>{error}</div>}
      {rows === null && <p style={{ fontSize: 13, color: "#64748B", padding: 12 }}>Loading…</p>}
      {rows && rows.length === 0 && !error && (
        <p style={{ fontSize: 13, color: "#64748B", padding: 12 }}>
          Nothing on the lot yet. Design a building in the <strong>Designer</strong> tab and click <strong>Request this build</strong> — it takes the next serial number automatically and lands here. Put it on the <strong>Build Schedule</strong> when you're ready to make it.
        </p>
      )}
      {rows && rows.length > 0 && filtered.length === 0 && (
        <p style={{ fontSize: 13, color: "#64748B", padding: 12 }}>
          No buildings match{query ? <> “{query}”</> : null}.{" "}
          <button type="button" onClick={clearFilters} style={{ ...linkBtn({ color: ACCENT }), marginRight: 0 }}>Clear filters</button>
        </p>
      )}
      {rows && filtered.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              {["Serial #", "Building", "Roof", "Colors", "Location", "Asking price", "Estimates", "Added", "Status", "Actions"].map((h) => (
                <th key={h} style={S.th}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {filtered.map((u) => {
                const sold = invSold(u);
                const ests = u.estimates || [];
                const isOpen = !!expanded[u.id];
                // The buyer is a RECORDED fact — the design the invoice (or payment) named —
                // never a guess from estimate ordering.
                const winner = ests.find((e) => e.shortCode === u.soldDesignShortCode);
                return (
                  <React.Fragment key={u.id}>
                    <tr>
                      <td style={{ ...S.td, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>#{u.serial}</td>
                      <td style={S.td}><strong>{[titleCase(u.style || ""), u.size].filter(Boolean).join(" ") || "—"}</strong></td>
                      <td style={S.td}>{u.roofType ? <>{u.roofType}{u.roofColor ? <span style={{ color: "#94A3B8" }}> · {u.roofColor}</span> : null}</> : <span style={{ color: "#94A3B8" }}>—</span>}</td>
                      <td style={S.td}>{(u.bodyColor || u.trimColor) ? <>{u.bodyColor || "—"}<span style={{ color: "#94A3B8" }}> / {u.trimColor || "—"}</span></> : <span style={{ color: "#94A3B8" }}>—</span>}</td>
                      <td style={S.td}>{u.locationName ? <>{u.locationName}{u.locationCity ? <span style={{ color: "#94A3B8" }}> · {u.locationCity}</span> : null}</> : <span style={{ color: "#94A3B8" }}>—</span>}</td>
                      <td style={S.td}><strong>{invMoney(u.askingPriceCents)}</strong></td>
                      <td style={S.td}>
                        {ests.length === 0 ? <span style={{ color: "#94A3B8" }}>—</span> : (
                          <button type="button" onClick={() => setExpanded((x) => ({ ...x, [u.id]: !x[u.id] }))}
                            style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit", fontSize: "inherit", color: ACCENT, fontWeight: 700 }}>
                            {ests.length} {ests.length === 1 ? "estimate" : "estimates"} {isOpen ? "▾" : "▸"}
                          </button>
                        )}
                      </td>
                      <td style={{ ...S.td, whiteSpace: "nowrap", color: "#64748B" }}>{fmtDate(u.createdAt)}</td>
                      <td style={S.td}>{statusCell(u)}</td>
                      <td style={{ ...S.td, whiteSpace: "nowrap" }}>
                        {/* Open the building's own design. Sell it by sending an estimate and
                            invoicing that estimate — the sale records itself. Nothing here
                            touches the Build or Delivery schedules. */}
                        <button type="button" disabled={busyId === u.id}
                          onClick={() => onOpenDesign && onOpenDesign(u.shortCode, null, { unit: { unitId: u.id, askingPriceCents: u.askingPriceCents, locationId: u.locationId, lifecycle: u.lifecycle } })}
                          style={linkBtn({ color: ACCENT })}>Open</button>
                        {/* Sold ⇒ not sellable, at EVERY stage. Hiding this is a courtesy;
                            link_design_to_unit refuses the link server-side, because anyone
                            can call that endpoint directly with a valid session. */}
                        {!sold && (
                          <button type="button" disabled={busyId === u.id}
                            onClick={() => onSendEstimate && onSendEstimate(u)}
                            style={linkBtn({ color: ACCENT })}>Send estimate</button>
                        )}
                        {u.imageUrl && ssSafeUrl(u.imageUrl) && <a href={u.imageUrl} target="_blank" rel="noopener" style={{ color: "#334155", fontWeight: 700, textDecoration: "none", marginRight: 10 }}>PDF</a>}
                        {isAdmin && <button type="button" disabled={busyId === u.id} onClick={() => del(u)}
                          style={linkBtn({ color: "#CBD5E1", marginRight: 0 })}>Delete</button>}
                      </td>
                    </tr>
                    {isOpen && ests.length > 0 && (
                      <tr><td colSpan={10} style={{ padding: "2px 8px 12px" }}>
                        <div style={{ background: "#F8FAFC", border: "1px solid #EDF1F6", borderRadius: 10, padding: "12px 14px" }}>
                          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.5, color: "#94A3B8", textTransform: "uppercase", marginBottom: 9 }}>
                            Estimates on building #{u.serial}
                          </div>
                          {ests.map((e) => {
                            const es = normStatus(e.status);
                            const c = STATUS_COLORS[es] || STATUS_COLORS.sent;
                            const isWinner = winner && winner.shortCode === e.shortCode;
                            return (
                              <div key={e.shortCode} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", fontSize: 13, flexWrap: "wrap" }}>
                                <span style={tag}>Inventory</span>
                                <strong>{e.name || "—"}</strong>
                                <span style={{ color: "#94A3B8", fontSize: 12 }}>{e.estimateNumber ? `EST-${e.estimateNumber} · ` : ""}{fmtDate(e.createdAt)}</span>
                                <span style={{ background: c.bg, color: c.fg, borderRadius: 14, padding: "2.5px 10px", fontSize: 11, fontWeight: 700 }}>
                                  {STATUS_LABELS[es]}{isWinner ? " — buyer" : ""}
                                </span>
                                {/* The customer who lost the building is the one worth saving,
                                    so the prompt carries the action: it reopens their design in
                                    the Designer untied from this unit, so the next submit is a
                                    fresh build for them. */}
                                {sold && !isWinner && (
                                  <>
                                    <span style={{ background: "#FEF3C7", color: "#92400E", borderRadius: 12, fontSize: 11, fontWeight: 700, padding: "3px 10px" }}>⚠ Building sold</span>
                                    {onQuoteNewBuild && (
                                      <button type="button" onClick={() => onQuoteNewBuild(e)}
                                        style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit", fontSize: 12, color: ACCENT, fontWeight: 700 }}>
                                        Quote a new build for this customer →
                                      </button>
                                    )}
                                  </>
                                )}
                                <button type="button" onClick={() => onOpenDesign && onOpenDesign(e.shortCode, null, null)}
                                  style={{ marginLeft: "auto", background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit", fontSize: "inherit", color: ACCENT, fontWeight: 700 }}>Open</button>
                              </div>
                            );
                          })}
                        </div>
                      </td></tr>
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

