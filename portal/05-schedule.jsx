// ─── Build Schedule tab (SCHEDULING_SCOPE.md Phase 2) ───
// Kanban of tenant-custom stages over build_jobs, plus a table view and the unscheduled
// tray. ALL reads/writes go through portal-schedule (service role): operator view-as works
// via the sb.functions targetClientId injection; crew ("user" role) may move cards and add
// notes (STAFF actions server-side), everything else is owner/admin. Stage KIND
// (queue/active/done) drives every derived state — never the stage's editable name.
//
// ⚠️ OPERATOR-ONLY until the schedule_builds billing flip (Phase 5): tenants keep the
// ComingSoon teaser (see the render site), so the automatic Monday beta→main promotion
// cannot leak a paid feature early. The launch flip is ONE condition at the render site.
const SCHED_SRC_CHIP = {
  order:     { bg: "#EEF2FF", fg: "#3D3672", label: "Order" },
  inventory: { bg: "#ECFEFF", fg: "#0E7490", label: "Inventory" },
  repair:    { bg: "#FDF2F8", fg: "#BE185D", label: "Repair" },
  manual:    { bg: "#F1F5F9", fg: "#475569", label: "Manual" },
};
const schedChip = (bg, fg) => ({ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10.5, fontWeight: 800, borderRadius: 999, padding: "3px 9px", whiteSpace: "nowrap", background: bg, color: fg });
const schedInitials = (name) => String(name || "").trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase() || "?";
// ONE build date per job (Carolyn 2026-08-04): due_date is canonical (every cross-check —
// past due, delivery conflicts, the pool — already keys on it); scheduled_start is kept
// equal for compatibility. Older rows that only set a start date still read correctly.
const schedBuildDate = (job) => job.due_date || job.scheduled_start || null;
// Date-ONLY strings (YYYY-MM-DD — the shape every build/load date here takes) parse as
// UTC midnight through bare new Date(), so they render and compare a DAY EARLY in every
// US timezone (audit 2026-08-20). The constraint: parse a date-only string as LOCAL
// midnight, and build a day key / "today" from LOCAL components — never toISOString().
const schedLocalDate = (iso) => (iso ? new Date(String(iso).slice(0, 10) + "T00:00:00") : null);
const schedLocalIso = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
// Past due = has a build date, that date is before today, and the stage isn't finished.
const schedPastDue = (job, kind) => {
  const d = schedBuildDate(job);
  if (!d || kind === "done") return false;
  return d < schedLocalIso(new Date());
};
const schedDims = (j) => (j.width_ft && j.length_ft) ? `${Number(j.width_ft)}×${Number(j.length_ft)}` : "—";

// The read side of schedule_activity. The edge function has written a row on every move,
// note and completion since day one, and NOTHING displayed them — so "Add note", which is
// the one write a crew member has always been able to make, wrote to a table no screen
// read. Rendered inline as a compact line (SCHEDULING_SCOPE.md: "no popouts"), lazily —
// one fetch when a card is expanded, not one per card on the board.
const SCHED_ACT_VERB = {
  created: "added", moved: "moved", updated: "edited", noted: "note", completed: "marked built",
  deleted: "removed", loaded: "put on a load", unloaded: "taken off a load",
  out: "sent out", delivered: "delivered", override: "override",
};
function SchedJobHistory({ jobId, refreshKey = 0 }) {
  const [rows, setRows] = useState(null);   // null = loading, [] = none
  const [err, setErr] = useState(null);
  useEffect(() => {
    let dead = false;
    (async () => {
      const { data, error } = await sb.functions.invoke("portal-schedule", { body: { action: "job_activity", jobId } });
      if (dead) return;
      if (error || !data || data.error) { setErr((data && data.error) || "Could not load the history."); setRows([]); return; }
      setErr(null); setRows(data.activity || []);
    })();
    return () => { dead = true; };
  }, [jobId, refreshKey]);
  if (rows === null) return <div style={{ fontSize: 11, color: "#94A3B8", fontWeight: 600, marginTop: 8 }}>Loading history…</div>;
  if (err) return <div style={{ fontSize: 11, color: "#94A3B8", fontWeight: 600, marginTop: 8 }}>{err}</div>;
  if (!rows.length) return null;
  return (
    <div style={{ marginTop: 9, borderTop: "1px solid #F1F5F9", paddingTop: 8 }}>
      <span style={{ ...S.lbl, marginBottom: 4, color: "#94A3B8" }}>History</span>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {rows.map((a) => (
          <div key={a.id} style={{ fontSize: 11, color: "#64748B", fontWeight: 600, lineHeight: 1.45 }}>
            <span style={{ color: "#334155", fontWeight: 800 }}>{a.userName || "Someone"}</span>
            {" "}{SCHED_ACT_VERB[a.action] || a.action}
            {a.action === "moved" && a.toStage ? <> to <strong>{a.toStage}</strong></> : null}
            {a.detail ? <span style={{ color: "#475569" }}> — {a.detail}</span> : null}
            <span style={{ color: "#B9C4D6" }}> · {fmtDate(a.createdAt)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Inline editor rendered INSIDE the expanded card/row — job info stays at face value,
// never in a popout (scope decision 6).
//
// `canEdit` = build_schedule:'edit' (migration 100), NOT the owner/admin role. The stage
// dropdown and the note box below used to sit outside every check on the theory that "any
// linked role may move a card" — which was true under the old STAFF tier and is not true
// now: move_job and add_note both require build_schedule:'edit', so a view-only member was
// being offered two controls the server refuses.
function SchedJobEditor({ job, stages, crews = [], canEdit, busy, onSave, onComplete, onDelete, onMove, onNote, onOpenDesign }) {
  // ONE build date (Carolyn 2026-08-04: most builds finish within a day). It writes both
  // date columns so every existing check (past due, delivery conflicts, pool) keys off it.
  const [f, setF] = useState({
    title: job.title || "", customerName: job.customer_name || "", buildingLabel: job.building_label || "",
    buildDate: job.due_date || job.scheduled_start || "",
    crewId: job.crew_id || "", notes: job.notes || "",
  });
  const [note, setNote] = useState("");
  // Bumped after a note lands so the history below re-reads it — the note is stored as an
  // activity row, so without this the writer sees nothing happen.
  const [historyKey, setHistoryKey] = useState(0);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const lbl = { ...S.lbl, marginBottom: 3 };
  const inp = { ...S.input, padding: "6px 8px", fontSize: 12.5 };
  return (
    <div style={{ borderTop: "1px solid #F1F5F9", marginTop: 8, paddingTop: 9 }} onClick={(e) => e.stopPropagation()}>
      {canEdit && (<>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 10px", marginBottom: 8 }}>
          <div><span style={lbl}>Customer</span><input style={inp} value={f.customerName} onChange={set("customerName")} /></div>
          <div><span style={lbl}>Building</span><input style={inp} value={f.buildingLabel} onChange={set("buildingLabel")} /></div>
          <div><span style={lbl}>Build date</span><input type="date" style={inp} value={f.buildDate} onChange={set("buildDate")} /></div>
          <div><span style={lbl}>Crew</span>
            <select style={inp} value={f.crewId} onChange={set("crewId")}>
              <option value="">— No crew —</option>
              {crews.filter((c) => c.active !== false || c.id === job.crew_id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div style={{ gridColumn: "1 / -1" }}><span style={lbl}>Job notes</span><input style={inp} value={f.notes} onChange={set("notes")} placeholder="Shown on the card" /></div>
        </div>
        <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 8 }}>
          <button type="button" disabled={busy} style={S.btn(ACCENT, "#FFF")} onClick={() => onSave({
            customerName: f.customerName, buildingLabel: f.buildingLabel, title: f.title,
            scheduledStart: f.buildDate || null, dueDate: f.buildDate || null,
            crewId: f.crewId || null, notes: f.notes,
          })}>Save</button>
          <button type="button" disabled={busy} style={S.btn("#F0FDF4", "#15803D")} onClick={onComplete}>✓ Mark built</button>
          {job.design_short_code && onOpenDesign && (
            <button type="button" style={S.btn("#F1F5F9", "#334155")} onClick={() => onOpenDesign(job.design_short_code)}>Open design</button>
          )}
          <button type="button" disabled={busy} style={{ ...S.btn("#FEF2F2", "#DC2626"), marginLeft: "auto" }} onClick={onDelete}>Delete</button>
        </div>
      </>)}
      {/* Stage move without drag — the touch/keyboard path, and the crew path on phones. */}
      {canEdit && (
        <div style={{ display: "flex", gap: 7, alignItems: "center", flexWrap: "wrap" }}>
          <select style={{ ...inp, width: "auto" }} value={job.stage_id} onChange={(e) => onMove(e.target.value)} disabled={busy} aria-label="Move to stage">
            {stages.filter((s) => !s.archived || s.id === job.stage_id).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <input style={{ ...inp, flex: 1, minWidth: 120 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note for the crew…" />
          <button type="button" disabled={busy || !note.trim()} style={S.btn("#F1F5F9", "#334155")}
            onClick={async () => {
              if (!note.trim()) return;
              await onNote(note.trim());
              setNote(""); setHistoryKey((k) => k + 1);
            }}>Add note</button>
        </div>
      )}
      {/* History — every move, note and completion, with who and when. This is the read side
          of schedule_activity, which the edge function has always written and nothing ever
          showed: a crew note went into the log and vanished from the screen. */}
      <SchedJobHistory jobId={job.id} refreshKey={historyKey} />
    </div>
  );
}

// Stage editor — a modal on purpose: this is CONFIG (like Settings), not job data, so the
// no-popout rule doesn't apply. Kind is presented in plain words; the server enforces
// "at least one finished stage".
function SchedStageEditor({ stages, busy, onClose, onSave }) {
  const [rows, setRows] = useState(stages.map((s) => ({ id: s.id, name: s.name, color: s.color, kind: s.kind, archived: !!s.archived })));
  const move = (i, d) => {
    const j = i + d; if (j < 0 || j >= rows.length) return;
    const next = rows.slice(); const t = next[i]; next[i] = next[j]; next[j] = t; setRows(next);
  };
  const set = (i, k, v) => setRows(rows.map((r, idx) => idx === i ? { ...r, [k]: v } : r));
  const valid = rows.every((r) => r.name.trim()) && rows.some((r) => r.kind === "done" && !r.archived);
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,.38)", zIndex: 95, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }} onClick={onClose}>
      <div style={{ background: "#FFF", borderRadius: 14, width: 520, maxWidth: "94vw", maxHeight: "86vh", overflowY: "auto", padding: "18px 20px" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
          <span style={S.h2}>Build stages</span>
          <button type="button" onClick={onClose} style={{ ...S.btn("#F1F5F9", "#64748B"), marginLeft: "auto", padding: "4px 10px" }}>×</button>
        </div>
        {rows.map((r, i) => (
          <div key={r.id || "new" + i} style={{ display: "flex", alignItems: "center", gap: 8, border: "1px solid #E2E8F0", borderRadius: 10, padding: "7px 10px", marginBottom: 7, background: r.archived ? "#F8FAFC" : "#FBFCFE", opacity: r.archived ? 0.65 : 1 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
              <button type="button" onClick={() => move(i, -1)} disabled={i === 0} style={{ border: "none", background: "none", cursor: "pointer", color: "#94A3B8", fontSize: 10, padding: 0 }} aria-label="Move up">▲</button>
              <button type="button" onClick={() => move(i, 1)} disabled={i === rows.length - 1} style={{ border: "none", background: "none", cursor: "pointer", color: "#94A3B8", fontSize: 10, padding: 0 }} aria-label="Move down">▼</button>
            </div>
            <input type="color" value={r.color} onChange={(e) => set(i, "color", e.target.value)} style={{ width: 26, height: 26, border: "none", background: "none", padding: 0, cursor: "pointer" }} aria-label="Stage color" />
            <input value={r.name} onChange={(e) => set(i, "name", e.target.value)} style={{ ...S.input, flex: 1, padding: "6px 8px", fontSize: 13 }} />
            <select value={r.kind} onChange={(e) => set(i, "kind", e.target.value)} style={{ ...S.input, width: "auto", padding: "6px 8px", fontSize: 12 }}>
              <option value="queue">Waiting to start</option>
              <option value="active">Work in progress</option>
              <option value="done">Finished</option>
            </select>
            <button type="button" onClick={() => set(i, "archived", !r.archived)} title={r.archived ? "Restore this stage" : "Archive this stage"}
              style={{ ...S.btn(r.archived ? "#F0FDF4" : "#F1F5F9", r.archived ? "#15803D" : "#64748B"), padding: "5px 9px", fontSize: 11 }}>
              {r.archived ? "Restore" : "Archive"}
            </button>
          </div>
        ))}
        <button type="button" style={{ ...S.btn("#F1F5F9", "#334155"), marginBottom: 10 }}
          onClick={() => setRows([...rows, { name: "", color: "#94A3B8", kind: "active", archived: false }])}>+ Add a stage</button>
        <p style={{ fontSize: 11.5, color: "#64748B", lineHeight: 1.5, background: "#F1F5F9", borderRadius: 8, padding: "8px 11px", marginBottom: 12 }}>
          Rename, recolor, and reorder stages to match your shop — add "Paint" or "Materials Pulled" if that's how you work.
          Mark which column means <strong>finished</strong>: that's how the Delivery Schedule knows a building is truly done, no matter what you call your columns.
        </p>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" style={S.btn("#F1F5F9", "#334155")} onClick={onClose}>Cancel</button>
          <button type="button" disabled={busy || !valid} style={S.btn(ACCENT, "#FFF")} title={valid ? "" : "Every stage needs a name, and one non-archived stage must be Finished"}
            onClick={() => onSave(rows)}>Save stages</button>
        </div>
      </div>
    </div>
  );
}

function BuildScheduleTab({ clientId, canAdmin, access = null, onOpenDesign }) {
  // Who may WRITE here is build_schedule:'edit' (migration 100) — a Crew Leader has it, a
  // Sales Rep does not, and neither is an admin. `canAdmin` alone was the old owner/admin
  // gate: it locked every write control for exactly the people the Crew Leader title was
  // created for, while the server was already letting them through.
  const canEdit = canAdmin || !!(access && access.build_schedule === "edit");
  // Closing a repair is a REPAIRS write — offered only to someone who holds that area.
  const canRepairs = canAdmin || !!(access && access.repairs === "edit");
  const [data, setData] = useState(null);        // { stages, jobs, stopByJob, tray, team } | null = loading
  const [error, setError] = useState(null);
  const [view, setView] = useState("calendar"); // calendar (main) | board | table
  const [calView, setCalView] = useState("week"); // week | month
  const [cursorMs, setCursorMs] = useState(() => Date.now());
  const [crewFilter, setCrewFilter] = useState("all"); // "all" | userId — each crew gets their own calendar
  // Weekends on/off — remembered per browser; most shops run Mon–Fri (or Mon–Sat).
  const [showWeekends, setShowWeekends] = useState(() => {
    try { return window.localStorage.getItem("ss_sched_weekends") !== "off"; } catch (_e) { return true; }
  });
  const toggleWeekends = () => {
    const next = !showWeekends;
    setShowWeekends(next);
    try { window.localStorage.setItem("ss_sched_weekends", next ? "on" : "off"); } catch (_e) { /* private mode */ }
  };
  const [query, setQuery] = useState("");
  const [stageFilter, setStageFilter] = useState("all");
  const [sortKey, setSortKey] = useState("due_date");
  const [sortDir, setSortDir] = useState("asc");
  const [msg, setMsg] = useState(null);          // { ok } | { err }
  const [busy, setBusy] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [dragId, setDragId] = useState(null);
  const [dragIntake, setDragIntake] = useState(null); // a tray item (not on the board yet) being dragged onto a date
  const [dropStage, setDropStage] = useState(null);
  const [editingStages, setEditingStages] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [manual, setManual] = useState({ title: "", customerName: "", dueDate: "" });

  const call = async (body, okMsg) => {
    const { data: d, error: err } = await sb.functions.invoke("portal-schedule", { body });
    if (err || !d || d.error) {
      setMsg({ err: (d && d.error) || (err ? await fnError(err) : "That didn't work.") });
      return null;
    }
    if (okMsg) setMsg({ ok: okMsg });
    return d;
  };
  const load = useCallback(async () => {
    setError(null);
    const { data: d, error: err } = await sb.functions.invoke("portal-schedule", { body: { action: "build_board" } });
    if (err || !d || d.error) {
      setError((d && d.error) || (err ? await fnError(err) : "Could not load the build schedule."));
      setData({ stages: [], jobs: [], stopByJob: {}, tray: { orders: [], inventory: [], repairs: [] }, team: [] });
      return;
    }
    setData(d);
  }, [clientId]);
  useEffect(() => { load(); }, [load]);

  const stages = (data && data.stages) || [];
  const jobs = (data && data.jobs) || [];
  const stopByJob = (data && data.stopByJob) || {};
  const tray = (data && data.tray) || { orders: [], inventory: [], repairs: [] };
  const team = (data && data.team) || [];
  // Crews (094) — the scheduling unit: calendars flip per crew, drops assign the crew.
  const crews = (data && data.crews) || [];
  const activeCrews = crews.filter((c) => c.active !== false);
  const crewById = {}; crews.forEach((c) => { crewById[c.id] = c; });
  const kindOf = {}; stages.forEach((s) => { kindOf[s.id] = s.kind; });
  const stageName = {}; stages.forEach((s) => { stageName[s.id] = s.name; });
  const nameOf = {}; team.forEach((m) => { nameOf[m.userId] = m.name; });
  const visibleStages = stages.filter((s) => !s.archived);
  const trayCount = tray.orders.length + tray.inventory.length + tray.repairs.length;

  const counts = { queue: 0, active: 0, done: 0, pastDue: 0 };
  jobs.forEach((j) => {
    const k = kindOf[j.stage_id] || "queue";
    counts[k] = (counts[k] || 0) + 1;
    if (schedPastDue(j, k)) counts.pastDue++;
  });
  // Board jobs with no build date — they live in the ONE Unscheduled tray on the calendar.
  const undatedJobs = jobs.filter((j) => !schedBuildDate(j) && !j.completed_at);

  // Optimistic stage move; on server rejection the reload restores the truth.
  const moveJob = async (job, stageId) => {
    if (!stageId || stageId === job.stage_id) return;
    setData((d) => ({ ...d, jobs: d.jobs.map((j) => j.id === job.id ? { ...j, stage_id: stageId } : j) }));
    const r = await call({ action: "move_job", jobId: job.id, stageId, position: Date.now() });
    if (!r) load();
  };
  // Calendar drop = the reschedule (one build date per job; both date columns kept equal).
  // Dropping while viewing a CREW'S calendar also hands the job to that crew.
  const moveJobDate = async (job, iso) => {
    const assignCrew = iso && crewFilter !== "all" ? crewFilter : null;
    setData((d) => ({ ...d, jobs: d.jobs.map((j) => j.id === job.id ? {
      ...j, scheduled_start: iso, due_date: iso,
      crew_id: assignCrew || j.crew_id,
    } : j) }));
    const patch = { action: "update_job", jobId: job.id, scheduledStart: iso, dueDate: iso };
    if (assignCrew) patch.crewId = assignCrew;
    const r = await call(patch);
    if (!r) load();
  };
  const addFromTray = async (body, label) => {
    setBusy(true); setMsg(null);
    const r = await call({ action: "create_job", ...body }, `${label} added to the board.`);
    setBusy(false); if (r) load();
  };
  // Dragging a tray item (not on the board yet) straight onto a calendar date creates the
  // job WITH that build date — and assigns the crew whose calendar is showing.
  const addFromTrayDated = async (body, label, iso) => {
    setBusy(true); setMsg(null);
    const extra = { dueDate: iso, scheduledStart: iso };
    if (crewFilter !== "all") extra.crewId = crewFilter;
    const r = await call({ action: "create_job", ...body, ...extra },
      `${label} scheduled for ${fmtDate(schedLocalDate(iso))}${crewFilter !== "all" ? " with " + ((crewById[crewFilter] || {}).name || "crew") : ""}.`);
    setBusy(false); if (r) load();
  };
  const createManual = async () => {
    if (!manual.title.trim() && !manual.customerName.trim()) { setMsg({ err: "Give the job a title or customer." }); return; }
    setBusy(true); setMsg(null);
    const r = await call({ action: "create_job", source: "manual", title: manual.title, customerName: manual.customerName, dueDate: manual.dueDate || null }, "Job added.");
    setBusy(false);
    if (r) { setManual({ title: "", customerName: "", dueDate: "" }); setAddOpen(false); load(); }
  };
  const saveJob = async (job, patch) => {
    setBusy(true); setMsg(null);
    const r = await call({ action: "update_job", jobId: job.id, ...patch }, "Saved.");
    setBusy(false); if (r) load();
  };
  const completeJob = async (job) => {
    setBusy(true); setMsg(null);
    const r = await call({ action: "complete_job", jobId: job.id }, `${job.customer_name || job.title || "Job"} marked built.`);
    setBusy(false);
    if (!r) return;
    setExpandedId(null);
    // The shop work on a repair is done — offer to close the repair too. PROMPT, never
    // automatic: the repair's status is what the customer is told, and it may still be
    // waiting on a part or on payment (SCHEDULING_SCOPE.md).
    if (r.repairPrompt && canRepairs) {
      const p = r.repairPrompt;
      if (window.confirm(`That was the last shop job for R-${p.repairNo}. Mark the repair completed as well?`)) {
        await call({ action: "update_repair", repairId: p.repairId, status: "completed" }, `R-${p.repairNo} completed.`);
      }
    }
    load();
  };
  const deleteJob = async (job) => {
    if (!window.confirm(`Remove ${job.customer_name || job.title || "this job"} from the build schedule? The order/design itself is not touched.`)) return;
    setBusy(true); setMsg(null);
    const r = await call({ action: "delete_job", jobId: job.id }, "Removed from the board.");
    setBusy(false); if (r) { setExpandedId(null); load(); }
  };
  const addNote = async (job, text) => {
    setBusy(true); setMsg(null);
    await call({ action: "add_note", jobId: job.id, note: text }, "Note added.");
    setBusy(false);
  };
  const saveStages = async (rows) => {
    setBusy(true); setMsg(null);
    const r = await call({ action: "save_stages", stages: rows.map((x) => ({ id: x.id, name: x.name, color: x.color, kind: x.kind, archived: x.archived })) }, "Stages saved.");
    setBusy(false); if (r) { setEditingStages(false); load(); }
  };

  // ── Shared card face (board card + expanded editor) ──
  const loadChip = (job) => {
    const link = stopByJob[job.id];
    if (!link || !link.load) return null;
    const l = link.load;
    const delivered = l.status === "delivered" || link.deliveredAt;
    const c = delivered ? { bg: "#F0FDF4", fg: "#15803D" } : l.status === "out" ? { bg: "#FFFBEB", fg: "#B45309" } : { bg: "#EEF2FF", fg: "#3D3672" };
    const when = l.load_date ? " · " + fmtDate(schedLocalDate(l.load_date)) : "";
    return <span style={schedChip(c.bg, c.fg)}>{delivered ? "Delivered" : `Load ${l.load_no}${when}`}</span>;
  };
  const jobCard = (job, opts = {}) => {
    const kind = kindOf[job.stage_id] || "queue";
    const late = schedPastDue(job, kind);
    const src = SCHED_SRC_CHIP[job.source] || SCHED_SRC_CHIP.manual;
    const stg = stages.find((s) => s.id === job.stage_id);
    const open = expandedId === job.id;
    const bd = schedBuildDate(job);
    // Building-first reading order (Carolyn 2026-08-04, mockup approved): style+size is
    // the headline, then roof, then colors (real catalog swatches), then the customer.
    const isRepair = job.source === "repair";
    let headline = isRepair ? (job.title || "Repair") : (job.building_label || job.title || "—");
    if (!isRepair && headline !== "—" && !/[x×]/.test(headline) && schedDims(job) !== "—") headline += " " + schedDims(job);
    const roofLine = isRepair
      ? [job.serial ? "Building #" + job.serial : null, job.building_label].filter(Boolean).join(" · ")
      : (job.roof_type ? String(job.roof_type) + (/roof/i.test(String(job.roof_type)) ? "" : " roof") : null);
    const colorBits = [
      job.body_color ? { hex: job.body_color_hex, name: job.body_color, sfx: "" } : null,
      job.trim_color ? { hex: job.trim_color_hex, name: job.trim_color, sfx: " trim" } : null,
      job.roof_color ? { hex: job.roof_color_hex, name: job.roof_color, sfx: " roof" } : null,
    ].filter(Boolean);
    const custLine = job.customer_name || (job.source === "inventory" ? "Spec build for the lot" : null);
    return (
      <div key={job.id} draggable={!open && canEdit} tabIndex={0} role="button" aria-expanded={open}
        onDragStart={(e) => { setDragId(job.id); try { e.dataTransfer.effectAllowed = "move"; } catch (_) {} }}
        onDragEnd={() => { setDragId(null); setDropStage(null); }}
        onClick={() => setExpandedId(open ? null : job.id)}
        onKeyDown={(e) => { if (e.key === "Enter") setExpandedId(open ? null : job.id); }}
        style={{ background: "#FFF", border: "1px solid " + (open ? "#B9C4D6" : "#E2E8F0"), borderRadius: 10, padding: "9px 11px",
          cursor: open ? "default" : "grab", opacity: dragId === job.id ? 0.45 : 1, boxShadow: "0 1px 2px rgba(15,23,42,.05)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 4 }}>
          <span style={{ fontSize: 11, fontWeight: 800, color: "#64748B", fontVariantNumeric: "tabular-nums" }}>{job.serial ? "#" + job.serial : (job.source === "repair" ? "Repair" : "—")}</span>
          <span style={{ ...schedChip(src.bg, src.fg), marginLeft: "auto" }}>{src.label}</span>
        </div>
        {/* 1 · The building — the headline the shop floor reads first. */}
        <div style={{ fontSize: 14.5, fontWeight: 800, lineHeight: 1.2, letterSpacing: 0.1 }}>{headline}</div>
        {/* 2 · Roof type (for repairs: which building this belongs to). */}
        {roofLine && <div style={{ fontSize: 11, fontWeight: 700, color: "#475569", marginTop: 3 }}>{roofLine}</div>}
        {/* 3 · Colors, with true swatches from the tenant's catalog. */}
        {colorBits.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
            {colorBits.map((c, i) => (
              <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, fontWeight: 700, color: "#64748B" }}>
                {c.hex && <span style={{ width: 10, height: 10, borderRadius: 3, border: "1px solid rgba(15,23,42,.18)", background: c.hex, display: "inline-block", flexShrink: 0 }}></span>}
                {c.name}{c.sfx}
              </span>
            ))}
          </div>
        )}
        {/* 4 · The customer, under the fold line. */}
        {custLine && (
          <div style={{ fontSize: 11.5, fontWeight: 700, color: "#334155", marginTop: 6, paddingTop: 6, borderTop: "1px solid #F1F5F9" }}>{custLine}</div>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
          {/* Stage chip on calendar cards (there the column is a DATE, so the stage needs a home). */}
          {opts.showStage && stg && (
            <span style={schedChip("#FFF", "#334155")}><span style={{ width: 8, height: 8, borderRadius: "50%", background: stg.color, display: "inline-block" }}></span>{stg.name}</span>
          )}
          {/* One build date per job; hidden on the calendar where the column says it. */}
          {!opts.hideDate && bd && (
            <span style={{ ...schedChip(late ? "#FEF2F2" : "#F1F5F9", late ? "#DC2626" : "#475569"), fontVariantNumeric: "tabular-nums" }}>
              {fmtDate(schedLocalDate(bd))}{late ? " · past due" : ""}
            </span>
          )}
          {loadChip(job)}
        </div>
        {/* Crew as a named row — every detail at face value. Crew (094) wins; a legacy
            individual assignee still shows on old cards. */}
        {(job.crew_id && crewById[job.crew_id]) ? (
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
            <span style={{ width: 10, height: 10, borderRadius: "50%", background: crewById[job.crew_id].color || ACCENT, flexShrink: 0 }}></span>
            <span style={{ fontSize: 10.5, fontWeight: 700, color: "#475569" }}>{crewById[job.crew_id].name}</span>
          </div>
        ) : job.assignee_user_id ? (
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
            <span style={{ width: 18, height: 18, borderRadius: "50%", background: "#DBEAFF", border: "1px solid #C3D9F7", color: ACCENT, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 8, fontWeight: 800, flexShrink: 0 }}>
              {schedInitials(nameOf[job.assignee_user_id])}
            </span>
            <span style={{ fontSize: 10.5, fontWeight: 700, color: "#475569" }}>{nameOf[job.assignee_user_id] || "Assigned"}</span>
          </div>
        ) : null}
        {job.notes && <div style={{ fontSize: 11, color: "#64748B", fontWeight: 600, marginTop: 6, whiteSpace: "pre-wrap" }}>{job.notes}</div>}
        {open && (
          <SchedJobEditor job={job} stages={stages} crews={crews} canEdit={canEdit} busy={busy}
            onSave={(patch) => saveJob(job, patch)} onComplete={() => completeJob(job)} onDelete={() => deleteJob(job)}
            onMove={(stageId) => moveJob(job, stageId)} onNote={(t) => addNote(job, t)} onOpenDesign={onOpenDesign} />
        )}
      </div>
    );
  };

  // ── Table view rows ──
  const tableRows = jobs.filter((j) => {
    if (stageFilter !== "all" && j.stage_id !== stageFilter) return false;
    if (!query.trim()) return true;
    return rowMatchesQuery(j, query,
      (stageName[j.stage_id] || "") + " " + (nameOf[j.assignee_user_id] || "") + " #" + (j.serial || ""));
  });
  const sorted = sortRows(tableRows, (j) => j[sortKey], sortDir);
  const onSort = makeOnSort(sortKey, setSortKey, sortDir, setSortDir);

  // In calendar view a tray item is DRAGGABLE — drop it on a date and the job is created
  // with that build date (addFromTrayDated). The + button still adds it unscheduled.
  const trayItem = (key, chipConf, who, what, addBody, label) => {
    const draggable = canEdit && view === "calendar";
    return (
      <div key={key} draggable={draggable}
        onDragStart={draggable ? () => setDragIntake({ body: addBody, label }) : undefined}
        onDragEnd={draggable ? () => { setDragIntake(null); setDropStage(null); } : undefined}
        style={{ flex: "0 0 auto", display: "flex", alignItems: "center", gap: 9, border: "1px solid #E2E8F0", borderRadius: 10, padding: "8px 11px", background: "#FBFCFE", cursor: draggable ? "grab" : "default" }}>
        <span style={schedChip(chipConf.bg, chipConf.fg)}>{chipConf.label}</span>
        <div>
          <div style={{ fontSize: 12.5, fontWeight: 700 }}>{who}</div>
          {what && <div style={{ fontSize: 11, color: "#64748B", fontWeight: 600 }}>{what}</div>}
        </div>
        {canEdit && (
          <button type="button" disabled={busy} onClick={() => addFromTray(addBody, label)}
            title={view === "calendar" ? "Add without a date (or drag onto a day below)" : "Add to the board"}
            style={{ border: "none", background: ACCENT, color: "#FFF", width: 24, height: 24, borderRadius: 7, fontSize: 15, fontWeight: 800, cursor: "pointer", lineHeight: 1, flexShrink: 0 }}>+</button>
        )}
      </div>
    );
  };

  return (
    <div style={S.card}>
      <CardHead title="Build Schedule" count={jobs.length}
        right={<>
          <div style={{ display: "flex", background: "#EDF1F7", borderRadius: 9, padding: 3, gap: 2 }}>
            {[["calendar", "Calendar"], ["board", "Board"], ["table", "Table"]].map(([v, label]) => (
              <button key={v} type="button" onClick={() => setView(v)}
                style={{ border: "none", background: view === v ? "#FFF" : "transparent", borderRadius: 7, padding: "5px 12px", fontSize: 12, fontWeight: 700, color: view === v ? ACCENT : "#64748B", cursor: "pointer", fontFamily: "inherit", boxShadow: view === v ? "0 1px 3px rgba(15,23,42,.12)" : "none" }}>
                {label}
              </button>
            ))}
          </div>
          <button type="button" onClick={load} style={S.btn("#F1F5F9", "#334155")}>↻ Refresh</button>
          {canEdit && <button type="button" onClick={() => setEditingStages(true)} style={S.btn("#FFF", "#475569")}>Edit stages</button>}
          {canEdit && <button type="button" onClick={() => setAddOpen(!addOpen)} style={S.btn(ACCENT, "#FFF")}>+ Add job</button>}
        </>} />

      {/* Summary tiles */}
      {data && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginBottom: 13 }}>
          {[["In queue", counts.queue, "#1E293B"], ["In progress", counts.active, "#1E293B"], ["Built — awaiting delivery", counts.done, "#1E293B"], ["Past due", counts.pastDue, counts.pastDue ? "#DC2626" : "#1E293B"]].map(([t, n, c]) => (
            <div key={t} style={{ background: "#FFF", border: "1px solid #E2E8F0", borderRadius: 12, padding: "10px 14px" }}>
              <div style={{ fontSize: 21, fontWeight: 800, fontVariantNumeric: "tabular-nums", color: c }}>{n}</div>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: "#64748B", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 1 }}>{t}</div>
            </div>
          ))}
        </div>
      )}

      {msg && msg.ok && <div style={S.okMsg}>{msg.ok}</div>}
      {msg && msg.err && <div style={S.err}>{msg.err}</div>}
      {error && <div style={S.err}>{error}</div>}
      {data === null && <p style={{ fontSize: 13, color: "#64748B", padding: 12 }}>Loading…</p>}

      {/* Manual add (admin) */}
      {addOpen && canEdit && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", border: "1px dashed #B9C4D6", borderRadius: 10, padding: "10px 12px", marginBottom: 12 }}>
          <div style={{ flex: 2, minWidth: 160 }}><span style={S.lbl}>Job title</span><input style={S.input} value={manual.title} onChange={(e) => setManual({ ...manual, title: e.target.value })} placeholder='e.g. "Shop maintenance day"' /></div>
          <div style={{ flex: 2, minWidth: 140 }}><span style={S.lbl}>Customer (optional)</span><input style={S.input} value={manual.customerName} onChange={(e) => setManual({ ...manual, customerName: e.target.value })} /></div>
          <div style={{ flex: 1, minWidth: 120 }}><span style={S.lbl}>Due</span><input type="date" style={S.input} value={manual.dueDate} onChange={(e) => setManual({ ...manual, dueDate: e.target.value })} /></div>
          <button type="button" disabled={busy} style={S.btn(ACCENT, "#FFF")} onClick={createManual}>Add</button>
        </div>
      )}

      {/* ONE Unscheduled tray (Carolyn 2026-08-04) — intake items that aren't on the board
          yet AND, on the calendar, board jobs without a build date. Everything here drags
          straight onto a date below; dropping a scheduled card back clears its date. */}
      {data && (trayCount > 0 || (view === "calendar" && undatedJobs.length > 0)) && (
        <div
          onDragOver={view === "calendar" && canEdit ? (e) => { e.preventDefault(); setDropStage("cal:none"); } : undefined}
          onDragLeave={view === "calendar" && canEdit ? () => setDropStage((d) => d === "cal:none" ? null : d) : undefined}
          onDrop={view === "calendar" && canEdit ? (e) => {
            e.preventDefault(); setDropStage(null);
            const job = jobs.find((j) => j.id === dragId);
            if (job && schedBuildDate(job)) moveJobDate(job, null);
            setDragId(null); setDragIntake(null);
          } : undefined}
          style={{ border: "1px dashed #B9C4D6", borderRadius: 12, padding: "10px 14px", marginBottom: 13, background: "#FFF",
            outline: dropStage === "cal:none" ? `2px dashed ${ACCENT}` : "none", outlineOffset: -2 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 9 }}>
            <span style={{ ...S.lbl, marginBottom: 0, color: "#475569" }}>Unscheduled</span>
            <span style={schedChip("#EEF2FF", "#3D3672")}>{trayCount + (view === "calendar" ? undatedJobs.length : 0)}</span>
            <span style={{ fontSize: 11.5, color: "#64748B", fontWeight: 600 }}>
              {view === "calendar"
                ? "— drag anything here onto a day below to schedule it" + (canEdit ? "; drag a scheduled card back here to clear its date" : "")
                : "— sold orders, inventory, and repairs that aren't on the board yet"}
            </span>
          </div>
          <div style={{ display: "flex", gap: 9, overflowX: "auto", paddingBottom: 2 }}>
            {view === "calendar" && undatedJobs.map((j) => (
              <div key={j.id} style={{ flex: "0 0 230px" }}>{jobCard(j, { hideDate: true, showStage: true })}</div>
            ))}
            {/* Building-first like the cards: style+size bold, customer in the small line. */}
            {tray.orders.map((o) => trayItem("o" + o.designShortCode, SCHED_SRC_CHIP.order,
              o.buildingLabel || o.designShortCode, o.customerName,
              { source: "order", designShortCode: o.designShortCode }, o.customerName || "Order"))}
            {/* DROPPING A REQUESTED BUILDING ONTO THE BOARD IS THE APPROVAL (migration 105) —
                there is no separate accept step, so every unit without a build job sits here.
                A SOLD spec build still belongs here too: selling a building does not build
                it, and dropping sold units out of the tray would quietly stop them being
                made. The shop just needs to know it is already spoken for. */}
            {tray.inventory.map((u) => trayItem("u" + u.inventoryUnitId, SCHED_SRC_CHIP.inventory,
              u.buildingLabel || "#" + u.serial,
              "#" + u.serial + (u.sold ? " · SOLD" + (u.soldFirstName ? " — " + u.soldFirstName : "") : " · Requested — drag to a day to approve"),
              { source: "inventory", inventoryUnitId: u.inventoryUnitId }, "#" + u.serial))}
            {tray.repairs.map((rp) => trayItem("r" + rp.repairId, SCHED_SRC_CHIP.repair,
              (rp.description || "Repair").slice(0, 50), "R-" + rp.repairNo + " · " + (rp.customerName || ""),
              { source: "repair", repairId: rp.repairId }, "R-" + rp.repairNo))}
          </div>
        </div>
      )}

      {/* ── BOARD ── */}
      {data && view === "board" && visibleStages.length > 0 && (
        <div style={{ overflowX: "auto", paddingBottom: 6 }}>
          <div style={{ display: "flex", gap: 11, alignItems: "flex-start", minWidth: "min-content" }}>
            {visibleStages.map((s) => {
              const colJobs = jobs.filter((j) => j.stage_id === s.id).sort((a, b) => Number(a.position) - Number(b.position));
              return (
                <div key={s.id} data-stage={s.id}
                  onDragOver={(e) => { e.preventDefault(); setDropStage(s.id); }}
                  onDragLeave={() => setDropStage((d) => d === s.id ? null : d)}
                  onDrop={(e) => {
                    e.preventDefault(); setDropStage(null);
                    const job = jobs.find((j) => j.id === dragId);
                    if (job) moveJob(job, s.id);
                    setDragId(null);
                  }}
                  style={{ width: 268, flex: "0 0 268px", background: "#EEF2F8", borderRadius: 12, padding: 9, outline: dropStage === s.id ? `2px dashed ${ACCENT}` : "none", outlineOffset: -2 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "2px 4px 8px" }}>
                    <span style={{ width: 9, height: 9, borderRadius: "50%", background: s.color, flexShrink: 0 }}></span>
                    <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: 0.3, color: "#334155" }}>{s.name}</span>
                    <span style={{ fontSize: 8.5, fontWeight: 800, letterSpacing: 0.8, textTransform: "uppercase", color: "#94A3B8" }}>
                      {s.kind === "queue" ? "waiting" : s.kind === "active" ? "in progress" : "finished"}
                    </span>
                    <span style={{ marginLeft: "auto", fontSize: 10.5, fontWeight: 800, color: "#64748B", background: "#FFF", borderRadius: 999, padding: "2px 8px", fontVariantNumeric: "tabular-nums" }}>{colJobs.length}</span>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, minHeight: 36 }}>
                    {colJobs.map((j) => jobCard(j))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {data && view === "board" && jobs.length === 0 && !error && (
        <p style={{ fontSize: 13, color: "#64748B", padding: 12 }}>
          Nothing on the board yet. Sold orders, inventory builds, and repairs appear in the tray above — one click adds them. Every order job takes the next shop serial number automatically.
        </p>
      )}

      {/* ── TABLE ── */}
      {data && view === "table" && (<>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search — serial, customer, building, stage…"
          style={{ ...S.input, width: "100%", boxSizing: "border-box", marginBottom: 10 }} />
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
          <button type="button" onClick={() => setStageFilter("all")} style={{ ...S.btn(stageFilter === "all" ? "#1E293B" : "#FFF", stageFilter === "all" ? "#FFF" : "#475569"), padding: "5px 12px", fontSize: 12, border: "1px solid " + (stageFilter === "all" ? "#1E293B" : "#E2E8F0"), borderRadius: 16 }}>All {jobs.length}</button>
          {visibleStages.map((s) => {
            const n = jobs.filter((j) => j.stage_id === s.id).length;
            const on = stageFilter === s.id;
            return n > 0 && (
              <button key={s.id} type="button" onClick={() => setStageFilter(on ? "all" : s.id)}
                style={{ ...S.btn(on ? "#1E293B" : "#FFF", on ? "#FFF" : "#475569"), padding: "5px 12px", fontSize: 12, border: "1px solid " + (on ? "#1E293B" : "#E2E8F0"), borderRadius: 16 }}>
                {s.name} {n}
              </button>
            );
          })}
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              <SortTh label="Serial" col="serial" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              <SortTh label="Customer" col="customer_name" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              <SortTh label="Building" col="building_label" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              <th style={S.th}>Size</th>
              <th style={S.th}>Source</th>
              <th style={S.th}>Stage</th>
              <SortTh label="Build date" col="due_date" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              <th style={S.th}>Crew</th>
              <th style={S.th}>Delivery</th>
            </tr></thead>
            <tbody>
              {sorted.map((j) => {
                const kind = kindOf[j.stage_id] || "queue";
                const late = schedPastDue(j, kind);
                const src = SCHED_SRC_CHIP[j.source] || SCHED_SRC_CHIP.manual;
                const stg = stages.find((s) => s.id === j.stage_id);
                const open = expandedId === j.id;
                return (
                  <React.Fragment key={j.id}>
                    <tr onClick={() => setExpandedId(open ? null : j.id)} style={{ cursor: "pointer", background: open ? "#F7F9FF" : "transparent" }}>
                      <td style={{ ...S.td, fontVariantNumeric: "tabular-nums", fontWeight: 800, color: "#64748B" }}>{j.serial ? "#" + j.serial : "—"}</td>
                      <td style={S.td}><strong>{j.customer_name || j.title || "—"}</strong></td>
                      <td style={S.td}>{j.building_label || j.title || "—"}</td>
                      <td style={{ ...S.td, fontVariantNumeric: "tabular-nums", fontWeight: 700 }}>{schedDims(j)}</td>
                      <td style={S.td}><span style={schedChip(src.bg, src.fg)}>{src.label}</span></td>
                      <td style={S.td}>{stg && <span style={schedChip("#FFF", "#334155")}><span style={{ width: 8, height: 8, borderRadius: "50%", background: stg.color, display: "inline-block" }}></span>{stg.name}</span>}</td>
                      <td style={{ ...S.td, whiteSpace: "nowrap", color: late ? "#DC2626" : "#1E293B", fontWeight: late ? 700 : 400 }}>{schedBuildDate(j) ? fmtDate(schedLocalDate(schedBuildDate(j))) + (late ? " · past due" : "") : "—"}</td>
                      <td style={S.td}>{(j.crew_id && crewById[j.crew_id] && crewById[j.crew_id].name) || nameOf[j.assignee_user_id] || "—"}</td>
                      <td style={S.td}>{loadChip(j) || <span style={{ fontSize: 11.5, color: "#94A3B8", fontWeight: 600 }}>not on a load</span>}</td>
                    </tr>
                    {open && (
                      <tr><td colSpan={9} style={{ ...S.td, background: "#F7F9FF" }}>
                        <SchedJobEditor job={j} stages={stages} crews={crews} canEdit={canEdit} busy={busy}
                          onSave={(patch) => saveJob(j, patch)} onComplete={() => completeJob(j)} onDelete={() => deleteJob(j)}
                          onMove={(stageId) => moveJob(j, stageId)} onNote={(t) => addNote(j, t)} onOpenDesign={onOpenDesign} />
                      </td></tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        {sorted.length === 0 && <p style={{ fontSize: 13, color: "#64748B", padding: 12 }}>No jobs match.</p>}
      </>)}

      {/* ── CALENDAR — real dates, one build date per card, per-crew calendars ── */}
      {data && view === "calendar" && (() => {
        const isoLocal = schedLocalIso;   // the shared LOCAL day key (see the top of the file)
        const todayIso = isoLocal(new Date());
        const cur = new Date(cursorMs); cur.setHours(0, 0, 0, 0);
        const dated = jobs.filter((j) => schedBuildDate(j) && (crewFilter === "all" || j.crew_id === crewFilter));
        const byDate = {}; dated.forEach((j) => { const k = schedBuildDate(j); (byDate[k] = byDate[k] || []).push(j); });
        const stageColor = {}; stages.forEach((s) => { stageColor[s.id] = s.color; });

        // SUNDAY-FIRST weeks (Carolyn 2026-08-04); weekends can be toggled off entirely.
        // Days advance by DATE, never by adding 86,400,000ms: the US fall-back day is 25
        // hours long, so ms-stepping across it repeats a local date (duplicate keys, jobs
        // rendered twice) and shifts every later cell back one (audit 2026-08-20).
        const isWknd = (d) => d.getDay() === 0 || d.getDay() === 6;
        const sun = new Date(cur); sun.setDate(sun.getDate() - sun.getDay());
        let weekDays = []; for (let i = 0; i < 7; i++) { const d = new Date(sun); d.setDate(d.getDate() + i); weekDays.push(d); }
        const weekLabelDays = weekDays; // full-range label even when weekend columns hide
        if (!showWeekends) weekDays = weekDays.filter((d) => !isWknd(d));
        const m0 = new Date(cur.getFullYear(), cur.getMonth(), 1);
        const gridStart = new Date(m0); gridStart.setDate(gridStart.getDate() - gridStart.getDay());
        let monthCells = []; for (let i = 0; i < 42; i++) { const d = new Date(gridStart); d.setDate(d.getDate() + i); monthCells.push(d); }
        if (!showWeekends) monthCells = monthCells.filter((d) => !isWknd(d));
        const monthHeads = showWeekends ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] : ["Mon", "Tue", "Wed", "Thu", "Fri"];
        const gridCols = showWeekends ? 7 : 5;
        const fmtShort = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
        const label = calView === "week"
          ? fmtShort(weekLabelDays[0]) + " – " + fmtShort(weekLabelDays[6]) + ", " + weekLabelDays[6].getFullYear()
          : cur.toLocaleDateString("en-US", { month: "long", year: "numeric" });
        const step = (dir) => {
          const c = new Date(cursorMs);
          if (calView === "week") c.setDate(c.getDate() + dir * 7); else c.setMonth(c.getMonth() + dir);
          setCursorMs(c.getTime());
        };
        const dropProps = (iso) => canEdit ? {
          onDragOver: (e) => { e.preventDefault(); setDropStage("cal:" + (iso || "none")); },
          onDragLeave: () => setDropStage((d) => d === "cal:" + (iso || "none") ? null : d),
          onDrop: (e) => {
            e.preventDefault(); setDropStage(null);
            const job = jobs.find((j) => j.id === dragId);
            if (job) moveJobDate(job, iso);
            // A tray item (not on the board yet) dropped on a date: create it scheduled.
            else if (dragIntake && iso) addFromTrayDated(dragIntake.body, dragIntake.label, iso);
            setDragId(null); setDragIntake(null);
          },
        } : {};
        const dropGlow = (iso) => dropStage === "cal:" + (iso || "none") ? { outline: `2px dashed ${ACCENT}`, outlineOffset: -2 } : {};

        return (
          <div>
            {/* Nav + crew calendars */}
            <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 10, flexWrap: "wrap" }}>
              <div style={{ display: "flex", background: "#EDF1F7", borderRadius: 9, padding: 3, gap: 2 }}>
                {[["week", "Week"], ["month", "Month"]].map(([v, l]) => (
                  <button key={v} type="button" onClick={() => setCalView(v)}
                    style={{ border: "none", background: calView === v ? "#FFF" : "transparent", borderRadius: 7, padding: "5px 12px", fontSize: 12, fontWeight: 700, color: calView === v ? ACCENT : "#64748B", cursor: "pointer", fontFamily: "inherit", boxShadow: calView === v ? "0 1px 3px rgba(15,23,42,.12)" : "none" }}>{l}</button>
                ))}
              </div>
              <button type="button" style={S.btn("#F1F5F9", "#334155")} onClick={() => step(-1)}>‹</button>
              <span style={{ fontSize: 14, fontWeight: 800 }}>{label}</span>
              <button type="button" style={S.btn("#F1F5F9", "#334155")} onClick={() => step(1)}>›</button>
              <button type="button" style={{ ...S.btn("#FFF", "#475569"), border: "1px solid #CBD5E1", padding: "6px 11px", fontSize: 12 }} onClick={() => setCursorMs(Date.now())}>Today</button>
              <button type="button" onClick={toggleWeekends}
                title={showWeekends ? "Hide Saturday & Sunday (anything scheduled on a weekend stays scheduled — turn weekends back on to see it)" : "Show Saturday & Sunday"}
                style={{ ...S.btn(showWeekends ? "#EEF2FF" : "#FFF", showWeekends ? ACCENT : "#64748B"), border: "1px solid " + (showWeekends ? "#C3D9F7" : "#CBD5E1"), padding: "6px 11px", fontSize: 12 }}>
                Weekends {showWeekends ? "on" : "off"}
              </button>
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 11, alignItems: "center" }}>
              <button type="button" onClick={() => setCrewFilter("all")}
                style={{ ...S.btn(crewFilter === "all" ? "#1E293B" : "#FFF", crewFilter === "all" ? "#FFF" : "#475569"), padding: "5px 12px", fontSize: 12, border: "1px solid " + (crewFilter === "all" ? "#1E293B" : "#E2E8F0"), borderRadius: 16 }}>
                All crews {jobs.filter((j) => schedBuildDate(j)).length || ""}
              </button>
              {activeCrews.map((c) => {
                const on = crewFilter === c.id;
                const n = jobs.filter((j) => schedBuildDate(j) && j.crew_id === c.id).length;
                return (
                  <button key={c.id} type="button" onClick={() => setCrewFilter(on ? "all" : c.id)}
                    style={{ ...S.btn(on ? "#1E293B" : "#FFF", on ? "#FFF" : "#475569"), padding: "5px 12px", fontSize: 12, border: "1px solid " + (on ? "#1E293B" : "#E2E8F0"), borderRadius: 16, display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: c.color || ACCENT, display: "inline-block" }}></span>
                    {c.name} {n > 0 ? n : ""}
                  </button>
                );
              })}
              {activeCrews.length === 0 && (
                <span style={{ fontSize: 11.5, fontWeight: 700, color: "#B45309" }}>
                  No crews yet — add them in Settings → Team to get per-crew calendars.
                </span>
              )}
              {crewFilter !== "all" && (
                <span style={{ fontSize: 11.5, fontWeight: 700, color: ACCENT }}>
                  — {(crewById[crewFilter] || {}).name || "this crew"}'s calendar: dropping a card here schedules it AND assigns it to them
                </span>
              )}
            </div>

            {/* The ONE Unscheduled tray sits above (shared with all views) — nothing
                unscheduled renders inside the calendar itself (Carolyn 2026-08-04). */}

            {/* WEEK — the kanban feel, with days as the columns */}
            {calView === "week" && (
              <div style={{ overflowX: "auto", paddingBottom: 6 }}>
                <div style={{ display: "flex", gap: 10, alignItems: "flex-start", minWidth: "min-content" }}>
                  {weekDays.map((d) => {
                    const iso = isoLocal(d);
                    const isToday = iso === todayIso;
                    const wknd = d.getDay() === 0 || d.getDay() === 6;
                    const dayJobs = byDate[iso] || [];
                    return (
                      <div key={iso} {...dropProps(iso)}
                        style={{ width: 218, flex: "0 0 218px", background: isToday ? "#E9F0FF" : wknd ? "#F4F6F9" : "#EEF2F8", borderRadius: 12, padding: 9, minHeight: 190, outline: isToday ? "2px solid #C3D9F7" : "none", outlineOffset: -2, ...dropGlow(iso) }}>
                        <div style={{ display: "flex", alignItems: "baseline", gap: 6, padding: "1px 3px 8px" }}>
                          <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: 0.8, textTransform: "uppercase", color: isToday ? ACCENT : "#64748B" }}>{d.toLocaleDateString("en-US", { weekday: "short" })}</span>
                          <span style={{ fontSize: 16, fontWeight: 800, color: isToday ? ACCENT : "#1E293B" }}>{d.getDate()}</span>
                          <span style={{ marginLeft: "auto", fontSize: 10, fontWeight: 800, color: "#64748B", background: "#FFF", borderRadius: 999, padding: "2px 7px", fontVariantNumeric: "tabular-nums" }}>{dayJobs.length}</span>
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 7, minHeight: 40 }}>
                          {dayJobs.map((j) => jobCard(j, { hideDate: true, showStage: true }))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* MONTH — the planning radar */}
            {calView === "month" && (
              <div style={{ overflowX: "auto", paddingBottom: 6 }}>
                <div style={{ display: "grid", gridTemplateColumns: `repeat(${gridCols}, minmax(120px, 1fr))`, gap: 6, minWidth: gridCols === 7 ? 880 : 640 }}>
                  {monthHeads.map((h) => (
                    <div key={h} style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.8, textTransform: "uppercase", color: "#94A3B8", padding: "0 4px 2px" }}>{h}</div>
                  ))}
                  {monthCells.map((d) => {
                    const iso = isoLocal(d);
                    const inMonth = d.getMonth() === cur.getMonth();
                    const isToday = iso === todayIso;
                    const dayJobs = byDate[iso] || [];
                    const shown = dayJobs.slice(0, 3);
                    return (
                      <div key={iso} {...dropProps(iso)}
                        style={{ background: inMonth ? "#FFF" : "#F8FAFC", opacity: inMonth ? 1 : 0.55, border: "1px solid #E2E8F0", borderRadius: 9, minHeight: 92, padding: "6px 7px", outline: isToday ? `2px solid ${ACCENT}` : "none", outlineOffset: -2, ...dropGlow(iso) }}>
                        <div style={{ fontSize: 11.5, fontWeight: 800, color: isToday ? ACCENT : "#475569", marginBottom: 5 }}>{d.getDate()}</div>
                        {shown.map((j) => (
                          <div key={j.id} title={(j.customer_name || j.title || "") + " · " + (j.building_label || "")}
                            onClick={() => { setCursorMs(d.getTime()); setCalView("week"); }}
                            style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, fontWeight: 700, background: "#F1F5F9", borderRadius: 6, padding: "3px 6px", marginBottom: 4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", cursor: "pointer" }}>
                            <span style={{ width: 8, height: 8, borderRadius: "50%", background: stageColor[j.stage_id] || "#94A3B8", flexShrink: 0 }}></span>
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{j.serial ? "#" + j.serial + " " : ""}{j.customer_name || j.title || ""}</span>
                          </div>
                        ))}
                        {dayJobs.length > 3 && (
                          <div style={{ fontSize: 9.5, fontWeight: 800, color: "#94A3B8", cursor: "pointer" }}
                            onClick={() => { setCursorMs(d.getTime()); setCalView("week"); }}>+{dayJobs.length - 3} more</div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            <p style={{ fontSize: 11.5, color: "#64748B", fontWeight: 600, lineHeight: 1.5, marginTop: 10 }}>
              One build date per card — dropping a card on a day IS the reschedule. Flip between crew calendars above: on a crew's calendar, a drop schedules the job and hands it to that crew in one motion. Click a month pill to open that week. Rescheduling from the calendar is admin-only.
            </p>
          </div>
        );
      })()}

      <p style={{ fontSize: 11.5, color: "#64748B", fontWeight: 600, lineHeight: 1.5, marginTop: 12 }}>
        Drag cards between stages — team members can move cards and add notes; dates, assignments, and new jobs are admin-only. Every move is logged with who and when. Click a card to see and edit everything in place.
      </p>

      {editingStages && (
        <SchedStageEditor stages={stages} busy={busy} onClose={() => setEditingStages(false)} onSave={saveStages} />
      )}
    </div>
  );
}

// ─── Repairs tab (SCHEDULING_SCOPE.md Phase 3) ───
// Intake + tracking + service history. A repair is logged ONCE, then scheduled where the
// work happens: shop work becomes a build_jobs card (source='repair'); field visits ride
// a delivery load (Phase 4). Status is a FIXED customer-facing ladder — not tenant-custom.
// "Not one of ours" is allowed: builders repair competitors' sheds too, so the building
// fields are optional. Layout is list + always-visible detail card (no popouts).
// Same operator-only gate as Build Schedule until the Phase 5 billing flip.
const REPAIR_STATUS = {
  requested:   { label: "Requested",   bg: "#F1F5F9", fg: "#475569" },
  approved:    { label: "Approved",    bg: "#EEF2FF", fg: "#3D3672" },
  in_progress: { label: "In progress", bg: "#FFFBEB", fg: "#B45309" },
  completed:   { label: "Completed",   bg: "#F0FDF4", fg: "#15803D" },
  declined:    { label: "Declined",    bg: "#FEF2F2", fg: "#DC2626" },
};
const REPAIR_OPEN = new Set(["requested", "approved", "in_progress"]);
// Quote money arrives however people type it — "$1,200", "1 200.50" — so strip the
// dressing before Number(). Blank → null (an intentional clear). Unparseable → NaN,
// which the caller must REFUSE with a message and never send: quoteCents:null is the
// server's "clear quote_cents" (update_repair), so mapping a typo like "12o0" to null
// silently erased a real quote on file (audit 2026-08-20).
const repairQuoteCents = (raw) => {
  const s = String(raw ?? "").replace(/[$,\s]/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
};

function RepairsTab({ clientId, canAdmin, access = null }) {
  // repairs:'edit' (migration 100) — the Crew Leader preset carries it. Same reasoning as
  // the Build Schedule: the old owner/admin gate hid intake and status from the people
  // whose job this is.
  const canEdit = canAdmin || !!(access && access.repairs === "edit");
  // Putting a repair on a load is a DELIVERY write, not a repairs one — gate it on that.
  const canDeliver = canAdmin || !!(access && access.delivery_schedule === "edit");
  const [data, setData] = useState(null);        // { repairs, jobs, stops } | null = loading
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("open");
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [intakeOpen, setIntakeOpen] = useState(false);
  const [loadPick, setLoadPick] = useState(null);  // null = picker closed; array = planned loads
  const [intake, setIntake] = useState({ customerName: "", phone: "", email: "", serial: "", description: "", quote: "" });
  const [photos, setPhotos] = useState(null);    // for the selected repair; null = loading
  const [detail, setDetail] = useState(null);    // editable copy of the selected repair
  const fileRef = useRef(null);

  const call = async (body, okMsg) => {
    const { data: d, error: err } = await sb.functions.invoke("portal-schedule", { body });
    if (err || !d || d.error) {
      setMsg({ err: (d && d.error) || (err ? await fnError(err) : "That didn't work.") });
      return null;
    }
    if (okMsg) setMsg({ ok: okMsg });
    return d;
  };
  const load = useCallback(async () => {
    setError(null);
    const { data: d, error: err } = await sb.functions.invoke("portal-schedule", { body: { action: "list_repairs" } });
    if (err || !d || d.error) {
      setError((d && d.error) || (err ? await fnError(err) : "Could not load repairs."));
      setData({ repairs: [], jobs: [], stops: [] });
      return;
    }
    setData(d);
  }, [clientId]);
  useEffect(() => { load(); }, [load]);

  const repairs = (data && data.repairs) || [];
  const jobs = (data && data.jobs) || [];
  const stops = (data && data.stops) || [];
  const jobByRepair = {}; jobs.forEach((j) => { jobByRepair[j.repair_id] = j; });
  const stopsByRepair = {}; stops.forEach((s) => { (stopsByRepair[s.repair_id] = stopsByRepair[s.repair_id] || []).push(s); });
  const selected = repairs.find((r) => r.id === selectedId) || null;

  // Auto-select the first row so the detail column is never empty for no reason.
  useEffect(() => {
    if (!selectedId && repairs.length) setSelectedId(repairs[0].id);
  }, [repairs.length]);
  // Editable detail copy + photos, refreshed whenever the selection changes.
  useEffect(() => {
    if (!selected) { setDetail(null); setPhotos(null); return; }
    setDetail({ status: selected.status, quote: selected.quote_cents == null ? "" : String(selected.quote_cents / 100), notes: selected.notes || "" });
    setPhotos(null);
    setLoadPick(null);   // a picker left open would apply to the wrong repair
    let dead = false;
    (async () => {
      const { data: d } = await sb.functions.invoke("portal-schedule", { body: { action: "repair_photos", repairId: selected.id } });
      if (!dead) setPhotos((d && d.photos) || []);
    })();
    return () => { dead = true; };
  }, [selectedId, data]);

  const counts = { open: 0, in_progress: 0, done30: 0, quotedCents: 0 };
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
  repairs.forEach((r) => {
    if (REPAIR_OPEN.has(r.status)) counts.open++;
    if (r.status === "in_progress") counts.in_progress++;
    if (r.status === "completed" && (r.completed_at || "") >= cutoff) counts.done30++;
    if (REPAIR_OPEN.has(r.status) && r.quote_cents) counts.quotedCents += r.quote_cents;
  });

  const filtered = repairs.filter((r) => {
    if (statusFilter === "open" && !REPAIR_OPEN.has(r.status)) return false;
    if (statusFilter !== "all" && statusFilter !== "open" && r.status !== statusFilter) return false;
    if (!query.trim()) return true;
    return rowMatchesQuery(r, query, "R-" + (r.repair_no || "") + " #" + (r.serial || ""));
  });

  const createRepair = async () => {
    if (!intake.customerName.trim() || !intake.description.trim()) {
      setMsg({ err: "Customer name and a description of the problem are required." }); return;
    }
    const quoteCents = repairQuoteCents(intake.quote);
    if (Number.isNaN(quoteCents)) {
      setMsg({ err: `Couldn't read "${intake.quote}" as a dollar amount — try digits, like 1200 or 1,200.50.` }); return;
    }
    setBusy(true); setMsg(null);
    const r = await call({
      action: "create_repair", customerName: intake.customerName, phone: intake.phone, email: intake.email,
      // Raw — the server decides whether that's a serial or a design code and links the
      // building either way. Parsing it here would drop the code half on the floor.
      buildingRef: intake.serial.trim() || null,
      description: intake.description, quoteCents,
    });
    setBusy(false);
    if (r && r.repair) {
      setMsg({ ok: `R-${r.repair.repair_no} logged for ${r.repair.customer_name}.` });
      setIntake({ customerName: "", phone: "", email: "", serial: "", description: "", quote: "" });
      setIntakeOpen(false);
      await load();
      setSelectedId(r.repair.id);
    }
  };
  const saveDetail = async () => {
    if (!selected || !detail) return;
    const quoteCents = repairQuoteCents(detail.quote);
    if (Number.isNaN(quoteCents)) {
      setMsg({ err: `Couldn't read "${detail.quote}" as a dollar amount — try digits, like 1200 or 1,200.50.` }); return;
    }
    setBusy(true); setMsg(null);
    const r = await call({
      action: "update_repair", repairId: selected.id, status: detail.status,
      quoteCents, notes: detail.notes,
    }, "Saved.");
    setBusy(false); if (r) load();
  };
  const deleteRepair = async () => {
    if (!selected) return;
    if (!window.confirm(`Delete R-${selected.repair_no}? Its photos and any schedule cards are removed too.`)) return;
    setBusy(true); setMsg(null);
    const r = await call({ action: "delete_repair", repairId: selected.id }, `R-${selected.repair_no} deleted.`);
    setBusy(false);
    if (r) { setSelectedId(null); load(); }
  };
  const scheduleShopWork = async () => {
    if (!selected) return;
    setBusy(true); setMsg(null);
    const r = await call({ action: "create_job", source: "repair", repairId: selected.id },
      `R-${selected.repair_no} added to the Build Schedule.`);
    setBusy(false); if (r) load();
  };
  // Site visit = a stop on a delivery load. The loads list is fetched only when asked for:
  // it is a delivery_schedule read, and a Crew Leader (repairs:edit, no delivery access)
  // must not have this whole tab 403 just because the control exists.
  const openLoadPick = async () => {
    setBusy(true); setMsg(null);
    const { data: d, error } = await sb.functions.invoke("portal-schedule", { body: { action: "loads" } });
    setBusy(false);
    if (error || !d || d.error) { setMsg({ err: (d && d.error) || "Could not read the delivery schedule." }); return; }
    setLoadPick((d.loads || []).filter((l) => l.status === "planned"));
  };
  const addSiteVisit = async (loadId) => {
    if (!selected) return;
    setBusy(true); setMsg(null);
    let target = loadId;
    if (target === "new") {
      const created = await call({ action: "create_load" });
      if (!created || !created.load) { setBusy(false); return; }
      target = created.load.id;
    }
    const r = await call({ action: "add_stop", loadId: target, source: "repair", repairId: selected.id },
      `R-${selected.repair_no} added to the load.`);
    setBusy(false);
    if (r) { setLoadPick(null); load(); }
  };
  const uploadPhoto = async (file) => {
    if (!selected || !file) return;
    if (file.size > 10 * 1024 * 1024) { setMsg({ err: "That photo is over 10 MB." }); return; }
    setBusy(true); setMsg(null);
    const b64 = await new Promise((resolve, reject) => {
      const rd = new FileReader();
      rd.onload = () => resolve(String(rd.result).split(",")[1] || "");
      rd.onerror = reject;
      rd.readAsDataURL(file);
    }).catch(() => null);
    if (!b64) { setBusy(false); setMsg({ err: "Could not read that file." }); return; }
    const r = await call({ action: "upload_repair_photo", repairId: selected.id, fileName: file.name, contentType: file.type, dataBase64: b64 }, "Photo added.");
    setBusy(false);
    if (r) setPhotos((p) => [...(p || []), { path: r.path, url: r.url }]);
  };
  const deletePhoto = async (photo) => {
    if (!window.confirm("Remove this photo?")) return;
    setBusy(true); setMsg(null);
    const r = await call({ action: "delete_repair_photo", path: photo.path }, "Photo removed.");
    setBusy(false);
    if (r) setPhotos((p) => (p || []).filter((x) => x.path !== photo.path));
  };

  const chip = (k, label, n) => {
    const on = statusFilter === k;
    return (
      <button key={k} type="button" onClick={() => setStatusFilter(on && k !== "open" ? "open" : k)}
        style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 700, borderRadius: 16, padding: "5px 12px", background: on ? "#1E293B" : "#FFF", color: on ? "#FFF" : "#475569", border: `1px solid ${on ? "#1E293B" : "#E2E8F0"}` }}>
        {label}<span style={{ fontSize: 10.5, opacity: 0.75 }}>{n}</span>
      </button>
    );
  };
  const statusChip = (s) => {
    const c = REPAIR_STATUS[s] || REPAIR_STATUS.requested;
    return <span style={schedChip(c.bg, c.fg)}>{c.label}</span>;
  };
  const lbl = { ...S.lbl, marginBottom: 3 };
  const history = selected && selected.serial
    ? repairs.filter((r) => r.serial === selected.serial && r.id !== selected.id)
    : [];
  const selJob = selected && jobByRepair[selected.id];
  const selStops = (selected && stopsByRepair[selected.id]) || [];

  return (
    <div style={S.card}>
      <CardHead title="Repairs" count={repairs.length}
        right={<>
          <button type="button" onClick={load} style={S.btn("#F1F5F9", "#334155")}>↻ Refresh</button>
          {canEdit && <button type="button" onClick={() => setIntakeOpen(!intakeOpen)} style={S.btn(ACCENT, "#FFF")}>+ Log a repair</button>}
        </>} />

      {data && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginBottom: 13 }}>
          {[["Open", counts.open], ["In progress", counts.in_progress], ["Completed · 30 days", counts.done30], ["Quoted · open", invMoney(counts.quotedCents || null)]].map(([t, n]) => (
            <div key={t} style={{ background: "#FFF", border: "1px solid #E2E8F0", borderRadius: 12, padding: "10px 14px" }}>
              <div style={{ fontSize: 21, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>{n == null ? "—" : n}</div>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: "#64748B", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 1 }}>{t}</div>
            </div>
          ))}
        </div>
      )}

      {msg && msg.ok && <div style={S.okMsg}>{msg.ok}</div>}
      {msg && msg.err && <div style={S.err}>{msg.err}</div>}
      {error && <div style={S.err}>{error}</div>}
      {data === null && <p style={{ fontSize: 13, color: "#64748B", padding: 12 }}>Loading…</p>}

      {/* ── Intake ── */}
      {intakeOpen && canEdit && (
        <div style={{ border: "1px dashed #B9C4D6", borderRadius: 12, padding: "12px 14px", marginBottom: 13 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: "8px 12px", marginBottom: 8 }}>
            <div><span style={lbl}>Customer *</span><input style={S.input} value={intake.customerName} onChange={(e) => setIntake({ ...intake, customerName: e.target.value })} /></div>
            <div><span style={lbl}>Phone</span><input style={S.input} value={intake.phone} onChange={(e) => setIntake({ ...intake, phone: e.target.value })} /></div>
            <div><span style={lbl}>Email</span><input style={S.input} value={intake.email} onChange={(e) => setIntake({ ...intake, email: e.target.value })} /></div>
            <div><span style={lbl}>Building serial # or design code <span style={{ fontWeight: 500, textTransform: "none" }}>(blank if not one of ours)</span></span><input style={S.input} value={intake.serial} onChange={(e) => setIntake({ ...intake, serial: e.target.value })} placeholder="e.g. 11640 or SS-NR4DV8XK2P" /></div>
            <div><span style={lbl}>Quote ($)</span><input style={S.input} value={intake.quote} onChange={(e) => setIntake({ ...intake, quote: e.target.value })} placeholder="optional" /></div>
          </div>
          <span style={lbl}>What's wrong? *</span>
          <textarea style={{ ...S.input, minHeight: 54, resize: "vertical", fontFamily: "inherit" }} value={intake.description}
            onChange={(e) => setIntake({ ...intake, description: e.target.value })}
            placeholder="e.g. Roof leak at ridge cap after storm — water staining on loft decking, NE corner." />
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 9 }}>
            <button type="button" style={S.btn("#F1F5F9", "#334155")} onClick={() => setIntakeOpen(false)}>Cancel</button>
            <button type="button" disabled={busy} style={S.btn(ACCENT, "#FFF")} onClick={createRepair}>Log repair</button>
          </div>
        </div>
      )}

      {data && repairs.length === 0 && !error && (
        <p style={{ fontSize: 13, color: "#64748B", padding: 12 }}>
          No repairs yet. Click <strong>+ Log a repair</strong> when a customer calls — it takes a repair number automatically, and you can schedule the work on the Build Schedule from here.
        </p>
      )}

      {data && repairs.length > 0 && (<>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search — customer, serial #, description…"
          style={{ ...S.input, width: "100%", boxSizing: "border-box", marginBottom: 10 }} />
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
          {chip("open", "Open", counts.open)}
          {chip("all", "All", repairs.length)}
          {Object.keys(REPAIR_STATUS).map((k) => {
            const n = repairs.filter((r) => r.status === k).length;
            return n > 0 && chip(k, REPAIR_STATUS[k].label, n);
          })}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "minmax(330px, 1.5fr) minmax(300px, 1fr)", gap: 14, alignItems: "start" }}>
          {/* ── List ── */}
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>
                {["Repair", "Customer", "Building", "Requested", "Quote", "Status"].map((h) => <th key={h} style={S.th}>{h}</th>)}
              </tr></thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.id} onClick={() => setSelectedId(r.id)}
                    style={{ cursor: "pointer", background: r.id === selectedId ? "#F7F9FF" : "transparent" }}>
                    <td style={{ ...S.td, fontWeight: 800, color: "#64748B", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>R-{r.repair_no}</td>
                    <td style={S.td}><strong>{r.customer_name}</strong></td>
                    <td style={S.td}>{r.serial ? "#" + r.serial : <span style={{ color: "#94A3B8", fontWeight: 600, fontSize: 12 }}>not one of ours</span>}</td>
                    <td style={{ ...S.td, whiteSpace: "nowrap" }}>{fmtDate(r.requested_at)}</td>
                    <td style={{ ...S.td, fontVariantNumeric: "tabular-nums" }}>{invMoney(r.quote_cents)}</td>
                    <td style={S.td}>{statusChip(r.status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filtered.length === 0 && <p style={{ fontSize: 13, color: "#64748B", padding: 12 }}>No repairs match.</p>}
          </div>

          {/* ── Detail (always visible, never a popout) ── */}
          {selected && detail && (
            <div style={{ background: "#FFF", border: "1px solid #E2E8F0", borderRadius: 12, padding: "14px 16px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 11 }}>
                <span style={{ fontSize: 13, fontWeight: 800, color: "#64748B", fontVariantNumeric: "tabular-nums" }}>R-{selected.repair_no}</span>
                <span style={{ ...S.h2, marginBottom: 0, flex: 1 }}>{selected.customer_name}</span>
                {statusChip(selected.status)}
              </div>
              <div style={{ marginBottom: 10 }}>
                <span style={lbl}>Building</span>
                <div style={{ fontSize: 13, fontWeight: 700 }}>
                  {selected.serial ? <>Serial #{selected.serial}</> : "Not one of ours"}
                  {selected.design_short_code ? <span style={{ color: "#64748B", fontWeight: 600 }}> · {selected.design_short_code}</span> : null}
                </div>
              </div>
              <div style={{ marginBottom: 10 }}>
                <span style={lbl}>Problem</span>
                <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: "pre-wrap" }}>{selected.description}</div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 12px", marginBottom: 10 }}>
                <div><span style={lbl}>Contact</span><div style={{ fontSize: 13, fontWeight: 600 }}>{selected.phone || selected.email || "—"}</div></div>
                <div>
                  <span style={lbl}>Quote ($)</span>
                  {canEdit
                    ? <input style={{ ...S.input, padding: "6px 8px" }} value={detail.quote} onChange={(e) => setDetail({ ...detail, quote: e.target.value })} />
                    : <div style={{ fontSize: 13, fontWeight: 700 }}>{invMoney(selected.quote_cents)}</div>}
                </div>
              </div>
              {canEdit && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 12px", marginBottom: 10 }}>
                  <div>
                    <span style={lbl}>Status</span>
                    <select style={{ ...S.input, padding: "6px 8px" }} value={detail.status} onChange={(e) => setDetail({ ...detail, status: e.target.value })}>
                      {Object.keys(REPAIR_STATUS).map((k) => <option key={k} value={k}>{REPAIR_STATUS[k].label}</option>)}
                    </select>
                  </div>
                  <div><span style={lbl}>Internal notes</span><input style={{ ...S.input, padding: "6px 8px" }} value={detail.notes} onChange={(e) => setDetail({ ...detail, notes: e.target.value })} /></div>
                </div>
              )}

              <span style={lbl}>Photos</span>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "5px 0 11px" }}>
                {photos === null && <span style={{ fontSize: 12, color: "#94A3B8", fontWeight: 600 }}>Loading…</span>}
                {(photos || []).map((p) => (
                  <div key={p.path} style={{ position: "relative" }}>
                    <a href={p.url} target="_blank" rel="noopener noreferrer">
                      <img src={p.url} alt="Repair photo" style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 9, border: "1px solid #E2E8F0", display: "block" }} />
                    </a>
                    {canEdit && (
                      <button type="button" onClick={() => deletePhoto(p)} title="Remove photo" aria-label="Remove photo"
                        style={{ position: "absolute", top: -6, right: -6, width: 18, height: 18, borderRadius: "50%", border: "1px solid #FECACA", background: "#FEF2F2", color: "#DC2626", fontSize: 10, fontWeight: 800, cursor: "pointer", lineHeight: 1, padding: 0 }}>×</button>
                    )}
                  </div>
                ))}
                {canEdit && (
                  <button type="button" disabled={busy} onClick={() => fileRef.current && fileRef.current.click()}
                    style={{ width: 64, height: 64, borderRadius: 9, border: "1px dashed #CBD5E1", background: "#FFF", color: "#94A3B8", fontSize: 20, fontWeight: 700, cursor: "pointer" }}>+</button>
                )}
                <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" style={{ display: "none" }}
                  onChange={(e) => { const f = e.target.files && e.target.files[0]; if (f) uploadPhoto(f); e.target.value = ""; }} />
              </div>

              <span style={lbl}>Scheduling</span>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "5px 0 11px" }}>
                {selJob
                  ? <span style={schedChip("#F0FDF4", "#15803D")}>On the Build Schedule ✓</span>
                  : (canEdit && <button type="button" disabled={busy} style={{ ...S.btn("#FFF", "#475569"), border: "1px solid #CBD5E1", padding: "6px 11px", fontSize: 12 }} onClick={scheduleShopWork}>Schedule shop work →</button>)}
                {selStops.length > 0
                  ? <span style={schedChip("#EEF2FF", "#3D3672")}>{selStops.some((s) => s.delivered_at) ? "Site visit done ✓" : "Site visit on a load ✓"}</span>
                  : canDeliver
                    ? (loadPick === null
                        ? <button type="button" disabled={busy} style={{ ...S.btn("#FFF", "#475569"), border: "1px solid #CBD5E1", padding: "6px 11px", fontSize: 12 }}
                            onClick={openLoadPick}>Site visit — add to a load →</button>
                        : <select disabled={busy} value="" onChange={(e) => { if (e.target.value) addSiteVisit(e.target.value); }}
                            style={{ ...S.input, padding: "6px 8px", fontSize: 12, width: "auto", fontWeight: 700 }}>
                            <option value="">{loadPick.length ? "Pick a load…" : "No planned loads — start one"}</option>
                            {loadPick.map((l) => <option key={l.id} value={l.id}>Load {l.load_no}{l.load_date ? " · " + schedDayLabel(l.load_date) : ""}</option>)}
                            <option value="new">➕ New load</option>
                          </select>)
                    : <span style={{ fontSize: 11.5, color: "#94A3B8", fontWeight: 600, alignSelf: "center" }}>Site visits ride a delivery load — ask someone with Delivery Schedule access to add it.</span>}
              </div>

              {history.length > 0 && (<>
                <span style={lbl}>Service history — building #{selected.serial}</span>
                <div style={{ borderLeft: "2px solid #E2E8F0", padding: "2px 0 2px 12px", margin: "6px 0 11px 4px" }}>
                  {history.map((h) => (
                    <div key={h.id} style={{ marginBottom: 8, cursor: "pointer" }} onClick={() => setSelectedId(h.id)}>
                      <div style={{ fontSize: 10.5, fontWeight: 700, color: "#94A3B8", fontVariantNumeric: "tabular-nums" }}>{fmtDate(h.requested_at)} · R-{h.repair_no}</div>
                      <div style={{ fontSize: 12.5, fontWeight: 700 }}>{(h.description || "").slice(0, 70)}</div>
                      <div style={{ fontSize: 11, color: "#64748B", fontWeight: 600 }}>{(REPAIR_STATUS[h.status] || {}).label}{h.quote_cents ? " · " + invMoney(h.quote_cents) : ""}</div>
                    </div>
                  ))}
                </div>
              </>)}

              {canEdit && (
                <div style={{ display: "flex", gap: 8, borderTop: "1px solid #F1F5F9", paddingTop: 10 }}>
                  <button type="button" disabled={busy} style={S.btn(ACCENT, "#FFF")} onClick={saveDetail}>Save</button>
                  <button type="button" disabled={busy} style={{ ...S.btn("#FEF2F2", "#DC2626"), marginLeft: "auto" }} onClick={deleteRepair}>Delete</button>
                </div>
              )}
            </div>
          )}
        </div>
      </>)}

      <p style={{ fontSize: 11.5, color: "#64748B", fontWeight: 600, lineHeight: 1.5, marginTop: 12 }}>
        Log a repair once, then schedule the work where it happens — shop repairs go on the Build Schedule; site visits ride a delivery load as a stop. Service history follows the building's serial number forever.
      </p>
    </div>
  );
}

// ─── Delivery Schedule = the Load Planner (SCHEDULING_SCOPE.md Phase 4, decision 5) ───
// NOT a kanban: the unit of scheduling is a LOAD — one driver (with their truck), one day,
// one route — holding ordered STOPS. The "to be loaded" pool is a QUERY (built order jobs /
// sold units / open repairs without a stop), never a table. Deck-fit runs against the
// DRIVER'S snapshotted deck length; WIDE is computed from real dimensions. The
// built-before-delivered rule blocks going out/delivered, with an owner/admin override
// (required reason, audit-logged, permanent chip — decision 11). Width has NO override.
// Everything renders at face value — the load card reads as the driver's run sheet.
// Same operator-only gate as Build Schedule until the Phase 5 billing flip.
const schedFtNum = (v) => v == null ? null : Number(v);
const schedDayLabel = (iso) => {
  if (!iso) return "No date yet";
  try {
    return new Date(iso + "T00:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  } catch (_e) { return iso; }
};
const SCHED_LOAD_STATUS = {
  planned:   { label: "Planned",   bg: "#EEF2FF", fg: "#3D3672" },
  out:       { label: "Out",       bg: "#FFFBEB", fg: "#B45309" },
  delivered: { label: "Delivered", bg: "#F0FDF4", fg: "#15803D" },
};

// Inline stop editor (expand-in-place; no popouts).
function SchedStopEditor({ stop, territories, busy, onSave, onCancel }) {
  const [f, setF] = useState({
    destStreet: stop.dest_street || "", destCity: stop.dest_city || "", destState: stop.dest_state || "", destZip: stop.dest_zip || "",
    territoryId: stop.territory_id || "", legMiles: stop.leg_miles == null ? "" : String(stop.leg_miles),
    timeWindow: stop.time_window || "", siteNotes: stop.site_notes || "", customerPhone: stop.customer_phone || "",
  });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const inp = { ...S.input, padding: "5px 7px", fontSize: 12 };
  const lbl = { ...S.lbl, marginBottom: 2, fontSize: 10 };
  return (
    <div style={{ background: "#F7F9FF", borderRadius: 8, padding: "9px 11px", margin: "2px 0 4px" }} onClick={(e) => e.stopPropagation()}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: "7px 9px" }}>
        <div style={{ gridColumn: "span 2" }}><span style={lbl}>Street</span><input style={inp} value={f.destStreet} onChange={set("destStreet")} /></div>
        <div><span style={lbl}>City</span><input style={inp} value={f.destCity} onChange={set("destCity")} /></div>
        <div><span style={lbl}>State</span><input style={inp} value={f.destState} onChange={set("destState")} /></div>
        <div><span style={lbl}>Zip</span><input style={inp} value={f.destZip} onChange={set("destZip")} /></div>
        <div>
          <span style={lbl}>Territory</span>
          <select style={inp} value={f.territoryId} onChange={set("territoryId")}>
            <option value="">—</option>
            {territories.filter((t) => t.active !== false).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        <div><span style={lbl}>Leg (mi from previous)</span><input style={inp} value={f.legMiles} onChange={set("legMiles")} /></div>
        <div><span style={lbl}>Window</span><input style={inp} value={f.timeWindow} onChange={set("timeWindow")} placeholder="8–10 AM" /></div>
        <div><span style={lbl}>Phone</span><input style={inp} value={f.customerPhone} onChange={set("customerPhone")} /></div>
        <div style={{ gridColumn: "1 / -1" }}><span style={lbl}>Site notes (gate codes, ground, dogs…)</span><input style={inp} value={f.siteNotes} onChange={set("siteNotes")} /></div>
      </div>
      <div style={{ display: "flex", gap: 7, justifyContent: "flex-end", marginTop: 8 }}>
        <button type="button" style={{ ...S.btn("#F1F5F9", "#334155"), padding: "5px 11px", fontSize: 12 }} onClick={onCancel}>Cancel</button>
        <button type="button" disabled={busy} style={{ ...S.btn(ACCENT, "#FFF"), padding: "5px 11px", fontSize: 12 }}
          onClick={() => onSave({
            destStreet: f.destStreet, destCity: f.destCity, destState: f.destState, destZip: f.destZip,
            territoryId: f.territoryId || null, legMiles: f.legMiles === "" ? null : Number(f.legMiles),
            timeWindow: f.timeWindow, siteNotes: f.siteNotes, customerPhone: f.customerPhone,
          })}>Save stop</button>
      </div>
    </div>
  );
}

function DeliveryScheduleTab({ clientId, canAdmin, access = null }) {
  // delivery_schedule:'edit' (migration 100) — the Driver preset carries it, which is the
  // point: a driver plans and closes out their own loads.
  //
  // canEdit SURVIVES in exactly one place below — the built-before-delivered override.
  // Decision 11 says crew cannot override, and since the gate for mark_load_out is the
  // very level a Driver holds, the role check is the only thing separating "may dispatch"
  // from "may overrule the built check". portal-schedule re-checks it server-side.
  const canEdit = canAdmin || !!(access && access.delivery_schedule === "edit");
  const [data, setData] = useState(null);      // loads payload
  const [pool, setPool] = useState(null);      // pool payload
  const [error, setError] = useState(null);
  const [view, setView] = useState("loads");   // loads | table | calendar
  const [weekOffset, setWeekOffset] = useState(0);
  const [monthCursor, setMonthCursor] = useState(() => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d.getTime(); });
  const [calView, setCalView] = useState("week");            // calendar zoom: week | month
  const [showWeekends, setShowWeekends] = useState(false);   // calendar: Sat/Sun columns off by default (matches Build Schedule)
  const [driverFilter, setDriverFilter] = useState("all");
  const [dragItem, setDragItem] = useState(null);            // a to-be-loaded item being dragged onto the calendar
  const [dropKey, setDropKey] = useState(null);              // "day:<iso>" | "load:<id>" for the drop glow
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [newLoad, setNewLoad] = useState(null);          // { driverId, loadDate, routeLabel } | null
  const [editLoadId, setEditLoadId] = useState(null);    // header edit
  const [editStopId, setEditStopId] = useState(null);
  const [override, setOverride] = useState(null);        // { loadId, action, unbuilt, reason, complete }

  // Full-body call: on a non-2xx we still need the JSON (the 409 carries blocked+unbuilt).
  const callFull = async (body) => {
    const { data: d, error: err } = await sb.functions.invoke("portal-schedule", { body });
    if (d && !d.error) return { ok: true, data: d };
    let payload = d || null;
    try {
      const ctx = err && err.context;
      if (!payload && ctx && typeof ctx.json === "function") {
        payload = await (typeof ctx.clone === "function" ? ctx.clone() : ctx).json();
      }
    } catch (_e) { /* fall through */ }
    return { ok: false, data: payload || {}, message: (payload && payload.error) || (err && err.message) || "That didn't work." };
  };
  const call = async (body, okMsg) => {
    const r = await callFull(body);
    if (!r.ok) { setMsg({ err: r.message }); return null; }
    if (okMsg) setMsg({ ok: okMsg });
    return r.data;
  };
  const load = useCallback(async () => {
    setError(null);
    const [l, p] = await Promise.all([
      sb.functions.invoke("portal-schedule", { body: { action: "loads" } }),
      sb.functions.invoke("portal-schedule", { body: { action: "pool" } }),
    ]);
    if (l.error || !l.data || l.data.error) {
      setError((l.data && l.data.error) || (l.error ? await fnError(l.error) : "Could not load the delivery schedule."));
      setData({ loads: [], stops: [], buildByJob: {}, drivers: [], territories: [], team: [] });
    } else setData(l.data);
    if (!p.error && p.data && !p.data.error) setPool(p.data);
    else setPool({ orders: [], inventory: [], repairs: [] });
  }, [clientId]);
  useEffect(() => { load(); }, [load]);

  const loads = (data && data.loads) || [];
  const stops = (data && data.stops) || [];
  const buildByJob = (data && data.buildByJob) || {};
  // Where each inventory unit on these loads / in the pool actually is on the build ladder.
  // Both responses carry it, so a stop and its pool row agree.
  const unitLifecycle = { ...((pool && pool.unitLifecycle) || {}), ...((data && data.unitLifecycle) || {}) };
  const drivers = (data && data.drivers) || [];
  const territories = (data && data.territories) || [];
  const team = (data && data.team) || [];
  const nameOf = {}; team.forEach((m) => { nameOf[m.userId] = m.name; });
  // Drivers are name-first profiles (095): resolve a load's driver by profile id, falling
  // back to the legacy user link on old rows.
  const profById = {}; const profByUser = {};
  drivers.forEach((p) => { profById[p.id] = p; if (p.user_id) profByUser[p.user_id] = p; });
  const loadProf = (l) => profById[l.driver_id] || profByUser[l.driver_user_id] || null;
  const profName = (p) => p ? (p.display_name || nameOf[p.user_id] || "Driver") : "No driver";
  const terrName = {}; territories.forEach((t) => { terrName[t.id] = t.name; });
  const stopsByLoad = {}; stops.forEach((s) => { (stopsByLoad[s.load_id] = stopsByLoad[s.load_id] || []).push(s); });
  Object.keys(stopsByLoad).forEach((k) => stopsByLoad[k].sort((a, b) => a.stop_order - b.stop_order));

  // `jobs` = every non-repair building on the build board without a stop (orders,
  // inventory spec builds, manual); older function versions called it `orders`.
  const poolJobs = (pool && (pool.jobs || pool.orders)) || [];
  const poolInv = (pool && pool.inventory) || [];
  const poolRepairs = (pool && pool.repairs) || [];
  const poolCount = poolJobs.length + poolInv.length + poolRepairs.length;
  const plannedLoads = loads.filter((l) => l.status === "planned");

  // A stop conflicts when its load has a date but the linked build isn't done and is due
  // after that date (or has no due date at all).
  const stopConflict = (s, l) => {
    if (!s.build_job_id || !l || !l.load_date) return false;
    const b = buildByJob[s.build_job_id];
    if (!b || b.kind === "done") return false;
    return !b.dueDate || b.dueDate > l.load_date;
  };
  const loadConflicts = {};
  loads.forEach((l) => { loadConflicts[l.id] = (stopsByLoad[l.id] || []).some((s) => stopConflict(s, l)); });
  const conflictCount = Object.keys(loadConflicts).filter((k) => loadConflicts[k]).length;
  const wideCount = loads.filter((l) => l.is_wide && l.status !== "delivered").length;
  // LOCAL today, not toISOString(): UTC is already tomorrow by ~8pm for US tenants,
  // which shifted this whole window a day (audit 2026-08-20).
  const weekAhead = (() => { const d = new Date(); d.setDate(d.getDate() + 7); return schedLocalIso(d); })();
  const todayIso = schedLocalIso(new Date());
  const thisWeek = loads.filter((l) => l.status !== "delivered" && l.load_date && l.load_date >= todayIso && l.load_date <= weekAhead).length;

  const visibleLoads = loads.filter((l) => driverFilter === "all" || ((loadProf(l) || {}).id === driverFilter));
  // Group by day (date-less loads last, under "No date yet").
  const dayKeys = []; const byDay = {};
  visibleLoads.slice().sort((a, b) => String(a.load_date || "9999").localeCompare(String(b.load_date || "9999"))).forEach((l) => {
    const k = l.load_date || "";
    if (!byDay[k]) { byDay[k] = []; dayKeys.push(k); }
    byDay[k].push(l);
  });

  // ── Actions ──
  const createLoad = async (fields) => {
    setBusy(true); setMsg(null);
    const r = await call({ action: "create_load", driverId: fields.driverId || null, loadDate: fields.loadDate || null, routeLabel: fields.routeLabel || null });
    setBusy(false);
    if (r && r.load) { setNewLoad(null); await load(); return r.load; }
    return null;
  };
  const addToLoad = async (loadId, body, label) => {
    let target = loadId;
    if (target === "new") {
      const l = await createLoad({});
      if (!l) return;
      target = l.id;
    }
    setBusy(true); setMsg(null);
    const r = await call({ action: "add_stop", loadId: target, ...body }, `${label} added to the load.`);
    setBusy(false); if (r) load();
  };
  // Calendar drag-and-drop: drop a to-be-loaded building on a DAY to start a new load there, or
  // on an existing load's card to add it as a stop. Both reuse createLoad/addToLoad.
  const dropOnDay = async (iso, item) => {
    if (!item || busy) return;
    setBusy(true); setMsg(null);
    const r = await call({ action: "create_load", loadDate: iso });
    setBusy(false);
    if (r && r.load) await addToLoad(r.load.id, item.body, item.label);
    else load();
  };
  const dropOnLoad = async (loadId, item) => {
    if (!item || busy) return;
    await addToLoad(loadId, item.body, item.label);
  };
  const saveLoadHeader = async (l, fields) => {
    setBusy(true); setMsg(null);
    const r = await call({ action: "update_load", loadId: l.id, ...fields }, "Load saved.");
    setBusy(false); if (r) { setEditLoadId(null); load(); }
  };
  const deleteLoad = async (l) => {
    if (!window.confirm(`Delete Load ${l.load_no}? Its stops go back to the pool.`)) return;
    setBusy(true); setMsg(null);
    const r = await call({ action: "delete_load", loadId: l.id }, `Load ${l.load_no} deleted.`);
    setBusy(false); if (r) load();
  };
  const saveStop = async (s, patch) => {
    setBusy(true); setMsg(null);
    const r = await call({ action: "update_stop", stopId: s.id, ...patch }, "Stop saved.");
    setBusy(false); if (r) { setEditStopId(null); load(); }
  };
  const removeStop = async (s) => {
    if (!window.confirm("Take this building off the load? It returns to the pool.")) return;
    setBusy(true); setMsg(null);
    const r = await call({ action: "remove_stop", stopId: s.id }, "Removed — back in the pool.");
    setBusy(false); if (r) load();
  };
  const bumpStop = async (l, s, dir) => {
    const list = (stopsByLoad[l.id] || []).map((x) => x.id);
    const i = list.indexOf(s.id); const j = i + dir;
    if (j < 0 || j >= list.length) return;
    const t = list[i]; list[i] = list[j]; list[j] = t;
    setBusy(true); setMsg(null);
    const r = await call({ action: "reorder_stops", loadId: l.id, stopIds: list });
    setBusy(false); if (r) load();
  };
  const markLoad = async (l, toDelivered, withOverride) => {
    setBusy(true); setMsg(null);
    const body = { action: toDelivered ? "mark_load_delivered" : "mark_load_out", loadId: l.id };
    if (withOverride) {
      body.override = true;
      body.overrideReason = withOverride.reason;
      body.alsoCompleteBuilds = !!withOverride.complete;
    }
    const r = await callFull(body);
    setBusy(false);
    if (r.ok) {
      setOverride(null);
      setMsg({ ok: toDelivered ? `Load ${l.load_no} delivered.` : `Load ${l.load_no} is out.` });
      load();
      return;
    }
    if (r.data && r.data.blocked && canAdmin) {
      setOverride({ loadId: l.id, toDelivered, unbuilt: r.data.unbuilt || [], reason: "", complete: true });
      return;
    }
    setMsg({ err: r.message });
  };
  const markStopDelivered = async (s) => {
    setBusy(true); setMsg(null);
    const r = await callFull({ action: "mark_stop_delivered", stopId: s.id });
    setBusy(false);
    if (r.ok) { setMsg({ ok: "Stop delivered." }); load(); }
    else setMsg({ err: r.message });
  };

  const lbl = { ...S.lbl, marginBottom: 3 };
  const inp = { ...S.input, padding: "6px 8px", fontSize: 12.5 };
  const driverLabel = (p) => !p ? "No driver" : profName(p) + (p.truck_name ? " · " + p.truck_name : "");
  // The pool's version of builtCell: same question ("is this building actually ready to
  // haul?"), asked about a unit that has no stop yet.
  const invReadyChip = (unitId) => {
    const lc = unitLifecycle[unitId];
    const meta = lc && INV_STAGES[lc.lifecycle];
    if (!meta) return <span style={schedChip("#ECFEFF", "#0E7490")}>On lot — ready</span>;
    if (meta.rank >= INV_STAGES.at_location.rank) return <span style={schedChip("#ECFEFF", "#0E7490")}>On lot — ready</span>;
    if (meta.rank >= INV_STAGES.built.rank) return <span style={schedChip("#F0FDF4", "#15803D")}>{meta.label}</span>;
    return <span style={schedChip("#FEF2F2", "#DC2626")}>Not built yet ⚠</span>;
  };
  const builtCell = (s, l) => {
    if (s.delivered_at) return <span style={schedChip("#F0FDF4", "#15803D")}>Delivered ✓</span>;
    if (s.build_job_id) {
      const b = buildByJob[s.build_job_id];
      if (b && b.kind === "done") return <span style={schedChip("#F0FDF4", "#15803D")}>Built ✓</span>;
      const conflict = stopConflict(s, l);
      return <span style={schedChip(conflict ? "#FEF2F2" : "#FFFBEB", conflict ? "#DC2626" : "#B45309")}>
        {(b && b.stage) || "In build"}{b && b.dueDate ? " · due " + fmtDate(schedLocalDate(b.dueDate)) : ""}{conflict ? " ⚠" : ""}
      </span>;
    }
    // This used to hard-code "On lot — ready" for EVERY inventory stop, which is a guess: it
    // is true for a sold building being collected from the lot and false for one that has not
    // been built yet — reachable now that a spec build can be sold before it is finished.
    // Read where the unit actually is. (mark_stop_delivered refuses an unbuilt one too; this
    // is so the board does not invite the click in the first place.)
    if (s.source === "inventory") {
      const lc = (unitLifecycle && s.inventory_unit_id && unitLifecycle[s.inventory_unit_id]) || null;
      const key = lc ? lc.lifecycle : null;
      const meta = key && INV_STAGES[key];
      if (!meta) return <span style={schedChip("#ECFEFF", "#0E7490")}>On lot — ready</span>;
      if (meta.rank >= INV_STAGES.at_location.rank) return <span style={schedChip("#ECFEFF", "#0E7490")}>On lot — ready</span>;
      if (meta.rank >= INV_STAGES.built.rank) return <span style={schedChip("#F0FDF4", "#15803D")}>{meta.label}</span>;
      return <span style={schedChip("#FEF2F2", "#DC2626")}>Not built yet ⚠</span>;
    }
    if (s.source === "repair") return <span style={schedChip("#FDF2F8", "#BE185D")}>Field work</span>;
    return <span style={{ color: "#94A3B8", fontWeight: 600, fontSize: 12 }}>—</span>;
  };
  const poolRow = (key, src, serial, customer, building, size, wide, ready, extraSub, addBody, label, dest) => (
    <tr key={key}>
      <td style={{ ...S.td, whiteSpace: "nowrap" }}>
        <span style={{ fontWeight: 800, color: "#64748B", fontVariantNumeric: "tabular-nums" }}>{serial}</span>
        {src && <div style={{ marginTop: 3 }}><span style={schedChip(src.bg, src.fg)}>{src.label}</span></div>}
      </td>
      <td style={S.td}><strong>{customer}</strong>{extraSub && <div style={{ fontSize: 11, color: "#64748B", fontWeight: 600 }}>{extraSub}</div>}</td>
      <td style={S.td}>{building}</td>
      <td style={{ ...S.td, fontVariantNumeric: "tabular-nums", fontWeight: 700, whiteSpace: "nowrap" }}>{size}{wide && <span style={{ ...schedChip("#FEF3C7", "#92400E"), marginLeft: 5 }}>WIDE</span>}</td>
      <td style={S.td}>{dest || <span style={{ color: "#CBD5E1", fontWeight: 600 }}>—</span>}</td>
      <td style={S.td}>{ready}</td>
      <td style={{ ...S.td, whiteSpace: "nowrap" }}>
        {canEdit && (
          <select disabled={busy} value="" onChange={(e) => { if (e.target.value) addToLoad(e.target.value, addBody, label); }}
            style={{ ...inp, width: "auto", fontWeight: 700 }}>
            <option value="">Add to load…</option>
            {plannedLoads.map((l) => <option key={l.id} value={l.id}>Load {l.load_no}{l.load_date ? " · " + schedDayLabel(l.load_date) : ""}{loadProf(l) ? " · " + profName(loadProf(l)) : ""}</option>)}
            <option value="new">➕ New load</option>
          </select>
        )}
      </td>
    </tr>
  );

  // Pool rows bucketed by territory. The server annotates each build job with the corridor
  // it will land in (same city/zip rule add_stop uses), so the grouping a dispatcher sees
  // is the territory the stop actually gets. Sold lot units and repairs have no destination
  // of their own yet — they sit in the trailing "no destination" group.
  const poolGroups = (() => {
    const buckets = new Map();       // territoryId | "" -> rows
    const push = (tid, row) => {
      const k = tid || "";
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(row);
    };
    poolJobs.forEach((j) => push(j.territoryId, {
      key: "j" + j.buildJobId,
      render: () => poolRow("j" + j.buildJobId, SCHED_SRC_CHIP[j.source] || SCHED_SRC_CHIP.manual,
        j.serial ? "#" + j.serial : "—",
        j.customerName || j.title || (j.source === "inventory" ? "Spec build" : "—"),
        j.buildingLabel || j.title || "—",
        (j.widthFt && j.lengthFt) ? `${Number(j.widthFt)}×${Number(j.lengthFt)}` : "—", j.wide,
        j.buildKind === "done"
          ? <span style={schedChip("#F0FDF4", "#15803D")}>Built ✓{j.completedAt ? " " + fmtDate(j.completedAt) : ""}</span>
          : <span style={schedChip("#FFFBEB", "#B45309")}>{j.buildStage || "In build"}{j.dueDate ? " · due " + fmtDate(schedLocalDate(j.dueDate)) : ""}</span>,
        j.source === "inventory" ? "spec build → haul to the sales lot" : null,
        { source: j.source, buildJobId: j.buildJobId },
        j.customerName || (j.serial ? "#" + j.serial : "Building"),
        [j.destCity, j.destState].filter(Boolean).join(", ")),
    }));
    // Was "Sold lot building" for every row — the same string for every building on the list —
    // beside a hard-coded "On lot — ready" chip. Both are real values now: the buyer's first
    // name, the building's own style+size, and where the unit actually is on the build ladder
    // (a unit sold before it was finished is not on any lot, and must not look ready to haul).
    poolInv.forEach((u) => push(null, {
      key: "u" + u.inventoryUnitId,
      render: () => poolRow("u" + u.inventoryUnitId, SCHED_SRC_CHIP.inventory,
        "#" + u.serial,
        u.soldFirstName || (u.location ? u.location.name : "Sales lot"),
        u.buildingLabel || "Lot building", "—", false,
        invReadyChip(u.inventoryUnitId),
        "sold — deliver to the buyer", { source: "inventory", inventoryUnitId: u.inventoryUnitId }, "#" + u.serial, null),
    }));
    poolRepairs.forEach((rp) => push(null, {
      key: "r" + rp.id,
      render: () => poolRow("r" + rp.id, SCHED_SRC_CHIP.repair,
        "R-" + rp.repair_no, rp.customer_name, (rp.description || "").slice(0, 50), "—", false,
        <span style={schedChip("#FDF2F8", "#BE185D")}>{(REPAIR_STATUS[rp.status] || {}).label || rp.status}</span>,
        rp.serial ? "building #" + rp.serial : null, { source: "repair", repairId: rp.id }, "R-" + rp.repair_no, null),
    }));
    const named = territories
      .filter((t) => buckets.has(t.id))
      .map((t) => ({
        key: t.id, territory: t, rows: buckets.get(t.id),
        drivers: drivers.filter((p) => p.is_driver && (p.territory_ids || []).indexOf(t.id) !== -1).map((p) => profName(p)),
      }));
    const loose = buckets.get("") || [];
    return loose.length ? named.concat([{ key: "none", territory: null, rows: loose, drivers: [] }]) : named;
  })();

  return (
    <div style={S.card}>
      <CardHead title="Delivery Schedule" count={loads.length}
        right={<>
          <div style={{ display: "flex", background: "#EDF1F7", borderRadius: 9, padding: 3, gap: 2 }}>
            {[["loads", "Loads"], ["table", "Table"], ["calendar", "Calendar"]].map(([v, label]) => (
              <button key={v} type="button" onClick={() => setView(v)}
                style={{ border: "none", background: view === v ? "#FFF" : "transparent", borderRadius: 7, padding: "5px 12px", fontSize: 12, fontWeight: 700, color: view === v ? ACCENT : "#64748B", cursor: "pointer", fontFamily: "inherit", boxShadow: view === v ? "0 1px 3px rgba(15,23,42,.12)" : "none" }}>
                {label}
              </button>
            ))}
          </div>
          <button type="button" disabled title="Coming later: fits buildings to each driver's deck, groups stops by territory, routes by map"
            style={{ ...S.btn("#FFF", "#B9C4D6"), border: "1px solid #E2E8F0", cursor: "default" }}>⚡ Auto-plan · soon</button>
          <button type="button" onClick={load} style={S.btn("#F1F5F9", "#334155")}>↻ Refresh</button>
          {canEdit && <button type="button" onClick={() => setNewLoad(newLoad ? null : { driverId: "", loadDate: "", routeLabel: "" })} style={S.btn(ACCENT, "#FFF")}>+ New load</button>}
        </>} />

      {data && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginBottom: 13 }}>
          {[["To be loaded", poolCount, "#1E293B"], ["Loads this week", thisWeek, "#1E293B"], ["Wide loads", wideCount, wideCount ? "#92400E" : "#1E293B"], ["Date conflicts", conflictCount, conflictCount ? "#DC2626" : "#1E293B"]].map(([t, n, c]) => (
            <div key={t} style={{ background: "#FFF", border: "1px solid #E2E8F0", borderRadius: 12, padding: "10px 14px" }}>
              <div style={{ fontSize: 21, fontWeight: 800, fontVariantNumeric: "tabular-nums", color: c }}>{n}</div>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: "#64748B", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 1 }}>{t}</div>
            </div>
          ))}
        </div>
      )}

      {msg && msg.ok && <div style={S.okMsg}>{msg.ok}</div>}
      {msg && msg.err && <div style={S.err}>{msg.err}</div>}
      {error && <div style={S.err}>{error}</div>}
      {data === null && <p style={{ fontSize: 13, color: "#64748B", padding: 12 }}>Loading…</p>}

      {/* ── New load form ── */}
      {newLoad && canEdit && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", border: "1px dashed #B9C4D6", borderRadius: 10, padding: "10px 12px", marginBottom: 12 }}>
          <div style={{ minWidth: 180 }}>
            <span style={lbl}>Driver</span>
            <select style={inp} value={newLoad.driverId} onChange={(e) => setNewLoad({ ...newLoad, driverId: e.target.value })}>
              <option value="">— Pick later —</option>
              {drivers.filter((p) => p.is_driver && p.active).map((p) => <option key={p.id} value={p.id}>{driverLabel(p)}</option>)}
            </select>
            {drivers.filter((p) => p.is_driver).length === 0 && <div style={{ fontSize: 10.5, color: "#B45309", fontWeight: 700, marginTop: 3 }}>No drivers set up yet — add trucks in Settings → Team.</div>}
          </div>
          <div><span style={lbl}>Date</span><input type="date" style={inp} value={newLoad.loadDate} onChange={(e) => setNewLoad({ ...newLoad, loadDate: e.target.value })} /></div>
          <div style={{ flex: 1, minWidth: 160 }}><span style={lbl}>Route</span><input style={inp} value={newLoad.routeLabel} onChange={(e) => setNewLoad({ ...newLoad, routeLabel: e.target.value })} placeholder='e.g. "Shop → Sedalia → Warrensburg · Hwy 50 W"' /></div>
          <button type="button" disabled={busy} style={S.btn(ACCENT, "#FFF")} onClick={() => createLoad(newLoad)}>Create load</button>
        </div>
      )}

      {/* ── LOADS VIEW ── */}
      {data && pool && view === "loads" && (<>
        {/* Pool */}
        {poolCount > 0 && (
          <div style={{ border: "1px dashed #B9C4D6", borderRadius: 12, padding: "8px 12px 2px", marginBottom: 14, overflowX: "auto" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "2px 0 6px" }}>
              <span style={{ ...S.lbl, marginBottom: 0, color: "#475569" }}>To be loaded</span>
              <span style={schedChip("#EEF2FF", "#3D3672")}>{poolCount}</span>
              <span style={{ fontSize: 11.5, color: "#64748B", fontWeight: 600 }}>— sorted by when each building is ready; pick a load, or start a new one</span>
            </div>
            {/* Grouped by TERRITORY (SCHEDULING_SCOPE.md decision 9b + Phase 4): each group
                header carries the corridor description and whoever covers it, so a
                dispatcher reads "everything going West, soonest first" instead of one
                undifferentiated list. Buildings with no destination yet fall to the bottom
                group rather than being hidden. */}
            {poolGroups.map((g) => (
              <div key={g.key} style={{ marginBottom: 10 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", padding: "6px 2px 3px", borderTop: "1px solid #EEF2F8" }}>
                  <span style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", color: g.territory ? "#334155" : "#94A3B8" }}>
                    {g.territory ? g.territory.name : "Not in a territory yet"}
                  </span>
                  <span style={schedChip("#F1F5F9", "#475569")}>{g.rows.length}</span>
                  {g.territory && g.territory.description && (
                    <span style={{ fontSize: 11, color: "#64748B", fontWeight: 600 }}>{g.territory.description}</span>
                  )}
                  {g.drivers.length > 0 && (
                    <span style={{ fontSize: 11, color: ACCENT, fontWeight: 700 }}>· {g.drivers.join(", ")}</span>
                  )}
                  {g.territory && g.drivers.length === 0 && (
                    <span style={{ fontSize: 11, color: "#B45309", fontWeight: 700 }}>· no driver covers this yet</span>
                  )}
                  {!g.territory && (
                    <span style={{ fontSize: 11, color: "#94A3B8", fontWeight: 600 }}>
                      set the territory once on a stop in the same town and the rest follow it from then on
                    </span>
                  )}
                </div>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead><tr>{["Serial", "Customer", "Building", "Size", "Destination", "Ready", ""].map((h) => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
                  <tbody>{g.rows.map((r) => r.render())}</tbody>
                </table>
              </div>
            ))}
          </div>
        )}

        {/* Driver filter chips */}
        {drivers.filter((p) => p.is_driver).length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
            {[["all", `All drivers (${loads.length})`]].concat(drivers.filter((p) => p.is_driver).map((p) => [p.id, driverLabel(p) + ` (${loads.filter((l) => (loadProf(l) || {}).id === p.id).length})`])).map(([k, label]) => {
              const on = driverFilter === k;
              return (
                <button key={k} type="button" onClick={() => setDriverFilter(on && k !== "all" ? "all" : k)}
                  style={{ ...S.btn(on ? "#1E293B" : "#FFF", on ? "#FFF" : "#475569"), padding: "5px 12px", fontSize: 12, border: "1px solid " + (on ? "#1E293B" : "#E2E8F0"), borderRadius: 16 }}>
                  {label}
                </button>
              );
            })}
          </div>
        )}

        {data && loads.length === 0 && !error && (
          <p style={{ fontSize: 13, color: "#64748B", padding: 12 }}>
            No loads yet. Click <strong>+ New load</strong> to plan a truck day, then pull buildings from the pool above.
          </p>
        )}

        {dayKeys.map((day) => (
          <div key={day || "nodate"}>
            <div style={{ display: "flex", alignItems: "center", gap: 9, margin: "16px 2px 8px" }}>
              <span style={{ fontSize: 12.5, fontWeight: 800, letterSpacing: 0.5, textTransform: "uppercase", color: "#334155" }}>{schedDayLabel(day || null)}</span>
              <span style={{ flex: 1, height: 1, background: "#E2E8F0" }}></span>
            </div>
            {byDay[day].map((l) => {
              const lStops = stopsByLoad[l.id] || [];
              const used = lStops.reduce((a, s) => a + (Number(s.length_ft) || 0), 0);
              const deck = schedFtNum(l.deck_length_ft);
              const pct = deck ? Math.min(100, Math.round(used / deck * 100)) : null;
              const conflict = loadConflicts[l.id];
              const st = SCHED_LOAD_STATUS[l.status] || SCHED_LOAD_STATUS.planned;
              const ov = override && override.loadId === l.id;
              return (
                <div key={l.id} style={{ background: "#FFF", border: "1px solid " + (conflict ? "#FCA5A5" : "#E2E8F0"), borderRadius: 12, marginBottom: 12, overflow: "hidden" }}>
                  {/* Header */}
                  <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "10px 14px", background: "#F8FAFF", borderBottom: "1px solid #E2E8F0", flexWrap: "wrap", boxShadow: conflict ? "inset 3px 0 0 #DC2626" : "none" }}>
                    <span style={{ fontSize: 13.5, fontWeight: 800 }}>Load {l.load_no}</span>
                    <span style={schedChip(st.bg, st.fg)}>{st.label}</span>
                    <span style={{ fontSize: 11.5, color: "#64748B", fontWeight: 600 }}>
                      {driverLabel(loadProf(l))}
                      {deck ? ` · ${deck}' deck` : ""}{l.max_width_ft ? ` · max ${Number(l.max_width_ft)}' wide` : ""}
                    </span>
                    {l.route_label && <span style={{ fontSize: 11.5, color: "#64748B", fontWeight: 600 }}>📍 {l.route_label}</span>}
                    {(l.miles_out || l.miles_back) && <span style={{ fontSize: 11.5, color: "#64748B", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{l.miles_out ? Number(l.miles_out) + " mi out" : ""}{l.miles_out && l.miles_back ? " + " : ""}{l.miles_back ? Number(l.miles_back) + " back" : ""}</span>}
                    {l.is_wide && <span style={schedChip("#FEF3C7", "#92400E")}>WIDE LOAD{l.permit_status === "on_file" ? " · permit ✓" : l.permit_status === "needed" ? " · permit needed" : ""}</span>}
                    {conflict && <span style={schedChip("#FEF2F2", "#DC2626")}>⚠ building not built by this date</span>}
                    {l.override_reason && <span style={schedChip("#FEF3C7", "#92400E")} title={l.override_reason}>Overridden — {String(l.override_reason).slice(0, 40)}{l.overridden_at ? " · " + fmtDate(l.overridden_at) : ""}</span>}
                    <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 7 }}>
                      {deck != null && (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                          <span style={{ fontSize: 11, fontWeight: 700, color: "#475569", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{used}' of {deck}' deck</span>
                          <span style={{ width: 90, height: 8, background: "#F1F5F9", borderRadius: 99, overflow: "hidden", display: "inline-block" }}>
                            <span style={{ display: "block", height: "100%", width: pct + "%", background: pct >= 100 ? "#B45309" : ACCENT, borderRadius: 99 }}></span>
                          </span>
                        </span>
                      )}
                      {canEdit && l.status === "planned" && <button type="button" style={{ ...S.btn("#FFF", "#475569"), border: "1px solid #CBD5E1", padding: "4px 10px", fontSize: 11.5 }} onClick={() => setEditLoadId(editLoadId === l.id ? null : l.id)}>{editLoadId === l.id ? "Close" : "Edit"}</button>}
                      {canEdit && l.status === "planned" && <button type="button" disabled={busy} style={{ ...S.btn("#FFFBEB", "#B45309"), padding: "4px 10px", fontSize: 11.5 }} onClick={() => markLoad(l, false)}>Mark out →</button>}
                      {canEdit && l.status !== "delivered" && <button type="button" disabled={busy} style={{ ...S.btn("#F0FDF4", "#15803D"), padding: "4px 10px", fontSize: 11.5 }} onClick={() => markLoad(l, true)}>✓ Delivered</button>}
                      {canEdit && l.status === "planned" && lStops.length === 0 && <button type="button" disabled={busy} style={{ ...S.btn("#FEF2F2", "#DC2626"), padding: "4px 10px", fontSize: 11.5 }} onClick={() => deleteLoad(l)}>Delete</button>}
                    </span>
                  </div>

                  {/* Header edit (in place) */}
                  {editLoadId === l.id && canEdit && (
                    <SchedLoadHeaderEditor l={l} drivers={drivers} nameOf={nameOf} busy={busy}
                      onSave={(fields) => saveLoadHeader(l, fields)} onCancel={() => setEditLoadId(null)} />
                  )}

                  {/* Override confirm (in place, admin) */}
                  {ov && (
                    <div style={{ margin: "10px 14px", border: "1px solid #FCA5A5", background: "#FEF2F2", borderRadius: 10, padding: "10px 13px" }}>
                      <div style={{ fontSize: 12.5, fontWeight: 800, color: "#DC2626", marginBottom: 6 }}>
                        {override.unbuilt.length === 1 ? "1 building on this load isn't marked Built:" : override.unbuilt.length + " buildings on this load aren't marked Built:"}
                      </div>
                      <ul style={{ margin: "0 0 8px 18px", padding: 0 }}>
                        {override.unbuilt.map((u) => (
                          <li key={u.stopId} style={{ fontSize: 12, fontWeight: 600, color: "#7F1D1D" }}>
                            {u.serial ? "#" + u.serial + " · " : ""}{u.customerName || "stop " + u.stopOrder}{u.buildStage ? " — " + u.buildStage : ""}{u.buildDue ? " · due " + fmtDate(schedLocalDate(u.buildDue)) : ""}
                          </li>
                        ))}
                      </ul>
                      <input style={{ ...inp, width: "100%", boxSizing: "border-box", marginBottom: 7 }} value={override.reason}
                        onChange={(e) => setOverride({ ...override, reason: e.target.value })}
                        placeholder='Why is this okay? (required — e.g. "build finished, board not updated")' />
                      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color: "#334155", marginBottom: 8, cursor: "pointer" }}>
                        <input type="checkbox" checked={override.complete} onChange={(e) => setOverride({ ...override, complete: e.target.checked })} />
                        Also mark {override.unbuilt.length === 1 ? "this build" : "these builds"} as Built
                      </label>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button type="button" disabled={busy || !override.reason.trim()} style={S.btn("#DC2626", "#FFF")}
                          onClick={() => markLoad(l, override.toDelivered, { reason: override.reason.trim(), complete: override.complete })}>
                          Override &amp; {override.toDelivered ? "mark delivered" : "send out"}
                        </button>
                        <button type="button" style={S.btn("#FFF", "#475569")} onClick={() => setOverride(null)}>Cancel</button>
                      </div>
                    </div>
                  )}

                  {/* Stops */}
                  {lStops.length > 0 && (
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse" }}>
                        <thead><tr>{["", "Serial", "Customer", "Building", "Size", "Built", "Destination", "Leg", "Window", ""].map((h, i) => <th key={i} style={S.th}>{h}</th>)}</tr></thead>
                        <tbody>
                          {lStops.map((s) => (
                            <React.Fragment key={s.id}>
                              <tr style={{ background: stopConflict(s, l) ? "#FFF8F8" : "transparent" }}>
                                <td style={{ ...S.td, whiteSpace: "nowrap" }}>
                                  <span style={{ width: 20, height: 20, borderRadius: "50%", background: "#F1F5F9", color: "#475569", fontSize: 10.5, fontWeight: 800, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>{s.stop_order}</span>
                                </td>
                                <td style={{ ...S.td, fontWeight: 800, color: "#64748B", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{s.serial ? "#" + s.serial : (s.repair_id ? "Repair" : "—")}</td>
                                <td style={S.td}><strong>{s.customer_name || "—"}</strong>{s.customer_phone && <div style={{ fontSize: 11, color: "#64748B", fontWeight: 600 }}>{s.customer_phone}</div>}</td>
                                <td style={S.td}>{s.building_label || "—"}</td>
                                <td style={{ ...S.td, fontVariantNumeric: "tabular-nums", fontWeight: 700, whiteSpace: "nowrap" }}>
                                  {(s.width_ft && s.length_ft) ? `${Number(s.width_ft)}×${Number(s.length_ft)}` : "—"}
                                  {Number(s.width_ft) > 8.5 && <span style={{ ...schedChip("#FEF3C7", "#92400E"), marginLeft: 5 }}>W</span>}
                                </td>
                                <td style={S.td}>{builtCell(s, l)}</td>
                                <td style={S.td}>
                                  {[s.dest_street, s.dest_city].filter(Boolean).join(", ") || (terrName[s.territory_id] || "—")}
                                  {(s.site_notes || s.territory_id) && (
                                    <div style={{ fontSize: 11, color: "#64748B", fontWeight: 600 }}>
                                      {terrName[s.territory_id] ? terrName[s.territory_id] + (s.site_notes ? " · " : "") : ""}{s.site_notes || ""}
                                    </div>
                                  )}
                                </td>
                                <td style={{ ...S.td, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{s.leg_miles != null ? Number(s.leg_miles) + " mi" : "—"}</td>
                                <td style={{ ...S.td, whiteSpace: "nowrap" }}>{s.time_window || "—"}</td>
                                <td style={{ ...S.td, whiteSpace: "nowrap", textAlign: "right" }}>
                                  {canEdit && l.status === "out" && !s.delivered_at && <button type="button" disabled={busy} style={{ ...S.btn("#F0FDF4", "#15803D"), padding: "3px 8px", fontSize: 11 }} onClick={() => markStopDelivered(s)}>✓ Delivered</button>}
                                  {canEdit && l.status === "planned" && (<>
                                    <button type="button" onClick={() => bumpStop(l, s, -1)} title="Move up" style={{ border: "none", background: "none", cursor: "pointer", color: "#94A3B8", fontSize: 11, padding: "0 2px" }}>▲</button>
                                    <button type="button" onClick={() => bumpStop(l, s, 1)} title="Move down" style={{ border: "none", background: "none", cursor: "pointer", color: "#94A3B8", fontSize: 11, padding: "0 2px" }}>▼</button>
                                    <button type="button" style={{ ...S.btn("#F1F5F9", "#475569"), padding: "3px 8px", fontSize: 11, marginLeft: 4 }} onClick={() => setEditStopId(editStopId === s.id ? null : s.id)}>{editStopId === s.id ? "Close" : "Edit"}</button>
                                    <button type="button" style={{ ...S.btn("#FEF2F2", "#DC2626"), padding: "3px 8px", fontSize: 11, marginLeft: 4 }} onClick={() => removeStop(s)}>×</button>
                                  </>)}
                                </td>
                              </tr>
                              {editStopId === s.id && (
                                <tr><td colSpan={10} style={{ padding: "0 10px" }}>
                                  <SchedStopEditor stop={s} territories={territories} busy={busy}
                                    onSave={(patch) => saveStop(s, patch)} onCancel={() => setEditStopId(null)} />
                                </td></tr>
                              )}
                            </React.Fragment>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {lStops.length === 0 && <p style={{ fontSize: 12, color: "#94A3B8", fontWeight: 600, padding: "10px 14px" }}>No stops yet — add buildings from the pool above.</p>}
                  {deck != null && lStops.length > 0 && l.status === "planned" && used < deck && (
                    <div style={{ fontSize: 11.5, color: "#94A3B8", fontWeight: 700, padding: "0 14px 10px" }}>{deck - used}' of deck left</div>
                  )}
                </div>
              );
            })}
          </div>
        ))}

        <p style={{ fontSize: 11.5, color: "#64748B", fontWeight: 600, lineHeight: 1.5, marginTop: 12 }}>
          Loads group buildings by territory (one route per truck day), size (the deck bar runs against <strong>that driver's</strong> deck), and build dates.
          The <strong>Leg</strong> column is drop-to-drop miles. A load can't go out or be delivered while a building isn't built — owners/admins can override with a reason, and the override stays on the load for good.
          Wide buildings (over 8'6") are flagged automatically from the design's real dimensions.
        </p>
      </>)}

      {/* ── TABLE VIEW ── */}
      {data && view === "table" && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>{["Serial", "Customer", "Size", "Destination", "Territory", "Built", "Load", "Date", "Driver"].map((h) => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
            <tbody>
              {stops.slice().sort((a, b) => {
                const la = loads.find((x) => x.id === a.load_id) || {}; const lb = loads.find((x) => x.id === b.load_id) || {};
                return String(la.load_date || "9999").localeCompare(String(lb.load_date || "9999")) || a.stop_order - b.stop_order;
              }).map((s) => {
                const l = loads.find((x) => x.id === s.load_id) || {};
                return (
                  <tr key={s.id}>
                    <td style={{ ...S.td, fontWeight: 800, color: "#64748B", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{s.serial ? "#" + s.serial : (s.repair_id ? "R" : "—")}</td>
                    <td style={S.td}><strong>{s.customer_name || "—"}</strong>{s.building_label && <div style={{ fontSize: 11, color: "#64748B", fontWeight: 600 }}>{s.building_label}</div>}</td>
                    <td style={{ ...S.td, fontVariantNumeric: "tabular-nums", fontWeight: 700, whiteSpace: "nowrap" }}>{(s.width_ft && s.length_ft) ? `${Number(s.width_ft)}×${Number(s.length_ft)}` : "—"}{Number(s.width_ft) > 8.5 && <span style={{ ...schedChip("#FEF3C7", "#92400E"), marginLeft: 5 }}>W</span>}</td>
                    <td style={S.td}>{[s.dest_street, s.dest_city].filter(Boolean).join(", ") || "—"}</td>
                    <td style={S.td}>{terrName[s.territory_id] || "—"}</td>
                    <td style={S.td}>{builtCell(s, l)}</td>
                    <td style={{ ...S.td, whiteSpace: "nowrap" }}>{l.load_no ? "Load " + l.load_no + " · stop " + s.stop_order : "—"}</td>
                    <td style={{ ...S.td, whiteSpace: "nowrap" }}>{l.load_date ? schedDayLabel(l.load_date) : "—"}</td>
                    <td style={S.td}>{loadProf(l) ? profName(loadProf(l)) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {stops.length === 0 && <p style={{ fontSize: 13, color: "#64748B", padding: 12 }}>Nothing scheduled yet.</p>}
        </div>
      )}

      {/* ── CALENDAR VIEW — week at a glance ── */}
      {data && view === "calendar" && (() => {
        // LOCAL day keys, matching the local labels beside them (audit 2026-08-20):
        // toISOString() is UTC, which rang "today" on tomorrow's cell for US tenants and,
        // east of UTC, made a drop create the load on the day BEFORE the cell it hit.
        const isoOf = schedLocalIso;
        const trayItems = [
          ...poolJobs.map((j) => ({ key: "j" + j.buildJobId, building: j.buildingLabel || j.title || "Building", customer: j.customerName || (j.source === "inventory" ? "Spec build" : ""), serial: j.serial ? "#" + j.serial : "", ready: j.buildKind === "done", body: { source: j.source, buildJobId: j.buildJobId }, label: j.customerName || (j.serial ? "#" + j.serial : "Building") })),
          // `ready` drives the visual affordance, so a sold-but-unbuilt unit must stop looking
          // draggable-and-ready — it was hard-coded true alongside a generic building label.
          ...poolInv.map((u) => ({ key: "u" + u.inventoryUnitId, building: u.buildingLabel || "Lot building", customer: u.soldFirstName || (u.location ? u.location.name : "Sales lot"), serial: "#" + u.serial, ready: (unitLifecycle[u.inventoryUnitId] && INV_STAGES[unitLifecycle[u.inventoryUnitId].lifecycle] ? INV_STAGES[unitLifecycle[u.inventoryUnitId].lifecycle].rank >= INV_STAGES.built.rank : true), body: { source: "inventory", inventoryUnitId: u.inventoryUnitId }, label: "#" + u.serial })),
          ...poolRepairs.map((rp) => ({ key: "r" + rp.id, building: (rp.description || "Repair").slice(0, 40), customer: rp.customer_name || "", serial: "R-" + rp.repair_no, ready: true, body: { source: "repair", repairId: rp.id }, label: "R-" + rp.repair_no })),
        ];
        // PROFILE ids — the shared visibleLoads filter compares (loadProf(l) || {}).id, and
        // the Loads-view chips already carry p.id, so user_id values here emptied the
        // calendar for every driver picked (audit 2026-08-20). Filter to real drivers too:
        // mapping the whole team rendered key-less duplicate "Driver" chips for name-first
        // profiles (095).
        const driverChips = [["all", "All drivers"]].concat(drivers.filter((p) => p.is_driver).map((p) => [p.id, driverLabel(p)]));
        const undated = visibleLoads.filter((l) => !l.load_date && l.status === "planned").length;

        const step = (dir) => { if (calView === "month") { const d = new Date(monthCursor); d.setMonth(d.getMonth() + dir); d.setDate(1); setMonthCursor(d.getTime()); } else setWeekOffset(weekOffset + dir); };
        const goToday = () => { setWeekOffset(0); const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); setMonthCursor(d.getTime()); };

        const dayDrop = (iso) => canEdit ? {
          onDragOver: (e) => { if (dragItem) { e.preventDefault(); setDropKey("day:" + iso); } },
          onDragLeave: () => setDropKey((k) => k === "day:" + iso ? null : k),
          onDrop: (e) => { e.preventDefault(); const it = dragItem; setDropKey(null); setDragItem(null); if (it) dropOnDay(iso, it); },
        } : {};
        const dayGlow = (iso) => dropKey === "day:" + iso ? { outline: `2px dashed ${ACCENT}`, outlineOffset: -2 } : {};
        const loadDrop = (id) => canEdit ? {
          onDragOver: (e) => { if (dragItem) { e.preventDefault(); e.stopPropagation(); setDropKey("load:" + id); } },
          onDragLeave: () => setDropKey((k) => k === "load:" + id ? null : k),
          onDrop: (e) => { e.preventDefault(); e.stopPropagation(); const it = dragItem; setDropKey(null); setDragItem(null); if (it) dropOnLoad(id, it); },
        } : {};

        const loadCard = (l) => {
          const lStops = stopsByLoad[l.id] || [];
          const st = SCHED_LOAD_STATUS[l.status] || SCHED_LOAD_STATUS.planned;
          const conflict = loadConflicts[l.id];
          const usedFt = lStops.reduce((a, s) => a + (Number(s.length_ft) || 0), 0);
          const glow = dropKey === "load:" + l.id ? { outline: `2px dashed ${ACCENT}`, outlineOffset: -2 } : {};
          return (
            <div key={l.id} {...loadDrop(l.id)} onClick={() => setView("loads")} title={`Load ${l.load_no} — open the Loads view to manage`}
              style={{ background: "#FFF", border: "0.5px solid " + (conflict ? "#FCA5A5" : "#DDD6FE"), borderRadius: 12, overflow: "hidden", cursor: "pointer", ...glow }}>
              <div style={{ background: ACCENT, padding: "6px 10px", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <span style={{ fontSize: 12, fontWeight: 800, color: "#FFF" }}>Load {l.load_no}</span>
                <span style={{ ...schedChip(st.bg, st.fg), padding: "2px 8px", fontSize: 9.5 }}>{st.label}</span>
                {l.is_wide && <span style={{ ...schedChip("#FEF3C7", "#92400E"), padding: "2px 8px", fontSize: 9.5 }}>WIDE</span>}
              </div>
              <div style={{ padding: "6px 10px", display: "flex", alignItems: "center", gap: 8, borderBottom: "0.5px solid #F1F5F9" }}>
                <span style={{ fontSize: 11, color: "#475569", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{profName(loadProf(l))}{l.route_label ? " · " + l.route_label : ""}</span>
                {l.deck_length_ft ? <span style={{ marginLeft: "auto", fontSize: 10, fontWeight: 800, color: ACCENT, background: "#EEF2FF", borderRadius: 999, padding: "2px 8px", whiteSpace: "nowrap" }}>{Math.round(usedFt)}′ / {l.deck_length_ft}′</span> : null}
              </div>
              <div style={{ padding: 8, display: "flex", flexDirection: "column", gap: 6 }}>
                {conflict && <div style={{ ...schedChip("#FEF2F2", "#DC2626"), padding: "2px 8px", fontSize: 9.5 }}>⚠ a building isn't built yet</div>}
                {lStops.map((s) => (
                  <div key={s.id} style={{ border: "0.5px solid #E2E8F0", borderRadius: 9, padding: "6px 8px", display: "flex", gap: 8, alignItems: "flex-start" }}>
                    <span style={{ flex: "0 0 18px", height: 18, borderRadius: "50%", background: "#EEF2FF", color: ACCENT, fontSize: 10, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center" }}>{s.stop_order}</span>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: "#1E293B", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.building_label || "Building"}</div>
                      <div style={{ fontSize: 11, color: "#64748B", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.customer_name || "—"}{s.dest_city ? " · " + s.dest_city + (s.dest_state ? ", " + s.dest_state : "") : ""}</div>
                    </div>
                    {s.delivered_at ? <span style={{ color: "#16A34A", fontSize: 11 }} title="Delivered">✓</span> : (s.serial ? <span style={{ color: "#94A3B8", fontSize: 10 }}>#{s.serial}</span> : null)}
                  </div>
                ))}
                {lStops.length === 0 && <div style={{ fontSize: 10.5, color: "#94A3B8", fontStyle: "italic", padding: "2px" }}>No stops yet</div>}
              </div>
            </div>
          );
        };
        const loadChip = (l) => {
          const lStops = stopsByLoad[l.id] || [];
          const st = SCHED_LOAD_STATUS[l.status] || SCHED_LOAD_STATUS.planned;
          const conflict = loadConflicts[l.id];
          const glow = dropKey === "load:" + l.id ? { outline: `2px dashed ${ACCENT}`, outlineOffset: -1 } : {};
          return (
            <div key={l.id} {...loadDrop(l.id)} onClick={() => setView("loads")} title={`Load ${l.load_no} · ${lStops.length} stop${lStops.length === 1 ? "" : "s"}`}
              style={{ background: "#FFF", border: "0.5px solid " + (conflict ? "#FCA5A5" : "#DDD6FE"), borderRadius: 8, padding: "4px 6px", cursor: "pointer", display: "flex", alignItems: "center", gap: 5, ...glow }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: st.fg, flexShrink: 0 }}></span>
              <span style={{ fontSize: 11, fontWeight: 800, color: "#1E293B", whiteSpace: "nowrap" }}>Load {l.load_no}</span>
              <span style={{ fontSize: 10, color: "#64748B", marginLeft: "auto", whiteSpace: "nowrap" }}>{lStops.length} stop{lStops.length === 1 ? "" : "s"}</span>
              {l.is_wide && <span style={{ fontSize: 9, fontWeight: 800, color: "#92400E" }}>W</span>}
            </div>
          );
        };

        let label, cells, cols, headRow = null;
        if (calView === "month") {
          const m0 = new Date(monthCursor); m0.setDate(1); m0.setHours(0, 0, 0, 0);
          label = m0.toLocaleDateString("en-US", { month: "long", year: "numeric" });
          const gStart = new Date(m0); gStart.setDate(gStart.getDate() - gStart.getDay());
          // By DATE, not +86,400,000ms — the DST fall-back day would repeat a local key
          // (same constraint as the Build Schedule calendar; audit 2026-08-20).
          let mc = []; for (let i = 0; i < 42; i++) { const d = new Date(gStart); d.setDate(d.getDate() + i); mc.push(d); }
          if (!showWeekends) mc = mc.filter((d) => d.getDay() !== 0 && d.getDay() !== 6);
          cells = mc.map((d) => ({ iso: isoOf(d), d, inMonth: d.getMonth() === m0.getMonth() }));
          cols = showWeekends ? 7 : 5;
          headRow = showWeekends ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] : ["Mon", "Tue", "Wed", "Thu", "Fri"];
        } else {
          const b = new Date(); b.setHours(0, 0, 0, 0); b.setDate(b.getDate() - b.getDay() + weekOffset * 7);
          let wd = []; for (let i = 0; i < 7; i++) { const d = new Date(b); d.setDate(d.getDate() + i); wd.push({ iso: isoOf(d), d, inMonth: true }); }
          const wknd = wd[6].d;
          label = b.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " – " + wknd.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + ", " + wknd.getFullYear();
          if (!showWeekends) wd = wd.filter(({ d }) => d.getDay() !== 0 && d.getDay() !== 6);
          cells = wd; cols = showWeekends ? 7 : 5;
        }

        return (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 10, flexWrap: "wrap" }}>
              <div style={{ display: "flex", background: "#EDF1F7", borderRadius: 9, padding: 3, gap: 2 }}>
                {[["week", "Week"], ["month", "Month"]].map(([v, l2]) => (
                  <button key={v} type="button" onClick={() => setCalView(v)} style={{ border: "none", background: calView === v ? "#FFF" : "transparent", borderRadius: 7, padding: "5px 12px", fontSize: 12, fontWeight: 700, color: calView === v ? ACCENT : "#64748B", cursor: "pointer", fontFamily: "inherit", boxShadow: calView === v ? "0 1px 3px rgba(15,23,42,.12)" : "none" }}>{l2}</button>
                ))}
              </div>
              <button type="button" style={S.btn("#F1F5F9", "#334155")} onClick={() => step(-1)}>‹</button>
              <span style={{ fontSize: 14, fontWeight: 800 }}>{label}</span>
              <button type="button" style={S.btn("#F1F5F9", "#334155")} onClick={() => step(1)}>›</button>
              <button type="button" style={{ ...S.btn("#FFF", "#475569"), border: "1px solid #CBD5E1", padding: "6px 11px", fontSize: 12 }} onClick={goToday}>Today</button>
              <button type="button" onClick={() => setShowWeekends(!showWeekends)}
                title={showWeekends ? "Hide Saturday & Sunday" : "Show Saturday & Sunday"}
                style={{ ...S.btn(showWeekends ? "#EEF2FF" : "#FFF", showWeekends ? ACCENT : "#64748B"), border: "1px solid " + (showWeekends ? "#C3D9F7" : "#CBD5E1"), padding: "6px 11px", fontSize: 12 }}>
                Weekends {showWeekends ? "on" : "off"}
              </button>
              {undated > 0 && <span style={{ fontSize: 11.5, color: "#64748B", fontWeight: 600, marginLeft: "auto" }}>{undated} planned load{undated === 1 ? "" : "s"} with no date — see the Loads view</span>}
            </div>

            {driverChips.length > 1 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 11 }}>
                {driverChips.map(([k, lbl]) => {
                  const on = driverFilter === k;
                  return (
                    <button key={k} type="button" onClick={() => setDriverFilter(on && k !== "all" ? "all" : k)}
                      style={{ border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 11, fontWeight: 800, borderRadius: 999, padding: "4px 11px", background: on ? ACCENT : "#EEF2F8", color: on ? "#FFF" : "#475569" }}>{lbl}</button>
                  );
                })}
              </div>
            )}

            {canEdit && trayItems.length > 0 && (
              <div style={{ background: "#FFF7ED", border: "0.5px dashed #FDBA74", borderRadius: 10, padding: "8px 11px", marginBottom: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: "#9A3412", marginBottom: 6 }}>To be loaded · {trayItems.length}<span style={{ fontWeight: 600, color: "#B45309" }}> — drag onto a day to start a load, or onto an existing load</span></div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {trayItems.map((it) => (
                    <div key={it.key} draggable onDragStart={() => setDragItem(it)} onDragEnd={() => { setDragItem(null); setDropKey(null); }}
                      style={{ background: "#FFF", border: "0.5px solid #FED7AA", borderRadius: 8, padding: "5px 9px", cursor: "grab", fontSize: 11, maxWidth: 230 }}>
                      <span style={{ fontWeight: 700, color: "#7C2D12" }}>{it.building}</span>
                      <span style={{ color: "#9A3412" }}>{it.customer ? " · " + it.customer : ""}{it.serial ? " · " + it.serial : ""}</span>
                      {it.ready && <span style={{ marginLeft: 5, color: "#15803D" }} title="Built">✓</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {calView === "week" ? (
              <div style={{ overflowX: "auto", paddingBottom: 6 }}>
                <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, minmax(210px, 1fr))`, gap: 8, minWidth: cols * 218 }}>
                  {cells.map(({ iso, d }) => {
                    const isToday = iso === todayIso;
                    const dayLoads = visibleLoads.filter((l) => l.load_date === iso);
                    return (
                      <div key={iso} {...dayDrop(iso)} style={{ background: isToday ? "#E9F0FF" : "#EEF2F8", borderRadius: 12, padding: 9, minHeight: 150, outline: isToday ? "2px solid #C3D9F7" : "none", outlineOffset: -2, ...dayGlow(iso) }}>
                        <div style={{ display: "flex", alignItems: "baseline", gap: 6, padding: "1px 3px 8px" }}>
                          <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: 0.8, textTransform: "uppercase", color: isToday ? ACCENT : "#64748B" }}>{d.toLocaleDateString("en-US", { weekday: "short" })}</span>
                          <span style={{ fontSize: 16, fontWeight: 800, color: isToday ? ACCENT : "#1E293B" }}>{d.getDate()}</span>
                          <span style={{ marginLeft: "auto", fontSize: 10, fontWeight: 800, color: "#64748B", background: "#FFF", borderRadius: 999, padding: "2px 7px" }}>{dayLoads.length ? dayLoads.length + " load" + (dayLoads.length === 1 ? "" : "s") : "0"}</span>
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                          {dayLoads.map(loadCard)}
                          {dayLoads.length === 0 && <div style={{ border: "1px dashed #CBD5E1", borderRadius: 12, padding: "16px 8px", textAlign: "center", color: "#94A3B8", fontSize: 11 }}>{canEdit && dragItem ? "Drop to start a load" : "No loads"}</div>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div style={{ overflowX: "auto", paddingBottom: 6 }}>
                <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, minmax(120px, 1fr))`, gap: 6, minWidth: cols === 7 ? 880 : 640 }}>
                  {headRow.map((h) => <div key={h} style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.8, textTransform: "uppercase", color: "#94A3B8", padding: "0 4px 2px" }}>{h}</div>)}
                  {cells.map(({ iso, d, inMonth }) => {
                    const isToday = iso === todayIso;
                    const dayLoads = visibleLoads.filter((l) => l.load_date === iso);
                    return (
                      <div key={iso} {...dayDrop(iso)} style={{ background: isToday ? "#E9F0FF" : inMonth ? "#F6F8FB" : "#F1F3F6", borderRadius: 10, padding: 6, minHeight: 92, opacity: inMonth ? 1 : 0.55, outline: isToday ? "2px solid #C3D9F7" : "none", outlineOffset: -2, ...dayGlow(iso) }}>
                        <div style={{ fontSize: 12, fontWeight: 800, color: isToday ? ACCENT : "#475569", marginBottom: 5, textAlign: "right" }}>{d.getDate()}</div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          {dayLoads.map(loadChip)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}

// Load header editor (expand-in-place; only while the load is planned).
function SchedLoadHeaderEditor({ l, drivers, nameOf, busy, onSave, onCancel }) {
  const [f, setF] = useState({
    driverId: l.driver_id || ((drivers.find((p) => p.user_id && p.user_id === l.driver_user_id) || {}).id || ""),
    loadDate: l.load_date || "", routeLabel: l.route_label || "",
    milesOut: l.miles_out == null ? "" : String(l.miles_out), milesBack: l.miles_back == null ? "" : String(l.miles_back),
    permitStatus: l.permit_status || "not_needed", notes: l.notes || "",
  });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const inp = { ...S.input, padding: "6px 8px", fontSize: 12.5 };
  const lbl = { ...S.lbl, marginBottom: 3 };
  return (
    <div style={{ margin: "10px 14px", border: "1px solid #E2E8F0", borderRadius: 10, padding: "10px 13px", background: "#FBFCFE" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "8px 10px" }}>
        <div>
          <span style={lbl}>Driver</span>
          {/* PROFILE ids, matching the seeded l.driver_id — the server resolves driverId
              against driver_profiles.id, so user_id values made every reassign fail
              "Driver not found." and showed a load that HAD a driver as "— No driver —"
              (audit 2026-08-20). display_name first: name-first drivers (095) may have
              no login to look up. The new-load form above already did all of this. */}
          <select style={inp} value={f.driverId} onChange={set("driverId")}>
            <option value="">— No driver —</option>
            {drivers.filter((p) => p.is_driver && p.active).map((p) => <option key={p.id} value={p.id}>{(p.display_name || nameOf[p.user_id] || "Driver") + (p.truck_name ? " · " + p.truck_name : "")}</option>)}
          </select>
        </div>
        <div><span style={lbl}>Date</span><input type="date" style={inp} value={f.loadDate} onChange={set("loadDate")} /></div>
        <div style={{ gridColumn: "span 2" }}><span style={lbl}>Route</span><input style={inp} value={f.routeLabel} onChange={set("routeLabel")} /></div>
        <div><span style={lbl}>Miles out</span><input style={inp} value={f.milesOut} onChange={set("milesOut")} /></div>
        <div><span style={lbl}>Miles back</span><input style={inp} value={f.milesBack} onChange={set("milesBack")} /></div>
        <div>
          <span style={lbl}>Wide-load permit</span>
          <select style={inp} value={f.permitStatus} onChange={set("permitStatus")}>
            <option value="not_needed">Not needed</option><option value="needed">Needed</option><option value="on_file">On file ✓</option>
          </select>
        </div>
        <div style={{ gridColumn: "span 2" }}><span style={lbl}>Notes</span><input style={inp} value={f.notes} onChange={set("notes")} /></div>
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 9 }}>
        <button type="button" style={S.btn("#F1F5F9", "#334155")} onClick={onCancel}>Cancel</button>
        <button type="button" disabled={busy} style={S.btn(ACCENT, "#FFF")}
          onClick={() => onSave({
            driverId: f.driverId || null, loadDate: f.loadDate || null, routeLabel: f.routeLabel,
            milesOut: f.milesOut === "" ? null : Number(f.milesOut), milesBack: f.milesBack === "" ? null : Number(f.milesBack),
            permitStatus: f.permitStatus, notes: f.notes,
          })}>Save load</button>
      </div>
    </div>
  );
}

// ─── Drivers & delivery territories (Settings → Team; SCHEDULING_SCOPE.md decisions 9/9b) ───
// Each driver carries their OWN truck specs — deck length drives the capacity bar on every
// one of their loads, max width caps what they can haul (the one non-overridable rule) —
// and covers one or more TERRITORIES: broad corridors described in words ("Hwy 50 west of
// Linn to Kansas City, north to the Iowa line"), never city lists. driver_profiles is
// service-role only, so everything goes through portal-schedule (admin-gated server-side).
function DriversTerritoriesCard() {
  const [data, setData] = useState(null);      // { team, drivers, territories, crews }
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState({});    // userId -> editable driver draft
  const [editingDriver, setEditingDriver] = useState(null); // one-liner rows; Edit expands
  const [tDraft, setTDraft] = useState(null);  // { id?, name, description } | null
  const [cDraft, setCDraft] = useState(null);  // { id?, name, color, memberUserIds } | null
  const load = useCallback(async () => {
    const { data: d, error } = await sb.functions.invoke("portal-schedule", { body: { action: "list_drivers" } });
    if (error || !d || d.error) { setMsg({ err: (d && d.error) || "Could not load drivers." }); setData({ team: [], drivers: [], territories: [], crews: [] }); return; }
    setData(d);
    // Drafts are keyed by PROFILE id (095: drivers are name-first, logins optional).
    const map = {};
    (d.drivers || []).forEach((p) => {
      map[p.id] = {
        userId: p.user_id || null, displayName: p.display_name || "",
        isDriver: !!p.is_driver, truckName: p.truck_name || "",
        deck: p.deck_length_ft == null ? "" : String(p.deck_length_ft),
        maxW: p.max_width_ft == null ? "" : String(p.max_width_ft),
        wide: p.wide_load_capable !== false, territoryIds: p.territory_ids || [],
      };
    });
    setDrafts(map);
    setEditingDriver(null);
  }, []);
  useEffect(() => { load(); }, [load]);

  const team = (data && data.team) || [];
  const territories = (data && data.territories) || [];
  const crews = (data && data.crews) || [];
  const activeTerritories = territories.filter((t) => t.active !== false);
  const nameOfU = {}; team.forEach((m) => { nameOfU[m.userId] = m.name || m.userId.slice(0, 8); });
  const terrName = {}; territories.forEach((t) => { terrName[t.id] = t.name; });
  const call = async (body, okMsg) => {
    const { data: d, error } = await sb.functions.invoke("portal-schedule", { body });
    if (error || !d || d.error) { setMsg({ err: (d && d.error) || (error ? await fnError(error) : "That didn't save.") }); return null; }
    if (okMsg) setMsg({ ok: okMsg });
    return d;
  };
  const blank = { userId: null, displayName: "", isDriver: true, truckName: "", deck: "", maxW: "", wide: true, territoryIds: [] };
  const draftFor = (k) => drafts[k] || blank;
  const setDraft = (k, patch) => setDrafts({ ...drafts, [k]: { ...draftFor(k), ...patch } });
  const driverName = (f) => f.displayName || nameOfU[f.userId] || "Driver";
  const saveDriver = async (key, overrides) => {
    const f = { ...draftFor(key), ...(overrides || {}) };
    // A driver is a person on the team who can sign in — migration 101, and save_driver
    // enforces the same thing. Ask for it here so the answer arrives before the form is full.
    if (key === "new" && !f.userId) { setMsg({ err: "Pick the driver this truck belongs to. They need to be on your team first — add them under Team above." }); return; }
    if (!f.displayName.trim() && !f.userId) { setMsg({ err: "Give the driver a name." }); return; }
    setBusy(true); setMsg(null);
    const body = {
      action: "save_driver", isDriver: f.isDriver, displayName: f.displayName,
      truckName: f.truckName, deckLengthFt: f.deck === "" ? null : Number(f.deck),
      maxWidthFt: f.maxW === "" ? null : Number(f.maxW),
      wideLoadCapable: f.wide, territoryIds: f.territoryIds,
    };
    // `userId` goes up on EDITS as well as creates, so reassigning a truck to a different
    // person actually reaches the server — it writes user_id whenever the key is present.
    // Only sent when it has a value: the server reads a present-but-empty `userId` as an
    // attempt to unlink and refuses it ("A driver must stay linked to a team member"),
    // which is right, but sending it blindly would turn a half-filled form into that error.
    if (key === "new") { if (f.userId) body.userId = f.userId; }
    else { body.driverId = key; if (f.userId) body.userId = f.userId; }
    const r = await call(body, f.isDriver ? `${driverName(f)} saved.` : `${driverName(f)} is no longer a driver.`);
    setBusy(false);
    if (r) { if (key === "new") setDrafts((d) => { const n = { ...d }; delete n.new; return n; }); load(); }
  };
  const saveCrew = async () => {
    if (!cDraft || !cDraft.name.trim()) { setMsg({ err: "Give the crew a name." }); return; }
    setBusy(true); setMsg(null);
    // sortOrder + active go up on EDITS too. save_crew builds a FULL row —
    // `sort_order: num(payload?.sortOrder) ?? 0` and `active: payload?.active !== false` —
    // so omitting them was not "leave unchanged", it was "reset to 0" and "set active".
    // Renaming a crew therefore knocked it to the front of the order, and editing an
    // ARCHIVED crew silently un-archived it. The archive path already sent both; only the
    // edit path did not. Undefined for a new crew, which is exactly when the server's
    // defaults are the right answer.
    const r = await call({ action: "save_crew", id: cDraft.id, name: cDraft.name, color: cDraft.color, memberUserIds: cDraft.memberUserIds, sortOrder: cDraft.sortOrder, active: cDraft.active }, "Crew saved.");
    setBusy(false); if (r) { setCDraft(null); load(); }
  };
  const archiveCrew = async (c) => {
    setBusy(true); setMsg(null);
    const r = await call({ action: "save_crew", id: c.id, name: c.name, color: c.color, memberUserIds: c.member_user_ids || [], sortOrder: c.sort_order, active: c.active === false },
      c.active === false ? `${c.name} restored.` : `${c.name} archived.`);
    setBusy(false); if (r) load();
  };
  const saveTerritory = async () => {
    if (!tDraft || !tDraft.name.trim()) { setMsg({ err: "Give the territory a name." }); return; }
    setBusy(true); setMsg(null);
    // Same full-row overwrite as save_crew above — see that comment.
    const r = await call({ action: "save_territory", id: tDraft.id, name: tDraft.name, description: tDraft.description, sortOrder: tDraft.sortOrder, active: tDraft.active }, "Territory saved.");
    setBusy(false); if (r) { setTDraft(null); load(); }
  };
  const archiveTerritory = async (t) => {
    setBusy(true); setMsg(null);
    const r = await call({ action: "save_territory", id: t.id, name: t.name, description: t.description, sortOrder: t.sort_order, active: t.active === false }, t.active === false ? `${t.name} restored.` : `${t.name} archived.`);
    setBusy(false); if (r) load();
  };
  const toggleTerr = (uid, tid) => {
    const f = draftFor(uid);
    const has = f.territoryIds.indexOf(tid) !== -1;
    setDraft(uid, { territoryIds: has ? f.territoryIds.filter((x) => x !== tid) : [...f.territoryIds, tid] });
  };
  const lbl = { ...S.lbl, marginBottom: 3 };
  const inp = { ...S.input, padding: "6px 8px", fontSize: 12.5 };

  return (
    <div style={S.card}>
      <CardHead title="Crews, drivers & territories" count={null}
        right={<button type="button" onClick={load} style={S.btn("#F1F5F9", "#334155")}>↻ Refresh</button>} />
      <p style={{ fontSize: 12, color: "#64748B", fontWeight: 600, lineHeight: 1.5, margin: "0 0 12px" }}>
        <strong>Crews</strong> are who builds — the Build Schedule calendar flips between them.
        <strong> Drivers</strong> power the Delivery Schedule: deck length sets what fits on their loads, max width caps what they can haul, territories route the right deliveries to them.
      </p>
      {msg && msg.ok && <div style={S.okMsg}>{msg.ok}</div>}
      {msg && msg.err && <div style={S.err}>{msg.err}</div>}
      {data === null && <p style={{ fontSize: 13, color: "#64748B", padding: 8 }}>Loading…</p>}

      {data && (<>
        {/* ── Build crews (094) — one line each; Edit expands in place ── */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "2px 0 8px" }}>
          <span style={{ ...S.lbl, marginBottom: 0 }}>Build crews</span>
          <span style={{ fontSize: 11.5, color: "#94A3B8", fontWeight: 600 }}>— builds get assigned to a crew; each crew gets its own calendar</span>
          <button type="button" style={{ ...S.btn("#FFF", "#475569"), border: "1px solid #CBD5E1", padding: "4px 10px", fontSize: 11.5, marginLeft: "auto" }}
            onClick={() => setCDraft({ name: "", color: "#3D3672", memberUserIds: [] })}>+ Add crew</button>
        </div>
        {crews.length === 0 && !cDraft && (
          <p style={{ fontSize: 12.5, color: "#64748B", padding: "4px 2px 10px" }}>No crews yet — add your first ("TJ's crew", "Crew 2"…). Members are optional; many shop crews never log in.</p>
        )}
        {crews.map((c) => (
          cDraft && cDraft.id === c.id ? null : (
            <div key={c.id} style={{ display: "flex", gap: 10, alignItems: "center", border: "1px solid #E2E8F0", borderRadius: 10, padding: "8px 11px", marginBottom: 7, opacity: c.active === false ? 0.55 : 1 }}>
              <span style={{ width: 11, height: 11, borderRadius: "50%", background: c.color || ACCENT, flexShrink: 0 }}></span>
              <strong style={{ fontSize: 13 }}>{c.name}</strong>
              <span style={{ fontSize: 11.5, fontWeight: 600, color: "#64748B", flex: 1 }}>
                {(c.member_user_ids || []).length ? (c.member_user_ids || []).map((u) => nameOfU[u]).filter(Boolean).join(", ") : "no linked logins"}
              </span>
              <button type="button" style={{ ...S.btn("#F1F5F9", "#475569"), padding: "4px 9px", fontSize: 11 }}
                onClick={() => setCDraft({ id: c.id, name: c.name, color: c.color || "#3D3672", memberUserIds: c.member_user_ids || [], sortOrder: c.sort_order, active: c.active !== false })}>Edit</button>
              <button type="button" style={{ ...S.btn(c.active === false ? "#F0FDF4" : "#F1F5F9", c.active === false ? "#15803D" : "#64748B"), padding: "4px 9px", fontSize: 11 }} onClick={() => archiveCrew(c)}>{c.active === false ? "Restore" : "Archive"}</button>
            </div>
          )
        ))}
        {cDraft && (
          <div style={{ border: "1px dashed #B9C4D6", borderRadius: 10, padding: "9px 12px", marginBottom: 7 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
              <div style={{ width: 180 }}><span style={{ ...S.lbl, marginBottom: 3 }}>Crew name</span><input style={{ ...S.input, padding: "6px 8px", fontSize: 12.5 }} value={cDraft.name} onChange={(e) => setCDraft({ ...cDraft, name: e.target.value })} placeholder={'e.g. "TJ’s crew"'} /></div>
              <div><span style={{ ...S.lbl, marginBottom: 3 }}>Color</span><input type="color" value={cDraft.color} onChange={(e) => setCDraft({ ...cDraft, color: e.target.value })} style={{ width: 34, height: 30, border: "1px solid #CBD5E1", borderRadius: 6, background: "#FFF", padding: 2, cursor: "pointer", display: "block" }} /></div>
              <div style={{ flex: 1, minWidth: 200 }}>
                <span style={{ ...S.lbl, marginBottom: 3 }}>Team logins on this crew (optional)</span>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {team.map((m) => {
                    const on = cDraft.memberUserIds.indexOf(m.userId) !== -1;
                    return (
                      <button key={m.userId} type="button"
                        onClick={() => setCDraft({ ...cDraft, memberUserIds: on ? cDraft.memberUserIds.filter((x) => x !== m.userId) : [...cDraft.memberUserIds, m.userId] })}
                        style={{ ...schedChip(on ? "#3D3672" : "#F1F5F9", on ? "#FFF" : "#475569"), border: "none", cursor: "pointer", fontFamily: "inherit" }}>
                        {m.name || m.userId.slice(0, 8)}{on ? " ✓" : ""}
                      </button>
                    );
                  })}
                  {team.length === 0 && <span style={{ fontSize: 11, color: "#94A3B8", fontWeight: 600 }}>no team logins yet</span>}
                </div>
              </div>
              <button type="button" disabled={busy} style={S.btn(ACCENT, "#FFF")} onClick={saveCrew}>Save crew</button>
              <button type="button" style={S.btn("#F1F5F9", "#334155")} onClick={() => setCDraft(null)}>Cancel</button>
            </div>
          </div>
        )}

        {/* ── Territories ── */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "2px 0 8px" }}>
          <span style={{ ...S.lbl, marginBottom: 0 }}>Delivery territories</span>
          <span style={{ fontSize: 11.5, color: "#94A3B8", fontWeight: 600 }}>— broad corridors, not city lists. Describe them the way you'd tell a new driver.</span>
          <button type="button" style={{ ...S.btn("#FFF", "#475569"), border: "1px solid #CBD5E1", padding: "4px 10px", fontSize: 11.5, marginLeft: "auto" }}
            onClick={() => setTDraft({ name: "", description: "" })}>+ Add territory</button>
        </div>
        {territories.length === 0 && !tDraft && (
          <p style={{ fontSize: 12.5, color: "#64748B", padding: "4px 2px 10px" }}>
            None yet. Example: <em>"West — Hwy 50 west of the shop to Kansas City, the I-70 corridor and everything in between, north to the Iowa line."</em>
          </p>
        )}
        {territories.map((t) => (
          tDraft && tDraft.id === t.id ? (
            <div key={t.id} style={{ display: "flex", gap: 8, alignItems: "flex-end", border: "1px solid #E2E8F0", borderRadius: 10, padding: "8px 11px", marginBottom: 7 }}>
              <div style={{ width: 140 }}><span style={lbl}>Name</span><input style={inp} value={tDraft.name} onChange={(e) => setTDraft({ ...tDraft, name: e.target.value })} /></div>
              <div style={{ flex: 1 }}><span style={lbl}>Covers</span><input style={inp} value={tDraft.description || ""} onChange={(e) => setTDraft({ ...tDraft, description: e.target.value })} /></div>
              <button type="button" disabled={busy} style={S.btn(ACCENT, "#FFF")} onClick={saveTerritory}>Save</button>
              <button type="button" style={S.btn("#F1F5F9", "#334155")} onClick={() => setTDraft(null)}>Cancel</button>
            </div>
          ) : (
            <div key={t.id} style={{ display: "flex", gap: 10, alignItems: "center", border: "1px solid #E2E8F0", borderRadius: 10, padding: "8px 11px", marginBottom: 7, opacity: t.active === false ? 0.55 : 1 }}>
              <span style={schedChip("#EEF2FF", "#3D3672")}>{t.name}</span>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: "#334155", flex: 1 }}>{t.description || <em style={{ color: "#94A3B8" }}>no description</em>}</span>
              <button type="button" style={{ ...S.btn("#F1F5F9", "#475569"), padding: "4px 9px", fontSize: 11 }} onClick={() => setTDraft({ id: t.id, name: t.name, description: t.description || "", sortOrder: t.sort_order, active: t.active !== false })}>Edit</button>
              <button type="button" style={{ ...S.btn(t.active === false ? "#F0FDF4" : "#F1F5F9", t.active === false ? "#15803D" : "#64748B"), padding: "4px 9px", fontSize: 11 }} onClick={() => archiveTerritory(t)}>{t.active === false ? "Restore" : "Archive"}</button>
            </div>
          )
        ))}
        {tDraft && !tDraft.id && (
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end", border: "1px dashed #B9C4D6", borderRadius: 10, padding: "8px 11px", marginBottom: 7 }}>
            <div style={{ width: 140 }}><span style={lbl}>Name</span><input style={inp} value={tDraft.name} onChange={(e) => setTDraft({ ...tDraft, name: e.target.value })} placeholder="West" /></div>
            <div style={{ flex: 1 }}><span style={lbl}>Covers</span><input style={inp} value={tDraft.description || ""} onChange={(e) => setTDraft({ ...tDraft, description: e.target.value })} placeholder="Hwy 50 west of the shop to Kansas City, north to the Iowa line" /></div>
            <button type="button" disabled={busy} style={S.btn(ACCENT, "#FFF")} onClick={saveTerritory}>Save</button>
            <button type="button" style={S.btn("#F1F5F9", "#334155")} onClick={() => setTDraft(null)}>Cancel</button>
          </div>
        )}

        {/* ── Drivers — one line each (like Sales Locations); Edit expands in place.
               Name-first (095): type any name; linking a portal login is optional. ── */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "16px 0 8px" }}>
          <span style={{ ...S.lbl, marginBottom: 0 }}>Trucks &amp; drivers</span>
          <span style={{ fontSize: 11.5, color: "#94A3B8", fontWeight: 600 }}>— truck specs drive the load planner's deck math</span>
          <button type="button" disabled={busy || editingDriver === "new"}
            onClick={() => { setDraft("new", { ...blank }); setEditingDriver("new"); }}
            style={{ ...S.btn(editingDriver === "new" ? "#E2E8F0" : ACCENT, editingDriver === "new" ? "#94A3B8" : "#FFF"), padding: "5px 11px", fontSize: 11.5, marginLeft: "auto" }}>
            + Add truck
          </button>
        </div>
        {(data.drivers || []).filter((p) => p.is_driver).length === 0 && editingDriver !== "new" && (
          <p style={{ fontSize: 12.5, color: "#64748B", padding: "4px 2px 8px" }}>
            No trucks yet — add a truck and connect the driver who runs it. Deck length and max
            width are what the load planner uses to decide what fits.
          </p>
        )}
        {(data.drivers || []).filter((p) => p.is_driver).map((p) => p.id).concat(editingDriver === "new" ? ["new"] : []).map((key) => {
          const f = draftFor(key);
          const editing = editingDriver === key;
          return (
            <div key={key} style={{ border: "1px " + (key === "new" ? "dashed #B9C4D6" : "solid #E2E8F0"), borderRadius: 10, marginBottom: 7, background: "#FBFCFE" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 11px", flexWrap: "wrap" }}>
                <strong style={{ fontSize: 13 }}>{key === "new" ? (f.displayName || "New driver") : driverName(f)}</strong>
                {f.userId && <span style={schedChip("#EEF2FF", "#3D3672")}>login ✓</span>}
                <span style={{ fontSize: 11.5, fontWeight: 600, color: "#64748B", flex: 1, minWidth: 160 }}>
                  {[f.truckName || "no truck yet", f.deck ? f.deck + "' deck" : null, f.maxW ? "max " + f.maxW + "' wide" : null, f.wide ? "wide-load ✓" : "no wide loads"].filter(Boolean).join(" · ")}
                  {f.territoryIds.length > 0 ? " · " + f.territoryIds.map((tid) => terrName[tid]).filter(Boolean).join(", ") : ""}
                </span>
                {key !== "new" && <button type="button" style={{ ...S.btn("#F1F5F9", "#475569"), padding: "4px 9px", fontSize: 11 }} onClick={() => setEditingDriver(editing ? null : key)}>{editing ? "Close" : "Edit"}</button>}
              </div>
              {editing && (
                <div style={{ borderTop: "1px solid #F1F5F9", padding: "9px 11px" }}>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: "8px 10px" }}>
                    <div><span style={lbl}>Truck / trailer</span><input style={inp} value={f.truckName} onChange={(e) => setDraft(key, { truckName: e.target.value })} placeholder="40' gooseneck" /></div>
                    {/* Editable for an EXISTING driver too, not just a new one. It used to be a
                        read-only box, so once a profile was created the truck was welded to
                        that person: reassigning it meant deleting the driver and rebuilding
                        the truck, deck, width and territories from scratch. The server has
                        always supported the change (portal-schedule's save_driver writes
                        user_id whenever `userId` is present), so this was a UI-only dead end.
                        The list keeps the CURRENT person in it — filtering to "people without
                        a profile" alone would drop the selected value and blank the field. */}
                    <div>
                      <span style={lbl}>Driver{key === "new" ? " *" : ""}</span>
                      <select style={inp} value={f.userId || ""}
                        onChange={(e) => { const v = e.target.value; setDraft(key, { userId: v || null, displayName: v ? (nameOfU[v] || "") : "" }); }}>
                        <option value="">Who drives it?…</option>
                        {team.filter((m) => m.userId === f.userId || !(data.drivers || []).some((p) => p.user_id === m.userId))
                          .map((m) => <option key={m.userId} value={m.userId}>{m.name || m.userId.slice(0, 8)}</option>)}
                      </select>
                      {key !== "new" && (
                        <div style={{ fontSize: 10.5, color: "#94A3B8", marginTop: 3, lineHeight: 1.4 }}>
                          Changing this hands the truck and its territories to someone else. Every driver must keep a login.
                        </div>
                      )}
                    </div>
                    <div><span style={lbl}>Deck length (ft)</span><input style={inp} value={f.deck} onChange={(e) => setDraft(key, { deck: e.target.value })} placeholder="40" /></div>
                    <div><span style={lbl}>Max building width (ft)</span><input style={inp} value={f.maxW} onChange={(e) => setDraft(key, { maxW: e.target.value })} placeholder="14" /></div>
                    <div><span style={lbl}>Wide-load capable</span>
                      <select style={inp} value={f.wide ? "yes" : "no"} onChange={(e) => setDraft(key, { wide: e.target.value === "yes" })}>
                        <option value="yes">Yes</option><option value="no">No</option>
                      </select>
                    </div>
                  </div>
                  {activeTerritories.length > 0 && (
                    <div style={{ marginTop: 8 }}>
                      <span style={lbl}>Territories</span>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 3 }}>
                        {activeTerritories.map((t) => {
                          const on = f.territoryIds.indexOf(t.id) !== -1;
                          return (
                            <button key={t.id} type="button" onClick={() => toggleTerr(key, t.id)} title={t.description || t.name}
                              style={{ ...schedChip(on ? "#3D3672" : "#F1F5F9", on ? "#FFF" : "#475569"), border: "none", cursor: "pointer", fontFamily: "inherit" }}>
                              {t.name}{on ? " ✓" : ""}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 8, marginTop: 9 }}>
                    <button type="button" disabled={busy} style={{ ...S.btn(ACCENT, "#FFF"), padding: "6px 13px", fontSize: 12 }} onClick={() => saveDriver(key)}>Save driver</button>
                    <button type="button" style={{ ...S.btn("#F1F5F9", "#334155"), padding: "6px 13px", fontSize: 12 }} onClick={() => { setEditingDriver(null); if (key === "new") setDrafts((d) => { const n = { ...d }; delete n.new; return n; }); }}>Cancel</button>
                    {key !== "new" && <button type="button" disabled={busy} style={{ ...S.btn("#FEF2F2", "#DC2626"), padding: "6px 13px", fontSize: 12, marginLeft: "auto" }} onClick={() => saveDriver(key, { isDriver: false })}>Remove driver</button>}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </>)}
    </div>
  );
}

// ─── Sales locations + building serial numbers (Settings → Team) ───
// Locations are where inventory buildings sit on display; the serial block sets the ONE
// shared per-builder sequence (inventory now, orders when Build Scheduling ships).
function LocationsCard() {
  const [locs, setLocs] = useState(null);        // null = loading
  const [nextSerial, setNextSerial] = useState("");
  const [form, setForm] = useState(null);        // { id?, name, street, city, state, zip } | null
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const load = useCallback(async () => {
    const { data, error } = await sb.functions.invoke("portal-settings", { body: { action: "list_locations" } });
    if (error || !data || data.error) { setMsg({ err: (data && data.error) || "Could not load locations." }); setLocs([]); return; }
    setLocs(data.locations || []);
    setNextSerial(data.nextSerial == null ? "" : String(data.nextSerial));
  }, []);
  useEffect(() => { load(); }, [load]);
  const saveLoc = async () => {
    if (!form || !String(form.name || "").trim()) { setMsg({ err: "Give the location a name." }); return; }
    setBusy(true); setMsg(null);
    const { data, error } = await sb.functions.invoke("portal-settings", { body: { action: "save_location", ...form } });
    setBusy(false);
    if (error || !data || data.error) { setMsg({ err: (data && data.error) || "Save failed." }); return; }
    setForm(null); setMsg({ ok: "Location saved." }); load();
  };
  const delLoc = async (l) => {
    if (!window.confirm(`Remove "${l.name}"? Buildings sitting there keep existing — they'll just show no location.`)) return;
    setBusy(true); setMsg(null);
    const { data, error } = await sb.functions.invoke("portal-settings", { body: { action: "delete_location", id: l.id } });
    setBusy(false);
    if (error || !data || data.error) { setMsg({ err: (data && data.error) || "Delete failed." }); return; }
    load();
  };
  const saveSerial = async () => {
    setBusy(true); setMsg(null);
    const { data, error } = await sb.functions.invoke("portal-settings", { body: { action: "save_serial_start", nextSerial: Number(nextSerial) } });
    setBusy(false);
    if (error || !data || data.error) { setMsg({ err: (data && data.error) || "Save failed." }); return; }
    setMsg({ ok: `Next building will be #${data.nextSerial}.` });
  };
  const F = form || {};
  return (
    <div style={S.card}>
      <div style={S.h2}>Sales Locations</div>
      <div style={{ fontSize: 12.5, color: "#64748B", marginBottom: 12, lineHeight: 1.5 }}>
        The lots where your buildings sit on display. Every inventory building is tracked to one of these.
      </div>
      {msg && msg.ok && <div style={{ background: "#F0FDF4", border: "1px solid #BBF7D0", color: "#15803D", borderRadius: 8, padding: "8px 12px", fontSize: 13, fontWeight: 600, marginBottom: 10 }}>{msg.ok}</div>}
      {msg && msg.err && <div style={{ ...S.err, marginBottom: 10 }}>{msg.err}</div>}
      {locs === null && <p style={{ fontSize: 13, color: "#64748B" }}>Loading…</p>}
      {locs && locs.length === 0 && <p style={{ fontSize: 13, color: "#64748B" }}>No locations yet — add your first lot below.</p>}
      {(locs || []).map((l) => (
        <div key={l.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 2px", borderBottom: "1px solid #F1F5F9", fontSize: 13, flexWrap: "wrap" }}>
          <strong style={{ minWidth: 140 }}>{l.name}</strong>
          <span style={{ color: "#64748B", flex: 1, minWidth: 200 }}>{[l.street, l.city, l.state, l.zip].filter(Boolean).join(", ") || "No address"}</span>
          <span style={{ background: "#F1F5F9", color: "#475569", borderRadius: 12, fontSize: 11, fontWeight: 700, padding: "2px 9px" }}>{l.buildings} {l.buildings === 1 ? "building" : "buildings"}</span>
          <button type="button" onClick={() => { setForm({ id: l.id, name: l.name, street: l.street || "", city: l.city || "", state: l.state || "", zip: l.zip || "" }); }} disabled={busy}
            style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit", fontSize: "inherit", color: ACCENT, fontWeight: 700 }}>Edit</button>
          <button type="button" onClick={() => delLoc(l)} disabled={busy}
            style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit", fontSize: "inherit", color: "#94A3B8", fontWeight: 700 }}>Remove</button>
        </div>
      ))}
      {form ? (
        <div style={{ background: "#F8FAFC", border: "1px dashed #CBD5E1", borderRadius: 10, padding: "13px 14px", marginTop: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10, marginBottom: 10 }}>
            <div><span style={S.lbl}>Location name</span><input style={S.input} value={F.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="e.g. Hwy 65 Display" /></div>
            <div><span style={S.lbl}>Street</span><input style={S.input} value={F.street} onChange={(e) => setForm((f) => ({ ...f, street: e.target.value }))} /></div>
            <div><span style={S.lbl}>City</span><input style={S.input} value={F.city} onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))} /></div>
            <div><span style={S.lbl}>State</span><input style={S.input} value={F.state} onChange={(e) => setForm((f) => ({ ...f, state: e.target.value }))} /></div>
            <div><span style={S.lbl}>Zip</span><input style={S.input} value={F.zip} onChange={(e) => setForm((f) => ({ ...f, zip: e.target.value.replace(/\D/g, "").slice(0, 5) }))} /></div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={saveLoc} disabled={busy} style={S.btn(ACCENT, "#FFF")}>{busy ? "Saving…" : (F.id ? "Save location" : "+ Add location")}</button>
            <button type="button" onClick={() => setForm(null)} disabled={busy} style={S.btn("#F1F5F9", "#334155")}>Cancel</button>
          </div>
        </div>
      ) : (
        <div style={{ marginTop: 12 }}>
          <button type="button" onClick={() => setForm({ name: "", street: "", city: "", state: "", zip: "" })} style={S.btn(ACCENT, "#FFF")}>+ Add location</button>
        </div>
      )}
      <div style={{ borderTop: "1px solid #EDF1F6", margin: "18px 0 14px" }}></div>
      <div style={S.h2}>Building Serial Numbers</div>
      <div style={{ fontSize: 12.5, color: "#64748B", marginBottom: 12, lineHeight: 1.5 }}>
        Every inventory building — and every customer order that reaches your build board — takes
        the next number in one shared sequence, in the order they're created.
      </div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 12, flexWrap: "wrap" }}>
        <div>
          <span style={S.lbl}>Next serial #</span>
          <input style={{ ...S.input, fontSize: 18, fontWeight: 800, width: 140, fontVariantNumeric: "tabular-nums" }}
            value={nextSerial} inputMode="numeric"
            onChange={(e) => setNextSerial(e.target.value.replace(/\D/g, "").slice(0, 9))} />
        </div>
        <button type="button" onClick={saveSerial} disabled={busy || !nextSerial} style={S.btn(ACCENT, "#FFF")}>Save</button>
        <span style={{ fontSize: 12, color: "#94A3B8", maxWidth: 420, lineHeight: 1.5 }}>
          Set this once to match your shop's count: if your last build was <strong>#12046</strong>, enter <strong>12047</strong>.
          It advances on its own and can never go backwards past a used number.
        </span>
      </div>
      {/* Says what these locations DO, not what they will one day do. The previous copy
          promised "assigning team members to locations arrives with Build & Delivery
          Scheduling" — scheduling shipped 2026-08-04 and renders on this very tab, while
          member↔location assignment was never built, so the banner read as a delivered
          feature the owner could not find. */}
      <div style={{ background: "#EFF6FF", border: "1px solid #BFDBFE", color: "#1E3A8A", borderRadius: 10, padding: "10px 14px", fontSize: 12.5, fontWeight: 600, marginTop: 14, lineHeight: 1.5 }}>
        📍 Locations are where your buildings live: each inventory building sits at one, and
        the Delivery Schedule uses it as the pickup point when that building sells.
      </div>
    </div>
  );
}

