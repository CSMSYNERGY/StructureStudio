// ─── Generic Monday-style table engine ───
// Column-descriptor-driven grouped table, built for the Projects tab (10-projects.jsx)
// and designed so the Build Schedule's table view can re-skin onto it later: everything
// below reads only column rows ({id, type, name, settings, width}), item rows
// ({id, name, values, group_id, position}), and a ctx object — nothing is board-specific.
//
// Architecture copied deliberately from the Build Schedule table (05-schedule.jsx):
//   * ONE <table> whether grouped or not — table-per-group would break column alignment.
//   * Group headings are full-width colSpan rows: {key, label, rank, color, rows}.
//   * Grouping ARRANGES, filtering NARROWS, they compose; group order comes from the
//     mode, never from the sort; sort applies WITHIN a group.
//   * THE INVARIANT: no grouping mode may ever drop a row — enumerable modes pad empty
//     buckets in, and anything unmatched lands in a "—" bucket.
//   * Drag-and-drop: id-based row→bucket with stopPropagation on the inner target
//     (load-bearing — see groupDropProps in 05-schedule.jsx).
//
// Cell editing is INLINE-IMMEDIATE (Monday-style): native controls (select / date / text
// inputs) swapped into the cell on click, committed on change/blur through onCellCommit.
// Native controls beat hand-rolled popovers here: keyboard accessible, no outside-click
// bookkeeping, and they work in the no-bundler babel world without a positioning library.

// One generic chip row (the crew-chips / stage-chips / StatusChips visual, made reusable).
function PMChips({ items, value, onChange, allLabel }) {
  const base = { border: "1px solid #CBD5E1", background: "#FFF", color: "#334155", borderRadius: 999, padding: "5px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer" };
  const on = { ...base, background: ACCENT, borderColor: ACCENT, color: "#FFF" };
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
      <button type="button" style={value == null ? on : base} onClick={() => onChange(null)}>{allLabel || "All"}</button>
      {items.map((it) => (
        <button key={it.key} type="button" style={value === it.key ? on : base} onClick={() => onChange(it.key)}>
          {it.color && <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: it.color, marginRight: 5, verticalAlign: 0 }} />}
          {it.label}{it.count != null ? ` (${it.count})` : ""}
        </button>
      ))}
    </div>
  );
}

const pmStatusLabel = (col, id) => (col.settings?.labels || []).find((l) => l.id === id) || null;
const pmOption = (col, id) => (col.settings?.options || []).find((o) => o.id === id) || null;
// Assignable people are pm_people (migration 148) — a roster of names, separate from who
// holds operator access. A person always has a name; the email is optional.
const pmPersonName = (o) => (o && (o.name || (o.email || "").split("@")[0])) || "?";
const pmPeopleNames = (ids, ctx) => (Array.isArray(ids) ? ids : []).map((id) => pmPersonName(ctx.peopleById[id]));
const pmInitials = (o) => pmPersonName(o).slice(0, 2).toUpperCase();
const PM_AVATAR_COLORS = ["#3D3672", "#1B7895", "#0E9F6E", "#B45309", "#BE185D", "#4338CA"];
const pmAvatarColor = (id) => PM_AVATAR_COLORS[Math.abs(String(id).split("").reduce((a, c) => a + c.charCodeAt(0), 0)) % PM_AVATAR_COLORS.length];

const pmChipStyle = (bg) => ({ display: "inline-block", fontSize: 11, fontWeight: 800, color: "#FFF", background: bg || "#64748B", borderRadius: 6, padding: "3px 10px", letterSpacing: 0.2, whiteSpace: "nowrap" });

// ── The type registry ─────────────────────────────────────────────────────────
// Per type: renderCell(value, col, ctx) → node · sortVal(value, col, ctx) → comparable ·
// groupsFor(col, ctx) → [{key,label,rank,color}] | null (null = not groupable) ·
// groupKeyOf(value) → key · facet (does this type get a toolbar FacetSelect).
const PM_TYPES = {
  status: {
    renderCell: (v, col) => { const l = pmStatusLabel(col, v); return l ? <span style={pmChipStyle(l.color)}>{l.label}</span> : <span style={{ color: "#94A3B8" }}>—</span>; },
    sortVal: (v, col) => { const ls = col.settings?.labels || []; const i = ls.findIndex((l) => l.id === v); return i === -1 ? "" : String(i).padStart(3, "0"); },
    groupsFor: (col) => (col.settings?.labels || []).map((l, i) => ({ key: l.id, label: l.label, rank: i, color: l.color })),
    groupKeyOf: (v) => v || null,
    facet: true,
  },
  dropdown: {
    renderCell: (v, col) => {
      const ids = Array.isArray(v) ? v : (v ? [v] : []);
      if (!ids.length) return <span style={{ color: "#94A3B8" }}>—</span>;
      return ids.map((id) => { const o = pmOption(col, id); return o ? <span key={id} style={{ display: "inline-block", fontSize: 11, fontWeight: 700, color: o.color, border: `1px solid ${o.color}44`, background: `${o.color}14`, borderRadius: 6, padding: "2px 9px", marginRight: 4, whiteSpace: "nowrap" }}>{o.label}</span> : null; });
    },
    sortVal: (v, col) => { const ids = Array.isArray(v) ? v : (v ? [v] : []); if (!ids.length) return ""; const os = col.settings?.options || []; const i = os.findIndex((o) => o.id === ids[0]); return i === -1 ? "" : String(i).padStart(3, "0"); },
    groupsFor: (col) => (col.settings?.options || []).map((o, i) => ({ key: o.id, label: o.label, rank: i, color: o.color })),
    groupKeyOf: (v) => { const ids = Array.isArray(v) ? v : (v ? [v] : []); return ids[0] || null; },
    facet: true,
  },
  people: {
    renderCell: (v, col, ctx) => {
      const ids = Array.isArray(v) ? v : [];
      if (!ids.length) return <span style={{ color: "#94A3B8" }}>—</span>;
      return (
        <span style={{ whiteSpace: "nowrap" }}>
          {ids.map((id) => { const o = ctx.peopleById[id]; return (
            <span key={id} title={o ? (o.email || o.name) : id} style={{ display: "inline-flex", width: 22, height: 22, borderRadius: "50%", background: pmAvatarColor(id), color: "#FFF", fontSize: 9.5, fontWeight: 800, alignItems: "center", justifyContent: "center", marginRight: -5, border: "2px solid #FFF", verticalAlign: "middle" }}>{pmInitials(o)}</span>
          ); })}
          <span style={{ marginLeft: 10, fontSize: 12 }}>{pmPeopleNames(ids, ctx).join(", ")}</span>
        </span>
      );
    },
    sortVal: (v, col, ctx) => pmPeopleNames(v, ctx).join(",").toLowerCase(),
    groupsFor: (col, ctx) => ctx.people.map((o, i) => ({ key: o.id, label: pmPersonName(o), rank: i, color: pmAvatarColor(o.id) })),
    groupKeyOf: (v) => (Array.isArray(v) && v.length ? v[0] : null),
    facet: true,
  },
  date: {
    // Date-ONLY strings parse as UTC midnight through bare new Date() (which is what
    // fmtDate does), so every date rendered a DAY EARLY in US timezones - the exact trap
    // the 2026-08-20 audit documented for the schedule. ssLocalDate parses local midnight.
    renderCell: (v) => v ? <span style={{ whiteSpace: "nowrap" }}>{ssLocalDate(v).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span> : <span style={{ color: "#94A3B8" }}>—</span>,
    sortVal: (v) => v || "",
    groupsFor: () => null,
    groupKeyOf: (v) => v || null,
    facet: false,
  },
  checkbox: {
    renderCell: (v) => <span style={{ fontSize: 15 }}>{v === true ? "☑" : "☐"}</span>,
    sortVal: (v) => (v === true ? "1" : "0"),
    groupsFor: () => [{ key: "yes", label: "Checked", rank: 0, color: "#0E9F6E" }, { key: "no", label: "Unchecked", rank: 1, color: "#94A3B8" }],
    groupKeyOf: (v) => (v === true ? "yes" : "no"),
    facet: false,
  },
  number: {
    renderCell: (v, col) => (v == null || v === "") ? <span style={{ color: "#94A3B8" }}>—</span> : <span style={{ fontVariantNumeric: "tabular-nums" }}>{Number(v).toLocaleString("en-US", { maximumFractionDigits: col.settings?.precision ?? 2 })}{col.settings?.unit ? " " + col.settings.unit : ""}</span>,
    sortVal: (v) => (v == null || v === "") ? null : Number(v),
    groupsFor: () => null,
    groupKeyOf: () => null,
    facet: false,
  },
  text: {
    renderCell: (v) => v ? String(v) : <span style={{ color: "#94A3B8" }}>—</span>,
    sortVal: (v) => String(v || "").toLowerCase(),
    groupsFor: () => null, groupKeyOf: (v) => v || null, facet: false,
  },
  long_text: {
    renderCell: (v) => v ? <span title={String(v)} style={{ display: "inline-block", maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", verticalAlign: "bottom" }}>{String(v)}</span> : <span style={{ color: "#94A3B8" }}>—</span>,
    sortVal: (v) => String(v || "").toLowerCase(),
    groupsFor: () => null, groupKeyOf: () => null, facet: false,
  },
  link: {
    renderCell: (v) => (v && v.url) ? <a href={v.url} target="_blank" rel="noreferrer" style={{ color: "#1B7895", fontWeight: 600 }} onClick={(e) => e.stopPropagation()}>{v.text || v.url.replace(/^https?:\/\//, "").slice(0, 40)}</a> : <span style={{ color: "#94A3B8" }}>—</span>,
    sortVal: (v) => String((v && (v.text || v.url)) || "").toLowerCase(),
    groupsFor: () => null, groupKeyOf: () => null, facet: false,
  },
};

const pmType = (col) => PM_TYPES[col.type] || PM_TYPES.text;
const pmGroupable = (col, ctx) => pmType(col).groupsFor(col, ctx) != null;

// ── Inline cell editing ──────────────────────────────────────────────────
// EVERY field is edited in its own cell (Carolyn 2026-08-27: "like in Monday and excel").
// The item modal owns notes only — it is never a form, and nothing here opens it.
//
// Two shapes, both one click to open and one click (or blur) to save:
//   * choice fields (status / dropdown / people) → PMChoiceMenu, a small anchored list.
//     A native <select> needed THREE clicks (open the editor, open the select, pick) and
//     showed raw text instead of the colours the board is read by.
//   * typed fields (text / long text / number / date / link) → PMCellInput, committed on
//     Enter or blur, abandoned on Escape. Checkbox commits straight from the cell click.

function PMChoiceMenu({ col, value, ctx, onCommit, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    // Deferred: the very click that opened this menu is still travelling to document.
    const t = setTimeout(() => document.addEventListener("mousedown", onDoc), 0);
    window.addEventListener("keydown", onKey);
    return () => { clearTimeout(t); document.removeEventListener("mousedown", onDoc); window.removeEventListener("keydown", onKey); };
  }, [onClose]);

  const rows = [];
  if (col.type === "status") {
    (col.settings?.labels || []).forEach((l) => rows.push({ key: l.id, label: l.label, color: l.color, on: value === l.id }));
  } else if (col.type === "dropdown") {
    const cur = Array.isArray(value) ? value : (value ? [value] : []);
    (col.settings?.options || []).forEach((o) => rows.push({ key: o.id, label: o.label, color: o.color, on: cur.includes(o.id) }));
  } else {
    const cur = Array.isArray(value) ? value : [];
    ctx.people.forEach((o) => rows.push({ key: o.id, label: pmPersonName(o), color: pmAvatarColor(o.id), on: cur.includes(o.id) }));
  }

  const pick = (key) => {
    if (col.type === "status") { onCommit(value === key ? null : key); onClose(); return; }
    const cur = Array.isArray(value) ? value.slice() : (value ? [value] : []);
    const multi = col.type === "people" || col.settings?.multi === true;
    if (!multi) { onCommit(cur[0] === key ? [] : [key]); onClose(); return; }
    // Multi-select stays open so several can be ticked in one visit.
    const i = cur.indexOf(key);
    if (i === -1) cur.push(key); else cur.splice(i, 1);
    onCommit(cur);
  };

  return (
    <div ref={ref} onClick={(e) => e.stopPropagation()}
      style={{ position: "absolute", top: "100%", left: 4, zIndex: 70, minWidth: 170, maxHeight: 260, overflowY: "auto",
        background: "#FFF", border: "1px solid #CBD5E1", borderRadius: 10, boxShadow: "0 12px 30px rgba(20,24,40,.18)", padding: 5 }}>
      <button type="button" onClick={() => { onCommit(col.type === "status" ? null : []); onClose(); }}
        style={{ display: "block", width: "100%", textAlign: "left", background: "none", border: "none", cursor: "pointer",
          fontSize: 12, fontWeight: 600, color: "#94A3B8", padding: "5px 8px", borderRadius: 6, fontFamily: "inherit" }}>
        {col.type === "people" ? "Unassigned" : "— none"}
      </button>
      {rows.map((r) => (
        <button key={r.key} type="button" onClick={() => pick(r.key)}
          style={{ display: "flex", alignItems: "center", gap: 7, width: "100%", textAlign: "left", cursor: "pointer",
            background: r.on ? "#EEF2FF" : "none", border: "none", borderRadius: 6, padding: "5px 8px",
            fontSize: 12.5, fontWeight: r.on ? 800 : 600, color: "#334155", fontFamily: "inherit" }}>
          <span style={{ width: 10, height: 10, borderRadius: 3, background: r.color || "#CBD5E1", flexShrink: 0 }} />
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.label}</span>
          {r.on && <span style={{ color: ACCENT, fontWeight: 800 }}>✓</span>}
        </button>
      ))}
    </div>
  );
}

function PMCellInput({ col, value, onCommit, onClose }) {
  const isLink = col.type === "link";
  const [text, setText] = useState(isLink ? ((value && value.url) || "") : (value == null ? "" : String(value)));
  const base = { ...S.input, padding: "4px 6px", fontSize: 12.5 };
  const commit = () => {
    if (col.type === "number") onCommit(text.trim() === "" ? null : Number(text));
    else if (isLink) onCommit(text.trim() ? { url: text.trim(), text: (value && value.text) || "" } : null);
    else onCommit(text);
    onClose();
  };
  if (col.type === "date") {
    return <input autoFocus type="date" style={{ ...base, minWidth: 130 }} value={value || ""}
      onChange={(e) => { onCommit(e.target.value || null); onClose(); }}
      onBlur={onClose} onKeyDown={(e) => { if (e.key === "Escape") onClose(); }} />;
  }
  if (col.type === "long_text") {
    return <textarea autoFocus rows={3} style={{ ...base, width: "100%", minWidth: 220, resize: "vertical", fontWeight: 500 }}
      value={text} onChange={(e) => setText(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Escape") onClose(); if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) commit(); }} />;
  }
  return <input autoFocus type={col.type === "number" ? "number" : "text"}
    placeholder={isLink ? "https://…" : undefined}
    style={{ ...base, minWidth: isLink ? 200 : 130, width: "100%" }}
    value={text} onChange={(e) => setText(e.target.value)} onBlur={commit}
    onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") onClose(); }} />;
}

// ── Group computation ─────────────────────────────────────────────────────────
// mode "groups" buckets by group_id over the boardGroups rows; a column id buckets by that
// column's groupKeyOf. Enumerable buckets are padded in even when empty (so drops have
// somewhere to land); the "—" bucket collects rows without a value and is only shown when
// occupied. Rank orders the buckets; the caller's sort orders rows INSIDE each bucket.
function pmComputeGroups(mode, rows, boardGroups, columns, ctx) {
  if (mode === "groups") {
    const byId = new Map(boardGroups.map((g, i) => [g.id, { key: g.id, label: g.name, rank: i, color: g.color || ACCENT, rows: [], isRealGroup: true }]));
    const orphan = { key: "__none", label: "—", rank: 9999, color: "#94A3B8", rows: [] };
    rows.forEach((r) => { (byId.get(r.group_id) || orphan).rows.push(r); });
    const out = [...byId.values()];
    if (orphan.rows.length) out.push(orphan);
    return out;
  }
  const col = columns.find((c) => c.id === mode);
  if (!col) return [{ key: "__all", label: "", rank: 0, color: null, rows }];
  const t = pmType(col);
  const defs = t.groupsFor(col, ctx) || [];
  const byKey = new Map(defs.map((d) => [d.key, { ...d, rows: [] }]));
  const none = { key: "__none", label: "No " + col.name.toLowerCase(), rank: 9999, color: "#94A3B8", rows: [] };
  rows.forEach((r) => {
    const k = t.groupKeyOf(r.values ? r.values[col.id] : null);
    (byKey.get(k) || none).rows.push(r);
  });
  const out = [...byKey.values()];
  if (none.rows.length) out.push(none);
  return out;
}

// ── The table ─────────────────────────────────────────────────────────────────
// Props:
//   columns / rows / boardGroups / ctx ({people, peopleById})
//   groupBy: "groups" | <columnId>    hiddenCols: Set of column ids
//   sortKey ("name" | columnId) / sortDir / onSort
//   canEdit + onCellCommit(item, col, value) + onDropToGroup(item, group) +
//   onDropOnRow(item, beforeItem) + onRowOpen(item) + onAddItem(group, name)
//   activeItemId — the row whose modal is open (ACCENT outline, decision 25's marking)
function PMTable({ columns, rows, boardGroups, ctx, groupBy, hiddenCols, sortKey, sortDir, onSort, canEdit, onCellCommit, onDropToGroup, onDropOnRow, onRowOpen, onAddItem, onReorderCols, activeItemId }) {
  const [dragId, setDragId] = useState(null);
  const [dragColId, setDragColId] = useState(null);       // a header being dragged
  const [colDropTarget, setColDropTarget] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);   // group key or "row:"+id
  const [editCell, setEditCell] = useState(null);       // itemId + ":" + colId
  const [newItemGroup, setNewItemGroup] = useState(null);
  const [newItemName, setNewItemName] = useState("");

  const visCols = columns.filter((c) => !hiddenCols.has(c.id));
  const colCount = visCols.length + 2; // grip + name

  const sorted = useMemo(() => {
    const valOf = (r) => {
      if (sortKey === "name") return String(r.name || "").toLowerCase();
      const col = columns.find((c) => c.id === sortKey);
      if (!col) return "";
      return pmType(col).sortVal(r.values ? r.values[sortKey] : null, col, ctx);
    };
    return sortRows(rows, valOf, sortDir);
  }, [rows, sortKey, sortDir, columns, ctx]);

  const groups = useMemo(() => pmComputeGroups(groupBy, sorted, boardGroups, columns, ctx),
    [groupBy, sorted, boardGroups, columns, ctx]);

  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);

  // Drops: onto a group header/band = move into that bucket; onto a row = insert above it
  // (same bucket ⇒ reorder; different ⇒ move). preventDefault on dragover is what makes an
  // element a drop target at all; stopPropagation keeps the inner target's claim.
  const groupDropProps = (g) => ({
    onDragOver: (e) => { if (dragId && canEdit) { e.preventDefault(); e.stopPropagation(); setDropTarget(g.key); } },
    onDragEnter: (e) => { if (dragId && canEdit) { e.preventDefault(); setDropTarget(g.key); } },
    onDragLeave: () => setDropTarget((t) => (t === g.key ? null : t)),
    onDrop: (e) => {
      e.preventDefault(); e.stopPropagation(); setDropTarget(null);
      const item = byId.get(dragId); setDragId(null);
      if (item) onDropToGroup(item, g);
    },
  });
  const rowDropProps = (r) => ({
    onDragOver: (e) => { if (dragId && canEdit && dragId !== r.id) { e.preventDefault(); e.stopPropagation(); setDropTarget("row:" + r.id); } },
    onDrop: (e) => {
      e.preventDefault(); e.stopPropagation(); setDropTarget(null);
      const item = byId.get(dragId); setDragId(null);
      if (item && item.id !== r.id) onDropOnRow(item, r);
    },
  });

  // A cell is its own editor. The whole <td> is the hit target (clicking the padding
  // beside a chip used to fall through to the row and open the item) and NOTHING here
  // opens the modal — only the item name does.
  const CHOICE = new Set(["status", "dropdown", "people"]);
  const cellFor = (r, col) => {
    const key = r.id + ":" + col.id;
    const v = r.values ? r.values[col.id] : null;
    const open = editCell === key && canEdit;
    const commit = (nv) => onCellCommit(r, col, nv);
    if (open && !CHOICE.has(col.type)) {
      return <PMCellInput col={col} value={v} onCommit={commit} onClose={() => setEditCell(null)} />;
    }
    return (
      <>
        {pmType(col).renderCell(v, col, ctx)}
        {open && CHOICE.has(col.type) && (
          <PMChoiceMenu col={col} value={v} ctx={ctx} onCommit={commit} onClose={() => setEditCell(null)} />
        )}
      </>
    );
  };
  const cellClick = (r, col) => (e) => {
    if (!canEdit) return;
    e.stopPropagation();
    const v = r.values ? r.values[col.id] : null;
    // Checkbox needs no editor at all — one click IS the change.
    if (col.type === "checkbox") { onCellCommit(r, col, !(v === true)); return; }
    setEditCell(r.id + ":" + col.id);
  };

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", width: "100%", background: "#FFF", border: "1px solid #E2E8F0", borderRadius: 10 }}>
        <thead>
          <tr>
            <th style={{ ...S.th, width: 28 }}></th>
            <SortTh label="Item" col="name" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            {/* Column headers DRAG to reorder (Carolyn 2026-08-29) — the Monday gesture,
                alongside the ▲/▼ in Board settings. Gated on dragColId exactly the way
                row DnD gates on dragId, so the two drags can never cross: a header over
                a row does nothing, a row over a header does nothing. Click-to-sort
                survives because a real drag suppresses the click. The reorder moves the
                column in the FULL list (hidden columns keep their slots). */}
            {visCols.map((c) => (
              <SortTh key={c.id} label={c.name} col={c.id} sortKey={sortKey} sortDir={sortDir} onSort={onSort}
                style={c.width ? { width: c.width } : undefined}
                thProps={canEdit && onReorderCols ? {
                  draggable: true,
                  onDragStart: (e) => { setDragColId(c.id); e.dataTransfer.effectAllowed = "move"; },
                  onDragEnd: () => { setDragColId(null); setColDropTarget(null); },
                  onDragOver: (e) => { if (dragColId && dragColId !== c.id) { e.preventDefault(); e.stopPropagation(); setColDropTarget(c.id); } },
                  onDrop: (e) => {
                    e.preventDefault(); e.stopPropagation();
                    if (dragColId && dragColId !== c.id) {
                      const ids = columns.map((x) => x.id);
                      ids.splice(ids.indexOf(c.id), 0, ids.splice(ids.indexOf(dragColId), 1)[0]);
                      onReorderCols(ids);
                    }
                    setDragColId(null); setColDropTarget(null);
                  },
                  style: colDropTarget === c.id ? { background: "#EEF2FF", boxShadow: `inset 2px 0 0 ${ACCENT}` } : undefined,
                } : undefined} />
            ))}
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <React.Fragment key={g.key}>
              {g.label !== "" && (
                <tr {...groupDropProps(g)}>
                  <td colSpan={colCount} style={{ background: dropTarget === g.key ? "#E0E7FF" : "#EEF2FF", borderBottom: "1px solid #E0E5F5", padding: "7px 10px" }}>
                    <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", color: g.color || ACCENT }}>{g.label}</span>
                    <span style={{ fontSize: 10.5, fontWeight: 700, color: "#64748B", background: "#FFF", border: "1px solid #E2E8F0", borderRadius: 999, padding: "1px 8px", marginLeft: 8 }}>{g.rows.length}</span>
                  </td>
                </tr>
              )}
              {g.rows.map((r) => (
                <tr key={r.id} draggable={canEdit}
                  onDragStart={(e) => { setDragId(r.id); e.dataTransfer.effectAllowed = "move"; }}
                  onDragEnd={() => { setDragId(null); setDropTarget(null); }}
                  {...rowDropProps(r)}
                  style={{
                    background: r.id === activeItemId ? "#F5F3FF" : (dropTarget === "row:" + r.id ? "#EEF2FF" : "#FFF"),
                    outline: r.id === activeItemId ? `2px solid ${ACCENT}` : "none", outlineOffset: -2,
                  }}>
                  <td style={{ ...S.td, color: "#CBD5E1", cursor: canEdit ? "grab" : "default", fontSize: 13 }} onClick={(e) => e.stopPropagation()}>⠿</td>
                  <td style={{ ...S.td, fontWeight: 700, cursor: "pointer" }} onClick={() => onRowOpen(r)}
                    title="Open notes and updates">
                    <span style={{ borderBottom: "1px dashed #CBD5E1" }}>{r.name}</span>
                    {r.feedback_submission_id && (
                      <span title="From a client's portal" style={{ fontSize: 9, fontWeight: 800, color: "#1B7895", background: "#E6F7FA", border: "1px solid #BEE9F1", borderRadius: 4, padding: "1px 5px", marginLeft: 7, verticalAlign: 1, letterSpacing: 0.4 }}>CLIENT</span>
                    )}
                    {r.release_note_id && (
                      <span title="On the roadmap tenants can see in What's New" style={{ fontSize: 9, fontWeight: 800, color: "#4F46E5", background: "#EEF2FF", border: "1px solid #C7D2FE", borderRadius: 4, padding: "1px 5px", marginLeft: 7, verticalAlign: 1, letterSpacing: 0.4 }}>ROADMAP</span>
                    )}
                  </td>
                  {visCols.map((c) => (
                    <td key={c.id} onClick={cellClick(r, c)}
                      style={{ ...S.td, verticalAlign: "middle", position: "relative", cursor: canEdit ? "pointer" : "default" }}>
                      {cellFor(r, c)}
                    </td>
                  ))}
                </tr>
              ))}
              {canEdit && g.isRealGroup && (
                <tr>
                  <td></td>
                  <td colSpan={colCount - 1} style={{ ...S.td, borderBottom: "1px solid #E2E8F0" }}>
                    {newItemGroup === g.key ? (
                      <input autoFocus placeholder="Item name — Enter to add, Esc to cancel"
                        style={{ ...S.input, maxWidth: 420, padding: "5px 8px", fontSize: 12.5 }}
                        value={newItemName} onChange={(e) => setNewItemName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && newItemName.trim()) { onAddItem(g, newItemName.trim()); setNewItemName(""); }
                          if (e.key === "Escape") { setNewItemGroup(null); setNewItemName(""); }
                        }}
                        onBlur={() => { setNewItemGroup(null); setNewItemName(""); }} />
                    ) : (
                      <button type="button" style={{ background: "none", border: "none", color: "#94A3B8", fontSize: 12.5, fontWeight: 600, cursor: "pointer", padding: 0, fontStyle: "italic" }}
                        onClick={(e) => { e.stopPropagation(); setNewItemGroup(g.key); }}>＋ Add item…</button>
                    )}
                  </td>
                </tr>
              )}
            </React.Fragment>
          ))}
          {!rows.length && (
            <tr><td colSpan={colCount} style={{ ...S.td, color: "#94A3B8", textAlign: "center", padding: 24 }}>Nothing here yet.</td></tr>
          )}
        </tbody>
      </table>
      {canEdit
        ? <div style={{ fontSize: 11.5, color: "#94A3B8", marginTop: 6 }}>Click any cell to change it right there — it saves as soon as you pick. Click the item name to open its notes. Drag a row onto a group heading to move it, or onto another row to reorder.</div>
        : <div style={{ fontSize: 11.5, color: "#94A3B8", marginTop: 6 }}>Read-only — your operator account can view but not edit.</div>}
    </div>
  );
}
