// ── THE CONTACTS HUB (Carolyn 2026-10-12) ───────────────────────────────────────────────────
// "Let's have one tab and we can have contacts, and we can have this instead of list is designs,
// and then we have pipelines." And for the row itself: "this whole thing will have always
// contacts, always on the left side, and then always design list, and then every pipeline that
// they create will be next, next, next, next."
//
// So the sidebar's Contacts opens this, and this is a tab row over one view:
//   Contacts      the contact list (LeadsTable)                 contacts area + the built-in CRM
//   Design list   the old Pipeline page's List view             designs area, never the CRM
//   <pipeline>…   one board per pipeline, in the account's order contacts area + the built-in CRM
// It replaced the List | Pipeline toggle and the board's pipeline <select>, both of which sat
// where the row sits now (she drew the arrow from "26 cards" to the toggle: "up here").
//
// HOW MANY PIPELINE TABS (C27, C29): "let's say they can display five pipelines ... And then if
// they have more, the very last pipeline will have a drop down and they have to click down." And
// on Ahsan's scroll-left/right idea: "I just don't like a scroll bar." So at most five pipeline
// positions, and with more than five the fifth is the last pipeline WITH a drop-down: its name
// opens that pipeline in one click, its ▾ lists the rest, and while one of the rest is open the
// fifth tab wears that one's name. Where the row is narrower than that, more pipelines fold into
// the drop-down (ssHubFit); the row never scrolls. The order is the account's, the same for
// everyone (C28, per-person ordering, was Ahsan's idea and was not taken up).
//
// WHICH TAB IT OPENS ON (C24, C25): "by default, when they come here, they are going to be looking
// at Pipeline first ... as long as they have the CRM", then "we need them to set the default of
// what they want the default to be". So the person's own pick from My Profile (contactsView, or the
// old Pipeline tab's choice) when they made one, else the first pipeline with the CRM, else the
// Design list (C14: "we need to keep the list view for those not using the CRM"). A view the
// person cannot open is never shown: a Crew Leader holding designs:view and no contacts gets the
// Design list and nothing else. Every view has its own address (/portal/contacts/<sub>, see
// SS_HUB_* in 01-core), and the hub keeps the address on the view it shows.
const SS_HUB_MAX_PIPES = 5;

// The account's pipelines as the tab row needs them, in the order crm_pipelines_list sends them
// (crm_pipelines.position).
const ssHubPipes = (ps) => (Array.isArray(ps) ? ps : [])
  .filter((p) => p && p.id)
  .map((p) => ({ id: String(p.id).toLowerCase(), name: String(p.name || "Pipeline") }));

// Which view the hub shows. Pure, so it is tested without a browser (contactsHub_test.ts).
//   sub        the address's sub under /portal/contacts (null, a SS_HUB_* value, "p-<uuid>", junk)
//   saved      ssSavedHubView: the person's own pick, or null
//   reach      { people, designs }: ssHubCan's answers for this person
//   crm        the built-in CRM is on; crmKnown: the answer has landed (own portal), so "off" is real
//   pipelines  ssHubPipes(...), or null while they load (or when they are not asked for)
//   remembered the pipeline picked last on this browser, for "the board" (SS_HUB_PIPELINE)
// Returns { view, pipeId?, canon }. view: "people" | "designs" | "pipe" | "locked" | "loading" |
// "none". canon is the sub the address should carry for it (null: leave the address alone).
function ssHubResolve({ sub = null, saved = null, reach, crm, crmKnown, pipelines, remembered = null }) {
  const has = (id) => !!pipelines && pipelines.some((p) => p.id === id);
  // One candidate: the address (explicit) or the saved pick. Null = this one can't be shown here.
  const take = (want, explicit) => {
    if (!want) return null;
    if (want === SS_HUB_DESIGNS) return reach.designs ? { view: "designs", canon: want } : null;
    const pid = ssHubPipeId(want);
    if (want !== SS_HUB_PEOPLE && want !== SS_HUB_PIPELINE && !pid) return null;   // not a hub view
    if (!reach.people) return null;
    // Contacts and the boards are the CRM's. Until the answer is in, wait rather than paint the
    // Design list and snap away from it; once it is in and says no, an address that asked for one
    // gets the card that sells it, and a saved pick quietly falls back to the default.
    if (!crmKnown) return { view: "loading", canon: explicit ? want : null };
    if (!crm) return explicit ? { view: "locked", canon: pid ? SS_HUB_PIPELINE : want } : null;
    if (want === SS_HUB_PEOPLE) return { view: "people", canon: want };
    // A named pipeline opens at once, before the list has said it exists; a pipeline that turns out
    // to be gone (removed, or another account's) falls through to the default.
    if (pid) return (!pipelines || has(pid)) ? { view: "pipe", pipeId: pid, canon: want } : null;
    if (!pipelines) return { view: "loading", canon: null };
    const id = remembered && has(remembered) ? remembered : (pipelines[0] ? pipelines[0].id : null);
    return id ? { view: "pipe", pipeId: id, canon: "p-" + id } : null;
  };
  const picked = take(sub, true) || take(saved, false);
  if (picked) return picked;
  // THE DEFAULT: the first pipeline with the CRM, else the Design list, else the contact list.
  if (reach.people && !crmKnown) return { view: "loading", canon: null };
  if (reach.people && crm) {
    if (!pipelines) return { view: "loading", canon: null };
    if (pipelines.length) return { view: "pipe", pipeId: pipelines[0].id, canon: "p-" + pipelines[0].id };
  }
  if (reach.designs) return { view: "designs", canon: SS_HUB_DESIGNS };
  if (reach.people) return crm ? { view: "people", canon: SS_HUB_PEOPLE } : { view: "locked", canon: SS_HUB_PEOPLE };
  return { view: "none", canon: null };
}

// How many pipeline tabs fit in the row inline. Pure, tested with contactsHub_test.ts.
//   avail    the row's width; fixedW: the Contacts and Design list tabs together
//   pipeW    each pipeline tab's width, in order; caretW: the drop-down's ▾
//   activeIdx  the open pipeline's index, or -1: the drop-down wears its name when it holds it
// Returns k: pipelines [0, k) are tabs, and when k < pipeW.length the rest sit in the drop-down,
// whose own tab is the (k+1)th position. At most SS_HUB_MAX_PIPES positions in all.
function ssHubFit({ avail, fixedW, pipeW, caretW, activeIdx = -1, max = SS_HUB_MAX_PIPES, gap = 2 }) {
  const n = pipeW.length;
  const run = (k) => pipeW.slice(0, k).reduce((a, w) => a + w + gap, 0);
  if (n <= max && fixedW + run(n) <= avail) return n;
  for (let k = Math.min(n - 1, max - 1); k > 0; k--) {
    const shown = activeIdx >= k ? activeIdx : k;
    if (fixedW + run(k) + pipeW[shown] + caretW + gap <= avail) return k;
  }
  return 0;
}

// The account's pipelines, for the tab row and for My Profile's picker. Cached like a tab
// (ssTabCache), so coming back to Contacts paints the row at once and refreshes behind it.
// `replace` takes a fresh list from the board itself (SalesPipelines' onPipelines), so a pipeline
// added or removed there reaches the row without a second read. Not asked for at all when `enabled`
// is false: crm_pipelines_list is the CRM's, and the contacts area's.
function useSsPipelineList(clientId, enabled) {
  const [list, setList] = useState(null);   // null = not loaded (or not asked)
  const [err, setErr] = useState(null);
  useEffect(() => {
    if (!enabled) { setList(null); setErr(null); return undefined; }
    const hit = ssCacheGet("portal-settings", "crm_pipelines_list", clientId);
    if (hit) setList(hit);
    let off = false;
    ssPipeCall("crm_pipelines_list").then((r) => {
      if (off) return;
      const ps = ssHubPipes(r.pipelines);
      ssCachePut("portal-settings", "crm_pipelines_list", clientId, ps);
      setList(ps); setErr(null);
    }, (e) => { if (!off) { setErr(e.message || String(e)); setList((cur) => cur || []); } });
    return () => { off = true; };
  }, [clientId, enabled]);
  const replace = useCallback((raw) => {
    const ps = ssHubPipes(raw);
    ssCachePut("portal-settings", "crm_pipelines_list", clientId, ps);
    setList(ps); setErr(null);
  }, [clientId]);
  return { pipelines: enabled ? list : null, error: enabled ? err : null, replace };
}

// One tab's look. The underline strip Settings' hubs use (SubTabs, 08-integrations), so the two
// kinds of sub-navigation read alike; the active tab carries the accent underline.
const ssHubTabStyle = (on, locked) => ({
  display: "inline-flex", alignItems: "center", gap: 5, background: "none", border: "none", cursor: "pointer",
  fontFamily: "inherit", padding: "12px 14px 10px", fontSize: 13, fontWeight: 700, letterSpacing: 0.2,
  whiteSpace: "nowrap", textDecoration: "none", boxSizing: "border-box",
  color: on ? ACCENT : (locked ? "#94A3B8" : "#64748B"),
  borderBottom: on ? `2px solid ${ACCENT}` : "2px solid transparent", marginBottom: -2,
});
// A pipeline's name is capped, so one long name cannot take the row from the others.
const SS_HUB_NAME = { display: "inline-block", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", verticalAlign: "bottom" };
const SS_HUB_CRM_TITLE = "Part of the built-in CRM";

// The row. Real links (Carolyn 2026-09-11: every nav button opens in a new tab on a right or
// middle click), one click per tab. `fixed` and `pipes` are [{ id, label, locked? }]; `active` is
// the open tab's id.
function SsHubTabs({ fixed, pipes, active, onPick, hrefFor }) {
  const boxRef = useRef(null);
  const measRef = useRef(null);
  const ddRef = useRef(null);
  const menuRef = useRef(null);
  const [avail, setAvail] = useState(null);
  const [widths, setWidths] = useState(null);   // { fixed, pipes: [], caret } in px, or null
  const [menu, setMenu] = useState(null);       // { top, left } in viewport px, or null = shut
  const labelKey = fixed.concat(pipes).map((t) => (t.locked ? "!" : "") + t.label).join("\u0001");
  // Every label measured in an invisible copy of the row (same type, same padding), so the fit is
  // decided before the first paint and never by trial and error on screen. Again once the page's
  // font has loaded, since a label is wider in it than in the fallback.
  React.useLayoutEffect(() => {
    let off = false;
    const measure = () => {
      const m = measRef.current;
      if (off || !m) return;
      const w = Array.from(m.children).map((x) => Math.ceil(x.getBoundingClientRect().width));
      setWidths({ fixed: w.slice(0, fixed.length).reduce((a, x) => a + x + 2, 0), pipes: w.slice(fixed.length, fixed.length + pipes.length), caret: w[w.length - 1] || 24 });
    };
    measure();
    try { if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure, () => {}); } catch (_e) { /* no font API */ }
    return () => { off = true; };
  }, [labelKey]);
  React.useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    const read = () => setAvail(el.clientWidth);
    read();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", read);
      return () => window.removeEventListener("resize", read);
    }
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // The drop-down's list: painted in viewport coordinates (RowMenu's reason: nothing it sits in
  // may clip it or grow a scroll bar for it), and shut by a click away, Escape, a scroll or a resize.
  useEffect(() => {
    if (!menu) return undefined;
    const away = (e) => {
      if (ddRef.current && ddRef.current.contains(e.target)) return;
      if (menuRef.current && menuRef.current.contains(e.target)) return;
      setMenu(null);
    };
    const key = (e) => { if (e.key === "Escape") setMenu(null); };
    const shut = () => setMenu(null);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    window.addEventListener("scroll", shut, true);
    window.addEventListener("resize", shut);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
      window.removeEventListener("scroll", shut, true);
      window.removeEventListener("resize", shut);
    };
  }, [menu]);

  const n = pipes.length;
  const activeIdx = pipes.findIndex((t) => t.id === active);
  const k = (widths && avail)
    ? ssHubFit({ avail, fixedW: widths.fixed, pipeW: widths.pipes, caretW: widths.caret, activeIdx })
    : (n <= SS_HUB_MAX_PIPES ? n : SS_HUB_MAX_PIPES - 1);
  const inline = pipes.slice(0, k);
  const rest = pipes.slice(k);
  const shownRest = rest.length ? (activeIdx >= k ? pipes[activeIdx] : rest[0]) : null;

  const tab = (t, extra = null) => {
    const on = t.id === active;
    return (
      <a key={t.id} href={hrefFor(t.id)} role="tab" aria-selected={on ? "true" : "false"} data-ss-hub-tab={t.id}
        title={t.locked ? SS_HUB_CRM_TITLE : t.label}
        onClick={ssNavClick(() => { setMenu(null); onPick(t.id); })}
        style={{ ...ssHubTabStyle(on, t.locked), ...(extra || {}) }}>
        {t.locked && <span aria-hidden="true">🔒</span>}
        <span style={SS_HUB_NAME}>{t.label}</span>
      </a>
    );
  };
  const openMenu = () => {
    const r = ddRef.current.getBoundingClientRect();
    const W = 240;
    setMenu({ top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - W - 8)), width: W });
  };
  return (
    <div ref={boxRef} role="tablist" aria-label="Contacts views" data-ss-hub-tabs=""
      style={{ position: "relative", display: "flex", gap: 2, alignItems: "flex-end", flexWrap: "wrap", borderBottom: "2px solid #E2E8F0", marginBottom: 14, minWidth: 0 }}>
      {/* The measuring copy: no size of its own and clipped, so it can never widen the page. */}
      <div aria-hidden="true" style={{ position: "absolute", left: 0, top: 0, width: 0, height: 0, overflow: "hidden", visibility: "hidden", pointerEvents: "none" }}>
        <div ref={measRef} style={{ display: "flex", width: "max-content" }}>
          {fixed.concat(pipes).map((t) => (
            <span key={t.id} style={ssHubTabStyle(false, t.locked)}>
              {t.locked && <span>🔒</span>}
              <span style={SS_HUB_NAME}>{t.label}</span>
            </span>
          ))}
          <span style={{ ...ssHubTabStyle(false, false), padding: "12px 8px 10px" }}>▾</span>
        </div>
      </div>
      {fixed.map((t) => tab(t))}
      {inline.map((t) => tab(t))}
      {shownRest && (
        <span ref={ddRef} data-ss-hub-more="" style={{ display: "inline-flex", alignItems: "flex-end" }}>
          {tab(shownRest, { paddingRight: 4 })}
          <button type="button" aria-haspopup="menu" aria-expanded={menu ? "true" : "false"}
            aria-label={`${rest.length} more pipeline${rest.length === 1 ? "" : "s"}`} title={`${rest.length} more pipeline${rest.length === 1 ? "" : "s"}`}
            onClick={() => (menu ? setMenu(null) : openMenu())}
            style={{ ...ssHubTabStyle(shownRest.id === active, false), padding: "12px 8px 10px", fontSize: 12 }}>▾</button>
        </span>
      )}
      {menu && (
        <div ref={menuRef} role="menu" data-ss-hub-menu=""
          style={{ position: "fixed", top: menu.top, left: menu.left, width: menu.width, zIndex: 60, background: "#FFF",
            border: "1px solid #E2E8F0", borderRadius: 8, padding: 5, boxShadow: "0 10px 26px rgba(15,23,42,0.16)", maxHeight: "60vh", overflowY: "auto" }}>
          {rest.map((t) => {
            const on = t.id === active;
            return (
              <a key={t.id} href={hrefFor(t.id)} role="menuitem" aria-current={on ? "page" : undefined}
                onClick={ssNavClick(() => { setMenu(null); onPick(t.id); })}
                style={{ display: "block", padding: "7px 9px", borderRadius: 6, fontSize: 13, fontWeight: on ? 800 : 700, textDecoration: "none",
                  color: on ? ACCENT : "#334155", background: on ? "#EEF2FF" : "transparent", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {t.label}
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}

// The hub. The shell builds the three views it cannot (they need its routing, phone and access
// wiring) and hands them in as elements; the boards are built here.
//   sub          the address's sub under /portal/contacts (records never reach here)
//   onRoute(sub, replace)              moves the address (navigate("contacts", sub, replace))
//   onOpenRecord(code, contactId, fromSub)  opens a card's customer or design, Back to `fromSub`
function ContactsHub({ clientId, sub = null, viewing = false, reach, crmUnlocked = false, crmKnown = true, saved = null, refreshKey = 0,
  onRoute, onOpenRecord, people = null, designs = null, locked = null }) {
  const canPipes = !!crmUnlocked && !!reach.people;
  const { pipelines, error, replace } = useSsPipelineList(clientId, canPipes);
  let remembered = null;
  try { remembered = localStorage.getItem(SS_PIPE_LAST + ":" + clientId); } catch (_e) { /* private mode */ }
  const r = ssHubResolve({ sub, saved, reach, crm: !!crmUnlocked, crmKnown, pipelines, remembered });
  // Keep the address on the view that shows (a bare /portal/contacts, "the board", or a view this
  // person cannot open), without a history entry, so a refresh or a copied link lands right back.
  useEffect(() => {
    if (r.canon && r.canon !== (sub || null)) onRoute(r.canon, true);
  }, [r.canon, sub]);
  // The board last looked at, for "the board" (/portal/contacts/pipeline and every old Pipeline
  // address).
  useEffect(() => {
    if (r.view !== "pipe" || !r.pipeId) return;
    try { localStorage.setItem(SS_PIPE_LAST + ":" + clientId, r.pipeId); } catch (_e) { /* private mode */ }
  }, [r.view, r.pipeId, clientId]);

  const crmOff = crmKnown && !crmUnlocked;
  const fixed = [];
  if (reach.people) fixed.push({ id: SS_HUB_PEOPLE, label: "Contacts", locked: crmOff });
  if (reach.designs) fixed.push({ id: SS_HUB_DESIGNS, label: "Design list" });
  // Without the CRM there are no boards to list, and one padlocked "Pipeline" tab stays to say
  // they exist, where the padlocked Pipeline button used to.
  const pipes = canPipes ? (pipelines || []).map((p) => ({ id: "p-" + p.id, label: p.name }))
    : (reach.people && crmOff ? [{ id: SS_HUB_PIPELINE, label: "Pipeline", locked: true }] : []);
  const active = r.view === "people" ? SS_HUB_PEOPLE
    : r.view === "designs" ? SS_HUB_DESIGNS
    : r.view === "pipe" ? "p-" + r.pipeId
    : r.canon;
  const fromPipe = r.view === "pipe" ? "p-" + r.pipeId : null;

  return (
    <div data-ss-contacts-hub="">
      <SsHubTabs fixed={fixed} pipes={pipes} active={active}
        hrefFor={(id) => ssPagePath("contacts", id)}
        onPick={(id) => onRoute(id, false)} />
      {error && canPipes && (pipelines || []).length === 0 && <div style={S.err}>{error}</div>}
      {r.view === "loading" && (
        <div style={S.card} data-ss-hub-view="loading" aria-busy="true">
          <table style={{ width: "100%", borderCollapse: "collapse" }}><tbody><SkelRows cols={5} rows={6} /></tbody></table>
        </div>
      )}
      {r.view === "people" && <div data-ss-hub-view="people">{people}</div>}
      {r.view === "designs" && <div data-ss-hub-view="designs">{designs}</div>}
      {r.view === "locked" && <div data-ss-hub-view="locked">{locked}</div>}
      {r.view === "pipe" && (
        <div style={S.card} data-ss-hub-view="pipe">
          <SalesPipelines embedded hosted clientId={clientId} viewing={viewing} refreshKey={refreshKey}
            urlPipelineId={r.pipeId}
            onPickPipeline={(id) => onRoute("p-" + String(id).toLowerCase(), false)}
            onPipelines={replace}
            onOpenRecord={(code, contactId, dealId) => onOpenRecord(code, contactId, fromPipe, dealId)} />
        </div>
      )}
    </div>
  );
}

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

// ── TWO KEYS OUT OF THE PLAN, NOT THE PLAN ──────────────────────────────────────────────
// `designs.selections` is the WHOLE design: every placed item, its position, its options —
// commonly tens of kilobytes a row. The Designs and Contacts lists read exactly two things
// out of it, `style` and `size`, to draw one "Barn 12x24" cell; they used to pull the entire
// blob for every design in the tenant to do it, so a few hundred designs moved megabytes to
// paint two columns, and `design_versions` paid the same toll a second time.
//
// PostgREST projects json keys server-side (`alias:column->>key`), so the two values arrive
// as two short strings. `withListSelections` then rebuilds the `{ selections: { style, size } }`
// shape the rows already had, which is why nothing downstream — the facets, the search, the
// sort, the pipeline cards, the version rows — had to learn about this.
//
// Anything that needs the FULL selections fetches the row it is opening and always did: the
// version diff in the contact drawer comes from portal-settings `contact_activity`, the
// record view and the designer load the design itself. Operator view-as (fetchDesigns) is a
// service-role path with its own shape and is left exactly as it was.
const SEL_LIST_COLS = "sel_style:selections->>style, sel_size:selections->>size";
function withListSelections(r) {
  const { sel_style, sel_size, ...rest } = r;
  return { ...rest, selections: { style: sel_style || "", size: sel_size || "" } };
}

// ── EVERY ROW, NOT THE FIRST THOUSAND ───────────────────────────────────────────────────
// PostgREST answers at most db-max-rows (1000 on this project) per request and says nothing
// when it stops there. The Designs and Contacts lists read the whole tenant in ONE request,
// newest first, so past 1000 rows the OLDEST designs, versions and browsing leads simply
// vanished — from the list, from the chip counts, from search — with no error anywhere.
// design_versions crosses the line first (every save writes one, drafts included), and then
// older designs lose their "▾ versions" expander and drop out of the "2+ versions" filter.
//
// So these reads page with .range() until a short page, at a size under the cap so a page can
// never come back silently short and end the scan early (customerIdentity.ts ADDRESS_SCAN_PAGE,
// same reasoning). `page(from, to)` must order on a UNIQUE tiebreaker after its real order, or
// rows sharing a timestamp can swap across a page boundary; `keyOf` drops the duplicate a row
// inserted mid-read produces. A failed page is an error, never a shorter list.
const SS_LIST_PAGE = 500;
async function ssReadAllRows(page, keyOf) {
  const seen = new Set();
  const out = [];
  for (let from = 0; from < SS_LIST_PAGE * 400; from += SS_LIST_PAGE) {
    const { data, error } = await page(from, from + SS_LIST_PAGE - 1);
    if (error) return { data: null, error };
    (data || []).forEach((r) => { const k = keyOf(r); if (!seen.has(k)) { seen.add(k); out.push(r); } });
    if (!data || data.length < SS_LIST_PAGE) break;
  }
  return { data: out, error: null };
}

// NO SCHEDULING FROM THIS PAGE (Carolyn 2026-08-08). Designs briefly carried an
// "Add to build schedule" action; it moved to ORDERS the same day — "Orders is all sales",
// and it is from Orders that a sold building goes to the Build or Delivery schedule.
function DesignsTable({ clientId, refreshKey = 0, fetchDesigns = null, isAdmin = false, viewingLabel = null, onOpenDesign = null, onOpenRecord = null }) {
  // THE DESIGN LIST (Carolyn 2026-10-12): "instead of list is designs". This was the Pipeline
  // page's List view, with a List | Pipeline toggle beside it that flipped the same card to the
  // board. The page is now one tab of the Contacts hub (ContactsHub, top of this file), and the
  // boards are tabs of their own beside it, one per pipeline, so the toggle and the board it drew
  // are gone from here and this is the list only. It never needs the CRM — Carolyn 2026-08-29:
  // "they only get the list view" — which is why it is the tab an account without the CRM opens
  // on (C14). Which tab opens, and the person's own choice of it, is the hub's business now.
  // Cache-seeded so returning to Designs paints at once and refreshes behind it (see
  // ssTabCache in 01-core, and LeadsTable/Orders which already do this). Operator view-as
  // reads through a service-role path and is left uncached, same rule as Contacts.
  const seeded = () => (fetchDesigns ? null : ssCacheGet("rest", "designs", clientId));
  const [rows, setRows] = useState(() => (seeded() || {}).rows || null); // null = loading
  const [error, setError] = useState(null);
  const [vmap, setVmap] = useState(() => (seeded() || {}).vmap || {});   // short_code -> versions (newest first)
  // id -> serial for the Inventory chips (owner-select RLS; absent for operators in
  // view-as, where the chip simply reads "Inventory" without a number).
  //
  // Scoped to the units the loaded rows actually point at, rather than every unit the tenant
  // has ever stocked: a lot with hundreds of buildings was read in full to label the handful
  // of designs that came from one. Nothing here is a filter — an id with no serial yet just
  // renders the chip without a number, exactly as it does before this resolves.
  const [unitSerials, setUnitSerials] = useState({});
  const unitIdKey = useMemo(() => {
    const ids = new Set();
    (rows || []).forEach((r) => { if (r.inventory_unit_id) ids.add(r.inventory_unit_id); });
    Object.keys(vmap).forEach((code) => (vmap[code] || []).forEach((v) => { if (v.inventory_unit_id) ids.add(v.inventory_unit_id); }));
    return [...ids].sort().join(",");
  }, [rows, vmap]);
  useEffect(() => {
    const ids = unitIdKey ? unitIdKey.split(",") : [];
    if (ids.length === 0) { setUnitSerials((p) => (Object.keys(p).length ? {} : p)); return undefined; }
    let off = false;
    // Chunked because the id list rides in the URL — one `in.(…)` over hundreds of uuids is
    // a query string long enough to be rejected by the proxy rather than by PostgREST.
    const chunks = [];
    for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));
    Promise.all(chunks.map((c) => sb.from("inventory_units").select("id, serial").eq("client_id", clientId).in("id", c).then((r) => r, () => ({ data: [] }))))
      .then((res) => {
        if (off) return;
        const map = {};
        res.forEach(({ data }) => (data || []).forEach((u) => { map[u.id] = u.serial; }));
        setUnitSerials(map);
      }, () => {});
    return () => { off = true; };
  }, [unitIdKey, clientId]);
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
    // Only `selections.style` and `selections.size` are read here — see SEL_LIST_COLS above
    // for why the blob itself never crosses the wire for a list.
    const [dRes, vRes] = await Promise.all([
      // Paged (ssReadAllRows): one request stopped at PostgREST's 1000-row cap.
      ssReadAllRows((from, to) => sb.from("designs")
        // contact_id (130) is selected for ONE reason: the Pipeline's job is now to open the
        // CUSTOMER, and the customer record is addressed by contact id, not short_code.
        // Carolyn 2026-09-04 @1:07:19, watching it work: "this pipeline click is going to
        // take you into the customer view where you can see everything about that customer."
        // It stays nullable — crm_ensure_contact returns NULL for a design carrying neither
        // a phone nor an email, and those rows fall back to the design record.
        //
        // ⚠️ It rides ALONGSIDE the SEL_LIST_COLS projection, which is a separate change that
        // landed the same night: the list stopped pulling the whole `selections` blob across
        // the wire and now names the two columns it reads. Taking either side of that merge
        // alone was wrong in a way nothing would have reported — keeping only the narrow
        // projection loses the Pipeline's ability to open a customer at all, and keeping only
        // this line silently re-inflates every list payload back to the blob.
        //
        // ss_invoice_sent_at (2026-10-05) is for the delete dialog only: a StructureStudio
        // invoice leaves the design 'accepted', and the dialog has to know its quote is kept.
        .select(`short_code, created_at, updated_at, status, contact, contact_id, ${SEL_LIST_COLS}, ghl_estimate_number, image_url, inventory_unit_id, ss_quote_number, ss_quote_pdf_url, ss_invoice_sent_at, total_cents, expected_close_date`)
        .eq("client_id", clientId)
        .order("created_at", { ascending: false }).order("short_code", { ascending: false })
        .range(from, to), (r) => r.short_code),
      ssReadAllRows((from, to) => sb.from("design_versions")
        .select(`short_code, version, created_at, ${SEL_LIST_COLS}, image_url, inventory_unit_id`)
        .eq("client_id", clientId)
        .order("version", { ascending: false }).order("short_code", { ascending: true })
        .range(from, to), (v) => v.short_code + ":" + v.version)
        .then((r) => r, () => ({ data: [] })),
    ]);
    if (dRes.error) { setError(dRes.error.message); setRows([]); return; }
    const list = (dRes.data || []).map(withListSelections).filter(notInventory);
    setRows(list); // show cached statuses immediately
    const map = {};
    (vRes.data || []).forEach((v0) => { const v = withListSelections(v0); (map[v.short_code] = map[v.short_code] || []).push(v); });
    setVmap(map);
    ssCachePut("rest", "designs", clientId, { rows: list, vmap: map });
    // Refresh fulfillment status from GHL (read-only projection). Non-fatal: if the sync
    // errors or GHL isn't configured, the cached designs.status values above stay shown.
    // LAST on purpose — everything above is already on screen before this starts.
    if (list.length > 0) {
      try {
        const { data: sync } = await sb.functions.invoke("sync-design-status", { body: { shortCodes: list.map((r) => r.short_code) } });
        const statuses = sync && sync.statuses;
        if (statuses) {
          // ⚠️ MERGE INTO WHATEVER IS ON SCREEN NOW, never into the `list` this run captured.
          // `load` has four triggers (mount/refreshKey, invoice send, delete confirm) and no
          // cancellation, and the call above is the slow one — so a superseded run can land
          // after a newer one. Writing the captured list back would RESURRECT rows the newer
          // run already dropped: delete A, then delete B inside the window, and the older
          // sync repaints B with a live Open/Invoice/Delete menu — and pins it in the tab
          // cache for the 10-minute TTL. A functional update can only ever mis-set a status
          // on a row that is still there, which is recoverable; putting a deleted design back
          // in front of someone is not. The cache is written from the same merged value for
          // the same reason.
          setRows((rs) => {
            const merged = (rs || []).map((r) => statuses[r.short_code] ? { ...r, status: statuses[r.short_code] } : r);
            ssCachePut("rest", "designs", clientId, { rows: merged, vmap: map });
            return merged;
          });
        }
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
    // `note` rides beside either outcome: the invoice-time tax check (Avalara stage) informs, it
    // never decides, so it is not folded into the ok/err sentence.
    const note = ssTaxCheckNote(data && data.taxCheck);
    setInvMsg(data && data.sent === false
      ? { err: `Invoice ${(data && data.invoiceNumber) || ""} is created and ${outcome}, but the customer was NOT emailed${data.emailReason ? ` (${data.emailReason})` : ""} — print the invoice PDF or copy the customer link.`, note }
      : { ok: `Invoice ${(data && data.invoiceNumber) || ""} sent — ${outcome}.`, note });
    load();
  };

  // SS-mode rep tools (migration 122, Carolyn 2026-08-23: rep tools live in all three
  // places — this table, the order detail, and the designer success screen).
  const [resendBusyKey, setResendBusyKey] = useState(null);
  const [copiedKey, setCopiedKey] = useState(null);
  const copyCustomerLink = (code) => {
    // The designer's account panel focused on THIS quote (plan 3.8, 2026-09-15), not the bare
    // /my-quotes list it used to be: the customer logs in and lands on the card with Review &
    // Accept. `quotes` even for an invoiced row — the designer moves to whichever tab the card
    // lives on. /my-quotes stays up, so links already sent keep working.
    const link = `${window.location.origin}/?client=${encodeURIComponent(clientId)}&account=quotes&q=${encodeURIComponent(code)}`;
    const done = () => { setCopiedKey(code); setTimeout(() => setCopiedKey((k) => (k === code ? null : k)), 2000); };
    // A rejected writeText is NOT a copy: the API exists but can still refuse (permissions
    // policy, unfocused tab), and `.then(done, done)` used to flash "Copied ✓" over a
    // clipboard that still held something else — the rep then pastes the wrong thing to a
    // customer. On rejection, fall back to the same manual prompt no-clipboard browsers get.
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(done, () => window.prompt("Copy the customer link:", link));
    else window.prompt("Copy the customer link:", link);
  };
  const resendQuoteEmail = async (r) => {
    setResendBusyKey(r.short_code); setInvMsg(null);
    const { data, error: err } = await sb.functions.invoke("portal-settings", { body: { action: "resend_quote_email", shortCode: r.short_code } });
    setResendBusyKey(null);
    if (err) { setInvMsg({ err: await fnError(err) }); return; }
    if (data && data.error) { setInvMsg({ err: data.error }); return; }
    setInvMsg(data && data.sent
      ? { ok: `Estimate ${r.ss_quote_number || ""} emailed to the customer.` }
      : { err: `Estimate email not sent${data && data.reason ? ` — ${data.reason}` : ""}. Print the PDF or copy the customer link instead.` });
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

  // Paged. (The board this list used to flip to never was: a board showing "30 of 400" cards is
  // not a pipeline. The boards are the hub's pipeline tabs now.)
  const [pageSize, setPageSize] = usePageSize("designs");
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [query, statusFilter, fStyle, fSize, fFrom, fTo, fVersions]);
  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const curPage = Math.min(page, pageCount);
  const paged = sorted.slice((curPage - 1) * pageSize, curPage * pageSize);

  return (
    <div style={S.card}>
      {/* The hub's tab row names this view "Design list"; the card keeps the count it always
          had. The List | Pipeline toggle that sat on the right is the hub's tab row now. */}
      <CardHead
        title="Designs"
        count={rows ? ((query || statusFilter !== "all" || hasFacets) ? `${filtered.length} of ${rows.length}` : rows.length) : null}
        right={<button onClick={load} style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0", padding: "6px 12px" }}>↻ Refresh</button>}
      />
      {rows && rows.length > 0 && (
        <div style={{ display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
          {/* Filters LEFT, search RIGHT (Carolyn, 2026-09-07). The search box used to lead and
              sat 20px above the facet controls, because those carry a heading and it does not —
              so the row read as two rows. It now trails the facets and wears a heading-shaped
              spacer, which puts every box on one line by construction rather than by a pixel
              offset that would drift the next time the label type changes. */}
          <FilterBar hasFilters={hasFacets} onClear={clearFacets} shown={filtered.length} total={rows.length} noun="design">
            {styleOpts.length > 1 && <FacetSelect label="Building style" value={fStyle} onChange={setFStyle} options={styleOpts.map((s) => ({ value: s, label: s }))} allLabel="All styles" />}
            {sizeOpts.length > 1 && <FacetSelect label="Size" value={fSize} onChange={setFSize} options={sizeOpts.map((s) => ({ value: s, label: s }))} allLabel="All sizes" />}
            <DateRange label="Created" from={fFrom} to={fTo} onFrom={setFFrom} onTo={setFTo} />
            <FacetSelect label="Versions" value={fVersions} onChange={setFVersions} options={[{ value: "multi", label: "2+ versions" }]} allLabel="All" />
          </FilterBar>
          <div style={{ ...FCTRL, flex: "1 1 320px", minWidth: 260 }}>
            <span style={FLBL_SPACER} aria-hidden="true">Search</span>
            <SearchInput value={query} onChange={setQuery} placeholder="Search designs — name, email, phone, building, estimate #…" />
          </div>
        </div>
      )}
      {rows && rows.length > 0 && <StatusChips counts={statusCounts} value={statusFilter} onChange={setStatusFilter} />}
      {delMsg && <div style={delMsg.err ? S.err : S.okMsg}>{delMsg.err || delMsg.ok}</div>}
      {invMsg && (invMsg.err || invMsg.ok) && <div style={invMsg.err ? S.err : S.okMsg}>{invMsg.err || invMsg.ok}</div>}
      {invMsg && invMsg.note && <div style={SS_TAX_NOTE_STYLE}>{invMsg.note}</div>}
      {error && <div style={S.err}>{error}</div>}
      {/* Grey blocks in the real column shape, not the word "Loading" on an empty card —
          see SkelRows. Carolyn, 2026-08-26, on watching a list arrive: "so let's do that." */}
      {rows === null && !error && (
        <div style={{ overflowX: "auto" }} data-ss-designs-view="loading">
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
      {rows && filtered.length > 0 && (
        <div style={{ overflowX: "auto" }} data-ss-designs-view="list">
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
                    {/* THE NAME IS THE LINK, and it opens the CUSTOMER — Carolyn 2026-09-04
                        @1:07:19: "when you're in pipeline and you click on test customer,
                        you're going to open up this ... you're going to see everything in
                        here." The list is the DEFAULT view, so before this the most common
                        click in the product went to the designer instead, which is the
                        opposite of what she asked for. "Open" in the Actions column still
                        goes to the designer — that is a different intention and it keeps it.
                        Same pattern LeadsTable already uses for a contact name. */}
                    <td style={{ ...S.td, fontWeight: 700 }}>
                      {onOpenRecord
                        ? <button type="button" onClick={() => onOpenRecord(r.short_code, r.contact_id)}
                            title={`Open ${c.name || "this customer"}`}
                            style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit", fontSize: "inherit", fontWeight: 700, color: ACCENT, textAlign: "left" }}>
                            {c.name || "—"}
                          </button>
                        : (c.name || "—")}
                    </td>
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
                    <td style={S.td}><StatusPill status={r.status} /></td>
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
                            key: "quote", label: "Estimate PDF", title: "Open the printable estimate document",
                            onClick: () => setPdf({ url: r.ss_quote_pdf_url, title: `Estimate ${r.ss_quote_number} — ${c.name || r.short_code}` }),
                          },
                          // keepOpen, because "Copied ✓" IS the confirmation and it is drawn on
                          // this very item — closing the menu on click would take the only
                          // feedback this action has away with it.
                          r.ss_quote_number && {
                            key: "copy", keepOpen: true,
                            label: copiedKey === r.short_code ? "Copied ✓" : "Copy link",
                            title: "Copy the customer's link to this estimate (they log in with a code to accept it)",
                            onClick: () => copyCustomerLink(r.short_code),
                          },
                          // These two report through the invMsg banner above the table, which is
                          // why they close: the outcome is not written on the button.
                          r.ss_quote_number && {
                            key: "resend", disabled: resendBusyKey === r.short_code,
                            label: resendBusyKey === r.short_code ? "Sending…" : "Resend email",
                            title: "Re-send the estimate email to the customer",
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
            // The StructureStudio quote's half (2026-10-05), named only when the design has a
            // quote number, and added to whichever CRM sentence applies: a design can have both (a
            // CRM estimate from before the switch to StructureStudio paperwork, then a quote). A
            // server older than this page sends no `quote`, and every message then reads exactly
            // as before.
            const quote = res.quoteNumber ? `Estimate ${res.quoteNumber}` : null;
            const quoteLine = !quote ? ""
              : res.quote === "removed" ? ` ${quote} and its PDF were deleted too.`
              : res.quote === "kept" ? ` ${quote} and its PDF were kept, because an invoice was made from it.`
              : res.quote === "failed" ? ` The PDF for ${quote} could not be removed. Support has a record of it.`
              : "";
            let msg;
            if (res.estimate === "failed") {
              msg = `${base}, but ${est} could NOT be removed from your CRM (${res.estimateError || "unknown error"}). Delete it there by hand — support has a record.`;
            } else if (res.estimate === "skipped_invoiced") {
              msg = `${base}. ${est} was left in your CRM because an invoice was created from it — void that invoice there if you also want the estimate gone.`;
            } else if (res.estimate === "deleted") {
              msg = `${base}, along with ${est} in your CRM.`;
            } else {
              msg = `${base}.`;
            }
            const leftover = res.estimate === "failed" || (quote && res.quote === "failed");
            setDelMsg(leftover ? { err: msg + quoteLine } : { ok: msg + quoteLine });
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
  const CLADDING_LABELS = { lap: "7\" LP Lap Siding", vinyl: "4.5\" Vinyl Siding", panel: "Panel Siding", agpanel: "AG Panel", batten: "Board & Batten" };
  // The metal roof profile, a design's own pick since 2026-10-06 (the Designer's Roof options card).
  const ROOF_PROFILE_LABELS = { agpanel: "AG Panel", standingseam: "Standing Seam" };
  const KEYS = [["style", "style"], ["size", "size"], ["roofType", "roof type"], ["roofColor", "roof color"], ["roofProfile", "roof profile"], ["cladding", "cladding"]];
  const parts = [];
  const push = (lbl, av, bv) => { if (av !== bv && (av || bv)) parts.push(`${lbl}: ${av || "—"} → ${bv || "—"}`); };
  for (const [k, lbl] of KEYS) {
    let av = String(a[k] || ""), bv = String(b[k] || "");
    if (k === "cladding") { av = CLADDING_LABELS[av] || av; bv = CLADDING_LABELS[bv] || bv; }
    if (k === "roofProfile") { av = ROOF_PROFILE_LABELS[av] || av; bv = ROOF_PROFILE_LABELS[bv] || bv; }
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
      if (i === 0) { ev.push({ t: v.created_at, code: d.short_code, text: `Designed ${label} and requested an estimate (v1)` }); return; }
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

// ── CONTACTS WITH NO DESIGN AND NO VISIT (2026-10-06) ───────────────────────────────────
// The list below was built from designs and browsing leads only, so a contact with neither was
// in nobody's list: one brought in from GoHighLevel (migration 282), saved from My Synergy Phone,
// added by hand, or whose design was deleted. They opened as records and came up in the phone's
// search, but not here, and the GoHighLevel import waits on this list showing them.
//
// So the list reads crm_contacts too, as a THIRD source, and shows a row for every live contact
// that no design and no browsing lead in the list already carries (matched on the contact id,
// which is the record the name opens). A builder's portal reads it from PostgREST under RLS, so
// someone limited to their own customers gets exactly the contacts they can open; an operator's
// view-as gets it from operator-portal's get_portal, the audited route the designs take.
//
// ONE PAGE AT A TIME. An import can bring thousands, so the first load asks for the newest page
// and a total, and "Show more" asks for the next. Newest by first_seen_at (a GoHighLevel row's
// own "date added"), never updated_at: every import stamps that with the moment it ran, so a
// whole import would otherwise sit above every real customer. Page size and columns are
// _shared/contactListPage.ts's, which the operator path reads with; its test fails on drift.
const SS_CONTACT_LIST_PAGE = 500;
const SS_CONTACT_LIST_COLS = "id, name, phone, email, source, first_seen_at, created_at";
// "Show more" keeps reading pages until it has this many new rows to show, so a press never
// comes back empty because the next page held only people who already have a design. Bounded,
// so one press is never the whole table.
const SS_CONTACT_MORE_ROWS = 100;
const SS_CONTACT_MORE_PAGES = 8;
// Where a contact came from, in a builder's words (crm_contacts.source: 130, 254, 282). A
// 'design' or 'captured_lead' contact is here only once that design or visit is gone, or not
// visible to this person, so it says no more than what the row is.
const SS_CONTACT_SOURCE_LABELS = {
  ghl_import: "Imported from GoHighLevel",
  phone: "Saved from My Synergy Phone",
  manual: "Added by hand",
  import: "Imported",
};
function ssContactSourceLabel(source) {
  return SS_CONTACT_SOURCE_LABELS[source] || "Contact only";
}

// ─── Leads table (contact-grouped view of designs) ───
// Same RLS-scoped designs read as DesignsTable, but grouped by the person
// (normalized phone → email → name) so a repeat shopper collapses into ONE lead
// with a design count + activity dates. Read-only. "Last activity" = the newest
// design's updated_at (portal logins aren't client-readable); status = the
// highest fulfillment stage across that lead's designs.
// My Synergy Phone (2026-09-29): `callOffered` is ssPhoneOffered's answer for the tenant on screen (the
// shell's one rule for whether calling exists here at all); `viewing`, `canCall`, `phoneOn` and
// `userId` are exactly what the contact record's Call tab is given, and the row's Call button asks
// that tab's own enabled/hint functions, so the list and the record cannot disagree.
function LeadsTable({ clientId, fetchDesigns = null, isAdmin = false, onOpenDesign = null, onOpenRecord = null,
  callOffered = false, viewing = false, canCall = false, phoneOn = false, userId = null }) {
  // Cache-seeded so returning to Contacts paints the grouped list at once and refreshes
  // behind it (see ssTabCache in 01-core). Operator view-as reads through a different path
  // and is left uncached — those rows are service-role and audit-logged.
  const [rows, setRows] = useState(() => (fetchDesigns ? null : ssCacheGet("rest", "contacts", clientId))); // null = loading
  const [error, setError] = useState(null);
  const [query, setQuery] = useState("");  // free-text search across all fields
  // Contacts with no design (see SS_CONTACT_LIST_PAGE above). `byId` is every contact read so far,
  // `fetched` how many rows the pages have answered (the next page's offset), `total` how many live
  // contacts the tenant has for this person. `lastPaint` is the last paint's inputs, so "Show more"
  // can add rows without reading the designs again. `loadGen` lets a Refresh outrank a Show more
  // that is still in flight.
  const contactsRef = useRef({ byId: new Map(), fetched: 0, total: 0 });
  const lastPaintRef = useRef(null);
  const loadGenRef = useRef(0);
  // The rows the last "Show more" added, so the table can go to the page they start on (below).
  const jumpRef = useRef(null);
  const [moreLeft, setMoreLeft] = useState(false);     // the server has contacts not read yet
  const [moreContacts, setMoreContacts] = useState(0); // of those, at least this many have no design
  const [moreBusy, setMoreBusy] = useState(false);
  const [moreErr, setMoreErr] = useState(null);

  // One page of contacts starting at row `from`: PostgREST under RLS for the builder's own portal,
  // get_portal's `contactsFrom` for an operator's view-as (12-shell's viewingFetch).
  const readContactPage = useCallback(async (from) => {
    if (fetchDesigns) {
      const res = await fetchDesigns({ contactsFrom: from });
      return { rows: res.crmContacts || [], total: res.crmContactsTotal || 0 };
    }
    const { data, error: err, count } = await sb.from("crm_contacts")
      .select(SS_CONTACT_LIST_COLS, { count: "exact" })
      .eq("client_id", clientId).is("merged_into", null)
      .order("first_seen_at", { ascending: false }).order("id", { ascending: false })
      .range(from, from + SS_CONTACT_LIST_PAGE - 1);
    // PGRST103 (HTTP 416): the offset is past the end, because contacts were merged or reassigned
    // since the last page. That is the end of the list, not an error, or every later press would
    // fail the same way and say so.
    if (err && err.code === "PGRST103") return { rows: [], total: from };
    if (err) throw err;
    const got = data || [];
    return { rows: got, total: typeof count === "number" ? count : from + got.length };
  }, [fetchDesigns]);

  // Fold one page into what has been read. A row seen on an earlier page (the list moved between
  // pages) is not added twice; an empty page ends the list whatever the total said, so a stale
  // total can never keep "Show more" asking for nothing.
  const takeContacts = (from, page) => {
    const cr = contactsRef.current;
    page.rows.forEach((c) => { if (c && c.id && !cr.byId.has(c.id)) cr.byId.set(c.id, c); });
    cr.fetched = from + page.rows.length;
    cr.total = page.rows.length ? Math.max(page.total, cr.fetched) : cr.fetched;
  };

  const load = useCallback(async () => {
    setError(null);
    loadGenRef.current += 1;
    contactsRef.current = { byId: new Map(), fetched: 0, total: 0 };
    setMoreErr(null); setMoreBusy(false);   // a Show more still in flight is dropped (loadGen)
    // And none can start until this load paints: the previous paint's designs are not this load's,
    // and a failed Refresh must not leave a Show more that repaints the list from before it.
    lastPaintRef.current = null; jumpRef.current = null;
    setMoreLeft(false); setMoreContacts(0);
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
      // ONE BROWSING ROW PER PERSON. captured_leads is unique on the RAW digits, so the same
      // visitor captured once as "+1 512…" (browser autofill keeps the +1, and the gate accepts
      // it) and once as "512…" is two rows there — and was two identical "Browsing" rows here,
      // both opening the same contact. Newest first (the read orders on updated_at), so the row
      // kept is the latest; the older one only fills in what the kept one lacks.
      const browsingByPhone = new Map();
      browsingIn.forEach((l) => {
        const em = String(l.email || "").trim().toLowerCase();
        // captured_leads.phone_digits is the raw digit filter (capture-lead), so it has to
        // go through the same key or a lead captured as "+1 …" survives as a third row for
        // a person who has already submitted designs.
        if (groups.has(normPhone(l.phone_digits)) || (em && groupEmails.has(em))) return;
        const pk = normPhone(l.phone_digits);
        const kept = pk ? browsingByPhone.get(pk) : null;
        if (kept) {
          if (!kept.contactId && l.contact_id) kept.contactId = l.contact_id;
          if (!kept.name && l.name) kept.name = l.name;
          if (!kept.email && l.email) kept.email = l.email;
          if (l.created_at && l.created_at < kept.firstSeen) kept.firstSeen = l.created_at;
          if (l.source === "details" && kept.source !== "details") {
            kept.source = "details";
            kept.search = " browsing lead viewed pricing estimate details";
          }
          return;
        }
        const lead = {
          key: "lead-" + l.id, browsing: true, source: l.source,
          // A browsing lead is a PERSON too, so its name links to the record like every
          // other row. captured_leads.contact_id is stamped by capture-lead (and by 130's
          // backfill) — before that this was always null, which is why the newest row in
          // the list, the one anybody clicks first, was the one row that did nothing.
          contactId: l.contact_id || null,
          name: l.name || "", email: l.email || "", phone: l.phone || "",
          count: 0, firstSeen: l.created_at, lastActivity: l.updated_at,
          latestCode: null, topStatus: "browsing",
          search: " browsing lead" + (l.source === "details" ? " viewed pricing estimate details" : ""),
          codes: [],
        };
        groups.set(lead.key, lead);
        if (pk) browsingByPhone.set(pk, lead);
      });
      // CONTACTS WITH NO DESIGN AND NO VISIT. Matched on the contact id ONLY, every design's and
      // every browsing lead's (a browsing lead hidden above under its person's design still counts):
      // the id is the record the name opens, so a person who already has a row never gets a second.
      // Not matched on phone or email the way browsing leads are: two live contacts sharing an
      // email are two records (282 keeps an email with the contact that had it), and hiding one
      // here would leave it in no list at all.
      const linked = new Set();
      rowsIn.forEach((r) => { if (r.contact_id) linked.add(r.contact_id); });
      browsingIn.forEach((l) => { if (l.contact_id) linked.add(l.contact_id); });
      const cr = contactsRef.current;
      cr.byId.forEach((c) => {
        if (linked.has(c.id)) return;
        // First seen for both dates: the import's own run time is not activity (see the header).
        const seen = c.first_seen_at || c.created_at;
        groups.set("contact-" + c.id, {
          key: "contact-" + c.id, contactOnly: true, source: c.source || "",
          contactId: c.id,
          name: c.name || "", email: c.email || "", phone: c.phone || "",
          count: 0, firstSeen: seen, lastActivity: seen,
          latestCode: null, topStatus: "contact",
          search: " " + ssContactSourceLabel(c.source) + " no design yet",
          codes: [],
        });
      });
      // How many contacts with no design are still to come. Every contact not read yet either
      // carries a design or visit (it is in `linked`, unread) or is one of these. That is a FLOOR,
      // not a count: a visit can point at a contact that is gone (captured_leads.contact_id has no
      // foreign key) and a design at one this person can't see, so it can read 0 while some are
      // left. Whether to offer "Show more" is therefore the server's say alone (fetched < total).
      let linkedUnread = 0;
      linked.forEach((id) => { if (!cr.byId.has(id)) linkedUnread += 1; });
      const left = cr.fetched < cr.total;
      setMoreLeft(left);
      setMoreContacts(left ? Math.max(0, cr.total - cr.byId.size - linkedUnread) : 0);
      lastPaintRef.current = { linked, repaint: () => paint(rowsIn, browsingIn) };
      const out = [...groups.values()].sort((a, b) => (b.lastActivity > a.lastActivity ? 1 : b.lastActivity < a.lastActivity ? -1 : 0));
      setRows(out);
      // Cache the GROUPED result, not the raw reads: regrouping is the expensive part of
      // this function and the shape the table renders from. Operator view-as is excluded —
      // those rows come from a service-role path and belong to someone else's tenant.
      if (!fetchDesigns) ssCachePut("rest", "contacts", clientId, out);
    };
    if (fetchDesigns) {
      // Operator view-as: rows from operator-portal (service-role, audit-logged);
      // live status sync skipped (owner-JWT-bound) — cached statuses show. `withContacts` asks for
      // the first page of contacts too: only this list does, so the Pipeline's get_portal carries none.
      try {
        const res = await fetchDesigns({ withContacts: true }); list = (res.designs || []).filter(notInventoryLead); browsing = res.capturedLeads || [];
        takeContacts(0, { rows: res.crmContacts || [], total: res.crmContactsTotal || 0 });
      }
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
    const [dRes, clRes, ccRes] = await Promise.all([
      // Style and size only (SEL_LIST_COLS) — this list groups people, and the two values it
      // folds into a lead's searchable text are the only part of the plan it ever reads.
      // Both paged (ssReadAllRows) — a single request stopped at PostgREST's 1000-row cap.
      ssReadAllRows((from, to) => sb.from("designs")
        .select(`short_code, created_at, updated_at, status, contact, ${SEL_LIST_COLS}, ghl_estimate_number, contact_id`)
        .eq("client_id", clientId)
        .order("created_at", { ascending: false }).order("short_code", { ascending: false })
        .range(from, to), (r) => r.short_code),
      ssReadAllRows((from, to) => sb.from("captured_leads")
        .select("id, name, phone, phone_digits, email, source, created_at, updated_at, contact_id")
        .eq("client_id", clientId).order("updated_at", { ascending: false }).order("id", { ascending: true })
        .range(from, to), (l) => l.id)
        .then((r) => r, () => ({ data: [] })),
      // The newest page of contacts (SS_CONTACT_LIST_PAGE). Additive like the browsing leads: if
      // it fails, the list is exactly what it was before contacts with no design were shown.
      readContactPage(0).then((r) => r, () => null),
    ]);
    if (dRes.error) { setError(dRes.error.message); setRows([]); return; }
    list = (dRes.data || []).map(withListSelections).filter(notInventoryLead);
    browsing = clRes.data || [];
    if (ccRes) takeContacts(0, ccRes);
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

  // SHOW MORE: the next pages of contacts, until there are SS_CONTACT_MORE_ROWS new rows to show,
  // the server has no more, or SS_CONTACT_MORE_PAGES pages have been read. Then one repaint over
  // the designs and leads already in hand.
  //
  // Always the NEWEST paint, read after every await, never one held from the click: the owner's
  // list paints twice (cached statuses, then the GoHighLevel sync), and a press during the sync
  // that repainted from the first paint put every synced status back to the cached one.
  const showMoreContacts = async () => {
    const gen = loadGenRef.current;
    if (moreBusy || !lastPaintRef.current) return;
    setMoreBusy(true); setMoreErr(null);
    try {
      const fresh = new Set();   // the rows this press adds, by their list key
      for (let i = 0; i < SS_CONTACT_MORE_PAGES; i++) {
        const cr = contactsRef.current;
        if (cr.fetched >= cr.total) break;
        const page = await readContactPage(cr.fetched);
        if (gen !== loadGenRef.current) return;   // a Refresh started meanwhile; its read wins
        const { linked } = lastPaintRef.current;  // same load, so a paint is in hand (load clears it)
        page.rows.forEach((c) => { if (c && c.id && !cr.byId.has(c.id) && !linked.has(c.id)) fresh.add("contact-" + c.id); });
        takeContacts(cr.fetched, page);
        if (fresh.size >= SS_CONTACT_MORE_ROWS) break;
      }
      jumpRef.current = fresh.size ? fresh : null;
      lastPaintRef.current.repaint();
    } catch (_e) {
      if (gen === loadGenRef.current) setMoreErr("Couldn't load more contacts. Try again.");
    } finally {
      if (gen === loadGenRef.current) setMoreBusy(false);
    }
  };

  // Status chips. NOTE this filters PEOPLE by their furthest-along design, because
  // `topStatus` is a max over the person's group — "Accepted" here means "has at least one
  // accepted design", not "all their designs are accepted". That is the useful reading for a
  // contact list (it answers "who are my customers?"), and it is why the same component is
  // fed a different bucket set than the Designs table: `browsing` is a synthetic group with
  // no design behind it at all.
  const [statusFilter, setStatusFilter] = useState("all");
  const statusCounts = (rows || []).reduce((a, g) => { a[g.topStatus] = (a[g.topStatus] || 0) + 1; return a; }, {});
  // A chip's name in a sentence. The two synthetic buckets (browsing leads, contacts with no
  // design) are not designs.status values, so STATUS_LABELS has no word for them.
  const chipName = (k) => (k === "browsing" ? "Browsing" : k === "contact" ? "Contact only" : STATUS_LABELS[k]);
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
      case "status":       return g.contactOnly ? -3 : g.browsing ? -2 : STATUS_RANK[g.topStatus]; // contact only < browsing < draft (-1) < sent
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
  // After "Show more", go to the page the first added contact is on. They are older than everything
  // already listed, so in the default order they land past the last page, and the page on screen
  // did not change at all: the press looked like it had done nothing. Under a search or a filter
  // that none of them matches, the page stays where it is.
  useEffect(() => {
    const want = jumpRef.current;
    if (!want || !rows) return;
    jumpRef.current = null;
    const at = sorted.findIndex((g) => want.has(g.key));
    if (at >= 0) setPage(Math.floor(at / pageSize) + 1);
  }, [rows]);

  // ── Details drawer (per contact): what they changed + their estimate activity ──
  const [detailsFor, setDetailsFor] = useState(null); // group key | null
  const [activity, setActivity] = useState(null);     // contact_activity payload
  const [actBusy, setActBusy] = useState(false);
  const [actErr, setActErr] = useState(null);
  // Guards against a stale contact_activity response landing under a different contact:
  // every request stamps this ref, and only the newest one is allowed to render.
  const actReqRef = useRef(0);
  // My Synergy Phone: where the last row's Call got to — { key, kind, to?, text? }, ssPhoneStartCall's
  // answer for the row with that group key. One at a time; a new press replaces it.
  const [callUi, setCallUi] = useState(null);


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

  // ── MY SYNERGY PHONE: Call from the list ───────────────────────────────────────────────
  // THE RECORD PAGE'S RULES, NOT A COPY OF THEM. The button asks CRM_TABS' own "call" entry
  // (enabled + hint) with the same four facts the record's ctx carries, and dials through the
  // same ssPhoneStartCall. A row with no phone gets no button at all: on a list, a column of
  // greyed "Call"s for email-only customers reads as broken, and the record still explains it.
  const callTab = CRM_TABS.find((t) => t.key === "call");
  const callCtx = (g) => ({ viewing: !!viewing, canCall: !!canCall, phone: { on: !!phoneOn }, contact: { phone: g.phone } });
  const callRow = async (g) => {
    setCallUi({ key: g.key, kind: "checking", to: ssPhoneE164(g.phone) });
    const out = await ssPhoneStartCall(g.phone, { contact_id: g.contactId || null, user_id: userId, client_id: clientId },
      "This contact's phone number can't be dialed. Open their record to check it.");
    setCallUi({ key: g.key, ...out });
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
        desc="Everyone who submitted a design, browsed your designer or is in your contacts, grouped by person — repeat visitors collapse into one lead. Read-only."
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
          {/* Same shape as Pipeline's bar above, and changed with it: Contacts sits one nav
              item away, so leaving it search-first would have made two neighbouring tabs
              disagree about where their search box lives. */}
          <FilterBar hasFilters={hasFacets} onClear={clearFacets} shown={filtered.length} total={rows.length} noun="contact">
            <DateRange label="Last activity" from={fFrom} to={fTo} onFrom={setFFrom} onTo={setFTo} />
            <FacetSelect label="Contact info" value={fContact} onChange={setFContact}
              options={[{ value: "has", label: "Has email or phone" }, { value: "missing", label: "No contact info" }]} allLabel="All" />
          </FilterBar>
          <div style={{ ...FCTRL, flex: "1 1 320px", minWidth: 260 }}>
            <span style={FLBL_SPACER} aria-hidden="true">Search</span>
            <SearchInput value={query} onChange={setQuery} placeholder="Search contacts — name, email, phone, status…" />
          </div>
        </div>
      )}
      {/* `browsing` is passed via `extra` because it is not a designs.status — it is the
          synthetic group built from captured_leads for people who never submitted anything. */}
      {rows && rows.length > 0 && (
        <StatusChips counts={statusCounts} value={statusFilter} onChange={setStatusFilter}
          extra={[["browsing", "Browsing", { fg: "#3D3672" }], ["contact", "Contact only", { fg: "#64748B" }]]} />
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
            ? <>No contacts match “{query}”{statusFilter !== "all" ? <> in <strong>{chipName(statusFilter)}</strong></> : null}{hasFacets ? " with the current filters" : ""}.</>
            : hasFacets
              ? <>No contacts match the current filters. Adjust or <button onClick={clearFacets} style={{ background: "none", border: "none", color: ACCENT, cursor: "pointer", fontWeight: 700, fontSize: 13, padding: 0, fontFamily: "inherit", textDecoration: "underline" }}>clear the filters</button>.</>
              : <>No contacts are <strong>{chipName(statusFilter)}</strong> yet.</>}
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
                const sc = g.browsing ? { bg: "#DBEAFF", fg: "#3D3672" } : g.contactOnly ? { bg: "#F1F5F9", fg: "#475569" } : (STATUS_COLORS[g.topStatus] || STATUS_COLORS.sent);
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
                          with no crm_contacts row yet — i.e. before the backfill has run.
                          A contact with no design and no name (an import, a saved number) shows
                          its phone or email instead, so the one link to its record is not a dash.
                          The phone is crm_contacts' +1 form, so it is written the way people read
                          one, as the rest of the portal writes it. */}
                      {g.contactId && onOpenRecord ? (
                        <button type="button" onClick={() => onOpenRecord(g.contactId)}
                          title="Open this contact's record"
                          style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit", fontSize: "inherit", fontWeight: 700, color: ACCENT, textAlign: "left" }}>
                          {g.name || (g.contactOnly && (g.phone ? phoneDisplay(g.phone) : g.email)) || "—"}
                        </button>
                      ) : (g.name || "—")}
                    </td>
                    <td style={S.td}>
                      <div>{g.email || ""}</div>
                      <div style={{ color: "#64748B", fontSize: 12 }}>{g.contactOnly && g.phone ? phoneDisplay(g.phone) : (g.phone || "")}</div>
                    </td>
                    <td style={S.td}>{g.browsing || g.contactOnly ? "—" : g.count}</td>
                    <td style={{ ...S.td, whiteSpace: "nowrap" }}>{fmtDate(g.firstSeen)}</td>
                    <td style={{ ...S.td, whiteSpace: "nowrap" }}>{fmtDate(g.lastActivity)}</td>
                    <td style={S.td}><span title={g.browsing && g.source === "details" ? "Filled in their contact info and viewed estimate details" : g.browsing ? "Entered name and phone at the designer gate" : g.contactOnly ? "In your contacts, with no design or designer visit yet. Click their name to open their record." : undefined}
                      style={{ background: sc.bg, color: sc.fg, borderRadius: 20, padding: "4px 12px", fontSize: 12, fontWeight: 700, whiteSpace: "nowrap" }}>{g.browsing ? (g.source === "details" ? "Browsing · saw pricing" : "Browsing") : g.contactOnly ? ssContactSourceLabel(g.source) : STATUS_LABELS[g.topStatus]}</span></td>
                    <td style={{ ...S.td, whiteSpace: "nowrap" }}>
                      {(g.browsing || g.contactOnly) && <span style={{ color: "#94A3B8", fontSize: 12.5 }}>No design yet</span>}
                      {/* In-portal open — same rule as DesignsTable: never the public page. */}
                      {!g.browsing && !g.contactOnly && <button type="button" onClick={() => onOpenDesign && onOpenDesign(g.latestCode)}
                        style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit", fontSize: "inherit", color: ACCENT, fontWeight: 700 }}>Open latest</button>}
                      {/* The "Open record" button that stood here is gone: the customer NAME
                          is the link now, which is what Carolyn demonstrated. "Details" stays
                          as the quick inline peek that does not leave the list. */}
                      {!g.browsing && !g.contactOnly && (
                        <button type="button" onClick={() => openDetails(g)}
                          style={{ marginLeft: 10, background: "transparent", border: "none", padding: 0, cursor: "pointer", color: "#334155", fontWeight: 700, fontSize: 13, fontFamily: "inherit" }}>
                          {detailsFor === g.key ? "Hide details" : "Details"}
                        </button>
                      )}
                      {callOffered && callTab && g.phone && (() => {
                        const c = callCtx(g);
                        const on = callTab.enabled(c);
                        const why = on ? "Call with My Synergy Phone" : (typeof callTab.hint === "function" ? callTab.hint(c) : (callTab.hint || ""));
                        return (
                          <button type="button" disabled={!on} title={why} data-ss-list-call={g.contactId || g.key}
                            onClick={() => { if (on) callRow(g); }}
                            style={{ marginLeft: 10, background: "transparent", border: "none", padding: 0, cursor: on ? "pointer" : "not-allowed", color: on ? ACCENT : "#CBD5E1", fontWeight: 700, fontSize: 13, fontFamily: "inherit" }}>
                            Call
                          </button>
                        );
                      })()}
                    </td>
                  </tr>
                  {/* What the row's Call did. Nothing here places a call; it reports what
                      My Synergy Phone said, with the same words and the same install card as the record. */}
                  {callUi && callUi.key === g.key && (
                    <tr>
                      <td colSpan={7} style={{ ...S.td, background: "#F8FAFC" }} data-ss-phone-panel="list-call">
                        <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            {callUi.kind === "checking" && <div style={{ fontSize: 12.5, color: "#64748B" }}>Starting the call in My Synergy Phone…</div>}
                            {callUi.kind === "calling" && (
                              <div style={{ ...S.okMsg, marginBottom: 0 }}>
                                Calling <strong>{phoneDisplay(callUi.to)}</strong> in My Synergy Phone. The call runs there, so you can keep working here.
                              </div>
                            )}
                            {callUi.kind === "app" && (
                              <>
                                <div style={{ fontSize: 12.5, color: "#475569", marginBottom: 8 }}>
                                  Opening the My Synergy Phone app to call <strong>{phoneDisplay(callUi.to)}</strong>. If nothing happens, the app isn't on this phone yet.
                                </div>
                                <SsPhoneInstallCard what="call" mobile />
                              </>
                            )}
                            {callUi.kind === "install" && <SsPhoneInstallCard what="call" fromRecord />}
                            {callUi.kind === "error" && <div style={{ ...S.err, marginBottom: 0 }}>{callUi.text}</div>}
                          </div>
                          <button type="button" title="Close" onClick={() => setCallUi(null)}
                            style={{ background: "none", border: "none", color: "#94A3B8", cursor: "pointer", fontWeight: 800, fontSize: 15, lineHeight: 1 }}>×</button>
                        </div>
                      </td>
                    </tr>
                  )}
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
      {/* SHOW MORE: older contacts with no design are read a page at a time (SS_CONTACT_LIST_PAGE).
          Outside the table on purpose: a search that matches nothing yet may match them, so the
          way to load them stays on screen when the table is empty. */}
      {rows && (moreLeft || moreErr) && (
        <div data-ss-contacts-more="" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", padding: "12px 4px 2px", fontSize: 13, color: "#475569" }}>
          {/* The number is a floor (see paint), so when it is 0 with contacts still unread the
              sentence says so without one. */}
          {moreLeft && (
            <span>
              {moreContacts > 0
                ? <><strong>{moreContacts.toLocaleString()}</strong> older {moreContacts === 1 ? "contact" : "contacts"} with no design {moreContacts === 1 ? "isn't" : "aren't"} listed yet</>
                : <>Some older contacts aren't loaded yet</>}
              {(query || statusFilter !== "all" || hasFacets) ? ", so your search and filters don't cover them" : ""}.
            </span>
          )}
          {moreErr && <span style={{ color: "#B91C1C" }}>{moreErr}</span>}
          <button type="button" onClick={showMoreContacts} disabled={moreBusy}
            style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0", padding: "6px 12px", cursor: moreBusy ? "wait" : "pointer" }}>
            {moreBusy ? "Loading…" : "Show more"}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Conversations (every customer's latest email, text or call) ───
// Carolyn, 2026-08-21 @45:22: "I like the idea of a conversations tab ... So conversations would
// be email, all of it. In the way that GoHighLevel has that, like I like that except I want that
// bar at the top that shows that I can sort and see just that." And @42:45, comparing Pipedrive:
// "I want a conversations tab, sure, but I want to be able to see my calls."
//
// ONE ROW PER CUSTOMER, from their newest message, newest first (portal-settings crm_inbox; the
// rules are in supabase/functions/_shared/crmInbox.ts). The bar on top is All · Email · Texts ·
// Calls, plus Everyone / Mine. A row opens the customer's record ON the matching History chip,
// and the replying happens there, in the record's Email and SMS boxes: this page has no reply
// box of its own (a GoHighLevel-style split pane was not built; say so when it ships).
//
// "Waiting on you" is derived, not stored: the customer spoke last (an email or a text from them,
// or a call from them nobody picked up). Replying is what clears it, so there is no read/unread
// state to keep.
//
// The filter lives in the URL (/portal/conversations/email|texts|calls), so the browser's Back
// from a record lands on the same filter. Mine/Everyone is remembered for the tab's session.
//
// Texts and Calls are offered the way the record's History chips are (CRM_CHIPS `when`): Texts
// once the account can text or has texts, Calls (for someone allowed to see calls) once calling
// is offered or there are calls. A filter that can only ever be empty reads as broken.
const SS_INBOX_FILTERS = [
  { slug: null, channel: "all", label: "All" },
  { slug: "email", channel: "email", label: "Email" },
  { slug: "texts", channel: "sms", label: "Texts" },
  { slug: "calls", channel: "calls", label: "Calls" },
];
// The History chip (CRM_CHIPS key) a row opens the record on, by the row's channel.
const CRM_INBOX_CHIP = { email: "emails", sms: "messages", calls: "calls" };
const SS_INBOX_CHANNEL = {
  email: { label: "Email", bg: "#EFF6FF", fg: "#1D4ED8" },
  sms: { label: "Text", bg: "#F0FDF4", fg: "#15803D" },
  calls: { label: "Call", bg: "#F5F3FF", fg: ACCENT },
};
const SS_INBOX_DIRECTION = {
  in: { email: "Received", sms: "Received", calls: "Incoming" },
  out: { email: "Sent", sms: "Sent", calls: "Outgoing" },
};
// When, the way a message list says it: a time today, "Yesterday", a weekday this week, else the
// date (with the year only when it isn't this year). The full date and time is on hover.
function ssInboxWhen(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(now) - day(d)) / 86400000);
  if (days === 0) return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  if (days > 1 && days < 7) return d.toLocaleDateString("en-US", { weekday: "short" });
  return d.toLocaleDateString("en-US", d.getFullYear() === now.getFullYear()
    ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}
// Pages joined by customer: the server never lists someone twice, and this makes sure of it.
function ssInboxJoin(list, more) {
  const seen = new Set(list.map((r) => r.contactId));
  return list.concat((more || []).filter((r) => r && r.contactId && !seen.has(r.contactId) && seen.add(r.contactId)));
}
const SS_INBOX_MINE_KEY = "ss.inbox.mine";

// `urlFilter` is the URL's sub segment; `onFilter(slug)` changes it. `onOpen(contactId, channel)`
// opens the record. `phoneLevel` (the viewer's phone access) only keys the cache: what calls a
// person may see changes with it, the same reason the cache keys on the contacts row scope.
function ConversationsInbox({ clientId, viewing = false, phoneOffered = false, phoneLevel = null, urlFilter = null, onFilter = null, onOpen = null }) {
  const filter = SS_INBOX_FILTERS.find((f) => f.slug === urlFilter) || SS_INBOX_FILTERS[0];
  const channel = filter.channel;
  const [mine, setMine] = useState(() => { try { return sessionStorage.getItem(SS_INBOX_MINE_KEY) === "1"; } catch (_e) { return false; } });
  const [rows, setRows] = useState(null);       // null = loading
  const [cursor, setCursor] = useState(null);   // where the next page starts; null = no more
  const [meta, setMeta] = useState(null);       // which filters to offer (the first page says)
  const [error, setError] = useState(null);
  const [more, setMore] = useState(false);
  // True while load() is reading: the rows on screen may be the cached copy it is replacing.
  // Load more waits for it (review 2026-10-05): appended to the cached rows, its page either
  // overwrote the fresh first page (a customer who just texted vanished) or was wiped by it.
  const [refreshing, setRefreshing] = useState(false);
  // Drops an answer that arrives after the filter moved on, like openDetails' actReqRef above.
  const reqRef = useRef(0);
  // NARROW (a phone, or a squeezed window): one column per row, the way a messages app lists them
  // (the name, then the channel, then the words; the time on the right), instead of three
  // columns where the words wrap one per line and the time is pushed off the side. Measured on
  // the card itself, so the rail's width counts and no stylesheet is needed.
  const cardRef = useRef(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = cardRef.current;
    const measure = () => { const w = el ? el.getBoundingClientRect().width : window.innerWidth; setNarrow(w < 560); };
    measure();
    if (el && typeof ResizeObserver === "function") {
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      return () => ro.disconnect();
    }
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  // Cache-seeded like Contacts, so coming Back from a record paints at once and refreshes behind
  // it (every portal-settings call carries ~2 s of fixed cost). Not in view-as, like Contacts.
  const cacheAction = `crm_inbox|${channel}|${mine ? 1 : 0}|${phoneLevel || ""}`;

  const fetchPage = async (cur) => {
    const { data, error: err } = await sb.functions.invoke("portal-settings", {
      body: { action: "crm_inbox", channel, mine, ...(cur ? { cursor: cur } : {}) },
    });
    if (err) return { error: await fnError(err) };
    if (!data || data.error || !Array.isArray(data.threads)) return { error: (data && data.error) || "Couldn't load your conversations. Please try again." };
    return { data };
  };

  const load = useCallback(async () => {
    const req = ++reqRef.current;
    setError(null);
    setMore(false);
    setRefreshing(true);
    const hit = viewing ? null : ssCacheGet("portal-settings", cacheAction, clientId);
    if (hit) { setRows(hit.threads); setCursor(hit.cursor); setMeta(hit.meta); }
    else { setRows(null); setCursor(null); }
    let list = [];
    let cur = null;
    let firstMeta = null;
    try {
      // A page can come back with nobody on it and more to read: Mine, or someone who sees only
      // their own customers, can filter a whole page away. Read on a few pages before saying
      // "nothing here", rather than showing an empty list with a Load more under it.
      for (let i = 0; i < 5; i++) {
        const out = await fetchPage(cur);
        if (req !== reqRef.current) return;
        if (out.error) {
          setError(out.error);
          // Keep what did arrive (Load more retries from where it stopped); with nothing, the
          // cached rows, if any, stay on screen under the error.
          if (list.length) { setRows(list); setCursor(cur); }
          return;
        }
        const d = out.data;
        if (i === 0) firstMeta = { smsReady: !!d.smsReady, hasTexts: !!d.hasTexts, hasCalls: !!d.hasCalls, seesCalls: !!d.seesCalls };
        list = ssInboxJoin(list, d.threads);
        cur = d.cursor || null;
        if (list.length || !cur) break;
      }
      setRows(list); setCursor(cur); setMeta(firstMeta);
      if (!viewing) ssCachePut("portal-settings", cacheAction, clientId, { threads: list, cursor: cur, meta: firstMeta });
    } finally {
      // A newer load owns the flag from here.
      if (req === reqRef.current) setRefreshing(false);
    }
  }, [clientId, viewing, channel, mine, cacheAction]);
  useEffect(() => { load(); }, [load]);

  const loadMore = async () => {
    if (!cursor || more || refreshing) return;
    const req = reqRef.current;
    setMore(true); setError(null);
    let list = rows || [];
    let cur = cursor;
    try {
      for (let i = 0; i < 5 && cur; i++) {
        const out = await fetchPage(cur);
        if (req !== reqRef.current) return;
        if (out.error) { setError(out.error); break; }
        const before = list.length;
        list = ssInboxJoin(list, out.data.threads);
        cur = out.data.cursor || null;
        if (list.length > before) break;
      }
      if (req !== reqRef.current) return;
      setRows(list); setCursor(cur);
    } finally {
      if (req === reqRef.current) setMore(false);
    }
  };

  const setWhose = (v) => {
    setMine(v);
    try { sessionStorage.setItem(SS_INBOX_MINE_KEY, v ? "1" : "0"); } catch (_e) { /* storage blocked: it just won't be remembered */ }
  };

  const offered = SS_INBOX_FILTERS.filter((f) =>
    f.channel === channel || f.channel === "all" || f.channel === "email"
    || (f.channel === "sms" && !!(meta && (meta.smsReady || meta.hasTexts)))
    || (f.channel === "calls" && !!(meta && meta.seesCalls && (phoneOffered || meta.hasCalls))));
  const open = (r) => { if (onOpen) onOpen(r.contactId, r.channel); };
  const pill = (on) => ({
    display: "inline-flex", alignItems: "center", cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 700,
    padding: "5px 12px", borderRadius: 999, border: on ? "1px solid " + ACCENT : "1px solid #E2E8F0",
    background: on ? ACCENT : "#FFF", color: on ? "#FFF" : "#475569",
  });
  // Empty WITH more to read is not "nothing yet": load() gave up reading ahead (Mine, or someone
  // who sees only their own customers, can filter page after page away), and the button under
  // this reads further back. Mine's sentence names no "team": for someone who sees only their own
  // customers, Everyone adds the ones nobody is assigned to, not their colleagues' (review 2026-10-05).
  const emptyText = cursor
    ? "Nothing in the most recent conversations. Use Look further back to see older ones."
    : mine
    ? "Nothing here for you yet. Switch to Everyone to see every conversation you have access to."
    : channel === "email" ? "No email conversations yet."
    : channel === "sms" ? "No text conversations yet."
    : channel === "calls" ? "No calls with customers yet."
    : "No conversations yet. Emails, texts and calls with your customers show up here as they happen.";

  return (
    <div ref={cardRef} style={S.card} data-ss-inbox="" data-ss-inbox-narrow={narrow ? "1" : "0"}>
      <CardHead
        title="Conversations"
        count={rows ? `${rows.length}${cursor ? "+" : ""}` : null}
        desc="Click a conversation to open the customer's record and reply from there."
        right={<button type="button" onClick={load} style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0", padding: "6px 12px" }}>↻ Refresh</button>}
      />
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <div role="group" aria-label="Show" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {offered.map((f) => (
            <button key={f.channel} type="button" aria-pressed={f.channel === channel} data-ss-inbox-filter={f.channel}
              onClick={() => { if (f.channel !== channel && onFilter) onFilter(f.slug); }} style={pill(f.channel === channel)}>
              {f.label}
            </button>
          ))}
        </div>
        <div role="group" aria-label="Whose conversations" style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <button type="button" aria-pressed={!mine} data-ss-inbox-mine="0" onClick={() => { if (mine) setWhose(false); }} style={pill(!mine)}>Everyone</button>
          <button type="button" aria-pressed={mine} data-ss-inbox-mine="1" onClick={() => { if (!mine) setWhose(true); }} style={pill(mine)}
            title="Your customers, customers nobody is assigned to, and anyone you've written to or talked with">Mine</button>
        </div>
      </div>
      {error && <div style={S.err}>{error}</div>}
      {rows === null && !error && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>{(narrow ? ["Customer", "When"] : ["Customer", "Latest", "When"]).map((h) => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
            <tbody>{narrow ? <SkelRows cols={2} rows={6} widths={["80%", "60%"]} /> : <SkelRows cols={3} rows={6} widths={["55%", "80%", "50%"]} />}</tbody>
          </table>
        </div>
      )}
      {rows && rows.length === 0 && !error && (
        <p style={{ fontSize: 13, color: "#64748B", padding: 12, margin: 0 }} data-ss-inbox-empty="">{emptyText}</p>
      )}
      {rows && rows.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              <th style={S.th}>Customer</th>
              {!narrow && <th style={S.th}>Latest</th>}
              <th style={{ ...S.th, textAlign: "right" }}>When</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => {
                const ch = SS_INBOX_CHANNEL[r.channel] || SS_INBOX_CHANNEL.email;
                const dir = (SS_INBOX_DIRECTION[r.direction] || SS_INBOX_DIRECTION.in)[r.channel] || "";
                // A real link, like the nav: right-click or middle-click opens the record in a new
                // tab. A left click stays on the page (ssNavClick) and opens it on the History chip
                // for this channel.
                const who = (
                  <a href={ssPagePath("contacts", "c-" + r.contactId)}
                    onClick={(e) => { e.stopPropagation(); ssNavClick(() => open(r))(e); }}
                    style={{ color: ACCENT, fontWeight: 800, textDecoration: "none", overflowWrap: "anywhere" }}>
                    {r.name || "Unnamed contact"}
                  </a>
                );
                const waiting = r.awaitingReply ? (
                  <span data-ss-inbox-waiting="" style={{ background: "#FEF3C7", color: "#92400E", borderRadius: 999, padding: "2px 9px", fontSize: 11.5, fontWeight: 800, whiteSpace: "nowrap" }}>Waiting on you</span>
                ) : null;
                const latest = (
                  <>
                    <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap", marginBottom: 3 }}>
                      <span style={{ background: ch.bg, color: ch.fg, borderRadius: 6, padding: "1px 8px", fontSize: 11.5, fontWeight: 800 }}>{ch.label}</span>
                      <span style={{ fontSize: 11.5, color: "#64748B", fontWeight: 700 }}>{dir}</span>
                      {narrow && waiting}
                    </div>
                    <div style={{ color: "#334155", overflowWrap: "anywhere" }}>{r.preview}</div>
                  </>
                );
                return (
                  <tr key={r.contactId} data-ss-inbox-row={r.contactId} data-ss-inbox-channel={r.channel}
                    onClick={() => open(r)} style={{ cursor: "pointer" }}>
                    {narrow ? (
                      <td style={S.td}>
                        <div style={{ marginBottom: 4 }}>{who}</div>
                        {latest}
                      </td>
                    ) : (
                      <>
                        <td style={{ ...S.td, width: "32%" }}>
                          {who}
                          {waiting && <div style={{ marginTop: 5 }}>{waiting}</div>}
                        </td>
                        <td style={S.td}>{latest}</td>
                      </>
                    )}
                    <td style={{ ...S.td, whiteSpace: "nowrap", textAlign: "right", color: "#64748B", width: 1 }} title={fmtWhen(r.at)}>{ssInboxWhen(r.at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {rows && cursor && (
        <div style={{ textAlign: "center", marginTop: 12 }}>
          <button type="button" onClick={loadMore} disabled={more || refreshing} data-ss-inbox-more=""
            style={{ ...S.btn("#FFF", ACCENT), border: "1px solid #E2E8F0", padding: "8px 16px", cursor: more || refreshing ? "default" : "pointer" }}>
            {more || refreshing ? "Loading…" : rows.length ? "Load more" : "Look further back"}
          </button>
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

// THE DEAL ON SCREEN, whichever kind of record is showing it: the design record itself, or the
// deal PICKED on a contact. Null on a contact with nothing picked.
//
// Gate on this rather than on `kind === "design"` whenever a thing belongs to one deal. The two
// tests look interchangeable and are not: `kind` asks which URL you arrived by, this asks which
// building you are looking at. Gating on `kind` is what forced a trip to the deal's own record to
// see anything deal-shaped, which is the behaviour Ahsan removed on 2026-09-20 — he wants the
// contact page to be the whole story.
function crmContextDesign(c) {
  return (c.kind === "design" ? c.record : (c.designs || []).find((x) => x.short_code === c.selectedCode)) || null;
}

// The deal on screen, when it is a StructureStudio-issued quote. A quote number and no CRM
// estimate is the same test the Pipeline's send-invoice confirm uses for "StructureStudio issues
// this paperwork".
function crmSsQuoteDesign(c) {
  const d = crmContextDesign(c);
  return d && d.ss_quote_number && !d.ghl_estimate_number ? d : null;
}

// `kinds` is which record a card can EVER appear on, and it is what Settings → My Profile lists
// when someone puts the cards in their own order. `when` is whether it shows on THIS record. The
// two have to agree (a card whose `when` can pass on a contact must list "contact"), and
// crmCardOrder_test holds them to it: a card missing from `kinds` still renders, but it can't be
// moved, so it would sit at the bottom of everyone's arranged column with no way up.
const CRM_SECTIONS = [
  { key: "summary", title: "Summary", kinds: ["contact", "design"], when: () => true },
  { key: "details", title: "Details", kinds: ["contact", "design"], when: () => true },
  // ── THE RECIPROCAL EMBED. This pair IS Carolyn's "here is the contact, and the deal is
  // all on the side here ... it's in one place." A Person shows its Deals; a Deal shows
  // its Person. Same shell, mirrored.
  //
  // ONE Deals card since 2026-10-12. Migration 301 added a second "Sales pipelines" card for the
  // pipeline cards, and Carolyn: "I'm still confused about this deals and sales pipeline ... So
  // this also has to be merged." Each design row now carries its card's status, stage and
  // pipeline, and a deal with no design is a row here too (crmDealRows). A saved card order that
  // still names "salesPipelines" is harmless: crmOrderSections skips keys this build doesn't draw.
  { key: "deals", title: "Deals", kinds: ["contact"], when: (c) => c.kind === "contact" },
  // ORDERS. Carolyn, 2026-08-26 33:20: "when you're in contacts, in a contact, I feel like
  // you should see the deal. You should see the orders." Deals were already here; orders
  // are what say whether any of them turned into a sale. Contact-side only — a design's
  // order is the same one row and would just repeat the stage bar above it.
  { key: "orders", title: "Orders", kinds: ["contact"], when: (c) => c.kind === "contact" },
  { key: "person", title: "Person", kinds: ["design"], when: (c) => c.kind === "design" },
  // SALES TAX (Avalara stage, 2026-09-17). The deal on screen — the record itself, or the one
  // picked on a contact — and only a StructureStudio-issued quote: a CRM-mode tenant's CRM
  // figures tax on its own estimate, so there is nothing here for them to see or change.
  // `note` is the line My Profile shows under it, so nobody arranging their cards wonders why
  // this one is missing from most records.
  { key: "tax", title: "Sales tax", kinds: ["contact", "design"], when: (c) => !!crmSsQuoteDesign(c),
    note: "Shows for a deal with a StructureStudio estimate" },
  // BUILD, DELIVERY, REPAIRS. Carolyn, 2026-08-28 @37:48: "whether you're in a contact or
  // whether you're in a deal, it doesn't matter, you want to be able to see the contact
  // details, the deals, the orders, the build schedule, the delivery schedule ... Repairs
  // also." On BOTH kinds, which is why there is no `when` narrowing here.
  //
  // "If there's nothing, like, because they haven't placed an order, the card just is going
  // to be blank. It'll say build schedule. And it just is nothing." -- so an empty card
  // RENDERS EMPTY rather than disappearing. A card that vanishes reads as "not built".
  { key: "build", title: "Build schedule", kinds: ["contact", "design"], when: () => true },
  { key: "delivery", title: "Delivery schedule", kinds: ["contact", "design"], when: () => true },
  { key: "repairs", title: "Repairs", kinds: ["contact", "design"], when: () => true },
  { key: "overview", title: "Overview", kinds: ["contact", "design"], when: () => true },
];

// ── EACH PERSON'S CARD ORDER ──────────────────────────────────────────────────────────────
// Carolyn, 2026-08-28 @39:00: "they can put their cards in the order that they want them, and
// they can have a different order under a contact, and a different order under a deal." Stored
// per person in client_users.prefs.cardOrder ({ contact: [...keys], design: [...keys] }, migration
// 165) and arranged in Settings → My Profile; nothing on the server reads it.
//
// The saved list is a WISH, not a schema. It can name a card this build doesn't have (save_prefs
// keeps unknown keys on purpose, so a newer tab's layout survives a save from an older one) or
// leave out one added since it was saved. So: the saved keys that are showing, in saved order,
// then everything else that is showing in registry order. A new card turns up at the bottom of an
// arranged column rather than vanishing, and an empty or missing list is the registry order.
function crmOrderSections(visible, saved) {
  if (!Array.isArray(saved) || !saved.length) return visible;
  const out = [];
  for (const k of saved) {
    const s = visible.find((v) => v.key === k);
    if (s && out.indexOf(s) === -1) out.push(s);
  }
  for (const s of visible) if (out.indexOf(s) === -1) out.push(s);
  return out;
}

// The list to SAVE once someone has arranged the cards this build knows (`known`, the full key
// list for one kind). A key the saved list holds and this build doesn't know keeps its slot, and
// the known keys fill the other slots in their new order, so an older tab can't quietly drop a
// newer card's place. Known keys that weren't saved before go on the end.
function crmMergeCardOrder(saved, known) {
  const queue = known.slice();
  const seen = [];
  const out = [];
  for (const k of (Array.isArray(saved) ? saved : [])) {
    if (typeof k !== "string" || seen.indexOf(k) !== -1) continue;
    seen.push(k);
    // Each distinct known key in `saved` takes one slot, and there are never more of them than
    // `known` holds, so the queue can't run dry here.
    out.push(known.indexOf(k) === -1 ? k : queue.shift());
  }
  return out.concat(queue);
}

// The ACTION BAR — "up at the top here is things you can do. So this bar is basically
// actions that you can take." Disabled tabs render GREYED WITH A TOOLTIP, never hidden: a
// missing tab reads as "not built", a greyed one reads as "next", and she is showing this
// at a trade show.
// Why a THIRD reason a tab can be off, beside "not built" and "not your permission": the
// account has not bought the CRM. Blaming the reader's permissions for a billing state sends
// an owner — who has every permission there is — off to Team looking for a switch that is not
// there. Worded to match the 403 portal-settings returns for the same prefix, so the greyed
// hint and any refusal that reaches the browser tell one story.
const CRM_LOCKED_HINT = "The built-in CRM isn't part of your subscription — add it under Settings → Billing.";

// The reason a tab is greyed on a CONTACT record with no deal picked yet. Carolyn,
// 2026-09-02, looking at a contact holding four quotes: "Which one the heck is it when I'm
// in a contact? ... you have to have one of these selected for anything to show up here ...
// Right now, it's Greek, you have no idea."
//
// It says WHY rather than just "pick one": every one of these five writes carries a
// short_code, and filed against the wrong deal a note about one customer's building lands
// in another's history. Deliberately placed beside CRM_LOCKED_HINT so it falls inside the
// block crmRecordGate_test already slices — no test anchor moves.
const CRM_PICK_HINT = (what) =>
  `Pick a deal or order on the left first, so the ${what} is filed against the right one.`;

// OPERATOR VIEW-AS (plan section 12, My Synergy Phone). While CSM Synergy is looking at a builder's
// account, Call and Text go dark: a call or text placed from here would go out from the
// builder's own number, under the builder's name, to the builder's customer — by somebody who
// is not on that builder's team. The server refuses a contact from another tenant too; this is
// the browser saying so before anyone presses the button. FIRST in both hints' order, because
// it is the one reason nothing else on the page can fix.
const CRM_VIEWING_CALL_HINT = "Calling isn't available while viewing another account.";
const CRM_VIEWING_TEXT_HINT = "Texting isn't available while viewing another account.";

const CRM_TABS = [
  // "Not available yet" (the default hint) reads as NOT BUILT, which is the wrong story for
  // a tab that is merely out of this person's reach — it is built, they just cannot write.
  //
  // ⚠️ HINT ORDER IS SUBSCRIPTION → PERMISSION → THE TAB'S OWN DATA NEED → needsPick, and
  // needsPick goes LAST everywhere. If a contact has no email address, picking a deal still
  // leaves Email disabled, so leading with "pick a deal" would be a lie by omission and send
  // the reader off doing something that changes nothing. Ordered this way the hint always
  // names a reason that is STILL TRUE once the reader has acted on every reason above it.
  { key: "activity", label: "Activity", enabled: (c) => c.canEdit && !c.needsPick,
    hint: (c) => (!c.crmUnlocked ? CRM_LOCKED_HINT
      : !c.canEdit ? "You don't have permission to log activities."
      : CRM_PICK_HINT("activity")) },
  { key: "note", label: "Notes", enabled: (c) => c.canEdit && !c.needsPick,
    hint: (c) => (!c.crmUnlocked ? CRM_LOCKED_HINT
      : !c.canEdit ? "You don't have permission to add notes."
      : CRM_PICK_HINT("note")) },
  { key: "scheduler", label: "Meeting scheduler", enabled: () => false, hint: "Arrives with the calendar integration." },
  // CALL — My Synergy Phone (2026-09-29). Built now, so it no longer says "arrives with the phone
  // integration". Pressing it hands the number to the My Synergy Phone extension on this computer (or
  // the app, on a phone) and the call runs THERE; this page never moves. See startCall.
  //
  // It is NOT a CRM tab and NOT a contacts:edit tab, deliberately: it writes nothing through
  // portal-settings (no crm_ prefix, so the subscription does not gate it), and a rep with
  // read-only contacts who holds phone access may still ring the customer on screen — the plan
  // gates calling on the PHONE area alone (section 7). No deal pick either: a call is to the
  // person, not about one quote.
  //
  // Hint order: view-as first (nothing on the page can fix it), then permission, then the
  // account's switch, then the contact's own data — each still true once the ones above it
  // are acted on.
  { key: "call", label: "Call",
    enabled: (c) => !c.viewing && !!c.canCall && !!(c.phone && c.phone.on) && !!(c.contact && c.contact.phone),
    hint: (c) => (c.viewing
      ? CRM_VIEWING_CALL_HINT
      : !c.canCall
        ? "You don't have permission to make calls."
        : !(c.phone && c.phone.on)
          ? "Calling isn't switched on for this account yet."
          : "This contact has no phone number on file.") },
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
  //
  // MY SYNERGY PHONE (2026-09-29): when the extension is installed and signed in as this person, the
  // tab opens the customer's thread THERE instead (routeText), and this composer stays as the
  // fallback for everyone else. Its gates are unchanged — the extension's send runs the same
  // registration, consent and STOP rules — except the operator view-as, which now greys it.
  {
    key: "sms", label: "SMS",
    enabled: (c) => !c.viewing && c.canEdit && !!(c.contact && c.contact.phone && c.contact.id) && !!(c.sms && c.sms.ready) && !c.needsPick,
    hint: (c) => (c.viewing
      ? CRM_VIEWING_TEXT_HINT
      : !c.crmUnlocked
      ? CRM_LOCKED_HINT
      : !c.canEdit
      ? "You don't have permission to text contacts."
      : !(c.contact && c.contact.phone)
        ? "This contact has no phone number on file."
        : !(c.contact && c.contact.id)
          ? "This design predates contact records, so there is no contact to text yet. It gets its own contact the next time this customer submits."
          : !(c.sms && c.sms.ready)
            ? "Texting switches on once this account's number clears carrier registration."
            : CRM_PICK_HINT("text")),
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
    enabled: (c) => c.canEdit && !!(c.contact && c.contact.email) && !c.needsPick,
    hint: (c) => (!c.crmUnlocked
      ? CRM_LOCKED_HINT
      : !c.canEdit
      ? "You don't have permission to email contacts."
      : !(c.contact && c.contact.email)
        ? "This contact has no email address on file."
        : CRM_PICK_HINT("email")),
  },
  // TWO NAMES SEPARATED BY WHAT THEY DO, NOT BY WHOSE THEY ARE — and that is a revision.
  //
  // Carolyn spent the longest stretch of the 2026-08-26 call on this (20:08–26:45):
  // "documents is what we create ... customer files is like customer files", and "I don't
  // want it all mixed together." That produced "Design Documents" vs "Customer Uploads",
  // named by AUTHOR, on the reasoning that "Documents" and "Files" are the same word twice
  // so neither tells you which pile you are looking at.
  //
  // She moved off author on 2026-09-08 (29:05), and gave the reason: "customer uploads,
  // let's just name this upload, because it may sometimes be not just a customer upload,
  // like they might revise something and they want to save the file as well." The tab is
  // where a file goes IN — by anyone, us included — so "Customer" was describing a
  // restriction the tab never had. It is now "Uploads".
  //
  // The History chip is the other half of the same move: it lists everything already
  // filed, generated and uploaded alike, and it carries images and other non-document
  // formats, so "Documents" undersold it. It is now "Files".
  //
  // The 08-26 worry does not return, because the two words no longer sit in the same row:
  // "Uploads" is a TAB (a thing you do), "Files" is a HISTORY CHIP (a thing that happened).
  // If either is ever renamed back toward the other, re-read that call first.
  //
  // Live since migration 151. The hint it used to carry — "arrives with customer file
  // storage; nothing they send is lost in the meantime, it is still on the email" — was a
  // promise, and this is it kept. Only a contact record has somewhere to put a file: a
  // design's uploads belong to the person, not to one of their quotes.
  {
    key: "files", label: "Uploads",
    enabled: (c) => c.canEdit && !!(c.contact && c.contact.id) && !c.needsPick,
    hint: (c) => (!c.crmUnlocked
      ? CRM_LOCKED_HINT
      : !c.canEdit
      ? "You don't have permission to add files to contacts."
      : !(c.contact && c.contact.id)
        ? "This design has no contact record yet, so there is nowhere to file an upload."
        : CRM_PICK_HINT("upload")),
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
  // Follows THE DEAL, not the record kind — so it is here on a contact the moment one is picked,
  // and the contact page no longer has to hand you off to the deal's own record to reach it.
  { key: "invoice", label: "Invoice", when: (c) => !!crmContextDesign(c),
    enabled: (c) => { const d = crmContextDesign(c); return c.isAdmin && normStatus(d && d.status) === "accepted"; } },
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
  // Calls, voicemails and missed calls — My Synergy Phone. Mirrors CRM_FEED_TYPES.call in
  // _shared/crmFeed.ts; keep the two identical. Shown once the account can call, OR once this
  // record has any call on it, so switching calling off later never hides history that exists.
  { key: "calls", label: "Calls", types: ["call", "call_missed", "voicemail"], when: (c) => !!(c.phone && c.phone.on) || !!c.hasCalls },
  // Where the documents live now — ours AND theirs, one list, because "I don't want it all
  // mixed together" was about the two NAMES being interchangeable, not about them being far
  // apart. Mirrors CRM_FEED_TYPES.document; keep the two identical.
  { key: "documents", label: "Files", types: ["change_order", "invoice_created", "invoice_sent", "quote_pdf", "floor_plan", "customer_file"] },
  { key: "deals", label: "Deals", types: ["design_created", "design_version", "accepted", "quote_opened"], when: (c) => c.kind === "contact" },
  // No `when`: on a deal this is that deal's invoices, on a contact it is every invoice the
  // contact has. Both are worth having, and gating it on the record kind was the other half of
  // what made the deal's own record a place you had to go.
  { key: "invoices", label: "Invoices", types: ["invoice_created", "invoice_sent"] },
  // Everything that happened, not three types two of which were never emitted — see the
  // CRM_FEED_TYPES.changelog comment in _shared/crmFeed.ts for why this read 0 on Carolyn's
  // screen. Keep the two lists identical.
  // `owner_change` (2026-09-05) — assignment is a thing that HAPPENED to this record, and
  // Carolyn's definition of the word is everything that happened to it (08-26 25:18: "if they
  // changed ownership of a lead from one person to another person, that was logged").
  //
  // ⚠️ A chip asking for a type the server never emits fails SILENTLY — the filter returns
  // nothing and an empty changelog reads as "nothing has happened here" rather than as a bug.
  // That is how this very chip came to read 0 on Carolyn's screen. Mirrors
  // CRM_FEED_TYPES.changelog in _shared/crmFeed.ts; keep the two identical.
  //
  // A contact MERGE deliberately has no chip of its own: migration 192 records it as a
  // `crm_field_changes` row (`field = 'merged_from'`) and the feed emits it as the existing
  // `field_change` type, so it already rides this list.
  { key: "changelog", label: "Changelog", types: ["design_created", "design_version", "accepted", "quote_opened",
    "change_order", "invoice_created", "invoice_sent", "lead_captured", "field_change", "owner_change"] },
];

// WHAT HAPPENED TO ONE OF OUR EMAILS AFTER IT LEFT (B4, migration 262). Carolyn, 2026-10-01: a
// prospective client "asked to be able to see if an email is read or not." crmFeed puts the
// answer in `meta.delivery` (Opened, Delivered, Bounced or Marked as spam; nothing while it is only
// sent) and this draws it beside the title, the way the History already flags a failed send.
//
// "Marked as spam" is its own chip, not a kind of Bounced: the email ARRIVED (often it was opened
// first), so "check the address and send again" would be false, and sending again to someone who
// just reported the builder is what hurts their sending domain most.
//
// An open is a guess the provider makes from a tracking image, so the tooltip says so in the same
// words as Settings → Email Settings: some mail apps block the image (a real open never shows) and
// some fetch it by themselves (an open shows that nobody made). A builder who reads "Opened" as
// proof is the failure this sentence is for.
const SS_DELIVERY_TONE = {
  Opened: { bg: "#F0FDF4", fg: "#15803D", bd: "#BBF7D0" },
  Delivered: { bg: "#F1F5F9", fg: "#475569", bd: "#E2E8F0" },
  Bounced: { bg: "#FEF2F2", fg: "#DC2626", bd: "#FECACA" },
  "Marked as spam": { bg: "#FEF2F2", fg: "#DC2626", bd: "#FECACA" },
};
function SsEmailDeliveryChip({ meta }) {
  const tone = meta && SS_DELIVERY_TONE[meta.delivery];
  if (!tone) return null;
  let tip = "The customer's mail server accepted it.";
  if (meta.delivery === "Bounced") {
    // A suppressed send is recorded as a bounce too (postmark-events): the email provider skipped
    // it because an earlier email to the address bounced or was reported, maybe another builder's.
    tip = "The customer's mail server refused it, or it wasn't sent because an earlier email to this address bounced or was marked as spam. Check the address before sending again.";
  } else if (meta.delivery === "Marked as spam") {
    tip = "They marked this email as spam. Don't email them again.";
  } else if (meta.delivery === "Opened") {
    let when = "";
    try {
      when = new Date(meta.openedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    } catch (_e) { when = ""; }
    // 25 is where the server stops counting (migration 262), so 25 means "25 or more".
    const n = Number(meta.openCount) || 1;
    tip = `${when ? `First opened ${when}` : "Opened"}${n > 1 ? ` · opened ${n >= 25 ? "25+" : n} times` : ""}. `
      + "Opens are approximate: some mail apps block the tracking image, and some open emails automatically.";
  }
  return (
    <span title={tip} style={{
      marginLeft: 6, display: "inline-block", verticalAlign: "1px", fontSize: 10, fontWeight: 800,
      color: tone.fg, background: tone.bg, border: "1px solid " + tone.bd, borderRadius: 4, padding: "0 5px",
    }}>
      {meta.delivery}
    </span>
  );
}

// Street / City / State / ZIP for the contact editor, which renders in TWO places (the
// contact record's Person card and a deal record's Person drop-down). It was copy-pasted
// between them, and adding the billing pair (2026-09-04) would have made that four identical
// blocks — so it is one component that takes the field names it writes.
//
// ⚠️ `keys` is explicit rather than derived from a prefix. The delivery columns are bare
// (`street`) and the billing ones are prefixed (`billingStreet`), so any "" + capitalise rule
// would be a lie for one of the two and would break the moment somebody adds a third address.
function CrmAddressFields({ edit, setEdit, keys }) {
  const set = (k) => (e) => setEdit((p) => ({ ...p, [k]: e.target.value }));
  const cell = { ...S.input, marginBottom: 7, width: "100%", boxSizing: "border-box" };
  return (
    <>
      <span style={S.lbl}>Street</span>
      <input style={{ ...S.input, marginBottom: 7 }} value={edit[keys.street]} placeholder="412 Ladder Lane"
        onChange={set(keys.street)} />
      <div style={{ display: "flex", gap: 7 }}>
        <div style={{ flex: "2 1 0", minWidth: 0 }}>
          <span style={S.lbl}>City</span>
          <input style={cell} value={edit[keys.city]} placeholder="Springfield" onChange={set(keys.city)} />
        </div>
        <div style={{ flex: "1 1 0", minWidth: 0 }}>
          <span style={S.lbl}>State</span>
          <input style={cell} value={edit[keys.state]} placeholder="MO" onChange={set(keys.state)} />
        </div>
        <div style={{ flex: "1 1 0", minWidth: 0 }}>
          <span style={S.lbl}>ZIP</span>
          <input style={cell} value={edit[keys.zip]} placeholder="65801" onChange={set(keys.zip)} />
        </div>
      </div>
    </>
  );
}
// WHO OWNS THIS CUSTOMER. Carolyn 2026-09-04 @1:09:30, settling a 40-minute argument with
// herself: "we do not ever assign deals. We only assign contacts and followers … if they are
// not assigned to or following that customer, they can't see anything of it."
//
// The roster comes from the SERVER (`crm_record`'s `team`), never from a browser query:
// client_users' only policy is `client_users_select_own`, so a portal user cannot read their
// own colleagues' rows and a locally-built list would be empty for everyone but an operator.
//
// `undefined` team = this record was not built with one (a DESIGN record, or an older server).
// Render nothing rather than an empty picker — a drop-down with no names next to a filled-in
// owner name reads as broken, and Carolyn has already been shown one screen that did that.
function CrmOwnerPicker({ edit, setEdit, team }) {
  if (!Array.isArray(team)) return null;
  return (
    <>
      <span style={S.lbl}>Assigned to</span>
      <select style={{ ...S.input, marginBottom: 7 }} value={edit.owner || ""}
        onChange={(e) => setEdit((p) => ({ ...p, owner: e.target.value }))}>
        {/* "" is a real answer, not a placeholder — the server reads it as "clear the owner". */}
        <option value="">Unassigned</option>
        {team.map((m) => (
          <option key={m.userId} value={m.userId}>
            {m.name || "(no name set)"}{m.title ? ` — ${ssTitleLabel(m.title)}` : ""}
          </option>
        ))}
      </select>
    </>
  );
}
// Titles are stored as slugs (`sales_rep`); this is the only place the record page shows one.
function ssTitleLabel(t) {
  return String(t || "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// The two address sets, named once so a caller cannot invent a third spelling.
const CRM_ADDR_DELIVERY = { street: "street", city: "city", state: "state", zip: "zip" };
const CRM_ADDR_BILLING = { street: "billingStreet", city: "billingCity", state: "billingState", zip: "billingZip" };

// A section heading inside the contact editor. Only earns its place now that there are two
// addresses: with one, an unlabelled Street/City/State/ZIP was unambiguous.
function CrmEditHead({ children, hint }) {
  return (
    <div style={{ margin: "9px 0 5px", display: "flex", alignItems: "baseline", gap: 7 }}>
      <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", color: "#475569", whiteSpace: "nowrap" }}>{children}</span>
      {hint && <span style={{ fontSize: 11, color: "#94A3B8", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{hint}</span>}
    </div>
  );
}

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

// ── HAS THIS DEAL BEEN INVOICED? ────────────────────────────────────────────────────
// Carolyn, 2026-09-02, on a record with no invoice: "can we make this like hide this if it
// doesn't have an invoice?" This is that test, and BOTH halves are load-bearing — I checked
// the live data rather than reasoning about it.
//
// ss_invoice_sent_at alone is WRONG. Its only writer in the repo is send_invoice, so it
// marks a StructureStudio-issued invoice and nothing else; sync-design-status, which is what
// flips a GHL-quoted design to 'invoiced', writes {status, updated_at} and never touches it,
// and migration 136's backfill was narrowed to issued_by='structurestudio'. A design
// invoiced in GoHighLevel therefore has it NULL forever — on live that is FOURTEEN of
// junior-barns' buildings, every one physically on the build board. Since invoice_in_ghl
// defaults true, this half alone would hide the rails on most real tenants' sold work.
//
// status alone is also wrong, in the other direction. Since 136, send_invoice deliberately
// stopped flipping status, so an SS invoice that is OUT BUT UNSIGNED reads 'accepted' with
// only the column set. One such row on structure-studio today. Carolyn said "if it doesn't
// HAVE an invoice" — one sitting in the customer's inbox is one they have.
//
// Not invoice_sends: RLS with zero policies, so the browser cannot read it, and it covers
// only SS-issued invoices anyway — the same blind spot plus a round trip.
//
// ⚠️ normStatus is `STATUS_LABELS[s] ? s : "sent"`, NOT a lowercaser. 'inventory',
// undefined and 'INVOICED' all fall through to "sent" and read false. That is correct here.
const crmHasInvoice = (d) => !!d && (
  !!d.ss_invoice_sent_at ||
  normStatus(d.status) === "invoiced" ||
  normStatus(d.status) === "delivered"
);

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
// The chevron's notch, in ONE place. CrmChevronRail draws the real rail and
// CrmRecordSkeleton draws its grey stand-in, and a skeleton whose geometry has drifted from
// the thing it stands in for is worse than no skeleton: the page visibly re-cuts itself the
// moment the data lands, which is the jump every skeleton here exists to prevent.
const CRM_CHEVRON_CLIP = "polygon(0 0, calc(100% - 8px) 0, 100% 50%, calc(100% - 8px) 100%, 0 100%, 8px 50%)";

// ⚠️ idx === null is NOT STARTED, which is not stage zero -- every chevron stays idle
// rather than filling the first one, because filling it would claim the building is in it.
// A building that has never been scheduled is not "in the first stage".
//
// `only` lights the current chevron and nothing before it. A pipeline's stages are moved by
// hand, back as well as forward ("Nurturing - Hot", then "Gone Cold Again"), so the stages to the
// left of a deal's are not stages it has been through. Build and delivery do run in order and
// keep the filled-in trail.
function CrmChevronRail({ stages, idx = null, tone, title = null, only = false }) {
  const t = tone || CRM_RAIL_TONES.sales;
  const past = (i) => !only && i < idx;
  return (
    <div style={{ display: "flex", gap: 2, flexWrap: "wrap", flex: "1 1 auto", minWidth: 0 }}>
      {stages.map((s, i) => (
        // ⚠️ THE NAME LEADS THE TOOLTIP, and that is not decoration. Build stage names are
        // tenant-authored and uncapped, so a long one can be narrowed by the flex basis until
        // the chevron's clipPath eats its ends; hover is then the only way to read it whole.
        // The dot version carried title={s.name} for exactly that reason and the first draft
        // of this rail dropped it, keeping only the status word.
        <div key={i}
          title={only
            ? (idx != null && i === idx ? `${s.name} — the stage it is in` : s.name)
            : `${s.name} — ${idx == null ? (title || "Not started") : i <= idx ? "Reached" : "Not yet"}`}
          style={{
            // ⚠️ NO minWidth HERE ON PURPOSE. `min-width: 0` would let a chevron shrink past
            // its longest word, and since clipPath crops rather than scrolls, the word would
            // lose its ends with nothing to reveal them. The default `min-width: auto` keeps a
            // min-content floor: the rail wraps to another line instead of cropping. The
            // original CrmStageBar never set it either, so this is parity, not a new rule.
            flex: "1 1 90px", padding: "5px 10px", fontSize: 11, fontWeight: 700, textAlign: "center",
            background: idx == null ? CRM_RAIL_IDLE.bg : past(i) ? t.past : i === idx ? t.on : CRM_RAIL_IDLE.bg,
            color: idx == null ? CRM_RAIL_IDLE.fg : i === idx ? "#FFF" : past(i) ? t.on : CRM_RAIL_IDLE.fg,
            clipPath: CRM_CHEVRON_CLIP,
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
//
// THE FIRST ROW'S LABEL IS THE DEAL'S PIPELINE NOW (Carolyn 2026-10-12: "Instead of this saying
// sales ... I want this up here to say shed deals"), and a pipeline name is the builder's own
// and can be long. A grid, so the label column is as wide as the widest label (capped, the rest
// on hover) and every rail still starts at the same left edge and ends at the same right one.
function CrmStageDots({ rows }) {
  const live = (rows || []).filter((r) => r && r.stages && r.stages.length);
  if (!live.length) return null;
  return (
    <div data-ss-stage-rows="" style={{ display: "grid", gridTemplateColumns: "minmax(58px, max-content) minmax(0, 1fr)", columnGap: 8, rowGap: 4, alignItems: "center", marginBottom: 12 }}>
      {live.map((r) => (
        <React.Fragment key={r.key}>
          <span data-ss-stage-label={r.key} title={r.label}
            style={{ maxWidth: 170, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11, color: "#94A3B8", fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.3 }}>{r.label}</span>
          <CrmChevronRail stages={r.stages} idx={r.idx} tone={CRM_RAIL_TONES[r.key]} only={!!r.only}
            title={r.idx == null ? (r.emptyLabel || "Not started") : null} />
        </React.Fragment>
      ))}
    </div>
  );
}

// The status-derived ladder above. Since 2026-10-12 it draws only when crm_record sent no
// `pipeline` block: an account without the CRM (the free design record), a reader who may not
// see contacts, or a server from before the pipeline bar. Everywhere else the bar is the deal's
// own pipeline (crmPipeBarRow below).
function CrmStageBar({ status }) {
  const at = CRM_STAGE_FOR_STATUS[normStatus(status)] || "new";
  const idx = Math.max(0, CRM_STAGES.findIndex((s) => s.kind === at));
  return (
    <div style={{ display: "flex", marginBottom: 12 }}>
      <CrmChevronRail stages={CRM_STAGES} idx={idx} tone={CRM_RAIL_TONES.sales} />
    </div>
  );
}

// ── THE DEAL'S PIPELINE ON THE RECORD (Carolyn, 2026-10-12) ─────────────────────────────────
// `pipe` is crm_record's `pipeline` block: { pipelines: [{ id, name, lostReasons, stages }],
// statuses: [{ id, name, color }], deals: [crm_deals rows] }, or undefined when the server did
// not send one. Pure functions, so crmRecordPipeline_test can run them as they ship.
//
// What she asked for, and where each piece lives:
//   * ONE "Deals" section. "I'm still confused about this deals and sales pipeline ... So this
//     also has to be merged." The rows are this person's designs, each joined to its pipeline
//     card by short code, plus any deal with no design (a lead added straight to a pipeline).
//     crmDealRows.
//   * The status ONCE, on the row's top line: "If you put the status ... up there, we don't need
//     the status down here at all." crmPipeStatus. Read only: "the statuses are system-driven,
//     100%".
//   * Inside the opened deal, by "Open in designer": the stage, from THAT pipeline's stages only
//     ("I don't like how big it is"), and moving it to another pipeline ("To move a pipeline, you
//     can put that right here"). A deal is in one pipeline ("these cards can only be in one
//     pipeline"), so a move is one crm_deal_move to the new pipeline's first open stage:
//     crmPipeFirstOpen and crmPipeMoveTargets.
//   * The top bar names the deal's pipeline and shows its own stages: "I want this up here to
//     say shed deals with the stage that it's in." crmPipeBarRow.
const crmPipeDealFor = (pipe, code) =>
  (pipe && code ? (pipe.deals || []).find((d) => d.short_code === code) : null) || null;
const crmPipeOf = (pipe, deal) =>
  (pipe && deal ? (pipe.pipelines || []).find((p) => p.id === deal.pipeline_id) : null) || null;
const crmPipeStatus = (pipe, deal) =>
  (pipe && deal && deal.status_id ? (pipe.statuses || []).find((t) => t.id === deal.status_id) : null) || null;
// The stage a deal lands in when it moves to `pipeline`: the first OPEN one, the way a new card
// starts. A pipeline with no open stage falls back to its first won one; never a lost stage, which
// needs a reason the reader has not given.
function crmPipeFirstOpen(pipeline) {
  const st = (pipeline && pipeline.stages) || [];
  return st.find((s) => s.kind === "open") || st.find((s) => s.kind !== "lost") || null;
}
// The pipelines a deal can move to: every live one except its own, and only ones it could land in.
const crmPipeMoveTargets = (pipe, deal) =>
  ((pipe && pipe.pipelines) || []).filter((p) => (!deal || p.id !== deal.pipeline_id) && !!crmPipeFirstOpen(p));
// The rows of the one Deals section, newest first. A design keeps its row whether or not it has
// a pipeline card (inventory and very old designs may not); a card with no design here is a row
// of its own, keyed by the card's id. `key` is also what picking the row stores.
function crmDealRows(designs, pipe) {
  const ds = designs || [];
  const codes = new Set(ds.map((d) => d.short_code));
  const rows = ds.map((d) => ({ key: d.short_code, design: d, deal: crmPipeDealFor(pipe, d.short_code), at: d.created_at }));
  for (const deal of ((pipe && pipe.deals) || [])) {
    if (deal.short_code && codes.has(deal.short_code)) continue;
    rows.push({ key: deal.id, design: null, deal, at: deal.created_at });
  }
  return rows.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
}
// The top bar's first row for the deal on screen: the pipeline's name in place of "Sales", its
// own stages, the one the deal is in lit. Null when there is no deal or its pipeline is gone.
function crmPipeBarRow(pipe, deal) {
  const p = crmPipeOf(pipe, deal);
  if (!p || !(p.stages || []).length) return null;
  const i = p.stages.findIndex((s) => s.id === deal.stage_id);
  return { key: "sales", label: p.name, stages: p.stages.map((s) => ({ name: s.name })), idx: i < 0 ? null : i,
    only: true, emptyLabel: "Stage removed" };
}
// A deal's row after a move, painted before the server answers. The pipeline is the stage's.
function crmPipeMoved(pipe, dealId, stage, lostReason) {
  if (!pipe || !stage) return pipe;
  const owner = (pipe.pipelines || []).find((p) => (p.stages || []).some((s) => s.id === stage.id));
  return {
    ...pipe,
    deals: (pipe.deals || []).map((d) => (d.id !== dealId ? d : {
      ...d, stage_id: stage.id, pipeline_id: owner ? owner.id : d.pipeline_id,
      stage_entered_at: new Date().toISOString(), lost_reason: stage.kind === "lost" ? (lostReason || null) : null,
    })),
  };
}
// A read-only status pill. NOT SsStatusPill, which is the Pipeline board's control: on the record
// a status is shown, never set.
function CrmDealStatusPill({ status }) {
  if (!status) return null;
  const color = /^#[0-9A-Fa-f]{6}$/.test(status.color || "") ? status.color : "#64748B";
  return (
    <span data-ss-deal-status="" title="Set by the system as the deal moves along"
      style={{ flexShrink: 0, alignSelf: "center", background: color + "1F", color, border: "1px solid " + color + "55",
        borderRadius: 999, padding: "1px 9px", fontSize: 10.5, fontWeight: 800, lineHeight: "16px",
        maxWidth: 130, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{status.name}</span>
  );
}

// ─── Sales tax on a StructureStudio quote (Avalara stage, 2026-09-17) ───────────────────────
// Which link of the rate chain priced a quote, in words: a lookup somebody verified, the quote's
// sales location, or the company rate. `basis` arrived with the location rates; a stamp from
// before it has only `source`, and a pre-basis "fallback" was always the company rate.
// "Verified for …", never "exact": the lookup is Avalara's rate for the delivery address, and
// it knows nothing about origin sourcing across a state line.
function ssTaxBasisText(tax) {
  if (!tax || typeof tax !== "object") return null;
  const basis = tax.basis || (tax.source === "avalara" ? "avalara" : tax.source === "fallback" ? "company" : null);
  if (basis === "avalara") {
    const where = String(tax.jurisdiction || "").trim();
    const when = tax.verifiedAt || tax.resolvedAt;
    return `Verified for ${where || "the delivery address"}${when ? ` on ${fmtDate(when)}` : ""}`;
  }
  if (basis === "location") return `${String(tax.locationName || "").trim() || "Sales location"} rate`;
  if (basis === "company") return "Company rate";
  return null;
}
// Cents as dollars, for the tax card. Its own copy on purpose: `money` and `ssUsd` live in
// 04-orders.jsx, and this file's rule is that part 02 does not lean on a later part's consts
// (see CRM_LOAD_LABEL above).
function ssTaxMoney(cents) {
  if (cents == null || !Number.isFinite(Number(cents))) return "—";
  return "$" + (Number(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
// A stored fraction as a percentage for display: 0.0725 -> "7.25%". Rounded to four places so
// 0.07125 never prints as 7.124999999%.
function ssTaxPct(rate) {
  const n = Number(rate);
  if (rate == null || !Number.isFinite(n)) return "";
  return `${Math.round(n * 1000000) / 10000}%`;
}

// send_invoice's tax check, as a sentence — or null when there is nothing to say. INFORMATIONAL
// ONLY, and the copy says so: the check never changes an invoice (the customer agreed to a total)
// and never blocks one, so it must not read as a failure of the send it rode along with.
// "matched" and "skipped" say nothing; an older function sends no taxCheck at all.
const SS_TAX_FAILURE_TEXT = {
  credentials_rejected: "the tax service didn't accept our sign-in",
  subscription: "address lookups aren't part of the tax service plan",
  rate_limited: "the tax service is busy",
  timeout: "the tax service didn't answer in time",
  network: "the tax service couldn't be reached",
  malformed: "the tax service's answer couldn't be read",
  bad_address: "the delivery address wasn't recognised",
  no_address: "there is no delivery address on file",
  daily_cap: "today's lookup limit has been reached",
  not_configured: "address lookups aren't set up",
  ledger_unavailable: "the lookup couldn't be recorded, so none was made",
  // Our own per-minute cap. The claim only applies it to a Verify press, so an invoice check
  // should never carry it; worded anyway, because the server's failure type includes it.
  minute_cap: "too many lookups were made in the last minute",
};
// Informational, so neither the red of a failure nor the amber of a warning: the Locations tab's
// blue "what this does" banner.
const SS_TAX_NOTE_STYLE = { background: "#EFF6FF", border: "1px solid #BFDBFE", color: "#1E3A8A", borderRadius: 8, padding: "9px 13px", fontSize: 12.5, fontWeight: 600, lineHeight: 1.5, marginBottom: 12 };
function ssTaxCheckNote(taxCheck) {
  if (!taxCheck || typeof taxCheck !== "object") return null;
  if (taxCheck.status === "differs") {
    const where = String(taxCheck.jurisdiction || "").trim();
    const verified = taxCheck.verifiedRatePct != null ? `${taxCheck.verifiedRatePct}%` : "a different rate";
    const agreed = taxCheck.agreedRatePct != null ? ` of ${taxCheck.agreedRatePct}%` : "";
    return `Tax check: Avalara's rate for the delivery address${where ? ` (${where})` : ""} is ${verified}. The invoice keeps the rate the customer agreed to${agreed} — nothing on it was changed.`;
  }
  if (taxCheck.status === "failed") {
    const why = SS_TAX_FAILURE_TEXT[taxCheck.failure];
    return `Tax check: the rate for the delivery address couldn't be verified${why ? ` — ${why}` : ""}. The invoice keeps the rate the customer agreed to; nothing on it was changed.`;
  }
  return null;
}

// A portal-settings answer reduced to what the tax controls act on: the data on success, or the
// refusal's code, its sentence and the body's extra fields (quoteNumber, totalCents, …). The
// invoke wrapper keeps the server's sentence but not those fields, and a 403's message has
// "ask an owner or admin" appended — wrong advice for "lookups aren't switched on" — so the body
// is read again here, the way fnError does.
async function ssTaxOutcome(res) {
  const data = res && res.data;
  const error = res && res.error;
  if (!error && data && !data.error) return { data };
  let body = data && data.error ? data : null;
  if (!body && error && error.context && typeof error.context.json === "function") {
    try { body = await (typeof error.context.clone === "function" ? error.context.clone() : error.context).json(); }
    catch (_e) { body = null; }
  }
  return {
    reason: (body && body.reason) || (error && error.ssReason) || null,
    body: body || {},
    message: (body && body.error) || (error && error.message) || "That didn't work — try again.",
  };
}

// THE SALES TAX CARD on a deal. The product owner's ask: "if they don't know, they just click a
// button in the estimate and it creates the taxes for them." It shows the tax line the quote
// carries and which rate priced it, lets whoever may edit the design move it to another sales
// location, and offers the one deliberate, billed lookup — only when the account's lookups are
// switched on and the reader may edit CRM Connection settings, the area that owns the company
// rate.
//
// ⚠️ IT READS THE DESIGN ITSELF, which the record page above it deliberately never does. The
// estimate snapshot and `sales_location_id` are not in crm_record's projection, and the API
// publishes the stored location through the RLS'd `designs` select (migration 244). That read
// returns NOTHING in operator view-as — designs RLS is current_client_id() — so view-as reads
// through `orders_designs` instead, where the server resolves the tenant, and the stored location
// is then only known when the tax stamp names it.
//
// ⚠️ NOTHING HERE PRICES ANYTHING. Every figure on screen after a change is the one the server
// returned, and the lookup's cost is the server's to say: the Verify confirm states it only as
// tax_settings' lookupPriceCents gives it (2026-10-05), and names no figure while that is null —
// the meter off, unpriced, hidden or the account exempt. Each press sends the figure it stated,
// and a press that would cost another one comes back price_changed with the server's figure,
// which is asked about before anything is charged. A browser that thought it knew the price
// would be a second opinion about money.
function QuoteSalesTaxCard({ clientId = null, shortCode, viewingLabel = null, totalCentsHint = null, canEditDesign = false, canVerify = false, canReadTaxSettings = false, onChanged = null }) {
  const [row, setRow] = useState(null);         // the design | { err } | null while loading
  const [locKnown, setLocKnown] = useState(true); // is row.sales_location_id the stored value?
  const [locs, setLocs] = useState(null);       // active sales locations, or null when unreadable
  const [taxCfg, setTaxCfg] = useState(null);   // tax_settings answer, or null (not asked / unavailable)
  const [busy, setBusy] = useState(null);       // "location" | "verify" | null
  const [msg, setMsg] = useState(null);         // { ok } | { err }
  // Latest load wins: a slower first answer must not paint over a later one.
  const loadSeq = useRef(0);
  // Read at load time rather than a dependency: the record reloads after every change made
  // here, and a new hint is no reason to read the design a second time.
  const totalHint = useRef(totalCentsHint);
  totalHint.current = totalCentsHint;

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const cols = "short_code, status, accepted_at, total_cents, estimate_lines, ss_quote_number, ss_quote_sent_at, ghl_estimate_number, contact";
    const readDesign = async () => {
      if (!viewingLabel) {
        const direct = (withLoc) => {
          let q = sb.from("designs").select(withLoc ? `${cols}, sales_location_id` : cols).eq("short_code", shortCode);
          if (clientId) q = q.eq("client_id", clientId);
          return q.maybeSingle();
        };
        let r = await direct(true);
        // Before migration 244 the column does not exist and PostgREST refuses the whole select.
        // The tax line still has something true to say without it.
        if (r.error && /sales_location_id/.test(String(r.error.message || ""))) r = await direct(false);
        if (r.error) return { err: r.error.message || "Couldn't load this estimate's tax." };
        if (!r.data) return { err: "Not shown for your role." };
        return { row: r.data, known: Object.prototype.hasOwnProperty.call(r.data, "sales_location_id") };
      }
      const { data, error } = await sb.functions.invoke("portal-settings", { body: { action: "orders_designs", shortCodes: [shortCode], detail: true } });
      if (error || !data || data.error) return { err: (data && data.error) || (error && error.message) || "Couldn't load this estimate's tax." };
      const d = (data.designs || [])[0];
      if (!d) return { err: "Not shown for your role." };
      // No total_cents in that projection; crm_record's own read of the same row carries it.
      return { row: { ...d, total_cents: d.total_cents != null ? d.total_cents : totalHint.current }, known: Object.prototype.hasOwnProperty.call(d, "sales_location_id") };
    };
    const [design, locRes, cfgRes] = await Promise.all([
      readDesign(),
      sb.functions.invoke("portal-settings", { body: { action: "list_locations" } }),
      canReadTaxSettings ? sb.functions.invoke("portal-settings", { body: { action: "tax_settings" } }) : Promise.resolve(null),
    ]);
    if (seq !== loadSeq.current) return;
    if (design.err) { setRow({ err: design.err }); return; }
    setRow(design.row);
    setLocKnown(design.known);
    const cfg = cfgRes && !cfgRes.error && cfgRes.data && !cfgRes.data.error ? cfgRes.data : null;
    setTaxCfg(cfg);
    // list_locations is readable on inventory or branding; tax_settings on settings_crm. Either
    // list will do for the picker — and a reader who can see neither gets the name as text.
    if (locRes && !locRes.error && locRes.data && Array.isArray(locRes.data.locations)) {
      setLocs(locRes.data.locations.map((l) => ({ id: l.id, name: l.name, taxRatePct: l.taxRatePct != null ? l.taxRatePct : null })));
    } else if (cfg && Array.isArray(cfg.locations)) {
      setLocs(cfg.locations.filter((l) => l.active !== false).map((l) => ({ id: l.id, name: l.name, taxRatePct: l.taxRatePct != null ? l.taxRatePct : null })));
    } else setLocs(null);
  }, [clientId, shortCode, viewingLabel, canReadTaxSettings]);
  useEffect(() => { load(); }, [load]);

  // The server's answer IS the new state — the tax it stamped and the total it wrote.
  const applyTax = (data, extra = {}) => {
    setRow((r) => (!r || r.err) ? r : {
      ...r, ...extra,
      estimate_lines: data.tax ? { ...(r.estimate_lines || {}), tax: data.tax } : r.estimate_lines,
      total_cents: data.totalCents != null ? data.totalCents : r.total_cents,
    });
  };

  if (row === null) return <div style={{ fontSize: 12, color: "#94A3B8" }}>Loading…</div>;
  if (row.err) return <div style={{ fontSize: 12, color: "#94A3B8" }}>{row.err}</div>;

  const snap = row.estimate_lines || null;
  const tax = snap && snap.tax ? snap.tax : null;
  const basisText = ssTaxBasisText(tax);
  const quoteNo = row.ss_quote_number || "this estimate";
  // Signed means the tax is the customer's agreement now. Both server actions refuse
  // (accepted / ordered); not offering them is the courtesy half. The status arm is the server's
  // own agreed test (sync-design-status can re-project a status with accepted_at still null). An
  // acceptance row or an order the designs read cannot see is caught by the refusal instead, which
  // reloads the card.
  const locked = !!row.accepted_at || ["accepted", "invoiced", "delivered"].includes(String(row.status || ""));
  const curLocId = locKnown
    ? (row.sales_location_id || null)
    : (tax && tax.basis === "location" && tax.locationId ? tax.locationId : null);
  const locUnknown = !locKnown && !curLocId;
  const curLoc = curLocId && locs ? locs.find((l) => l.id === curLocId) : null;
  // A stored id missing from the ACTIVE list is a location someone has since retired — but only
  // when there is a list to be missing from. Without one this reader simply cannot see the lots.
  const curLocName = curLoc ? curLoc.name
    : (curLocId && tax && tax.locationId === curLocId && tax.locationName) ? tax.locationName
    : curLocId ? (locs ? "A location that is no longer active" : "A sales location") : null;
  const c = row.contact || {};
  const deliveryAddr = [c.street, [c.city, c.state].filter(Boolean).join(", ") + (c.zip ? ` ${c.zip}` : "")]
    .filter((s) => s && String(s).trim()).join(", ");
  // configured === false (no platform credentials) refuses every lookup, so a billed button there
  // could only fail.
  const showVerify = !locked && !!tax && canVerify && !!taxCfg && taxCfg.lookupEnabled === true && taxCfg.configured !== false;
  // The row this card shows is out of date: the customer agreed, an order exists, or something
  // else wrote the quote first. The server's sentence says which; the card re-reads the design.
  const staleRefusal = (reason) => reason === "accepted" || reason === "ordered" || reason === "changed";
  // After a re-price the server emails the quote again only when the customer already holds it
  // and its total moved, so no resendReason means nothing needed sending. A reason is the
  // server's own whole sentence: the customer hasn't been sent the new total, and what to do
  // about it. It is shown as written — the server knows whether it was the PDF, a missing email
  // address or a failed send, and a customer who got the quote by text or on paper may only
  // hear the new total from the rep. `resent` means it went out by email, the only re-send there is.
  const notResentText = (d) => { const why = String(d.resendReason || "").trim(); return why ? ` ${why}` : ""; };
  const resentText = (d) => d.resent ? " The updated estimate was emailed to the customer." : notResentText(d);

  const changeLocation = async (value) => {
    if (value === "__current") return;
    const locationId = value || null;
    if (!locUnknown && locationId === curLocId) return;
    setBusy("location"); setMsg(null);
    let confirmResend = false;
    // At most two calls: the plain one, and — when the customer already has the quote (emailed,
    // texted or printed: the server decides) and the total would move — the one the builder
    // confirmed.
    for (let attempt = 0; attempt < 2; attempt++) {
      const out = await ssTaxOutcome(await sb.functions.invoke("portal-settings", {
        body: { action: "set_design_sales_location", shortCode, locationId, ...(confirmResend ? { confirmResend: true } : {}) },
      }));
      if (out.data) {
        const d = out.data;
        applyTax(d, { sales_location_id: d.salesLocationId !== undefined ? d.salesLocationId : locationId });
        setLocKnown(true);
        const name = locationId ? ((locs || []).find((l) => l.id === locationId) || {}).name : null;
        setMsg({ ok: `${name ? `Sales location set to ${name}` : "Sales location cleared"}${d.totalCents != null ? ` — estimate total ${ssTaxMoney(d.totalCents)}` : ""}.${resentText(d)}` });
        if (onChanged) onChanged();
        break;
      }
      if (out.reason === "quote_sent" && !confirmResend) {
        const b = out.body;
        // "Already has", never "was emailed": the server asks for a quote handed over by text or
        // on paper too. And no promise of a re-send — whether one goes out is only known after
        // the change, and the success message reports it.
        const moves = b.totalCents != null && b.newTotalCents != null
          ? `its total will change from ${ssTaxMoney(b.totalCents)} to ${ssTaxMoney(b.newTotalCents)}`
          : "its total will change";
        const qn = b.quoteNumber || row.ss_quote_number;
        if (!window.confirm(`The customer already has ${qn ? `estimate ${qn}` : "this estimate"}. If you change the sales location, ${moves}.\n\nChange it anyway?`)) break;
        confirmResend = true;
        continue;
      }
      setMsg({ err: out.message });
      if (staleRefusal(out.reason)) load();
      break;
    }
    setBusy(null);
  };

  const verify = async () => {
    // What one press costs the wallet, as the server priced it. A wallet that can't cover it is
    // refused by the server before any lookup, and that sentence is shown like every refusal.
    // Priced, the confirm names one charge, the wallet's: "Avalara bills" beside a wallet figure
    // reads as two bills.
    let quoted = taxCfg && Number(taxCfg.lookupPriceCents) > 0 ? Number(taxCfg.lookupPriceCents) : null;
    const cost = quoted != null
      ? `Each verification is a paid lookup: this one costs ${ssTaxMoney(quoted)} from your wallet.`
      : "Avalara bills each verification.";
    if (!window.confirm(`Verify the sales tax on ${quoteNo} for the delivery address${deliveryAddr ? ` (${deliveryAddr})` : ""}?\n\n${cost} If the verified rate is different, the estimate's tax and total change to it.`)) return;
    setBusy("verify"); setMsg(null);
    const flags = {};
    // The server asks for each confirmation in turn — view-as first, then a quote the customer
    // already has, then (price_changed) the price when the one this dialog stated is not what the
    // press will cost — so this is at most four calls, and every refusal after a confirmation is
    // a real one whose sentence is shown. The per-minute limit (rate_limited) and the daily cap
    // are among those: nothing was looked up, and pressing again at once would only repeat them.
    // Every call carries the price the builder agreed to (null: none was named), and the server
    // never charges another one.
    for (let attempt = 0; attempt < 4; attempt++) {
      const out = await ssTaxOutcome(await sb.functions.invoke("portal-settings", {
        body: { action: "verify_tax", shortCode, quotedPriceCents: quoted, ...flags },
      }));
      if (out.data) {
        const d = out.data;
        applyTax(d);
        const t = d.tax || {};
        const moved = d.previousTotalCents != null && d.totalCents != null && d.previousTotalCents !== d.totalCents;
        setMsg({ ok: `Verified: ${ssTaxPct(t.rate) || "the rate"} for ${String(t.jurisdiction || "").trim() || "the delivery address"}.`
          + (moved ? ` The estimate total changed from ${ssTaxMoney(d.previousTotalCents)} to ${ssTaxMoney(d.totalCents)}.` : " The estimate total didn't change.")
          + resentText(d) });
        if (onChanged) onChanged();
        break;
      }
      if (out.reason === "confirm_operator" && !flags.confirmVerify) {
        if (!window.confirm(`You are doing this AS ${viewingLabel || "this builder"}.\n\nThis runs a billed Avalara lookup on their customer's estimate. Verify anyway?`)) break;
        flags.confirmVerify = true;
        continue;
      }
      if (out.reason === "quote_sent" && !flags.confirmResend) {
        const b = out.body;
        // Asked before the lookup, so the new total isn't known yet: the total will change if the
        // verified rate differs. Same rules as the location confirm — "already has", no promised
        // re-send.
        const qn = b.quoteNumber || row.ss_quote_number;
        if (!window.confirm(`The customer already has ${qn ? `estimate ${qn}` : "this estimate"}${b.totalCents != null ? ` at ${ssTaxMoney(b.totalCents)}` : ""}. If the verified tax rate is different, its total will change.\n\nVerify anyway?`)) break;
        flags.confirmResend = true;
        continue;
      }
      // The press would cost something this dialog didn't say (the card was opened before the
      // price was set, or its price couldn't be read). Ask once with the server's figure, and
      // remember it for the next press.
      if (out.reason === "price_changed" && Number(out.body.priceCents) > 0 && quoted !== Number(out.body.priceCents)) {
        const price = Number(out.body.priceCents);
        if (!window.confirm(`Verifying the sales tax on ${quoteNo} costs ${ssTaxMoney(price)} from your wallet.\n\nVerify anyway?`)) break;
        quoted = price;
        setTaxCfg((c) => (c ? { ...c, lookupPriceCents: price } : c));
        continue;
      }
      // Every other refusal — switched off, no address, today's limit, a failed lookup — is a
      // sentence the server wrote, and on every one of them the quote is unchanged.
      setMsg({ err: out.message });
      if (staleRefusal(out.reason)) load();
      break;
    }
    setBusy(null);
  };

  const selStyle = { ...S.input, padding: "5px 8px", fontSize: 12.5 };
  return (
    <div data-quote-sales-tax={shortCode}>
      {tax ? (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 13, color: "#1E293B" }}>
            <span>{String(tax.label || "").trim() || "Sales tax"}{ssTaxPct(tax.rate) ? ` (${ssTaxPct(tax.rate)})` : ""}</span>
            <strong style={{ fontVariantNumeric: "tabular-nums" }}>{ssTaxMoney(Math.round(Number(tax.amount) * 100))}</strong>
          </div>
          {basisText && <div style={{ fontSize: 11.5, color: "#64748B", marginTop: 2 }}>{basisText}</div>}
          {/* A staff resubmit to a different state or ZIP gives up a verified rate (the carry-over
              rule). The stamp says so in `reason`; the reader should know a verify would help. */}
          {tax.basis !== "avalara" && /address changed/i.test(String(tax.reason || "")) && (
            <div style={{ fontSize: 11.5, color: "#B45309", marginTop: 3 }}>The delivery address changed after the rate was verified, so this estimate is back on the default rate.</div>
          )}
        </>
      ) : (
        <div style={{ fontSize: 12.5, color: "#64748B" }}>No sales tax on this estimate.</div>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 13, color: "#475569", marginTop: 6, paddingTop: 6, borderTop: "1px solid #F1F5F9" }}>
        <span>Estimate total</span><strong style={{ color: "#1E293B", fontVariantNumeric: "tabular-nums" }}>{ssTaxMoney(row.total_cents)}</strong>
      </div>

      <div style={{ marginTop: 10 }}>
        <span style={S.lbl}>Sales location</span>
        {canEditDesign && !locked && locs ? (
          <select value={locUnknown ? "__current" : (curLocId || "")} disabled={!!busy}
            onChange={(e) => changeLocation(e.target.value)} style={selStyle}>
            {locUnknown && <option value="__current">Current location (not shown in this view)</option>}
            <option value="">None — company rate</option>
            {curLocId && !curLoc && <option value={curLocId}>{curLocName}</option>}
            {locs.map((l) => (
              <option key={l.id} value={l.id}>{l.name}{l.taxRatePct != null ? ` · ${Math.round(Number(l.taxRatePct) * 10000) / 10000}%` : ""}</option>
            ))}
          </select>
        ) : (
          <div style={{ fontSize: 13, color: "#1E293B" }}>{locUnknown ? "—" : (curLocName || "None")}</div>
        )}
        {busy === "location" && <div style={{ fontSize: 11.5, color: "#64748B", marginTop: 4 }}>Updating the estimate…</div>}
      </div>

      {locked && (
        <div style={{ fontSize: 11.5, color: "#94A3B8", marginTop: 8, lineHeight: 1.5 }}>
          Accepted — this estimate keeps the tax the customer agreed to.
        </div>
      )}

      {showVerify && (
        <div style={{ marginTop: 10 }}>
          <div style={{ background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 8, padding: "10px 12px", fontSize: 12.5, color: "#92400E", lineHeight: 1.5, marginBottom: 8 }}>
            <strong>Avalara bills each verification.</strong> It checks the rate for the customer's
            delivery address{deliveryAddr ? ` (${deliveryAddr})` : ""} — make sure the address is right first.
          </div>
          <button type="button" disabled={!!busy} onClick={verify}
            style={{ ...S.btn("#FFF", "#92400E"), border: "1px solid #FDE68A", padding: "7px 12px", fontSize: 12.5, opacity: busy ? 0.6 : 1 }}>
            {busy === "verify" ? "Verifying…" : "Verify tax for the delivery address"}
          </button>
        </div>
      )}

      {msg && <div style={{ ...(msg.err ? S.err : S.okMsg), marginTop: 9, marginBottom: 0, padding: "8px 11px", fontSize: 12.5 }}>{msg.err || msg.ok}</div>}
    </div>
  );
}

// ─── The record page's skeleton ───
// Ahsan, 2026-09-20, opening a contact and a deal: "it takes too much time to open this …
// add the skeleton card in here also." Until now this page was the one screen still sitting
// on the word "Loading…" over a single empty card — the exact thing Carolyn complained about
// on 2026-08-26 ("the page opens and there's nothing there") and that SkelBar/SkelRows were
// built to answer everywhere else.
//
// ⚠️ IT DRAWS ONLY WHAT BOTH RECORDS ARE CERTAIN TO HAVE. Six CRM_SECTIONS carry
// `when: () => true` (Summary, Details, Build schedule, Delivery schedule, Repairs,
// Overview) and the tabbed card on the right is unconditional, so those two columns are
// real. Deals/Orders (contact only), Person (design only) and Sales tax (needs an SS quote
// number) are NOT claimed — a skeleton that overstates the answer is the thing skeletons
// exist to avoid, and this page's shape varies more by kind than any other.
//
// ⚠️ THE CHEVRON RAIL IS DRAWN FOR A DESIGN ONLY. A deal record almost always has one (its
// pipeline card's stages, or CrmStageBar's ladder where there is no pipeline block; only a
// design with no card at all has neither). On a CONTACT the rails appear only once a deal has been
// picked, and nothing is picked on first paint (Carolyn 2026-09-02: "you have to have one of
// these selected for anything to show up here") — so drawing one would promise a ladder that
// never arrives. Blocks, not an idle CrmChevronRail: an idle rail carries the real stage
// names and the words "Not started", which is a claim about this deal, not a placeholder.
//
// BACK IS THE REAL BUTTON. It is the one control that works before any data lands, and
// somebody who clicked the wrong row should not have to wait out the load to leave. It is
// also why this takes onBack rather than rendering a grey block in its place.
//
// No hooks here, deliberately — CrmRecord's own hook block carries three warnings about
// what a hook near an early return does to this page, and a stateless skeleton cannot be
// dragged into that.
function CrmRecordSkeleton({ kind, onBack }) {
  const card = { ...S.card, marginBottom: 10 };
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
        <button style={{ ...S.btn("#FFF", ACCENT), border: "1px solid #E2E8F0" }} onClick={onBack}>Back</button>
        <SkelBar w={210} h={17} />
      </div>
      {kind === "design" && (
        <div style={{ display: "flex", gap: 2, flexWrap: "wrap", marginBottom: 12 }}>
          {CRM_STAGES.map((s, i) => (
            <SkelBar key={i} h={23} style={{ flex: "1 1 90px", borderRadius: 0, clipPath: CRM_CHEVRON_CLIP }} />
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
        {/* The section cards, same flex basis and same caps as the real column, so the page
            does not re-flow into two columns when the data lands. Faded down the stack for
            the reason SkelRows fades its rows: the eye reads it as "more below" rather than
            as five equal pending things it has to keep track of. */}
        <div style={{ flex: "1 1 260px", minWidth: 240, maxWidth: 360 }}>
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} style={{ ...card, opacity: 1 - i * 0.13 }}>
              <SkelBar w={74} h={8} style={{ marginBottom: 11 }} />
              <SkelBar w="88%" style={{ marginBottom: 7 }} />
              <SkelBar w="64%" />
            </div>
          ))}
        </div>
        <div style={{ flex: "3 1 420px", minWidth: 320 }}>
          <div style={S.card}>
            {/* The action bar. Six blocks because every record has at least that many tabs
                after CRM_TABS' `when` filters run, and the widths vary the way real labels
                do — a row of identical blocks reads as a loading bar, not as tabs. */}
            <div style={{ display: "flex", gap: 3, flexWrap: "wrap", borderBottom: "1px solid #E2E8F0", paddingBottom: 7, marginBottom: 9 }}>
              {[38, 56, 44, 34, 62, 48].map((w, i) => <SkelBar key={i} w={w} h={20} style={{ borderRadius: 6 }} />)}
            </div>
            <SkelBar w={54} h={9} style={{ marginBottom: 9 }} />
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 9 }}>
              {[58, 46, 52, 40].map((w, i) => <SkelBar key={i} w={w} h={17} style={{ borderRadius: 999 }} />)}
            </div>
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} style={{ display: "flex", gap: 9, padding: "7px 0", borderTop: "1px solid #F1F5F9", opacity: 1 - i * 0.13 }}>
                <SkelBar w={8} h={8} style={{ borderRadius: 99, marginTop: 5, flexShrink: 0 }} />
                <div style={{ flex: 1 }}>
                  <SkelBar w="46%" h={9} style={{ marginBottom: 6 }} />
                  <SkelBar w="78%" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// MY SYNERGY PHONE: one voicemail in the contact timeline. Nothing is fetched until the person presses
// Play: the Worker marks a voicemail heard the first time it streams, so opening the record must
// not fetch it. Then the audio is fetched with the sign-in in the Authorization header
// (ssPhoneFetchVoicemail) and played from a blob: URL — never an <audio src> carrying the token,
// which the Worker's request logs would keep (review SSB-7). The session is read at the press, so
// a page left open past a token refresh still plays.
function SsVoicemailPlayer({ voicemailId }) {
  const [src, setSrc] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  // The blob lives in this tab's memory until it is let go; let it go when it is replaced or the
  // line leaves the screen.
  useEffect(() => () => { if (src) { try { URL.revokeObjectURL(src); } catch (_e) { /* already gone */ } } }, [src]);
  const play = async () => {
    setBusy(true); setErr(null);
    try {
      const { data } = await sb.auth.getSession();
      const token = data && data.session ? data.session.access_token : null;
      setSrc(await ssPhoneFetchVoicemail(voicemailId, token));
    } catch (e) { setErr(e && e.message ? e.message : "The voicemail couldn't be loaded. Try again."); }
    finally { setBusy(false); }
  };
  if (src) {
    return (
      <audio controls autoPlay src={src} data-ss-voicemail={voicemailId}
        style={{ display: "block", width: "100%", maxWidth: 340, height: 34, marginTop: 5 }} />
    );
  }
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 5, flexWrap: "wrap" }}>
      <button type="button" disabled={busy} onClick={play} data-ss-voicemail-play={voicemailId}
        style={{ background: "#F1F5F9", border: "1px solid #E2E8F0", borderRadius: 6, padding: "4px 10px", fontSize: 12, fontWeight: 700, color: "#334155", cursor: busy ? "default" : "pointer", fontFamily: "inherit" }}>
        {busy ? "Loading…" : "▶ Play message"}
      </button>
      {err && <span style={{ fontSize: 12, color: "#B91C1C" }}>{err}</span>}
    </div>
  );
}

// MY SYNERGY PHONE, CALL RECORDING (migration 263): a recorded call's audio, cloned from
// SsVoicemailPlayer above and for the same reasons. Nothing is fetched until Play is pressed;
// then the audio comes from the Worker (GET /recordings/:id/audio) with the sign-in in the
// Authorization header (ssPhoneFetchRecording) and plays from a blob: URL. The Worker's own
// sentence is shown when it says no ("The recording isn't ready yet. Try again in a minute.").
function SsRecordingPlayer({ recordingId, durationS }) {
  const [src, setSrc] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => () => { if (src) { try { URL.revokeObjectURL(src); } catch (_e) { /* already gone */ } } }, [src]);
  const play = async () => {
    setBusy(true); setErr(null);
    try {
      const { data } = await sb.auth.getSession();
      const token = data && data.session ? data.session.access_token : null;
      setSrc(await ssPhoneFetchRecording(recordingId, token));
    } catch (e) { setErr(e && e.message ? e.message : "The recording couldn't be loaded. Try again."); }
    finally { setBusy(false); }
  };
  if (src) {
    return (
      <audio controls autoPlay src={src} data-ss-recording={recordingId}
        style={{ display: "block", width: "100%", maxWidth: 340, height: 34, marginTop: 5 }} />
    );
  }
  const len = Number(durationS) > 0 ? ` · ${Math.max(1, Math.round(Number(durationS) / 60))} min` : "";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 5, flexWrap: "wrap" }}>
      <button type="button" disabled={busy} onClick={play} data-ss-recording-play={recordingId}
        style={{ background: "#F1F5F9", border: "1px solid #E2E8F0", borderRadius: 6, padding: "4px 10px", fontSize: 12, fontWeight: 700, color: "#334155", cursor: busy ? "default" : "pointer", fontFamily: "inherit" }}>
        {busy ? "Loading…" : `▶ Play recording${len}`}
      </button>
      {err && <span style={{ fontSize: 12, color: "#B91C1C" }}>{err}</span>}
    </div>
  );
}

// A recorded call on the contact timeline: its summary (in the feed already, crmFeed's
// recordingMeta, and kept after the audio is deleted), Play recording, and "Show transcript".
// The transcript is NOT in the feed: it is read from the Worker on the press
// (ssPhoneFetchTranscript), which applies the same visibility rule as the audio. `canListen` is
// the voicemail player's rule: phone access, calling on, not an operator in view-as (whose
// sign-in is not on this builder's team, so the Worker would refuse it).
function SsCallRecording({ callId, meta, canListen }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const toggle = async () => {
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (text) return;
    setBusy(true); setErr(null);
    try {
      const { data } = await sb.auth.getSession();
      const token = data && data.session ? data.session.access_token : null;
      const r = await ssPhoneFetchTranscript(callId, token);
      setText(r.transcript);
    } catch (e) { setErr(e && e.message ? e.message : "The transcript couldn't be loaded. Try again."); }
    finally { setBusy(false); }
  };
  const state = meta.recordingState;
  const note = state === "live" ? "This call is being recorded."
    : state === "paused" ? "Recording paused while the customer is on hold."
    : state === "processing" ? "The recording is being saved. It can be played in a minute."
    : state === "failed" ? "This call wasn't recorded."
    : meta.transcriptPending ? "The transcript and summary are on their way."
    : meta.recordingDeleted && meta.summary ? "The recording and transcript were deleted after your keep period. The summary stays."
    : null;
  return (
    <div data-ss-call-recording={callId} style={{ marginTop: 4 }}>
      {meta.summary && (
        <div data-ss-call-summary style={{ background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 6, padding: "6px 9px", marginTop: 4 }}>
          <div style={{ fontSize: 10.5, fontWeight: 800, color: "#64748B", letterSpacing: "0.04em", textTransform: "uppercase", marginBottom: 2 }}>Call summary</div>
          <div style={{ fontSize: 12.5, color: "#1E293B", whiteSpace: "pre-wrap", lineHeight: 1.45 }}>{meta.summary}</div>
        </div>
      )}
      {meta.recordingReady && meta.recordingId && canListen && ssPhoneRecordingAudioUrl(meta.recordingId) && (
        <SsRecordingPlayer recordingId={meta.recordingId} durationS={meta.recordingDurationS} />
      )}
      {note && <div style={{ fontSize: 11.5, color: "#64748B", fontStyle: "italic", marginTop: 4 }}>{note}</div>}
      {meta.hasTranscript && canListen && (
        <div style={{ marginTop: 5 }}>
          <button type="button" onClick={toggle} disabled={busy} data-ss-transcript-toggle={callId}
            style={{ background: "none", border: "none", padding: 0, color: ACCENT, fontSize: 12, fontWeight: 700, cursor: busy ? "default" : "pointer", fontFamily: "inherit" }}>
            {busy ? "Loading the transcript…" : open ? "Hide transcript" : "Show transcript"}
          </button>
          {open && text && (
            <div data-ss-transcript style={{ fontSize: 12.5, color: "#1E293B", whiteSpace: "pre-wrap", lineHeight: 1.5, background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 6, padding: "6px 9px", marginTop: 4, maxHeight: 320, overflowY: "auto" }}>
              {text}
            </div>
          )}
          {open && err && <div style={{ fontSize: 12, color: "#B91C1C", marginTop: 4 }}>{err}</div>}
        </div>
      )}
    </div>
  );
}

// QUICK SENDS, the button and its list beside the record's Email and SMS boxes (Carolyn
// 2026-09-30; the rules are in 01-core beside ssFillQuickSend). The same list, the same chips and
// the same rows as My Synergy Phone's picker: "All · N" and each category, then every quick send
// with its name, a two-line preview filled in for THIS customer, "used N×" and Insert. Insert only
// fills the box (CrmRecord's insertQuickSend); nothing here sends.
//
// `quick` is CrmRecord's: null until the first open asks for the list (onOpen), "loading", the
// list, or "off" — a failed read hides the button entirely, with no banner, because the box works
// the same without it. Adding and editing quick sends stays in the app for now, so the empty
// state says where.
function CrmQuickSendPicker({ channel, quick, onOpen, onInsert, fill }) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState(null);
  // Where the list sits, worked out as it opens: under the button, moved left just enough to stay
  // on screen. On a phone the button starts a third of the way across, and a list anchored to
  // it ran off the right edge and scrolled the page sideways.
  const [place, setPlace] = useState({ left: 0, width: 380 });
  const wrap = useRef(null);
  const button = useRef(null);
  // A click anywhere else, or Escape, closes it (Escape hands focus back to the button).
  useEffect(() => {
    if (!open) return undefined;
    const down = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); };
    const key = (e) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      if (button.current) button.current.focus();
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [open]);
  if (quick === "off") return null;

  const list = quick && Array.isArray(quick.list) ? quick.list : null;
  const chips = list ? ssQuickSendChips(list) : [];
  const current = list && picked !== null && chips.some((c) => c.category === picked) ? picked : null;
  const rows = list ? ssQuickSendsIn(list, current) : [];
  const toggle = () => {
    if (!open) {
      onOpen();
      const vw = document.documentElement.clientWidth || window.innerWidth || 0;
      const at = button.current ? button.current.getBoundingClientRect().left : 0;
      const width = Math.max(240, Math.min(380, vw - 16));
      // 8px inside the right edge if it can, and never past 8px from the left.
      setPlace({ left: Math.max(8 - at, Math.min(0, vw - 8 - at - width)), width });
    }
    setOpen(!open);
  };

  return (
    <div ref={wrap} style={{ position: "relative", display: "inline-block" }}>
      <button ref={button} type="button" onClick={toggle} data-ss-quick-sends={channel}
        aria-haspopup="dialog" aria-expanded={open}
        title="Put a saved message in the box"
        style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0" }}>
        Quick sends
      </button>
      {open && (
        <div role="dialog" aria-label="Quick sends" data-ss-quick-send-picker={channel}
          style={{
            position: "absolute", left: place.left, top: "calc(100% + 6px)", zIndex: 30, width: place.width,
            background: "#FFF", border: "1px solid #E2E8F0", borderRadius: 10, boxShadow: "0 10px 28px rgba(15,23,42,0.16)",
            textAlign: "left",
          }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 12px 4px" }}>
            <span style={{ fontSize: 13.5, fontWeight: 800, color: "#1E293B" }}>Quick sends</span>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close quick sends"
              style={{ background: "none", border: "none", padding: "2px 4px", color: "#64748B", fontSize: 16, lineHeight: 1, cursor: "pointer", fontFamily: "inherit" }}>
              ×
            </button>
          </div>
          {!list ? (
            <div style={{ padding: "10px 12px 12px", fontSize: 12.5, color: "#64748B" }}>Loading your quick sends…</div>
          ) : !list.length ? (
            <div data-ss-quick-send-empty style={{ padding: "8px 12px 12px", fontSize: 12.5, color: "#475569", lineHeight: 1.5 }}>
              No quick sends yet. Add them in My Synergy Phone, under Settings → Quick sends.
            </div>
          ) : (
            <>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap", padding: "4px 12px 8px" }}>
                {chips.map((c) => {
                  const on = c.category === current;
                  return (
                    <button key={c.category === null ? "" : "c:" + c.category} type="button" onClick={() => setPicked(c.category)}
                      data-ss-quick-send-chip={c.category === null ? "" : c.category} aria-pressed={on}
                      style={{
                        background: on ? ACCENT : "#F1F5F9", color: on ? "#FFF" : "#475569",
                        border: "none", borderRadius: 999, padding: "3px 11px", fontSize: 11.5, fontWeight: 700, cursor: "pointer",
                      }}>{c.label}</button>
                  );
                })}
              </div>
              <div style={{ maxHeight: 320, overflowY: "auto", borderTop: "1px solid #F1F5F9" }}>
                {rows.map((q) => (
                  <div key={q.id} data-ss-quick-send={q.id}
                    style={{ display: "flex", gap: 10, alignItems: "center", padding: "9px 12px", borderBottom: "1px solid #F1F5F9" }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: "#1E293B", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{q.name}</div>
                      <div data-ss-quick-send-preview
                        style={{ fontSize: 12.5, color: "#475569", lineHeight: 1.45, marginTop: 2, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", overflowWrap: "anywhere" }}>
                        {ssFillQuickSend(q.body, fill)}
                      </div>
                      <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 2 }}>used {Math.max(0, Math.floor(Number(q.usage_count) || 0))}×</div>
                    </div>
                    <button type="button" aria-label={`Insert ${q.name}`}
                      onClick={() => { setOpen(false); onInsert(q); }}
                      style={{ ...S.btn("#FFF", ACCENT), border: "1px solid " + ACCENT, padding: "6px 12px", fontSize: 12.5, flex: "0 0 auto" }}>
                      Insert
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
          <div style={{ padding: "7px 12px 9px", fontSize: 11.5, color: "#64748B", textAlign: "center" }}>
            Inserting fills the box. Sending is yours.
          </div>
        </div>
      )}
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
// (The Sales tax card it renders is the one exception, and carries its own reasons and its own
// view-as path — see QuoteSalesTaxCard.)
function CrmRecord({ kind, recordId, isAdmin = false, canEdit: canEditProp = false, crmUnlocked = true, initialDeal = null, onSeeBilling = null, onBack, onNavigate, onOpenDesign , onOpenOrder = null,
  clientId = null, viewingLabel = null, canEditDesigns = false, canReadTaxSettings = false, canVerifyTax = false,
  // My Synergy Phone: the signed-in person (the extension refuses a call for anybody else), whether
  // their access includes calling, and whether calling is switched on for the account.
  userId = null, canCall = false, phoneOn = false,
  // The signed-in person's email signature (My Profile), shown under the Email box because the
  // server adds it to what they send: "" when they have none, null when it isn't known (view-as),
  // which shows nothing. onEditProfile opens My Profile, where it is changed.
  emailSignature = null, onEditProfile = null,
  // Whether the signed-in person switched reply copies on (My Profile): true, false, or null in
  // view-as. It only changes the line above the Email box; the server decides what goes out.
  replyCopy = null,
  // Quick sends (the signed-in person's saved messages, the list My Synergy Phone keeps) beside
  // the Email and SMS boxes. Off in view-as: the list would be the OPERATOR's own, and the server
  // refuses it there too.
  quickSendsOn = false,
  // The signed-in person's card order (My Profile), { contact: [...], design: [...] } or null.
  // Null in view-as, where prefs aren't read, so the operator sees the default order.
  cardOrder = null,
  // The History chip to open on (a CRM_CHIPS key), when the reader came from a Conversations row:
  // an email opens on Emails, a text on Messages, a call on Calls. Read once, as initial state
  // (the shell remounts the record per route). A chip this record doesn't show falls back to All.
  initialChip = null }) {
  // THE SUBSCRIPTION IS AN EDIT GATE, NOT A TAB GATE, and it has to be applied here rather
  // than tab by tab. Every WRITE this page makes is a `crm_*` action — crm_save_note,
  // crm_save_activity, crm_complete_activity, crm_send_email, crm_send_sms, crm_save_contact,
  // crm_record_consent, crm_file_* — and portal-settings refuses the whole prefix without the
  // CRM (index.ts, the crmGated guard). The one exception is the READ, `crm_record` with
  // kind "design", which is deliberately exempt so the free Pipeline list's own rows still
  // open. The result before this line existed: on a tenant without the CRM the design record
  // rendered in full, every control looked live, and the first click returned a 403 — Carolyn
  // 2026-09-01, "I don't want them, if they are not paying for the CRM part in the billing,
  // to be able to make these notes in any of this stuff here."
  //
  // Folding it into canEdit rather than adding a seventh predicate is what keeps the browser
  // and the server agreeing by construction: `enabled: (c) => c.canEdit` already names the
  // exact set of tabs the prefix refuses, and Invoice — which is send_invoice, NOT a crm_
  // action, and belongs to Simple Layout — reads c.isAdmin and correctly stays live.
  // `crmUnlocked` defaults TRUE so a caller that has not been taught about it (the contact
  // record route, which is gated a level up) behaves exactly as it did.
  const canEdit = canEditProp && crmUnlocked;
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [tab, setTab] = useState("note");
  const [chip, setChip] = useState(initialChip || "all");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [mail, setMail] = useState({ subject: "", body: "" });
  const [mailMsg, setMailMsg] = useState(null);
  // QUICK SENDS, read the first time a picker opens and never when the record opens:
  // null (not asked yet) → "loading" → { list, myName }, or "off" when the server would not give
  // them (an older server that doesn't know the action, a refusal, a blip), which hides the
  // button for the rest of this record without a banner. One read serves the Email and SMS
  // boxes both. The two refs are the boxes Insert hands focus back to. Up here with the other
  // hooks: CrmRecord returns early on `!data`, and a hook below that is React #310 (13ca37e).
  const [quick, setQuick] = useState(null);
  const mailBodyRef = useRef(null);
  const textBoxRef = useRef(null);
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
  // My Synergy Phone: where the last Call / Text hand-off got to ({ what: "call"|"text", kind, ... }),
  // and whether the reader chose to write a text here after it opened in My Synergy Phone. In the TOP
  // hook block for the same reason as everything above: CrmRecord returns early on `!data`,
  // and a hook below that guard is React #310 and a white page (13ca37e).
  const [phoneUi, setPhoneUi] = useState(null);
  const [smsHere, setSmsHere] = useState(false);
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
  // WHICH of this contact's deals the page is about. NULL on purpose — Carolyn, 2026-09-02:
  // "you have to have one of these selected for anything to show up here". The old behaviour
  // picked designs[0] silently, which is exactly what she was reading when she said "Right
  // now, it's Greek, you have no idea." ⚠️ This must be the LAST hook and stay ABOVE the
  // early returns below, same as the two above it — and it is the ONLY new one: activeCode
  // is derived, not stored, because a useMemo would be a second hook that would have to sit
  // above the `!data` guard where `data` does not exist yet.
  // SEEDED from initialDeal when the reader arrived by clicking that deal in the Pipeline
  // (2026-09-04). Initial state only — a hand-pick later supersedes it, and `key={sub}` in
  // the shell remounts on every route so a stale seed cannot outlive its own navigation.
  //
  // ⚠️ It is NOT trusted: activeCode below re-checks membership against knownCodes, so a
  // deal that does not belong to this contact resolves to null and the reader gets the
  // ordinary pick hint rather than somebody else's quote. That check already existed for
  // load()'s re-runs; seeding just gave it a second thing to protect against.
  const [selCode, setSelCode] = useState(initialDeal || null);

  const load = useCallback(async () => {
    setErr(null);
    const { data: d, error } = await sb.functions.invoke("portal-settings", { body: { action: "crm_record", kind, id: recordId } });
    if (error || (d && d.error)) { setErr((error && error.message) || d.error); return; }
    setData(d);
  }, [kind, recordId]);
  useEffect(() => { load(); }, [load]);

  // THE EXPANDED DEAL on a contact record — a short_code, or null for none. Carolyn,
  // 2026-09-07 36:50: "I would like to be able to click this here and see those custom fields
  // like when he's in here and he's talking with the customer", and at 37:20 the one she
  // actually needed: "The main and only thing right now is the expected close date."
  //
  // ⚠️ THERE ARE NO CUSTOM FIELDS IN THIS PRODUCT. Nothing defines one, stores one or renders
  // one. `expected_close_date` is a plain column on `designs` (migration 206) and everything
  // else she named is already inside `selections`. So this is a fixed panel over fields that
  // exist, NOT a field builder — building one on the strength of the words "custom fields"
  // would be a multi-day feature nobody asked for.
  //
  // ⚠️ THESE HOOKS SIT ABOVE THE EARLY RETURNS, like every other hook here. CrmRecord returns
  // early on `!data`, so a hook declared beside the deals renderer would be absent on the
  // first render and present on the second — React #310, and the record page goes white the
  // moment its data arrives. That has shipped more than once (13ca37e, app_errors bb53f026).
  //
  // They are BELOW `load` on purpose: saveDealClose closes over it, and `const` does not
  // hoist, so declaring them above would be a TDZ throw rather than a subtle bug.
  const [dealOpen, setDealOpen] = useState(null);
  const [dealBusy, setDealBusy] = useState(false);
  // The Deals card's pipeline controls (2026-10-12): the lost-reason picker a move into a lost
  // stage needs ({ deal, stage, reasons, key }), and "+ Add to a pipeline" while it is open (the
  // pipeline id it will add to). Up here with the rest, above the early returns (React #310).
  const [dealLost, setDealLost] = useState(null);
  const [dealAdd, setDealAdd] = useState(null);

  // Optimistic, and deliberately the SAME action the Pipeline board's close-date control calls:
  // one write path means the board and the contact record cannot disagree about what a close
  // date is. `designs` has no tenant UPDATE policy (154/193 are SELECT-only), so the edge
  // function is not a convenience here — it is the only way in.
  const saveDealClose = useCallback(async (shortCode, value) => {
    const iso = value || null;
    setDealBusy(true);
    setData((d) => (!d ? d : { ...d, designs: (d.designs || []).map((x) => (x.short_code === shortCode ? { ...x, expected_close_date: iso } : x)) }));
    try {
      const { data: r, error: e } = await sb.functions.invoke("portal-settings", {
        body: { action: "set_expected_close", shortCode, expectedCloseDate: iso },
      });
      if (e) throw new Error(await fnError(e));
      if (r && r.error) throw new Error(r.error);
      setOpErr(null);
    } catch (e2) {
      // Reload rather than repaint from a remembered value: this panel is one of two screens
      // writing the same column, so the server's answer is the only one worth trusting.
      await load();
      // Keyed by short_code: a bare where:"deals" showed the failure under EVERY expanded
      // deal, including ones the reader never touched.
      setOpErr({ where: "deals", code: shortCode, msg: e2.message || "That close date did not save." });
    } finally {
      setDealBusy(false);
    }
  }, [load]);

  if (err) {
    return (
      <div style={S.card}>
        <div style={S.h2}>Not found</div>
        <p style={{ fontSize: 13, color: "#64748B" }}>{err}</p>
        <button style={S.btn()} onClick={onBack}>Back</button>
      </div>
    );
  }
  if (!data) return <CrmRecordSkeleton kind={kind} onBack={onBack} />;

  const record = kind === "design" ? (data.designs || [])[0] : data.contact;

  // THE SELECTED DEAL. Below the early returns on purpose — none of this is a hook.
  //
  // The membership re-check is not defensive padding: load() re-runs after every write, and
  // a selCode left pointing at a design that has since moved contact would make every filter
  // below return [] with no error anywhere — the "quietly always empty" failure the orders
  // and delivery cards each have a comment about.
  //
  // activeCode can be set while activeDeal is null: orders join on short_code as a SOFT link
  // with no FK, so an order can name a code whose design this read did not return. Every
  // consumer has to tolerate that, and the rails do by construction.
  const knownCodes = new Set([
    ...(data.designs || []).map((d) => d.short_code),
    ...(data.orders || []).map((o) => o.short_code),
  ]);
  const activeCode = kind === "design" ? recordId
    : (selCode && knownCodes.has(selCode) ? selCode : null);
  const activeDeal = activeCode
    ? ((data.designs || []).find((d) => d.short_code === activeCode) || null)
    : null;

  // THE PIPELINE CARDS (crm_record's `pipeline` block, 2026-10-12): undefined from a server that
  // doesn't send it, or for a reader who may not see contacts, and then the record is what it was.
  const pipe = data.pipeline || null;
  // A Deals row with no design is picked by its card's id (crmDealRows' key), never a short code,
  // so activeCode stays null for it: every tab that files against a design still waits for one,
  // and only the top bar follows the pick. Re-checked against this contact's own cards for the
  // same reason activeCode is re-checked against knownCodes.
  const pickedLead = kind === "contact" && pipe && selCode && !knownCodes.has(selCode)
    ? (crmDealRows(data.designs, pipe).find((r) => !r.design && r.key === selCode) || {}).deal || null
    : null;
  // The card the top bar is about: a design record's own, or the picked row's.
  const barDeal = kind === "design" ? crmPipeDealFor(pipe, recordId)
    : activeCode ? crmPipeDealFor(pipe, activeCode) : pickedLead;

  // needsPick is derived and redundant, and that is the point: it puts the `kind ===
  // "contact"` half in ONE place, so no tab can accidentally gate itself on a design record
  // — which would break the free Pipeline list that opens design records without a CRM.
  const ctx = { kind, record, isAdmin, canEdit, crmUnlocked, contact: data.contact, designs: data.designs || [], sms: data.sms || null,
    selectedCode: activeCode, needsPick: kind === "contact" && !activeCode,
    // My Synergy Phone. `viewing` is operator view-as (the shell passes viewingLabel only then), and
    // greys Call and Text first; see CRM_VIEWING_CALL_HINT.
    viewing: !!viewingLabel, canCall: !!canCall, phone: { on: !!phoneOn },
    hasCalls: (data.feed || []).some((e) => e.type === "call" || e.type === "call_missed" || e.type === "voicemail") };
  const cname = (data.contact && (data.contact.name || data.contact.email || data.contact.phone)) || "Unnamed contact";
  const sel = (record && record.selections) || {};
  const title = kind === "design"
    ? ([sel.style, sel.size].filter(Boolean).join(" ") || (record && record.short_code) || "Design")
    : cname;

  // A composer renders only while ITS TAB IS ENABLED, not merely while it is the remembered
  // `tab`. The two drift apart in ordinary use: `tab` starts on "note", so a contact opened
  // with no deal picked showed a live note box under a greyed Notes tab whose hint says to pick
  // a deal first — and saved the note with shortCode null, the exact thing the picker exists to
  // stop. Clearing a pick, or picking a deal that is not accepted while Invoice is open, left
  // the old tab's panel live the same way. The tab's own predicate is the one answer.
  const tabOn = (key) => {
    const t = CRM_TABS.find((x) => x.key === key);
    return !!t && (!t.when || t.when(ctx)) && t.enabled(ctx);
  };
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
        shortCode: activeCode,
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
    // WHO OWNS THIS CUSTOMER (188). Carolyn 2026-09-04 @1:09:30: "we do not ever assign
    // deals. We only assign contacts and followers." The column has existed since 130 as
    // deliberate "header furniture" with nothing able to write it; this is the writer.
    // "" means unassigned — the server reads an empty string as a clear, the same contract
    // every other field here uses.
    owner: (data.contact && data.contact.owner_user_id) || "",
    // Address (166). Carolyn, 2026-08-28 @21:01: "We still need like address. You have it in
    // here, but everything that is contact related should be in here." These columns have
    // existed since 130 and were filled in from submitted designs -- the record SHOWED them
    // and only the editor could not touch them, which is why she asked "did you just specify
    // just these?" about name/phone/email.
    street: (data.contact && data.contact.street) || "",
    city: (data.contact && data.contact.city) || "",
    state: (data.contact && data.contact.state) || "",
    zip: (data.contact && data.contact.zip) || "",
    // SECOND ADDRESS (188). Carolyn, 2026-09-04 @1:14:06: "Address, we are going to need a
    // second address as well. One is going to be a delivery address. There is going to be a
    // mailing slash billing."
    //
    // ⚠️ THE FOUR FIELDS ABOVE ARE THE DELIVERY ADDRESS AND KEEP THAT MEANING. They are read
    // as the delivery destination all the way downstream — `_shared/contactAddress.ts`'s
    // `hasDestination()` and `territoryFor()` feed the delivery scheduler off exactly these
    // columns. Repurposing them as "the main address" and adding delivery as the new pair
    // would silently re-point every existing stop at a billing address, on live data, with
    // nothing raising.
    // ⚠️ THE COLUMNS ARE `billing_*`, NOT `bill_*`. This read said `bill_street` until the
    // migration was applied and the live column list checked — a wrong key here does not
    // throw, it resolves to undefined and falls through to "", so the field renders EMPTY
    // while the row underneath holds a real address. The write path uses different names
    // again (`billingStreet`, the wire shape crm_save_contact takes), so a builder would have
    // typed an address, saved it successfully, and watched it vanish on reload — with no
    // error anywhere and the data sitting safely in the table the whole time.
    billingStreet: (data.contact && data.contact.billing_street) || "",
    billingCity: (data.contact && data.contact.billing_city) || "",
    billingState: (data.contact && data.contact.billing_state) || "",
    billingZip: (data.contact && data.contact.billing_zip) || "",
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
        name: edit.name, phone: edit.phone, email: edit.email, owner: edit.owner,
        street: edit.street, city: edit.city, state: edit.state, zip: edit.zip,
        billingStreet: edit.billingStreet, billingCity: edit.billingCity,
        billingState: edit.billingState, billingZip: edit.billingZip,
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
        shortCode: activeCode,
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
            shortCode: activeCode,
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
        shortCode: activeCode,
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

  // ── MY SYNERGY PHONE: hand the call or the text over (SPEC section 5) ────────────────
  // The four fields every message carries. user_id and client_id are what let the extension
  // refuse a portal signed in as somebody else on a shared office computer ("wrong_user"),
  // so they are the SIGNED-IN person and the tenant on screen — never a contact's owner.
  const phoneMsg = () => ({
    to_e164: ssPhoneE164(data.contact && data.contact.phone),
    contact_id: (data.contact && data.contact.id) || null,
    user_id: userId || null,
    client_id: clientId || null,
  });

  // CALL. One press dials: the extension already holds a registered line (plan D4), so the
  // time from this click to Twilio is the extension's, not ours. On a phone's browser there is
  // no extension, so the My Synergy Phone app opens by its link instead. Neither path moves this page.
  // The rules are ssPhoneStartCall's (01-core), shared with the contact list's Call button.
  const startCall = async () => {
    const msg = phoneMsg();
    setPhoneUi({ what: "call", kind: "checking", to: msg.to_e164 });
    const out = await ssPhoneStartCall(data.contact && data.contact.phone, msg,
      "This contact's phone number can't be dialed. Check it under Summary.");
    setPhoneUi({ what: "call", ...out });
  };

  // TEXT. For someone who uses My Synergy Phone, the SMS tab opens the customer's thread in the
  // extension (plan section 12: "Opens the thread in the extension or app when My Synergy Phone is
  // installed"), so a conversation lives in one place. Everybody else — and anybody whose
  // extension is signed in as somebody else, or not at all — gets today's composer, unchanged.
  // It never sends: the extension opens the thread and the person types there.
  const routeText = async () => {
    setSmsHere(false);
    if (!phoneOn || !canCall || ssIsPhoneBrowser()) { setPhoneUi(null); return; }
    const msg = phoneMsg();
    setPhoneUi({ what: "text", kind: "checking" });
    const found = await ssPhonePing();
    if (!found) { setPhoneUi({ what: "text", kind: "install" }); return; }
    const who = found.reply || {};
    // Checked HERE as well as in the extension so the answer is "write it here" rather than a
    // refusal: a text is not urgent enough to send anybody off to switch accounts.
    if (!who.user_id || who.user_id !== userId || who.client_id !== clientId) {
      setPhoneUi({
        what: "text", kind: "elsewhere",
        text: who.user_id
          ? "My Synergy Phone on this computer is signed in as someone else, so this text goes from here."
          : "My Synergy Phone isn't signed in, so this text goes from here.",
      });
      return;
    }
    // The name rides along (optional, SPEC section 5) so the extension's Quick sends fill
    // {first_name} as this page's own do; an older extension ignores it.
    const out = await ssPhoneSend("sss.text", { ...msg, name: (data.contact && data.contact.name) || null });
    if (out.reply && out.reply.ok) { setPhoneUi({ what: "text", kind: "texting", to: msg.to_e164 }); return; }
    setPhoneUi({ what: "text", kind: "elsewhere", text: `${ssPhoneRefusal(out.reply)} You can still text from here.` });
  };
  // Showing the thread in My Synergy Phone instead of the composer: only once it has actually opened
  // there (or while we are finding out), and never after "Write it here instead".
  const smsViaPhone = !!(phoneUi && phoneUi.what === "text" && !smsHere && (phoneUi.kind === "texting" || phoneUi.kind === "checking"));

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
        shortCode: activeCode,
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

  // ── QUICK SENDS (Carolyn 2026-09-30; the helpers and the why are in 01-core) ─────────────────
  // The list, once per record, the first time either picker opens.
  const loadQuickSends = async () => {
    if (quick !== null) return;
    setQuick("loading");
    let r = null, failed = false;
    try {
      const res = await sb.functions.invoke("portal-settings", { body: { action: "quick_sends_list" } });
      r = res.data;
      failed = !!res.error;
    } catch (_e) { failed = true; }
    if (failed || !r || r.error || !Array.isArray(r.quick_sends)) { setQuick("off"); return; }
    setQuick({ list: r.quick_sends, myName: typeof r.my_name === "string" ? r.my_name : "" });
  };

  // INSERT FILLS THE BOX, AND THAT IS ALL IT DOES. The quick send, filled in for this customer,
  // goes into the BODY (after anything already typed; an email's subject is never touched), focus
  // goes back to the box, and Send stays the person's own press. One that would run past the
  // box's limit is refused with the box left as it was, never cut. The use is counted in the
  // background, and a failure there is ignored: it is only "used N×".
  const insertQuickSend = (q, channel) => {
    if (!quick || !quick.list || !q) return;
    const email = channel === "email";
    const fill = { contactName: data.contact && data.contact.name, myName: quick.myName };
    const next = ssInsertQuickSend(email ? mail.body : text, q, fill, channel);
    const say = email ? setMailMsg : setTextMsg;
    if (next === null) { say({ err: ssQuickSendTooLong(channel) }); return; }
    if (email) setMail((p) => ({ ...p, body: next })); else setText(next);
    say(null);
    const box = email ? mailBodyRef.current : textBoxRef.current;
    setTimeout(() => {
      if (!box) return;
      box.focus();
      try { box.setSelectionRange(next.length, next.length); } catch (_e) { /* not a text box */ }
      box.scrollTop = box.scrollHeight;
    }, 0);
    Promise.resolve(sb.functions.invoke("portal-settings", { body: { action: "quick_send_used", id: q.id } }))
      .then((res) => {
        if (!res || res.error || !res.data || !res.data.ok) return;
        setQuick((cur) => (cur && cur.list
          ? { ...cur, list: cur.list.map((x) => (x.id === q.id ? { ...x, usage_count: (Number(x.usage_count) || 0) + 1 } : x)) }
          : cur));
      })
      .catch(() => { /* only a count */ });
  };

  // ── A DEAL'S STAGE AND PIPELINE, FROM THE DEALS CARD (Carolyn 2026-10-12) ───────────────────
  // The SAME action the Pipeline board's drag calls, so the board and the record cannot disagree
  // about where a card is. Moving to another pipeline is a move to a stage IN it (crm_move_deal
  // takes the pipeline from the stage), which is what keeps a deal in one pipeline at a time.
  // Painted at once; a refusal reloads the record and says why under that deal. The status is
  // never painted here: it is the system's, and the server's answer carries it.
  const moveDeal = async (deal, stage, rowKey, lostReason) => {
    if (!deal || !stage || stage.id === deal.stage_id) return;
    setOpErr(null);
    setData((d) => (!d || !d.pipeline ? d : { ...d, pipeline: crmPipeMoved(d.pipeline, deal.id, stage, lostReason) }));
    try {
      const r = await ssPipeCall("crm_deal_move", { id: deal.id, stageId: stage.id, lostReason: lostReason || null });
      if (r && r.status_id) {
        setData((d) => (!d || !d.pipeline ? d : { ...d, pipeline: { ...d.pipeline,
          deals: (d.pipeline.deals || []).map((x) => (x.id === deal.id ? { ...x, status_id: r.status_id } : x)) } }));
      }
    } catch (e2) {
      await load();
      setOpErr({ where: "deals", code: rowKey, msg: e2.message || "That move did not save." });
    }
  };
  // A stage from the deal's own pipeline. A lost stage asks for the reason first, as the board does.
  const pickDealStage = (deal, stageId, rowKey) => {
    const p = crmPipeOf(pipe, deal);
    const stage = p ? (p.stages || []).find((s) => s.id === stageId) : null;
    if (!stage) return;
    if (stage.kind === "lost") { setDealLost({ deal, stage, reasons: p.lostReasons || [], key: rowKey }); return; }
    moveDeal(deal, stage, rowKey);
  };
  // To another pipeline: it lands in that pipeline's first open stage, and the stage drop-down,
  // which now lists the new pipeline's stages, picks any other.
  const moveDealToPipeline = (deal, pipelineId, rowKey) => {
    const target = crmPipeMoveTargets(pipe, deal).find((p) => p.id === pipelineId);
    if (target) moveDeal(deal, crmPipeFirstOpen(target), rowKey);
  };
  // A card's own close date, for a deal with no design (a design's is the design's: saveDealClose).
  const saveLeadClose = async (deal, value, rowKey) => {
    const iso = value || null;
    setDealBusy(true); setOpErr(null);
    setData((d) => (!d || !d.pipeline ? d : { ...d, pipeline: { ...d.pipeline,
      deals: (d.pipeline.deals || []).map((x) => (x.id === deal.id ? { ...x, expected_close_date: iso } : x)) } }));
    try { await ssPipeCall("crm_deal_update", { id: deal.id, expectedCloseDate: iso || "" }); }
    catch (e2) { await load(); setOpErr({ where: "deals", code: rowKey, msg: e2.message || "That close date did not save." }); }
    finally { setDealBusy(false); }
  };
  // "+ Add to a pipeline", kept from the Sales pipelines card it replaced: a new deal for this
  // person (not one of their designs, which have their cards already), in that pipeline's first
  // open stage. Reloaded rather than painted, because the new card's id comes from the server.
  const addDealToPipeline = async () => {
    const p = ((pipe && pipe.pipelines) || []).find((x) => x.id === dealAdd);
    const stage = crmPipeFirstOpen(p);
    if (!stage || !(data.contact && data.contact.id)) return;
    setDealBusy(true); setOpErr(null);
    try {
      await ssPipeCall("crm_deal_create", { contactId: data.contact.id, stageId: stage.id });
      setDealAdd(null);
      await load();
    } catch (e2) {
      setOpErr({ where: "dealAdd", msg: e2.message || "That deal was not added." });
    } finally {
      setDealBusy(false);
    }
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
            <CrmOwnerPicker edit={edit} setEdit={setEdit} team={data.team} />
            {/* DELIVERY, then MAILING/BILLING (188). Carolyn 2026-09-04 @1:14:06. The first
                four columns are the DELIVERY address and keep that meaning — the scheduler
                builds its destination from these same submitted values, so relabelling them
                would re-point live stops at a billing address with nothing raising. */}
            <CrmEditHead hint="where the building goes">Delivery address</CrmEditHead>
            <CrmAddressFields edit={edit} setEdit={setEdit} keys={CRM_ADDR_DELIVERY} />
            <CrmEditHead hint="leave blank if it is the same">Mailing / billing address</CrmEditHead>
            <CrmAddressFields edit={edit} setEdit={setEdit} keys={CRM_ADDR_BILLING} />
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
      // ONE SECTION (Carolyn 2026-10-12, C34). The rows are this person's designs, each joined to
      // its pipeline card, plus any card with no design; crmDealRows says how. Without a pipeline
      // block from the server this is the designs list it always was.
      const rows = crmDealRows(data.designs, pipe);
      const pipes = (pipe && pipe.pipelines) || [];
      // Compact, so the controls sit beside "Open in designer" inside the card: "I don't like how
      // big it is ... this drop down can be in here."
      const ctl = { border: "1px solid #CBD5E1", borderRadius: 6, padding: "4px 6px", fontSize: 12, fontWeight: 600,
        fontFamily: "inherit", color: "#1E293B", background: "#FFF", maxWidth: 150, minWidth: 0, cursor: "pointer" };
      return (
        <div>
          <div style={{ fontSize: 11, color: "#94A3B8", fontWeight: 800, marginBottom: 6 }}>OPEN DEALS ({rows.length})</div>
          {/* Shown only until something is picked, so it stops nagging the moment it has
              been acted on. Without it the page is a contact whose stages, build, delivery
              and every write tab are all silently off with nothing saying why. */}
          {kind === "contact" && !activeCode && !pickedLead && rows.length > 0 && (
            <div style={{ fontSize: 11, color: "#64748B", marginBottom: 6 }}>
              Pick a deal to see its stages, build and delivery.
            </div>
          )}
          {/* ⚠️ TWO SIBLING BUTTONS, NEVER NESTED — the Person card carries the same shape
              and the same warning: a button inside a button is invalid HTML and React will
              not render it. THE ROW SELECTS; THE CHEVRON EXPANDS. Both stay on this page.
              The ● / ○ glyph is there because colour alone is not a state indicator. The
              status pill sits INSIDE the row button as a plain span, so the row still has
              exactly two buttons (crmContactDeal.mjs counts them).

              ⚠️ THERE IS DELIBERATELY NO "open this deal's own record" ARROW. Ahsan, 2026-09-20:
              "remove this own record arrow in there i want every thing in the contact page."
              A third › used to sit here and navigate away. Do not add it back to solve a
              "you can't get to X from a contact" report — that is the report saying X is still
              gated on `kind === "design"` when it should be gated on `crmContextDesign(c)`.
              Fix the gate; the arrow was the workaround, not the feature. The design record
              itself still exists and the Pipeline still opens it directly — it is only no
              longer somewhere a contact has to send you. */}
          {rows.map((row) => {
            const d = row.design;
            const deal = row.deal;
            const sel = d ? activeCode === d.short_code : !!(pickedLead && pickedLead.id === deal.id);
            // `!!row.key` because dealOpen starts null: without it a row whose key is missing
            // matches, renders EXPANDED on arrival, and its arrow cannot close it — clicking
            // sets dealOpen back to null, which still matches.
            const open = !!row.key && dealOpen === row.key;
            const s = (d && d.selections) || {};
            const pc = s.paint_colors || s.paintColors || {};
            const colour = [pc.body, pc.trim].filter(Boolean).join(" / ") || s.paint || "—";
            const inPipe = crmPipeOf(pipe, deal);
            const targets = deal ? crmPipeMoveTargets(pipe, deal) : [];
            const name = d ? ([s.style, s.size].filter(Boolean).join(" ") || d.short_code)
              : (deal.title || (inPipe ? inPipe.name : "Deal"));
            const fieldRow = (label, node) => (
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0" }}>
                <div style={{ width: 96, flexShrink: 0, fontSize: 10.5, fontWeight: 800, letterSpacing: ".04em", textTransform: "uppercase", color: "#94A3B8" }}>{label}</div>
                <div style={{ minWidth: 0, fontSize: 12.5, color: "#334155" }}>{node}</div>
              </div>
            );
            // Saved on blur or Enter, the way the Pipeline card's close date is — NOT on
            // change. A date input fires change once per keystroke with whatever its segments
            // hold so far: typing the month "12" reports January first and the first digit of
            // a year reports year 0002, so a change-save stored January (and the save disabled
            // the box before the "2" could land). Keyed on the stored value so a save or a
            // reload repaints it; Escape puts it back. A design's date is the design's
            // (set_expected_close); a card with no design keeps its own (crm_deal_update).
            const closeStored = String((d ? d.expected_close_date : deal.expected_close_date) || "").slice(0, 10);
            const closeField = canEdit ? (
              <input type="date" key={`${row.key}:${closeStored}`} defaultValue={closeStored} disabled={dealBusy}
                onBlur={(e) => {
                  if (e.target.value === closeStored) return;
                  if (d) saveDealClose(d.short_code, e.target.value); else saveLeadClose(deal, e.target.value, row.key);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") { e.currentTarget.value = closeStored; e.currentTarget.blur(); }
                }}
                style={{ ...S.input, padding: "4px 7px", fontSize: 12.5, width: 158 }} />
            ) : (closeStored ? fmtDate(closeStored) : "—");
            return (
              <div key={row.key} data-ss-deal-row={row.key} style={{ marginBottom: 5 }}>
                <div style={{ display: "flex", alignItems: "stretch", gap: 0, background: sel ? "#EEF2FF" : "#F8FAFC",
                  border: "1px solid " + (sel ? ACCENT : "#E2E8F0"),
                  borderRadius: open ? "6px 6px 0 0" : 6, overflow: "hidden" }}>
                  <button onClick={() => setSelCode(sel ? null : row.key)} aria-pressed={sel}
                    title={sel ? "Showing this deal — click to clear" : "Show this deal's stages, build and delivery"}
                    style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 8, textAlign: "left",
                      background: "transparent", border: "none", padding: "7px 9px", cursor: "pointer" }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: ACCENT }}>
                        <span style={{ color: sel ? ACCENT : "#CBD5E1", marginRight: 6 }}>{sel ? "●" : "○"}</span>
                        {name}
                      </div>
                      <div style={{ fontSize: 11, color: "#64748B", marginLeft: 18 }}>{fmtDate(row.at)}</div>
                    </div>
                    {/* THE STATUS, ONCE, ON THE TOP LINE (C36). Carolyn, 2026-10-12, boxing the
                        space right of the name: "If you put the status ... up there, we don't
                        need the status down here at all." Shown, never set (C40). */}
                    <CrmDealStatusPill status={crmPipeStatus(pipe, deal)} />
                  </button>
                  {/* ⚠️ A THIRD SIBLING, never a child of the row button. Same rule the two
                      buttons beside it already carry: a <button> inside a <button> is invalid
                      HTML and React will not render it, so an "expand" chevron nested in the
                      row is the one obvious way to build this and it does not work. */}
                  <button onClick={() => setDealOpen(open ? null : row.key)} aria-expanded={open}
                    title={open ? "Hide this deal's details" : "Show this deal's details"}
                    style={{ background: "transparent", border: "none", borderLeft: "1px solid " + (sel ? ACCENT : "#E2E8F0"),
                      padding: "0 9px", fontSize: 12, color: "#94A3B8", cursor: "pointer" }}>{open ? "▾" : "▸"}</button>
                </div>
                {open && (
                  <div data-ss-deal-panel={row.key} style={{ border: "1px solid " + (sel ? ACCENT : "#E2E8F0"), borderTop: "none",
                    borderRadius: "0 0 6px 6px", background: "#FFF", padding: "7px 10px 9px" }}>
                    {fieldRow("Expected close", closeField)}
                    {d ? (
                      <>
                        {fieldRow("Style", s.style || "—")}
                        {fieldRow("Size", s.size || "—")}
                        {fieldRow("Total", d.total_cents != null ? fmtMoneyWhole(d.total_cents) : "—")}
                        {fieldRow("Colour", colour)}
                      </>
                    ) : fieldRow("Value", deal.value_cents != null ? fmtMoneyWhole(deal.value_cents) : "—")}
                    {deal && deal.lost_reason && <div style={{ fontSize: 11.5, color: "#DC2626", marginTop: 4 }}>Lost: {deal.lost_reason}</div>}
                    {/* "Open in designer" on the left and, at the bottom right where Carolyn
                        bracketed it, the stage and the move (C37, C38). Wraps under itself in a
                        narrow column rather than squeezing the controls. */}
                    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "flex-end", gap: 6, marginTop: 7 }}>
                      {/* The SAME in-portal handler the record header uses. Deliberately NOT a
                          link to the public ?id= page: signed-in staff browsing there fire
                          capture-lead and draft saves and corrupt the very activity this record
                          reports on. openInDesigner also clamps on the designer area, so a Crew
                          Leader gets a refusal instead of a button that silently does nothing. */}
                      {d && onOpenDesign && (
                        <button style={{ ...S.btn(), padding: "5px 10px", fontSize: 12, marginRight: "auto" }}
                          onClick={() => onOpenDesign(d.short_code)}>Open in designer</button>
                      )}
                      {/* THIS pipeline's stages and nobody else's: "no list of every pipeline's
                          stages" (C37). Read only for someone who can't edit contacts. */}
                      {deal && inPipe && (
                        <select aria-label="Stage" title={`Stage in ${inPipe.name}`} value={deal.stage_id || ""}
                          disabled={!canEdit} onChange={(e) => pickDealStage(deal, e.target.value, row.key)}
                          style={{ ...ctl, borderLeft: "4px solid " + (((inPipe.stages || []).find((x) => x.id === deal.stage_id) || {}).color || "#CBD5E1"),
                            cursor: canEdit ? "pointer" : "default" }}>
                          {!(inPipe.stages || []).some((x) => x.id === deal.stage_id) && <option value="">Pick a stage</option>}
                          {(inPipe.stages || []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                        </select>
                      )}
                      {/* Another pipeline (C38). The deal leaves this one: a deal is in exactly one
                          pipeline (C41). It lands in the new pipeline's first open stage, and the
                          stage drop-down beside it then lists that pipeline's stages. */}
                      {deal && canEdit && targets.length > 0 && (
                        <select aria-label="Move to another pipeline" value=""
                          title={inPipe ? `Move out of ${inPipe.name} into another pipeline` : "Move into a pipeline"}
                          onChange={(e) => { if (e.target.value) moveDealToPipeline(deal, e.target.value, row.key); }}
                          style={ctl}>
                          <option value="">{inPipe ? "Move to pipeline…" : "Put in a pipeline…"}</option>
                          {targets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                      )}
                    </div>
                    {opErr && opErr.where === "deals" && opErr.code === row.key && <div style={{ ...S.err, marginTop: 7, marginBottom: 0 }}>{opErr.msg}</div>}
                  </div>
                )}
              </div>
            );
          })}
          {rows.length === 0 && <div style={{ fontSize: 12, color: "#94A3B8" }}>No deals yet.</div>}
          {/* "+ Add to a pipeline", from the Sales pipelines card this one replaced. */}
          {kind === "contact" && canEdit && pipes.length > 0 && data.contact && data.contact.id && (
            dealAdd ? (
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 6 }}>
                <select aria-label="Pipeline for the new deal" value={dealAdd} onChange={(e) => setDealAdd(e.target.value)}
                  style={{ ...ctl, maxWidth: "none", flex: "1 1 140px" }}>
                  {pipes.filter((p) => !!crmPipeFirstOpen(p)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <button type="button" disabled={dealBusy} onClick={addDealToPipeline}
                  style={{ ...S.btn(ACCENT, "#FFF"), padding: "5px 10px", fontSize: 12, opacity: dealBusy ? 0.6 : 1 }}>Add</button>
                <button type="button" disabled={dealBusy} onClick={() => { setDealAdd(null); setOpErr(null); }}
                  style={{ ...S.btn("#F1F5F9", "#334155"), padding: "5px 10px", fontSize: 12 }}>Cancel</button>
                {opErr && opErr.where === "dealAdd" && <div style={{ ...S.err, flexBasis: "100%", marginBottom: 0 }}>{opErr.msg}</div>}
              </div>
            ) : (
              <button type="button"
                onClick={() => { const p = pipes.find((x) => !!crmPipeFirstOpen(x)); if (p) { setOpErr(null); setDealAdd(p.id); } }}
                title="Start a new deal for this person in one of your pipelines"
                style={{ background: "none", border: "none", color: ACCENT, fontWeight: 700, fontSize: 12.5, cursor: "pointer", padding: 0, marginTop: 4, fontFamily: "inherit" }}>＋ Add to a pipeline</button>
            )
          )}
          {dealLost && (
            <SsLostReasonDialog reasons={dealLost.reasons} onCancel={() => setDealLost(null)}
              onPick={(reason) => { const l = dealLost; setDealLost(null); moveDeal(l.deal, l.stage, l.key, reason); }} />
          )}
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
    // ⚠️ TWO MORE STATES, AND THEIR ORDER MATTERS. Both go BELOW the undefined guard and
    // BELOW the non-empty case, so a real row always beats a story about why there is none:
    //   "pick a deal"   -> the reader has not chosen which building this is about. Worded
    //                      DIFFERENTLY from the [] sentence on purpose, so "you haven't
    //                      picked" can never be misread as "there is nothing".
    //   "invoice first" -> chosen, but nobody has billed it. Carolyn's own vocabulary from
    //                      the Orders tab ("Needs invoice" / "Invoice first"), reused rather
    //                      than reinvented, so one concept does not grow two names.
    // The cards THEMSELVES stay — she settled that on 2026-08-28 ("the card just is going to
    // be blank. It'll say build schedule. And it just is nothing"), and hiding the Build card
    // would remove the place a builder goes to SCHEDULE the build. Only the rails hide.
    const pickFirst = (what) => (
      <div style={{ fontSize: 12, color: "#94A3B8" }}>Pick a deal or order above to see its {what}.</div>
    );
    const railSubject = kind === "contact" ? activeDeal : record;
    if (key === "build") {
      if (!data.build) return <div style={{ fontSize: 12, color: "#94A3B8" }}>Not shown for your role.</div>;
      const bJobs = activeCode ? data.build.filter((j) => j.design_short_code === activeCode) : data.build;
      if (!bJobs.length && ctx.needsPick) return pickFirst("build schedule");
      if (!bJobs.length && !crmHasInvoice(railSubject)) {
        return <div style={{ fontSize: 12, color: "#94A3B8" }}>Invoice first — scheduling unlocks once this is billed.</div>;
      }
      if (!bJobs.length) return <div style={{ fontSize: 12, color: "#94A3B8" }}>Not on the build schedule yet.</div>;
      const stageById = new Map((data.stages || []).map((s) => [s.id, s]));
      return (
        <div>
          {bJobs.map((j) => {
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
      const dStops = activeCode ? data.delivery.filter((s) => s.design_short_code === activeCode) : data.delivery;
      if (!dStops.length && ctx.needsPick) return pickFirst("deliveries");
      if (!dStops.length && !crmHasInvoice(railSubject)) {
        return <div style={{ fontSize: 12, color: "#94A3B8" }}>Invoice first — scheduling unlocks once this is billed.</div>;
      }
      if (!dStops.length) return <div style={{ fontSize: 12, color: "#94A3B8" }}>Not scheduled for delivery yet.</div>;
      return (
        <div>
          {dStops.map((s) => {
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
      // Scoped to the pick like its siblings, but ⚠️ NO INVOICE GATE. A repair is not
      // gated on billing — repairs key on design_short_code and have no invoice
      // relationship at all, so "invoice first" would be a sentence that never becomes true.
      const reps = activeCode ? data.repairs.filter((r) => r.design_short_code === activeCode) : data.repairs;
      if (!reps.length && ctx.needsPick) return pickFirst("repairs");
      if (!reps.length) return <div style={{ fontSize: 12, color: "#94A3B8" }}>No repairs.</div>;
      return (
        <div>
          {reps.map((r) => (
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
            // SELECTING AN ORDER AND SELECTING ITS DEAL ARE THE SAME SELECTION, which is
            // why selCode holds a SHORT CODE and not an order id. Carolyn asked for "a deal,
            // or an order"; pick the order and its deal lights up in the card above, because
            // they are the same building. Two independent selections could disagree, and
            // "which one am I looking at" is the entire problem being fixed here.
            const sel = !!o.short_code && activeCode === o.short_code;
            return (
              <div key={o.id}
                style={{ display: "flex", alignItems: "stretch", background: sel ? "#EEF2FF" : "#F8FAFC",
                  border: "1px solid " + (sel ? ACCENT : "#E2E8F0"), borderRadius: 6, marginBottom: 5, overflow: "hidden" }}>
                <button onClick={() => { if (o.short_code) setSelCode(sel ? null : o.short_code); }}
                  aria-pressed={sel} disabled={!o.short_code}
                  title={o.short_code ? (sel ? "Showing this order — click to clear" : "Show this order's stages, build and delivery") : ""}
                  style={{ flex: 1, minWidth: 0, textAlign: "left", background: "transparent", border: "none",
                    padding: "7px 9px", cursor: o.short_code ? "pointer" : "default" }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: ACCENT }}>
                    <span style={{ color: sel ? ACCENT : "#CBD5E1", marginRight: 6 }}>{sel ? "●" : "○"}</span>
                    #{o.order_no}{what ? ` · ${what}` : ""}
                  </div>
                  <div style={{ fontSize: 11, color: "#64748B", marginLeft: 18 }}>
                    {fmtDate(o.ordered_at)}
                    {o.total_cents != null ? ` · $${(o.total_cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : ""}
                  </div>
                </button>
                {onOpenOrder && (
                  <button onClick={() => onOpenOrder(o.id)} title="Open this order"
                    style={{ background: "transparent", border: "none", borderLeft: "1px solid " + (sel ? ACCENT : "#E2E8F0"),
                      padding: "0 10px", fontSize: 15, color: "#94A3B8", cursor: "pointer" }}>›</button>
                )}
              </div>
            );
          })}
          {os.length === 0 && <div style={{ fontSize: 12, color: "#94A3B8" }}>No orders yet. One appears when an estimate is signed.</div>}
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
                  <CrmOwnerPicker edit={edit} setEdit={setEdit} team={data.team} />
                  {/* DELIVERY, then MAILING/BILLING (188). Carolyn 2026-09-04 @1:14:06. The first
                      four columns are the DELIVERY address and keep that meaning — the scheduler
                      builds its destination from these same submitted values, so relabelling them
                      would re-point live stops at a billing address with nothing raising. */}
                  <CrmEditHead hint="where the building goes">Delivery address</CrmEditHead>
                  <CrmAddressFields edit={edit} setEdit={setEdit} keys={CRM_ADDR_DELIVERY} />
                  <CrmEditHead hint="leave blank if it is the same">Mailing / billing address</CrmEditHead>
                  <CrmAddressFields edit={edit} setEdit={setEdit} keys={CRM_ADDR_BILLING} />
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
    if (key === "tax") {
      const d = crmSsQuoteDesign(ctx);
      if (!d) return null;
      // Keyed by the deal, so picking another deal on a contact starts a fresh read rather than
      // showing the last one's tax under the new one's name.
      return (
        <QuoteSalesTaxCard key={d.short_code} clientId={clientId} shortCode={d.short_code}
          viewingLabel={viewingLabel} totalCentsHint={d.total_cents != null ? d.total_cents : null}
          canEditDesign={canEditDesigns} canVerify={canVerifyTax} canReadTaxSettings={canReadTaxSettings}
          onChanged={load} />
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
      {/* The old status ladder, only where there is no pipeline block (CrmStageBar says when). */}
      {kind === "design" && !pipe && <CrmStageBar status={record.status} />}
      {(() => {
        // The design these rails are about: the record itself on a deal, the PICKED deal on
        // a contact. Null on a contact with nothing picked, which reads as "no invoice" and
        // hides Build/Delivery — correct, and the sales row is gone for the same reason.
        const railDesign = kind === "contact" ? activeDeal : record;

        // THE DEAL'S PIPELINE (C35, Carolyn 2026-10-12): "Instead of this saying sales ... I
        // want this up here to say shed deals with the stage that it's in." The first row is
        // named after the pipeline the picked deal is in and draws THAT pipeline's stages, the
        // one it is in lit; picking a deal in another pipeline switches it. On a design record
        // it is the design's own card. The hard-coded ladder below is only for a record with no
        // pipeline block (CrmStageBar says when).
        const pipeRow = pipe ? crmPipeBarRow(pipe, barDeal) : null;

        // SALES (the old ladder): on a contact only (a design draws CrmStageBar above), and
        // only once a deal is PICKED.
        //
        // ⚠️ THIS USED TO AUTO-PICK designs[0], "the newest deal", and that auto-pick IS the
        // bug. Carolyn, 2026-09-02, on a contact holding four quotes: "there's three, four
        // quotes in here. Which one the heck is it when I'm in a contact? ... what is it
        // displaying up here? ... this should not show up here, unless one of these is
        // selected, so you know which one you're seeing." A ladder drawn for a deal the
        // reader did not choose and cannot identify is worse than no ladder: it looks like
        // an answer. Defaulting to the newest would be the same bug with a nicer comment.
        const salesIdx = activeDeal
          ? Math.max(0, CRM_STAGES.findIndex((s) => s.kind === (CRM_STAGE_FOR_STATUS[normStatus(activeDeal.status)] || "new")))
          : null;

        // Scope build/delivery to the picked deal. crm_record computes both over EVERY code
        // this contact owns, so without this the rails would mix four buildings into one
        // ladder — the same "what am I looking at" problem one level down. Every row carries
        // its own design_short_code, so this is pure client-side filtering, no server change.
        const forDeal = (rows) => (activeCode ? (rows || []).filter((r) => r.design_short_code === activeCode) : (rows || []));

        // BUILD: the tenant's OWN stages, in their own order. Names are editable, so the
        // ladder is whatever this builder configured, never a hard-coded list.
        const bStages = (data.stages || []).map((s) => ({ name: s.name }));
        const firstJob = forDeal(data.build)[0];
        const bIdx = firstJob
          ? (() => { const i = (data.stages || []).findIndex((s) => s.id === firstJob.stage_id); return i < 0 ? null : i; })()
          : null;
        // DELIVERY: the fixed three-value ladder on delivery_loads. A stop with a
        // delivered_at is delivered even if its load has not been closed out.
        const stop = forDeal(data.delivery)[0];
        const dIdx = !stop ? null
          : stop.delivered_at ? 2
          : stop.load ? Math.max(0, ["planned", "out", "delivered"].indexOf(stop.load.status))
          : 0;

        // ⚠️ THE ROW MUST BE CONDITIONAL, NOT THE INDEX. Setting bIdx = null does NOT drop
        // the row — CrmChevronRail renders an all-idle rail for idx == null deliberately
        // ("not started is not stage zero"), and CrmStageDots only filters rows with no
        // stages. Nulling the whole row object is the only thing that removes it.
        //
        // Carolyn: "can we make this like hide this if it doesn't have an invoice?" Build and
        // Delivery only — the Sales rail is what a pipeline IS for, and hiding it on an
        // un-invoiced quote would remove the ladder from every deal still being sold. Six
        // idle chevrons on an un-invoiced deal claim there is a ladder to be on; that is what
        // reads as broken. The permission check stays FIRST, so a reader without
        // build_schedule:view keeps their own reason and the invoice rule never speaks for it.
        const invoiced = crmHasInvoice(railDesign);
        return (
          <CrmStageDots rows={[
            pipeRow || (!pipe && kind === "contact" && activeDeal ? { key: "sales", label: "Sales", stages: CRM_STAGES, idx: salesIdx, emptyLabel: "No deals yet" } : null),
            data.build && invoiced ? { key: "build", label: "Build", stages: bStages, idx: bIdx, emptyLabel: "Not scheduled" } : null,
            data.delivery && invoiced ? { key: "delivery", label: "Delivery", stages: [{ name: "Planned" }, { name: "Out" }, { name: "Delivered" }], idx: dIdx, emptyLabel: "Not scheduled" } : null,
          ].filter(Boolean)} />
        );
      })()}

      <div style={{ display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 260px", minWidth: 240, maxWidth: 360 }}>
          {/* In the reader's own order (My Profile). CrmRecordSkeleton doesn't follow it: its
              blocks are untitled placeholders, so there is nothing there to arrange. */}
          {crmOrderSections(CRM_SECTIONS.filter((s) => s.when(ctx)), cardOrder && cardOrder[kind]).map((s) => (
            <div key={s.key} data-ss-crm-section={s.key} style={{ ...S.card, marginBottom: 10 }}>
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
                    onClick={() => {
                      if (!on) return;
                      setTab(t.key);
                      // Call and SMS DO something as they open: Call dials (one press, like the
                      // phone it is), SMS finds out whether the thread belongs in My Synergy Phone.
                      if (t.key === "call") startCall();
                      else if (t.key === "sms") routeText();
                    }}
                    style={{
                      background: tab === t.key && on ? "#EEF2FF" : "transparent",
                      color: on ? (tab === t.key ? ACCENT : "#475569") : "#CBD5E1",
                      border: "none", borderRadius: 6, padding: "5px 9px", fontSize: 12,
                      fontWeight: 700, cursor: on ? "pointer" : "not-allowed",
                    }}>{t.label}</button>
                );
              })}
            </div>

            {/* NOT ONLY A TOOLTIP. A greyed tab explains itself on hover, which is no
                explanation on a touch screen and none at all to someone who never hovers —
                and with every writable tab off, the panel below is an empty card. Say what is
                missing, and say what still works: the design, its quotes and its schedule are
                Simple Layout and are NOT affected, which is the half a reader assumes is gone
                the moment a page tells them something is locked. */}
            {!crmUnlocked && (
              <div style={{ background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 8, padding: "10px 12px", fontSize: 12.5, color: "#475569", lineHeight: 1.55 }}>
                Notes, activities, email, texts and customer files are part of the <strong>built-in CRM</strong>,
                which isn&rsquo;t on this subscription yet. This design, its estimates, its documents and its
                build and delivery schedule are unaffected.
                {onSeeBilling ? (
                  <>{" "}
                    <button onClick={onSeeBilling}
                      style={{ background: "none", border: "none", padding: 0, color: ACCENT, fontSize: 12.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", textDecoration: "underline" }}>
                      See Billing
                    </button>
                  </>
                ) : null}
              </div>
            )}

            {/* ── MY SYNERGY PHONE: the Call hand-off ─────────────────────────────────────
                Nothing here places a call; it reports what My Synergy Phone said. Every state names
                what to do next, because a Call button that "did nothing" is the report nobody
                can act on. */}
            {tab === "call" && phoneUi && phoneUi.what === "call" && (
              <div style={{ marginBottom: 12 }} data-ss-phone-panel="call">
                {phoneUi.kind === "checking" && (
                  <div style={{ fontSize: 12.5, color: "#64748B" }}>Starting the call in My Synergy Phone…</div>
                )}
                {phoneUi.kind === "calling" && (
                  <div style={{ ...S.okMsg, marginBottom: 0 }}>
                    Calling <strong>{phoneDisplay(phoneUi.to)}</strong> in My Synergy Phone. The call runs there, so you can
                    keep working on this page.
                  </div>
                )}
                {phoneUi.kind === "app" && (
                  <>
                    <div style={{ fontSize: 12.5, color: "#475569", marginBottom: 8 }}>
                      Opening the My Synergy Phone app to call <strong>{phoneDisplay(phoneUi.to)}</strong>. If nothing happens,
                      the app isn't on this phone yet.
                    </div>
                    <SsPhoneInstallCard what="call" mobile />
                  </>
                )}
                {phoneUi.kind === "install" && <SsPhoneInstallCard what="call" fromRecord />}
                {phoneUi.kind === "error" && <div style={{ ...S.err, marginBottom: 0 }}>{phoneUi.text}</div>}
              </div>
            )}

            {/* The thread opened in My Synergy Phone instead of here. One link back to the composer,
                because a person who wants to type it here should never be stuck. */}
            {tab === "sms" && tabOn("sms") && canEdit && data.contact && data.contact.phone && smsViaPhone && (
              <div style={{ marginBottom: 12 }} data-ss-phone-panel="text">
                {phoneUi.kind === "checking" ? (
                  <div style={{ fontSize: 12.5, color: "#64748B" }}>Opening the conversation in My Synergy Phone…</div>
                ) : (
                  <div style={{ ...S.okMsg, marginBottom: 0 }}>
                    The conversation with <strong>{phoneUi.to ? phoneDisplay(phoneUi.to) : data.contact.phone}</strong> is open in My Synergy Phone.{" "}
                    <button type="button" onClick={() => setSmsHere(true)}
                      style={{ background: "none", border: "none", padding: 0, color: ACCENT, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", textDecoration: "underline" }}>
                      Write it here instead
                    </button>
                  </div>
                )}
              </div>
            )}
            {tab === "sms" && tabOn("sms") && canEdit && data.contact && data.contact.phone && !smsViaPhone && (
              <div style={{ marginBottom: 12 }}>
                {/* Why the composer is here rather than My Synergy Phone, when that is news. */}
                {phoneUi && phoneUi.what === "text" && phoneUi.kind === "install" && <SsPhoneInstallCard what="text" compact />}
                {phoneUi && phoneUi.what === "text" && phoneUi.kind === "elsewhere" && (
                  <div style={{ fontSize: 12, color: "#64748B", marginBottom: 7 }}>{phoneUi.text}</div>
                )}
                <div style={{ fontSize: 11.5, color: "#64748B", marginBottom: 5 }}>
                  To <strong>{data.contact.phone}</strong>
                  {data.sms && data.sms.from ? <> — they see <strong>{data.sms.from}</strong>, this account&rsquo;s number.</> : null}
                </div>
                {/* Opted out is not an error state to discover by pressing Send. STOP is a
                    legal instruction, so the composer says so and offers no box. Worded by why
                    (crm_record's optOutReason, 2026-10-13): an opt-out the team recorded or an
                    import brought in is not a STOP, and saying so would be untrue. A server
                    without the field says STOP, as before. */}
                {data.sms && data.sms.optedOut ? (
                  <div style={{ ...S.err, marginBottom: 0 }}>
                    {data.sms.optOutReason === "team"
                      ? <>Your team recorded that this customer doesn&rsquo;t want texts, so we can&rsquo;t text them.</>
                      : data.sms.optOutReason === "other"
                        ? <>This customer opted out of texts, so we can&rsquo;t text them.</>
                        : <>This customer replied STOP, so we can&rsquo;t text them.</>}
                    {" "}They can reply START to that same number to opt back in.
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
                        {/* Two lines, not one (2026-10-05): "how they gave it" is a short story —
                            where, when, who asked — and a one-line box hid most of it as it was typed. */}
                        <textarea value={consentNote} onChange={(e) => setConsentNote(e.target.value)}
                          rows={2} maxLength={200} data-ss-consent-note=""
                          placeholder="How they gave it — e.g. asked us at the lot on 12 Aug (optional)"
                          style={{ ...S.input, width: "100%", boxSizing: "border-box", marginTop: 8, fontSize: 12.5, resize: "vertical", display: "block", lineHeight: 1.45 }} />
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
                    <textarea ref={textBoxRef} value={text} onChange={(e) => setText(e.target.value)} rows={4}
                      maxLength={1600}
                      placeholder="Text this customer…"
                      style={{ ...S.input, width: "100%", boxSizing: "border-box", resize: "vertical" }} />
                    <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 5, flexWrap: "wrap" }}>
                      {quickSendsOn && (
                        <CrmQuickSendPicker channel="sms" quick={quick} onOpen={loadQuickSends}
                          onInsert={(q) => insertQuickSend(q, "sms")}
                          fill={{ contactName: data.contact && data.contact.name, myName: quick && quick.myName }} />
                      )}
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
            {tab === "email" && tabOn("email") && canEdit && data.contact && data.contact.email && (
              <div style={{ marginBottom: 12 }}>
                {/* WHERE A REPLY GOES follows the server's rule (_shared/repReplyTo.ts): the writer's
                    own address, except in view-as, where CSM Synergy staff are never put on a
                    builder's email and the copy goes to the customer's assigned rep instead (or the
                    send is refused when no reply could reach anyone). viewingLabel is set only in
                    view-as. Since 2026-10-07 the inbox copy is opt-in per person (replyCopy, My
                    Profile), so with it off this line never promises the inbox: the reply comes
                    back to the record, and to the inbox only while the company hasn't set up
                    replies (the server keeps the address then, so a reply reaches somebody).
                    ⚠️ ALL THREE LINES CARRY THAT "UNTIL REPLIES ARE SET UP" (review 2026-10-07).
                    This page can't see the email settings, and on an account without them the
                    record never gets the reply: it goes to the writer's inbox alone, and in
                    view-as to the assigned rep whatever their switch says. And the OFF line says
                    files aren't kept on the record (email-inbound stores the words only), the same
                    sentence as the My Profile card in 08-integrations.jsx. */}
                <div style={{ fontSize: 11.5, color: "#64748B", marginBottom: 5 }}>
                  {viewingLabel
                    ? <>To <strong>{data.contact.email}</strong> — you're viewing as {viewingLabel}, so replies won't come to you. They come back to this record, and to this customer's assigned rep if they've switched reply copies on (until this company sets up replies, to the rep only).</>
                    : replyCopy === true
                      ? <>To <strong>{data.contact.email}</strong> — replies come back here and to your inbox (just your inbox until your company sets up replies).</>
                      : <>To <strong>{data.contact.email}</strong> — replies come back to this record (your inbox until your company sets up replies). Files a customer attaches aren't kept on the record yet: switch on reply copies in My Profile if you need them.</>}
                </div>
                <input value={mail.subject} onChange={(e) => setMail((p) => ({ ...p, subject: e.target.value }))}
                  placeholder="Subject" style={{ ...S.input, width: "100%", boxSizing: "border-box", marginBottom: 5 }} />
                <textarea ref={mailBodyRef} value={mail.body} onChange={(e) => setMail((p) => ({ ...p, body: e.target.value }))} rows={5}
                  placeholder="Write to this customer…"
                  style={{ ...S.input, width: "100%", boxSizing: "border-box", resize: "vertical" }} />
                {/* THE SIGNATURE, WHERE SHE IS TYPING. Carolyn 2026-10-01: "if I'm sitting here
                    typing a message, I want to see my signature right here." crm_send_email adds
                    it server-side (_shared/emailSignature.ts), so this is a preview of what goes
                    out, on one line; the full text is in the tooltip. Leaving for My Profile
                    asks first when the email has words in it, because the record unmounts and
                    the draft is not kept anywhere. */}
                {emailSignature !== null && (
                  <div style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 11.5, color: "#94A3B8", marginTop: 4 }}>
                    <span title={emailSignature || undefined}
                      style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {emailSignature
                        ? "Your signature is added: " + emailSignature.split("\n").map((l) => l.trim()).filter(Boolean).join(" · ")
                        : "No email signature yet."}
                    </span>
                    {onEditProfile && (
                      <a href={ssPagePath("settings", "myprofile")}
                        onClick={ssNavClick(() => {
                          if ((mail.subject.trim() || mail.body.trim())
                            && !window.confirm("Leave this email for My Profile? What you've written here won't be kept.")) return;
                          onEditProfile();
                        })}
                        style={{ color: ACCENT, fontWeight: 700, whiteSpace: "nowrap", textDecoration: "none" }}>
                        {emailSignature ? "Edit in My Profile" : "Add one in My Profile"}
                      </a>
                    )}
                  </div>
                )}
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 5, flexWrap: "wrap" }}>
                  {/* QUICK SENDS. Insert fills the body above; Send email is still the only way out. */}
                  {quickSendsOn && (
                    <CrmQuickSendPicker channel="email" quick={quick} onOpen={loadQuickSends}
                      onInsert={(q) => insertQuickSend(q, "email")}
                      fill={{ contactName: data.contact && data.contact.name, myName: quick && quick.myName }} />
                  )}
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
            {tab === "activity" && tabOn("activity") && canEdit && (
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
            {tab === "files" && tabOn("files") && canEdit && data.contact && data.contact.id && (
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
                  Images, PDFs, Word documents or text — up to 25&nbsp;MB each. They appear below, under Files.
                </span>
                {upMsg && upMsg.err && <div style={{ ...S.err, marginTop: 7 }}>{upMsg.err}</div>}
                {upMsg && upMsg.ok && <div style={{ ...S.okMsg, marginTop: 7 }}>{upMsg.ok}</div>}
              </div>
            )}
            {/* INVOICE. Invoicing lives on the order, which is where payments, change orders
                and the schedule already are — a second invoice button on a second screen is
                how two sources of truth for money get built. So this routes rather than
                duplicates, and says plainly what the customer still has to do. */}
            {tab === "invoice" && tabOn("invoice") && (kind === "design" ? record : activeDeal) && (
              <div style={{ marginBottom: 12, background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 8, padding: "10px 13px" }}>
                <div style={{ fontSize: 12.5, color: "#475569" }}>
                  This estimate is accepted, so it can be invoiced. Invoicing happens on the order — with the
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
            {tab === "note" && tabOn("note") && canEdit && (
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
                    {/* Completing an activity is a contacts:'edit' write (crm_complete_activity), so
                        it is offered only to someone who may change this customer — not to a
                        View holder or someone on Own · View (migration 286), who used to get a
                        live box that 403'd on click. */}
                    <input type="checkbox" disabled={!canEdit}
                      title={canEdit ? undefined : (!crmUnlocked ? CRM_LOCKED_HINT : "You don't have permission to complete activities.")}
                      style={canEdit ? undefined : { cursor: "not-allowed" }}
                      onChange={async (e) => {
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
                    {/* WHICH building this is about. crm_record has always selected
                        short_code here and thrown it away; on a contact with four deals
                        "Call about the door" tells you nothing without it. The History feed
                        already prints the code the same way — this is that, one list up. */}
                    {f.short_code && <span style={{ fontSize: 11, color: "#CBD5E1" }}>· {f.short_code}</span>}
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
                  /* Lit from `active`, the chip the list is really filtered by: a chip asked for
                     that this record doesn't show (initialChip "messages" where texting is off)
                     filters by All, and All is what has to look selected. */
                  <button key={c.key} onClick={() => setChip(c.key)} aria-pressed={active.key === c.key} data-ss-crm-chip={c.key}
                    style={{
                      background: active.key === c.key ? ACCENT : "#F1F5F9", color: active.key === c.key ? "#FFF" : "#475569",
                      border: "none", borderRadius: 999, padding: "3px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer",
                    }}>{c.label} ({n})</button>
                );
              })}
            </div>
            {feed.length === 0 ? (
              <div style={{ fontSize: 12, color: "#94A3B8" }}>Nothing here yet.</div>
            ) : feed.map((e) => (
              <div key={e.id} style={{ display: "flex", gap: 9, padding: "7px 0", borderTop: "1px solid #F1F5F9" }}>
                {/* A missed call and a waiting voicemail are the two events someone has to
                    ACT on, so their dot is the one coloured thing in a grey column. */}
                <div style={{ width: 8, height: 8, borderRadius: 99, background: e.type === "call_missed" ? "#F87171" : e.type === "voicemail" ? "#F59E0B" : "#CBD5E1", marginTop: 5, flexShrink: 0 }} />
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
                      <div style={{ fontSize: 11, fontWeight: 800, color: "#1D4ED8", marginBottom: 2, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        <span>↩ {e.actor || "Customer"} replied</span>
                        {/* NOTHING IN THE PIPELINE PROVES A REPLY IS REALLY FROM THE CUSTOMER.
                            A forged From renders here as their own words, in a card designed
                            to look exactly like them speaking. The receiving side's SPF/DKIM/
                            DMARC verdict was stored on every row and read by nobody; this is
                            it reaching a human.

                            Shown ONLY when the news is bad or absent. A verified sender gets
                            no chip at all — badging the normal case trains people to ignore
                            the badge, and the whole value here is that the chip is rare.

                            null is NOT false: "the provider told us nothing" is its own state
                            and says so, because a message we know nothing about is not a
                            message we vouched for. */}
                        {e.meta && e.meta.senderVerified === false && (
                          <span title={e.meta.senderVerdict || ""} style={{ fontSize: 10, fontWeight: 800, color: "#991B1B", background: "#FEE2E2", border: "1px solid #FCA5A5", borderRadius: 4, padding: "1px 5px" }}>
                            SENDER NOT VERIFIED
                          </span>
                        )}
                        {e.meta && e.meta.senderVerified === null && (
                          <span style={{ fontSize: 10, fontWeight: 700, color: "#92400E", background: "#FEF3C7", border: "1px solid #FCD34D", borderRadius: 4, padding: "1px 5px" }}>
                            SENDER UNCHECKED
                          </span>
                        )}
                      </div>
                      {/* The bare address next to the display name: "Bob Smith" is chosen by
                          the sender, the address is what actually arrived. */}
                      {e.meta && e.meta.from && e.meta.senderVerified !== true && (
                        <div style={{ fontSize: 10.5, color: "#64748B", marginBottom: 2 }}>{e.meta.from}</div>
                      )}
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
                      <div style={{ fontSize: 13, fontWeight: 600, color: "#1E293B" }}>
                        {e.title}
                        {/* Opened / Delivered / Bounced (migration 262). Only our own emails
                            carry it; the customer's replies are drawn above. */}
                        {e.type === "email" && <SsEmailDeliveryChip meta={e.meta} />}
                      </div>
                      {/* Our own emails and texts keep their line breaks, the way the
                          customer's replies above do: a conversation email's body is the
                          words someone typed (migration 261). Every other email body here is
                          one line (a document's subject, or "Emailed to …"), so nothing else
                          changes. */}
                      {/* An open activity's body is the server's `Due ${due_at}` — the raw
                          timestamptz ("Due 2026-09-03T12:00:00+00:00"). The date is formatted
                          here from meta.dueAt, the same way Focus prints it a few lines up. */}
                      {e.body && <div style={{ fontSize: 12, color: "#64748B", marginTop: 2, whiteSpace: e.type === "email" || e.type === "sms" ? "pre-wrap" : undefined }}>
                        {e.type === "activity" && e.meta && !e.meta.done && e.meta.dueAt ? `Due ${fmtDate(e.meta.dueAt)}` : e.body}
                      </div>}
                      {/* MY SYNERGY PHONE: the voicemail itself, played from the phone-api Worker
                          (GET /voicemails/:id/audio). Only for someone the Worker will serve —
                          phone access, calling on, not an operator in view-as (their token is
                          not on this builder's team) — and only while the recording exists.
                          The server already left out every call this viewer may not see
                          (crmFeed's phone scope), so a line that is here is one the Worker
                          plays. SsVoicemailPlayer fetches nothing until Play is pressed. */}
                      {e.type === "voicemail" && e.meta && e.meta.voicemailId && !e.meta.voicemailDeleted
                        && ctx.canCall && ctx.phone.on && !ctx.viewing && ssPhoneVoicemailAudioUrl(e.meta.voicemailId) && (
                        <SsVoicemailPlayer voicemailId={e.meta.voicemailId} />
                      )}
                      {/* MY SYNERGY PHONE, CALL RECORDING (migration 263): a recorded call's
                          summary, its recording and its transcript. The summary is in the feed
                          for anyone who sees the call; Play and Show transcript ask the Worker,
                          so they follow the voicemail player's rule above. */}
                      {(e.type === "call" || e.type === "call_missed" || e.type === "voicemail") && e.meta && e.meta.callId
                        && (e.meta.summary || e.meta.recordingId) && (
                        <SsCallRecording callId={e.meta.callId} meta={e.meta}
                          canListen={!!(ctx.canCall && ctx.phone.on && !ctx.viewing)} />
                      )}
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

// ══ SALES PIPELINES (migration 301) ═══════════════════════════════════════════════════════
// Hand-moved boards of deals, for every CRM builder. Carolyn 2026-10-09: her reps cold-calling
// shed manufacturers work those prospects in a pipeline inside Structure Studio, and every
// prospect lands in Contacts. Her first one is our own account's "Manufacturer Outreach".
//
// NOT the Pipeline tab. That board (DesignsTable above) is DERIVED from designs.status and cannot
// be dragged; this one is the "local crm_stages table" its comment called the next increment.
// Different data, different tab: /portal/pipelines[/<pipeline id>].
//
// A DEAL HAS NO OWNER (Carolyn 2026-09-04: "we do not ever assign deals. We only assign contacts
// and followers"). A card shows its CONTACT's owner, and the server returns only the deals whose
// contact this person may see, so a rep limited to their own customers sees their own cards.
//
// Every read and write goes through portal-settings: the tables have no browser path at all.

// One call, answering the data or throwing an Error that carries the server's JSON body as
// `.body`, so a 409 can hand back `existingContactId` beside its sentence.
async function ssPipeCall(action, body) {
  const { data, error } = await sb.functions.invoke("portal-settings", { body: { action, ...(body || {}) } });
  if (error) {
    let b = null;
    try {
      const ctx = error.context;
      if (ctx && typeof ctx.json === "function") b = await (typeof ctx.clone === "function" ? ctx.clone() : ctx).json();
    } catch (_e) { /* no body */ }
    const e = new Error((b && b.error) || (await fnError(error)));
    e.body = b;
    throw e;
  }
  if (data && data.error) { const e = new Error(data.error); e.body = data; throw e; }
  return data || {};
}

const SS_PIPE_LAST = "ss_pipeline_last";
const ssPipeInitials = (name) => String(name || "").trim().split(/\s+/).slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join("") || "?";
// Whole days since an instant, for "4d in stage". A duration, so no local-date handling is needed.
const ssDaysSince = (iso) => (iso ? Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 86400000)) : null);
const SS_STAGE_COLORS = ["#64748B", "#0EA5E9", "#14B8A6", "#6366F1", "#8B5CF6", "#EC4899", "#F59E0B", "#F97316", "#94A3B8", "#16A34A", "#DC2626"];

// ── THE BOARD'S STATUS FILTER (Carolyn 2026-10-12) ── "We need to have a dropdown of the
// statuses up here that they can quickly filter ... I want to see all my estimates and want to see
// all my payments, a filter of one or many, and also a filter to exclude." { mode, ids }: "inc"
// shows only the cards whose status is ticked, "exc" hides them. A card has exactly ONE status, so
// a mix of the two says nothing that one of them alone can't (ticking A and B already leaves out
// everything else); one list and a switch is the whole of it. SS_NO_STATUS stands for a card that
// has no status yet.
const SS_NO_STATUS = "none";
const SS_STATUS_FILTER_OFF = { mode: "inc", ids: [] };
function ssStatusFilterKeep(statusId, f) {
  if (!f || !f.ids || !f.ids.length) return true;
  const on = f.ids.indexOf(statusId || SS_NO_STATUS) !== -1;
  return f.mode === "exc" ? !on : on;
}
function ssStatusFilterToggle(f, id) {
  const cur = f || SS_STATUS_FILTER_OFF;
  const ids = cur.ids.indexOf(id) !== -1 ? cur.ids.filter((x) => x !== id) : cur.ids.concat([id]);
  return { mode: cur.mode === "exc" ? "exc" : "inc", ids };
}
// What the closed control says: "All statuses", "Estimate Sent", "Estimate Sent +1", and
// "All but Payment Received" when it hides. Names come from the account's list, so a renamed
// status reads its new name.
function ssStatusFilterLabel(f, statuses) {
  if (!f || !f.ids || !f.ids.length) return "All statuses";
  const nameOf = (id) => {
    if (id === SS_NO_STATUS) return "No status";
    const t = (statuses || []).find((x) => x.id === id);
    return t ? t.name : "Removed status";
  };
  const names = nameOf(f.ids[0]) + (f.ids.length > 1 ? ` +${f.ids.length - 1}` : "");
  return f.mode === "exc" ? `All but ${names}` : names;
}

// ── THE BOARD IS AS WIDE AS THE PAGE, NEVER WIDER (Carolyn 2026-10-12) ── "This scroll bar is
// not going to be there. I am going to make this like the designer where it can be as wide as it
// needs to be." The board used to be a fixed-width strip of 230px columns inside a sideways
// scroller, inside the page's 1240px cap. Now the page drops that cap while the board shows
// (portal.html, `.ss-inner:has([data-ss-board-wide])`) and the stages share the width. When they
// will not all fit at SS_BOARD_COL_MIN, as many go across as fit and the rest wrap onto the next
// row in the same columns: the first row keeps the most stages side by side, which is what a board
// is for (an even 4 + 4 split would put half of them below the longest column). 140px
// keeps a six-stage pipeline in one row on a 1280 screen with a scroll bar. Columns stop growing at
// SS_BOARD_COL_MAX, so a three-stage pipeline on a wide screen does not stretch its cards across it.
const SS_BOARD_COL_MIN = 140;
const SS_BOARD_COL_MAX = 360;
const SS_BOARD_GAP = 8;
function ssBoardColumns(stages, width, min = SS_BOARD_COL_MIN, gap = SS_BOARD_GAP) {
  const n = Math.max(1, Math.floor(Number(stages) || 0));
  // Not measured yet: every stage in one row, columns shrinking to fit (they never overflow).
  if (!(width > 0)) return n;
  return Math.min(n, Math.max(1, Math.floor((width + gap) / (min + gap))));
}

// The filter's control, beside the board's search: a heading like the Owner one, a button that
// says what is filtered, and a list of the account's statuses with how many of this pipeline's
// cards have each. A tick applies at once; the × beside the button clears it in one click.
function SsStatusFilter({ statuses, deals, value, onChange }) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState({ left: 0, width: 280 });
  const wrap = useRef(null);
  const button = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const down = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); };
    const key = (e) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      if (button.current) button.current.focus();
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [open]);
  const f = value || SS_STATUS_FILTER_OFF;
  const active = f.ids.length > 0;
  const counts = {};
  (deals || []).forEach((d) => { const k = d.status_id || SS_NO_STATUS; counts[k] = (counts[k] || 0) + 1; });
  // "No status" is offered only while a card has none (or it is already ticked): every card the
  // system has touched has one, so most accounts never see the row.
  const rows = (statuses || []).map((t) => ({ id: t.id, name: t.name, color: t.color }))
    .concat(counts[SS_NO_STATUS] || f.ids.indexOf(SS_NO_STATUS) !== -1 ? [{ id: SS_NO_STATUS, name: "No status", color: "#94A3B8" }] : []);
  const label = ssStatusFilterLabel(f, statuses);
  const toggle = () => {
    if (!open) {
      const vw = document.documentElement.clientWidth || window.innerWidth || 0;
      const at = button.current ? button.current.getBoundingClientRect().left : 0;
      const width = Math.max(220, Math.min(300, vw - 16));
      // 8px inside the right edge if it can, and never past 8px from the left.
      setPlace({ left: Math.max(8 - at, Math.min(0, vw - 8 - at - width)), width });
    }
    setOpen(!open);
  };
  const seg = (on) => ({
    flex: 1, background: on ? ACCENT : "#FFF", color: on ? "#FFF" : "#334155", border: "none",
    padding: "5px 8px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
  });
  return (
    <div ref={wrap} style={{ ...FCTRL, position: "relative" }} data-ss-status-filter="">
      <span style={FLBL}>Status</span>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <button ref={button} type="button" onClick={toggle} aria-haspopup="dialog" aria-expanded={open}
          title={active ? label : "Filter the cards by status"} data-ss-status-filter-button=""
          style={{
            ...S.input, width: "auto", minWidth: 140, maxWidth: 240, padding: "6px 26px 6px 8px", textAlign: "left", cursor: "pointer",
            position: "relative", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
            borderColor: active ? ACCENT : "#CBD5E1", background: active ? "#EEF2FF" : "#FFF", color: active ? ACCENT : "#1E293B",
          }}>
          {label}
          <span aria-hidden="true" style={{ position: "absolute", right: 9, top: "50%", transform: "translateY(-50%)", fontSize: 10, color: "#64748B" }}>▾</span>
        </button>
        {active && (
          <button type="button" onClick={() => onChange(SS_STATUS_FILTER_OFF)} title="Show every status" aria-label="Clear the status filter"
            style={{ background: "transparent", border: "none", cursor: "pointer", color: "#64748B", fontSize: 18, lineHeight: 1, padding: "2px 4px", fontFamily: "inherit" }}>×</button>
        )}
      </div>
      {open && (
        <div role="dialog" aria-label="Filter by status" data-ss-status-filter-menu=""
          style={{
            position: "absolute", left: place.left, top: "calc(100% + 6px)", zIndex: 30, width: place.width,
            background: "#FFF", border: "1px solid #E2E8F0", borderRadius: 10, boxShadow: "0 10px 28px rgba(15,23,42,0.16)",
          }}>
          <div style={{ display: "flex", border: "1px solid #E2E8F0", borderRadius: 8, overflow: "hidden", margin: "10px 10px 6px" }}>
            <button type="button" aria-pressed={f.mode !== "exc"} onClick={() => onChange({ ...f, mode: "inc" })} style={seg(f.mode !== "exc")}>Show only</button>
            <button type="button" aria-pressed={f.mode === "exc"} onClick={() => onChange({ ...f, mode: "exc" })} style={seg(f.mode === "exc")}>Hide</button>
          </div>
          <div style={{ fontSize: 11.5, color: "#64748B", padding: "0 12px 6px", lineHeight: 1.4 }}>
            {f.mode === "exc" ? "Cards with a ticked status are hidden." : "Only cards with a ticked status show."}
          </div>
          <div style={{ borderTop: "1px solid #F1F5F9", padding: "4px 0" }}>
            {rows.length === 0 && <div style={{ padding: "8px 12px", fontSize: 12.5, color: "#64748B" }}>No statuses yet.</div>}
            {rows.map((t) => {
              const on = f.ids.indexOf(t.id) !== -1;
              return (
                <label key={t.id} data-ss-status-option={t.id}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 12px", cursor: "pointer", fontSize: 13, fontWeight: 600, color: "#1E293B" }}>
                  <input type="checkbox" checked={on} onChange={() => onChange(ssStatusFilterToggle(f, t.id))} />
                  <span aria-hidden="true" style={{ width: 9, height: 9, borderRadius: "50%", background: t.color || "#64748B", flexShrink: 0 }} />
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textDecoration: on && f.mode === "exc" ? "line-through" : "none" }}>{t.name}</span>
                  <span style={{ fontSize: 11.5, fontWeight: 700, color: "#94A3B8", fontVariantNumeric: "tabular-nums" }}>{counts[t.id] || 0}</span>
                </label>
              );
            })}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "8px 10px", borderTop: "1px solid #F1F5F9" }}>
            <button type="button" disabled={!active} onClick={() => onChange({ ...f, ids: [] })}
              style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0", padding: "5px 12px", fontSize: 12.5, opacity: active ? 1 : 0.5, cursor: active ? "pointer" : "default" }}>Clear</button>
            <button type="button" onClick={() => setOpen(false)} style={{ ...S.btn(ACCENT, "#FFF"), padding: "5px 14px", fontSize: 12.5 }}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── CARD STATUS (migration 302) ── Carolyn 2026-10-11: "a STATUS for all Pipeline cards ... All
// of these status's should show on the card as a pill and all have their own color."
// READ-ONLY since 2026-10-12: "those statuses are automatically set, like, it is not even possible
// for them to make the changes, it is system-driven, okay, the statuses are system-driven, 100%."
// It used to be a <select> dressed as a pill; it is a plain label now, wherever it is drawn, and
// `onChange` / `disabled` from older callers are ignored. Tinted the way StatusPill is: the colour
// at ~12% behind the colour itself.
const ssStatusTint = (hex) => (/^#[0-9A-Fa-f]{6}$/.test(hex || "") ? hex + "1F" : "#F1F5F9");
function SsStatusPill({ statuses, value, style = null }) {
  const cur = (statuses || []).find((x) => x.id === value) || null;
  const color = cur ? cur.color : "#64748B";
  return (
    <span data-ss-status-pill={value || ""} title={cur ? `${cur.name}: set automatically` : "No status yet"}
      style={{
        display: "inline-block", boxSizing: "border-box", verticalAlign: "middle",
        background: ssStatusTint(color), color, border: "1px solid " + color + "55", borderRadius: 999,
        padding: "1px 9px", fontSize: 10.5, fontWeight: 800, fontFamily: "inherit", lineHeight: "16px",
        maxWidth: 150, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        ...(style || {}),
      }}>
      {cur ? cur.name : "No status"}
    </span>
  );
}

function SsPipeModal({ title, onClose, children, width = 460 }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    const unlock = ssLockBodyScroll();
    return () => { window.removeEventListener("keydown", onKey); unlock(); };
  }, [onClose]);
  return (
    <div onClick={onClose} role="presentation"
      style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.5)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 1200 }}>
      <div role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}
        style={{ background: "#FFF", borderRadius: 12, width: `min(${width}px, 100%)`, maxHeight: "90vh", overflowY: "auto", padding: 20, boxShadow: "0 20px 50px rgba(0,0,0,0.3)", boxSizing: "border-box" }}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 14 }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: "#1E293B", flex: 1 }}>{title}</div>
          <button type="button" onClick={onClose} aria-label="Close"
            style={{ background: "none", border: "none", fontSize: 20, lineHeight: 1, color: "#94A3B8", cursor: "pointer" }}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// "+ Add lead": a contact and a deal in one step. A phone or email that is already a contact is
// refused with a way to open them, rather than a silent second deal on someone else's customer.
function SsAddLeadDialog({ pipelines, defaultPipelineId, team, ownOnly, me, onClose, onAdded, onOpenRecord }) {
  const [f, setF] = useState({ company: "", name: "", phone: "", email: "", title: "", value: "",
    pipelineId: defaultPipelineId || (pipelines[0] && pipelines[0].id) || "", stageId: "", ownerUserId: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [existing, setExisting] = useState(null);
  const pipe = pipelines.find((p) => p.id === f.pipelineId) || pipelines[0];
  const openStages = pipe ? pipe.stages.filter((s) => s.kind !== "lost") : [];
  const stageId = f.stageId && openStages.some((s) => s.id === f.stageId) ? f.stageId : (openStages[0] && openStages[0].id) || "";
  const set = (k) => (e) => { const v = e.target.value; setF((p) => ({ ...p, [k]: v })); };
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr(null); setExisting(null);
    try {
      const r = await ssPipeCall("crm_create_lead", {
        company: f.company, name: f.name, phone: f.phone, email: f.email, title: f.title, value: f.value,
        stageId, ownerUserId: f.ownerUserId || null,
      });
      onAdded(r);
    } catch (e2) {
      setErr(e2.message);
      if (e2.body && e2.body.existingContactId) setExisting(e2.body.existingContactId);
    } finally { setBusy(false); }
  };
  const row = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10, marginBottom: 10 };
  return (
    <SsPipeModal title="Add a lead" onClose={onClose} width={520}>
      <form onSubmit={submit}>
        <div style={row}>
          <label><span style={S.lbl}>Company</span><input style={S.input} value={f.company} onChange={set("company")} autoFocus placeholder="Acme Sheds" /></label>
          <label><span style={S.lbl}>Contact name</span><input style={S.input} value={f.name} onChange={set("name")} placeholder="Pat Jones" /></label>
        </div>
        <div style={row}>
          <label><span style={S.lbl}>Phone</span><input style={S.input} value={f.phone} onChange={set("phone")} inputMode="tel" placeholder="(816) 555-0100" /></label>
          <label><span style={S.lbl}>Email</span><input style={S.input} value={f.email} onChange={set("email")} type="email" placeholder="pat@acmesheds.com" /></label>
        </div>
        <div style={row}>
          <label><span style={S.lbl}>Pipeline</span>
            <select style={S.input} value={f.pipelineId} onChange={(e) => { const v = e.target.value; setF((p) => ({ ...p, pipelineId: v, stageId: "" })); }}>
              {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label><span style={S.lbl}>Stage</span>
            <select style={S.input} value={stageId} onChange={set("stageId")}>
              {openStages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        </div>
        <div style={row}>
          <label><span style={S.lbl}>Deal name (optional)</span><input style={S.input} value={f.title} onChange={set("title")} placeholder="Annual subscription" /></label>
          <label><span style={S.lbl}>Value (optional)</span><input style={S.input} value={f.value} onChange={set("value")} inputMode="decimal" placeholder="$2,500" /></label>
        </div>
        {/* Someone limited to their own customers always owns what they add (the server enforces
            it too), so the picker is offered only to people who can assign. */}
        {!ownOnly && (
          <label style={{ display: "block", marginBottom: 12 }}><span style={S.lbl}>Owner</span>
            <select style={S.input} value={f.ownerUserId} onChange={set("ownerUserId")}>
              <option value="">Unassigned</option>
              {(team || []).map((m) => <option key={m.userId} value={m.userId}>{m.name || "Team member"}{m.userId === me ? " (me)" : ""}</option>)}
            </select>
          </label>
        )}
        {err && (
          <div style={S.err}>
            {err}
            {existing && onOpenRecord && (
              <> <button type="button" onClick={() => onOpenRecord(existing)}
                style={{ background: "none", border: "none", color: "#DC2626", textDecoration: "underline", fontWeight: 800, cursor: "pointer", fontFamily: "inherit", fontSize: 13, padding: 0 }}>Open them</button></>
            )}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" onClick={onClose} style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0" }}>Cancel</button>
          <button type="submit" disabled={busy || !stageId} style={{ ...S.btn(ACCENT, "#FFF"), opacity: busy ? 0.6 : 1 }}>{busy ? "Adding…" : "Add lead"}</button>
        </div>
      </form>
    </SsPipeModal>
  );
}

// Moving a deal to a LOST stage asks why: the pipeline's own list first, then "Other".
function SsLostReasonDialog({ reasons, onCancel, onPick }) {
  const list = reasons || [];
  const [pick, setPick] = useState(list[0] || "__other");
  const [other, setOther] = useState("");
  const useOther = pick === "__other";
  const value = useOther ? other.trim() : pick;
  return (
    <SsPipeModal title="Why was it lost?" onClose={onCancel} width={400}>
      {list.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
          {list.concat(["__other"]).map((r) => (
            <label key={r} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, fontWeight: 600, color: "#1E293B", cursor: "pointer" }}>
              <input type="radio" name="ss-lost" checked={pick === r} onChange={() => setPick(r)} />
              {r === "__other" ? "Other…" : r}
            </label>
          ))}
        </div>
      )}
      {useOther && <input style={{ ...S.input, marginBottom: 12 }} autoFocus value={other} onChange={(e) => setOther(e.target.value)} placeholder="What happened?" maxLength={200} />}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button type="button" onClick={onCancel} style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0" }}>Cancel</button>
        <button type="button" disabled={!value} onClick={() => onPick(value)} style={{ ...S.btn("#DC2626", "#FFF"), opacity: value ? 1 : 0.5 }}>Mark lost</button>
      </div>
    </SsPipeModal>
  );
}

// Stages, colours, kinds and lost reasons for one pipeline, or a new pipeline. settings_crm:edit
// (owner/admin by preset); the server refuses everyone else whatever this shows. Stages are the
// builder's to shape (Carolyn 2026-10-12: "they can make them whatever they want"). A stage never
// sets a card's status: statuses are system-driven (migration 303 retired 302's stage link).
function SsPipelineEditor({ pipeline, onClose, onCreated }) {
  const [name, setName] = useState(pipeline ? pipeline.name : "");
  const [stages, setStages] = useState(pipeline ? pipeline.stages.map((s) => ({ ...s })) : []);
  const [reasons, setReasons] = useState(pipeline ? (pipeline.lostReasons || []).join("\n") : "");
  const [newStage, setNewStage] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const run = async (fn) => { setBusy(true); setErr(null); try { await fn(); } catch (e) { setErr(e.message); } finally { setBusy(false); } };

  if (!pipeline) {
    return (
      <SsPipeModal title="New pipeline" onClose={onClose} width={400}>
        <label style={{ display: "block", marginBottom: 12 }}><span style={S.lbl}>Name</span>
          <input style={S.input} autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Dealer recruiting" /></label>
        <p style={{ fontSize: 12, color: "#64748B", margin: "0 0 12px" }}>It starts with New, Won and Lost. Rename them and add stages next.</p>
        {err && <div style={S.err}>{err}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" onClick={onClose} style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0" }}>Cancel</button>
          <button type="button" disabled={busy || !name.trim()} style={S.btn(ACCENT, "#FFF")}
            onClick={() => run(async () => { const r = await ssPipeCall("crm_pipeline_save", { name }); onCreated(r.id); })}>Create</button>
        </div>
      </SsPipeModal>
    );
  }

  const saveStage = (s, patch) => run(async () => {
    await ssPipeCall("crm_stage_save", { id: s.id, ...patch });
    setStages((all) => all.map((x) => (x.id === s.id ? { ...x, ...patch } : x)));
  });
  const move = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= stages.length) return;
    const next = stages.slice(); const t = next[i]; next[i] = next[j]; next[j] = t;
    setStages(next);
    run(() => ssPipeCall("crm_stages_reorder", { pipelineId: pipeline.id, ids: next.map((s) => s.id) }));
  };
  const addStage = () => run(async () => {
    const label = newStage.trim();
    const r = await ssPipeCall("crm_stage_save", { pipelineId: pipeline.id, name: label, kind: "open" });
    // The server adds it last; an open stage belongs before the first won/lost one.
    const next = stages.slice();
    const at = next.findIndex((x) => x.kind !== "open");
    next.splice(at < 0 ? next.length : at, 0, { id: r.id, name: label, color: "#64748B", kind: "open" });
    setStages(next); setNewStage("");
    if (at >= 0) await ssPipeCall("crm_stages_reorder", { pipelineId: pipeline.id, ids: next.map((s) => s.id) });
  });
  const small = { ...S.btn("#F1F5F9", "#334155"), padding: "4px 8px" };
  return (
    <SsPipeModal title={`Edit “${pipeline.name}”`} onClose={onClose} width={560}>
      <label style={{ display: "block", marginBottom: 14 }}><span style={S.lbl}>Pipeline name</span>
        <input style={S.input} value={name} maxLength={80} onChange={(e) => setName(e.target.value)}
          onBlur={() => { if (name.trim() && name.trim() !== pipeline.name) run(() => ssPipeCall("crm_pipeline_save", { id: pipeline.id, name })); }} /></label>
      <span style={S.lbl}>Stages</span>
      <p style={{ fontSize: 12, color: "#64748B", margin: "0 0 6px", lineHeight: 1.45 }}>
        {pipeline.feedsDesigns ? "New designs land in this pipeline, in its first open stage. " : ""}
        Name, colour and order the stages however you work. Moving a card between stages never changes its
        status: statuses are set automatically (see Settings → Pipelines).
      </p>
      <div style={{ border: "1px solid #E2E8F0", borderRadius: 8, marginBottom: 8 }}>
        {stages.map((s, i) => (
          <div key={s.id} style={{ display: "flex", gap: 6, alignItems: "center", padding: "6px 8px", borderBottom: i < stages.length - 1 ? "1px solid #F1F5F9" : "none" }}>
            <select aria-label="Colour" value={s.color} onChange={(e) => saveStage(s, { color: e.target.value })}
              style={{ width: 34, height: 28, flexShrink: 0, border: "1px solid #CBD5E1", borderRadius: 6, background: s.color, color: "transparent", cursor: "pointer" }}>
              {SS_STAGE_COLORS.concat(SS_STAGE_COLORS.includes(s.color) ? [] : [s.color]).map((c) => <option key={c} value={c} style={{ background: c, color: "#FFF" }}>{c}</option>)}
            </select>
            <input aria-label="Stage name" style={{ ...S.input, flex: 1, minWidth: 0, padding: "5px 8px" }} defaultValue={s.name} maxLength={60}
              onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== s.name) saveStage(s, { name: v }); }} />
            <select aria-label="Kind" value={s.kind} onChange={(e) => saveStage(s, { kind: e.target.value })} style={{ ...S.input, width: 80, padding: "5px 6px" }}>
              <option value="open">Open</option><option value="won">Won</option><option value="lost">Lost</option>
            </select>
            <button type="button" title="Move up" disabled={busy || i === 0} onClick={() => move(i, -1)} style={small}>↑</button>
            <button type="button" title="Move down" disabled={busy || i === stages.length - 1} onClick={() => move(i, 1)} style={small}>↓</button>
            <button type="button" title="Remove stage" disabled={busy}
              onClick={() => { if (window.confirm(`Remove the “${s.name}” stage?`)) run(async () => { await ssPipeCall("crm_stage_save", { id: s.id, archive: true }); setStages((all) => all.filter((x) => x.id !== s.id)); }); }}
              style={{ ...small, background: "#FEF2F2", color: "#DC2626" }}>✕</button>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
        <input style={{ ...S.input, flex: 1 }} value={newStage} maxLength={60} onChange={(e) => setNewStage(e.target.value)} placeholder="New stage name"
          onKeyDown={(e) => { if (e.key === "Enter" && newStage.trim()) { e.preventDefault(); addStage(); } }} />
        <button type="button" disabled={busy || !newStage.trim()} style={S.btn(ACCENT, "#FFF")} onClick={addStage}>Add stage</button>
      </div>
      <label style={{ display: "block", marginBottom: 14 }}><span style={S.lbl}>Lost reasons, one per line</span>
        <textarea style={{ ...S.input, minHeight: 90 }} value={reasons} onChange={(e) => setReasons(e.target.value)}
          onBlur={() => run(() => ssPipeCall("crm_pipeline_save", { id: pipeline.id, lostReasons: reasons.split("\n") }))} /></label>
      {err && <div style={S.err}>{err}</div>}
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        {/* The pipeline new designs land in can't be removed (the server refuses it too): without it
            a new design would get no card. */}
        {pipeline.feedsDesigns ? <span /> : (
          <button type="button" disabled={busy}
            onClick={() => { if (window.confirm(`Remove the “${pipeline.name}” pipeline? It must have no deals left.`)) run(async () => { await ssPipeCall("crm_pipeline_save", { id: pipeline.id, archive: true }); onClose(); }); }}
            style={S.btn("#FEF2F2", "#DC2626")}>Remove pipeline</button>
        )}
        <button type="button" disabled={busy} onClick={onClose} style={S.btn(ACCENT, "#FFF")}>Done</button>
      </div>
    </SsPipeModal>
  );
}

// `embedded`: drawn inside a card its host owns, so no card or title of its own. onOpenRecord
// (shortCode, contactId): a design card opens its customer with that deal picked, a lead card (no
// design) opens its contact.
// HOSTED BY THE CONTACTS HUB (2026-10-12): `hosted` hides the pipeline picker, because the hub's tab
// row IS the picker now (one tab per pipeline, Carolyn: "every pipeline that they create will be
// next, next, next"), and urlPipelineId names the tab's pipeline. `onPipelines` hands the hub every
// fresh list this board loads, so a pipeline added, renamed or removed from "+ Pipeline" or "Edit
// stages" shows in the tab row at once.
function SalesPipelines({ clientId, viewing = false, embedded = false, hosted = false, refreshKey = 0, urlPipelineId = null, onPickPipeline = null, onPipelines = null, onOpenRecord = null }) {
  const [meta, setMeta] = useState(null);      // { pipelines, team, canManage, canWrite, ownOnly, me }
  const [deals, setDeals] = useState(null);    // null = loading
  const [err, setErr] = useState(null);
  const [query, setQuery] = useState("");
  const [owner, setOwner] = useState("all");
  const [statusFilter, setStatusFilter] = useState(SS_STATUS_FILTER_OFF);  // { mode, ids }, see ssStatusFilterKeep
  // The board's own width, for how many stage columns go across (ssBoardColumns). A ref callback,
  // not an effect, because the board mounts only once the pipelines are in, after the early return
  // below. Measured on a full-width wrapper, never on the grid it sizes (whose width it caps).
  const [boardW, setBoardW] = useState(0);
  const boardRO = useRef(null);
  const boardRef = useCallback((el) => {
    if (boardRO.current) { boardRO.current.disconnect(); boardRO.current = null; }
    if (!el) return;
    setBoardW(Math.round(el.getBoundingClientRect().width));
    if (typeof ResizeObserver === "function") {
      const ro = new ResizeObserver(() => setBoardW(Math.round(el.getBoundingClientRect().width)));
      ro.observe(el);
      boardRO.current = ro;
    }
  }, []);
  const [dialog, setDialog] = useState(null);  // "add" | "edit" | "new" | { lost: { deal, stage } }
  const [dragId, setDragId] = useState(null);
  const [overStage, setOverStage] = useState(null);
  const [pickedLocal, setPickedLocal] = useState(null);
  const [closeEdit, setCloseEdit] = useState(null);  // deal id whose close-date input is open

  const loadMeta = useCallback(async () => {
    try {
      const m = await ssPipeCall("crm_pipelines_list");
      setMeta(m); setErr(null);
      if (onPipelines) onPipelines(m.pipelines || []);
    }
    catch (e) { setErr(e.message); setMeta((m) => m || { pipelines: [], team: [] }); }
  }, [clientId]);
  useEffect(() => { loadMeta(); }, [loadMeta]);

  const pipelines = (meta && meta.pipelines) || [];
  let remembered = null;
  try { remembered = localStorage.getItem(SS_PIPE_LAST + ":" + clientId); } catch (_e) { /* private mode */ }
  const want = urlPipelineId || pickedLocal || remembered;
  const pipe = pipelines.find((p) => p.id === want) || pipelines[0] || null;
  const pipeId = pipe ? pipe.id : null;
  const pick = (id) => {
    try { localStorage.setItem(SS_PIPE_LAST + ":" + clientId, id); } catch (_e) { /* private mode */ }
    setPickedLocal(id);
    if (onPickPipeline) onPickPipeline(id);
  };

  const loadDeals = useCallback(async () => {
    if (!pipeId) return;
    setDeals(null);
    try { const r = await ssPipeCall("crm_deals_list", { pipelineId: pipeId }); setDeals(r.deals || []); setErr(null); }
    catch (e) { setErr(e.message); setDeals([]); }
  }, [pipeId]);
  useEffect(() => { loadDeals(); }, [loadDeals, refreshKey]);

  // Operator view-as is read-only here, as on the Pipeline board: a write would go under the
  // tenant's account with the operator's session.
  const canWrite = !!(meta && meta.canWrite) && !viewing;
  const team = (meta && meta.team) || [];
  const statuses = (meta && meta.statuses) || [];
  const teamName = (id) => { const m = team.find((x) => x.userId === id); return m ? (m.name || "Team member") : null; };

  // Optimistic: the card jumps at once, and a refusal puts it back and says why.
  // EXPECTED CLOSE DATE, from the card (Carolyn 2026-09-07: "editable straight from the card").
  // A design card's date lives on the design (set_expected_close, migration 206, the same field
  // the record shows); a lead's lives on its deal. Optimistic, like the move.
  const saveClose = async (deal, value) => {
    setCloseEdit(null);
    const iso = value || null;
    if (iso === (deal.expected_close_date || null)) return;
    const prev = deals;
    setDeals((ds) => (ds || []).map((d) => (d.id === deal.id ? { ...d, expected_close_date: iso } : d)));
    try {
      if (deal.short_code) await ssPipeCall("set_expected_close", { shortCode: deal.short_code, expectedCloseDate: iso });
      else await ssPipeCall("crm_deal_update", { id: deal.id, expectedCloseDate: iso || "" });
    } catch (e) { setDeals(prev); setErr(e.message); }
  };

  // A drag moves the STAGE only. The status is the system's (Carolyn 2026-10-12: "the statuses are
  // system-driven, 100%"), so the card keeps the one it has and shows whatever status the server
  // answers with, rather than painting one of its own. There is no way to set a status by hand here.
  const moveDeal = async (deal, stage, lostReason) => {
    const prev = deals;
    setDeals((ds) => (ds || []).map((d) => (d.id === deal.id ? { ...d, stage_id: stage.id, stage_entered_at: new Date().toISOString(), lost_reason: lostReason || null } : d)));
    try {
      const r = await ssPipeCall("crm_deal_move", { id: deal.id, stageId: stage.id, lostReason: lostReason || null });
      if (r && typeof r.status_id === "string") setDeals((ds) => (ds || []).map((d) => (d.id === deal.id ? { ...d, status_id: r.status_id } : d)));
    } catch (e) { setDeals(prev); setErr(e.message); }
  };
  const onDrop = (stage) => {
    const deal = (deals || []).find((d) => d.id === dragId);
    setDragId(null); setOverStage(null);
    if (!deal || deal.stage_id === stage.id) return;
    if (stage.kind === "lost") { setDialog({ lost: { deal, stage } }); return; }
    moveDeal(deal, stage);
  };

  const q = query.trim().toLowerCase();
  // A status that was removed since it was ticked filters nothing, so it cannot leave the board
  // blank with no way to see why.
  const statusF = {
    mode: statusFilter.mode,
    ids: statusFilter.ids.filter((id) => id === SS_NO_STATUS || statuses.some((t) => t.id === id)),
  };
  const shown = (deals || []).filter((d) => {
    const c = d.contact || {};
    if (!ssStatusFilterKeep(d.status_id, statusF)) return false;
    if (owner === "none" && c.ownerUserId) return false;
    if (owner !== "all" && owner !== "none" && c.ownerUserId !== owner) return false;
    if (!q) return true;
    const g = d.design || {};
    return [c.company, c.name, c.phone, c.email, d.title, g.estimateNumber, g.style, g.size, d.short_code].some((v) => v && String(v).toLowerCase().includes(q));
  });
  const ghost = { ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0", padding: "6px 12px" };

  if (!meta) return embedded
    ? <p style={{ fontSize: 13, color: "#64748B" }}>Loading pipelines…</p>
    : <div style={S.card}><CardHead title="Leads" /><p style={{ fontSize: 13, color: "#64748B" }}>Loading…</p></div>;

  const toolbar = (
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            {pipelines.length > 0 && !hosted && (
              <select aria-label="Pipeline" value={pipeId || ""} onChange={(e) => pick(e.target.value)}
                style={{ ...S.input, width: "auto", padding: "6px 10px", fontWeight: 700 }}>
                {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            )}
            {meta.canManage && !viewing && pipe && <button type="button" onClick={() => setDialog("edit")} style={ghost}>Edit stages</button>}
            {meta.canManage && !viewing && <button type="button" onClick={() => setDialog("new")} style={ghost}>＋ Pipeline</button>}
            {canWrite && pipe && <button type="button" onClick={() => setDialog("add")} style={{ ...S.btn(ACCENT, "#FFF"), padding: "6px 14px" }}>＋ Add lead</button>}
            {!embedded && <button type="button" onClick={() => { loadMeta(); loadDeals(); }} style={ghost}>↻ Refresh</button>}
          </div>
  );
  const count = deals ? (q || owner !== "all" || statusF.ids.length ? `${shown.length} of ${deals.length}` : deals.length) : null;
  const boardCols = pipe ? ssBoardColumns(pipe.stages.length, boardW) : 1;

  return (
    <div style={embedded ? undefined : S.card} data-ss-sales-pipelines="">
      {embedded
        ? <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
            {toolbar}
            {count !== null && <span style={{ fontSize: 12, fontWeight: 700, color: "#94A3B8" }}>{count} {count === 1 ? "card" : "cards"}</span>}
          </div>
        : <CardHead title="Leads" count={count} right={toolbar} />}
      {/* Search, then the STATUS filter beside it (Carolyn 2026-10-12: "a dropdown of the statuses
          up here ... beside the search"), then Owner. Tops aligned the way the Design list's bar
          is: the search wears a heading-shaped spacer so every box sits on one line. */}
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap", marginBottom: 12 }}>
        <div style={{ ...FCTRL, flex: "1 1 280px", minWidth: 220 }}>
          <span style={FLBL_SPACER} aria-hidden="true">Search</span>
          <SearchInput value={query} onChange={setQuery} placeholder="Search: company, name, phone, email…" />
        </div>
        {pipe && <SsStatusFilter statuses={statuses} deals={deals} value={statusFilter} onChange={setStatusFilter} />}
        {!meta.ownOnly && team.length > 0 && (
          <FacetSelect label="Owner" value={owner} onChange={setOwner} allLabel="Everyone"
            options={[{ value: "none", label: "Unassigned" }].concat(team.map((m) => ({ value: m.userId, label: m.name || "Team member" })))} />
        )}
      </div>
      {meta.ownOnly && <div style={{ fontSize: 12.5, color: "#475569", marginBottom: 10 }}>You see the leads assigned to you or that you follow.</div>}
      {err && <div style={S.err}>{err}</div>}
      {!pipe && !err && <p style={{ fontSize: 13, color: "#64748B" }}>No pipelines yet.</p>}
      {/* THE BOARD: no scroller of its own, sideways or down (Carolyn 2026-10-12, see
          ssBoardColumns). data-ss-board-wide lifts the page's width cap while it shows. */}
      {pipe && (
        <div ref={boardRef} data-ss-board-wide="" data-ss-board-cols={boardCols}>
          <div style={{
            display: "grid", gridTemplateColumns: `repeat(${boardCols}, minmax(0, 1fr))`, gap: SS_BOARD_GAP, alignItems: "start",
            maxWidth: boardCols * SS_BOARD_COL_MAX + (boardCols - 1) * SS_BOARD_GAP,
          }}>
            {pipe.stages.map((st) => {
              const cards = shown.filter((d) => d.stage_id === st.id);
              const total = cards.reduce((a, d) => a + (Number(d.value_cents) || 0), 0);
              const over = overStage === st.id && !!dragId;
              return (
                <div key={st.id} data-ss-stage={st.id}
                  onDragOver={canWrite ? (e) => { e.preventDefault(); if (overStage !== st.id) setOverStage(st.id); } : undefined}
                  onDrop={canWrite ? (e) => { e.preventDefault(); onDrop(st); } : undefined}
                  style={{ minWidth: 0, background: over ? "#EEF2FF" : "#F8FAFC", border: "1px solid " + (over ? ACCENT : "#E2E8F0"), borderTop: "3px solid " + st.color, borderRadius: 10, padding: 7, minHeight: 120 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", marginBottom: 7, columnGap: 6, rowGap: 2 }}>
                    <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.4, textTransform: "uppercase", color: "#475569", minWidth: 0, overflowWrap: "anywhere" }}>{st.name}</span>
                    <span style={{ fontSize: 11, fontWeight: 800, color: "#94A3B8", whiteSpace: "nowrap" }}>{deals ? cards.length : "…"}{total ? ` · ${fmtMoneyWhole(total)}` : ""}</span>
                  </div>
                  {deals === null && <div style={{ height: 54, background: "#EEF2F7", borderRadius: 8 }} />}
                  {deals && cards.length === 0 && <div style={{ fontSize: 11.5, color: "#CBD5E1", padding: "6px 2px" }}>—</div>}
                  {cards.map((d) => {
                    const c = d.contact || {};
                    const g = d.design;
                    const head = c.company || c.name || c.phone || c.email || "—";
                    const building = g ? [titleCase(g.style), g.size].filter(Boolean).join(" ") : "";
                    const sub = g
                      ? (building || d.short_code)
                      : (c.company ? (c.name || c.phone || c.email) : (d.title || null));
                    const closeIso = d.expected_close_date || null;
                    const closeLate = !!closeIso && closeIso < ssLocalIso(new Date());
                    const days = ssDaysSince(d.stage_entered_at);
                    const ownerName = teamName(c.ownerUserId);
                    const follow = d.next_follow_up_at ? Date.parse(d.next_follow_up_at) : null;
                    const late = follow !== null && follow < Date.now();
                    const openCard = () => { if (onOpenRecord) onOpenRecord(d.short_code || null, d.contact_id || null, d.id); };
                    return (
                      // THE CARD is a focusable div acting as a button (Enter or Space opens it, like a
                      // click), not a <button>: the close date below is a control of its own, and a
                      // control inside a <button> is invalid HTML that swallows the card's click. That
                      // used to force the close date out of the card into a sibling pinned over it at
                      // fixed pixel offsets; inside the card it sits in the status row and simply wraps
                      // under the pill when the column is narrow, as columns now can be.
                      // Not draggable while its close date is being typed, so the mouse works in the field.
                      <div key={d.id} role="button" tabIndex={0} draggable={canWrite && closeEdit !== d.id} data-ss-deal={d.id}
                        onDragStart={(e) => { setDragId(d.id); try { e.dataTransfer.setData("text/plain", d.id); e.dataTransfer.effectAllowed = "move"; } catch (_e) { /* old browsers */ } }}
                        onDragEnd={() => { setDragId(null); setOverStage(null); }}
                        onClick={openCard}
                        onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openCard(); } }}
                        style={{ display: "block", textAlign: "left", background: "#FFF", border: "1px solid #E2E8F0", borderRadius: 8, padding: "8px 9px", marginBottom: 6, cursor: canWrite ? "grab" : "pointer", fontFamily: "inherit", opacity: dragId === d.id ? 0.5 : 1 }}>
                        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                          <span style={{ flex: "1 1 auto", minWidth: 0, fontSize: 13, fontWeight: 700, color: "#1E293B", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{head}</span>
                          {d.value_cents != null && <span style={{ fontSize: 12.5, fontWeight: 800, color: "#1E293B", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{fmtMoneyWhole(d.value_cents)}</span>}
                        </div>
                        {sub && <div style={{ fontSize: 11.5, color: "#64748B", marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sub}</div>}
                        {/* The STATUS PILL (left; a label, statuses are the system's) and the close date
                            (right; Carolyn 2026-09-07: "editable straight from the card"). */}
                        <div style={{ marginTop: 5, minHeight: 20, display: "flex", alignItems: "center", flexWrap: "wrap", columnGap: 6, rowGap: 3 }}>
                          <SsStatusPill statuses={statuses} value={d.status_id} style={{ maxWidth: "100%" }} />
                          {closeEdit === d.id ? (
                            <input type="date" autoFocus defaultValue={closeIso || ""} aria-label="Expected close date"
                              onClick={(e) => e.stopPropagation()}
                              onBlur={(e) => saveClose(d, e.target.value)}
                              onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); if (e.key === "Escape") setCloseEdit(null); }}
                              style={{ marginLeft: "auto", maxWidth: "100%", boxSizing: "border-box", border: "1px solid " + ACCENT, borderRadius: 5, padding: "1px 4px", fontSize: 10.5, fontFamily: "inherit", fontWeight: 700, color: "#1E293B", background: "#FFF" }} />
                          ) : (closeIso || canWrite) && (
                            <button type="button" title={closeIso ? "Expected close: click to change" : "Set an expected close date"}
                              onClick={(e) => { e.stopPropagation(); setCloseEdit(d.id); }} disabled={!canWrite}
                              style={{ marginLeft: "auto", border: "none", borderRadius: 4, padding: "0 4px", fontSize: 10.5, fontWeight: 700, fontFamily: "inherit", whiteSpace: "nowrap",
                                cursor: canWrite ? "pointer" : "default", background: closeLate ? "#FEF2F2" : "transparent",
                                color: closeIso ? (closeLate ? "#DC2626" : "#1B7895") : "#CBD5E1" }}>
                              {closeIso ? fmtDateShort(closeIso) : "+ close"}
                            </button>
                          )}
                        </div>
                        {/* THE OLD BOARD'S DETAILS on a design card (Carolyn 2026-10-11, pointing at it:
                            "I want this to be listed on the cards of the newly created pipeline"):
                            the ESTIMATE's own status and number. The pill above is the card's status,
                            which the system sets; this one is what the estimate really is. */}
                        {g && (
                          <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 4, display: "flex", alignItems: "center", flexWrap: "wrap", columnGap: 6, rowGap: 2 }}>
                            <StatusPill status={g.status} small />
                            {g.estimateNumber && <span>#{g.estimateNumber}</span>}
                          </div>
                        )}
                        {st.kind === "lost" && d.lost_reason && <div style={{ fontSize: 11, color: "#DC2626", marginTop: 3 }}>{d.lost_reason}</div>}
                        <div style={{ marginTop: 6, display: "flex", alignItems: "center", flexWrap: "wrap", columnGap: 6, rowGap: 3, fontSize: 10.5, color: "#94A3B8" }}>
                          <span title={ownerName ? `Owner: ${ownerName}` : "Unassigned"}
                            style={{ width: 20, height: 20, flexShrink: 0, borderRadius: "50%", background: ownerName ? "#E0E7FF" : "#F1F5F9", color: ownerName ? ACCENT : "#94A3B8", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 9.5, fontWeight: 800 }}>
                            {ownerName ? ssPipeInitials(ownerName) : "–"}
                          </span>
                          {days !== null && <span>{days === 0 ? "New today" : `${days}d in stage`}</span>}
                          {follow !== null && (
                            <span style={{ marginLeft: "auto", fontWeight: 700, color: late ? "#DC2626" : "#1B7895", background: late ? "#FEF2F2" : "transparent", borderRadius: 4, padding: "0 4px", whiteSpace: "nowrap" }}>
                              {late ? "Overdue " : "Follow up "}{fmtDateShort(d.next_follow_up_at)}
                            </span>
                          )}
                        </div>
                        {/* Created · Updated, as on the old board: the design's own dates on a design
                            card, the card's on a lead. */}
                        <div style={{ marginTop: 5, paddingTop: 5, borderTop: "1px solid #F1F5F9", fontSize: 10, color: "#94A3B8", display: "flex", flexWrap: "wrap", columnGap: 5, fontVariantNumeric: "tabular-nums" }}>
                          <span style={{ whiteSpace: "nowrap" }}>Created {fmtDateShort(g ? g.createdAt : d.created_at)}</span>
                          <span style={{ opacity: 0.55 }}>·</span>
                          <span style={{ whiteSpace: "nowrap" }}>Updated {fmtDateShort(g ? g.updatedAt : d.updated_at)}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {canWrite && pipe && <p style={{ fontSize: 11.5, color: "#94A3B8", margin: "8px 0 0" }}>Drag a card to move it to another stage. Click a card to open the customer. Statuses are set automatically.{pipe.feedsDesigns ? " New designs appear here on their own." : ""}</p>}
      {dialog === "add" && (
        <SsAddLeadDialog pipelines={pipelines} defaultPipelineId={pipeId} team={team} ownOnly={!!meta.ownOnly} me={meta.me}
          onClose={() => setDialog(null)} onOpenRecord={onOpenRecord ? (contactId) => onOpenRecord(null, contactId) : null}
          onAdded={(r) => { setDialog(null); loadDeals(); }} />
      )}
      {dialog === "edit" && pipe && <SsPipelineEditor pipeline={pipe} statuses={statuses} onClose={() => { setDialog(null); loadMeta(); loadDeals(); }} />}
      {dialog === "new" && <SsPipelineEditor pipeline={null} onClose={() => setDialog(null)}
        onCreated={async (id) => { setDialog(null); await loadMeta(); pick(id); }} />}
      {dialog && dialog.lost && (
        <SsLostReasonDialog reasons={pipe ? pipe.lostReasons : []} onCancel={() => setDialog(null)}
          onPick={(reason) => { const { deal, stage } = dialog.lost; setDialog(null); moveDeal(deal, stage, reason); }} />
      )}
    </div>
  );
}

// ── SETTINGS → PIPELINES (migration 302) ─────────────────────────────────────────────────────
// Carolyn 2026-10-11: "I do want to have these stages in the settings, so that each builder can
// then rename them if they want and we also want them to add others if they want and they will set
// up When they get that stage such as when an estimate is accepted then it gets that stage. so we
// need a drop down similar to how we have it in GHL settings."
// The STATUSES card is that list; each one's "Set automatically when" drop-down names the system
// event that sets it (one status per event). The PIPELINES card opens each pipeline's stage editor.
// Carolyn 2026-10-12 (migration 303): statuses are "system-driven, 100%": nobody sets one on a
// card, so nothing here offers a hand-set or a stage link, and Quotes is gone (new designs land in
// Shed Deals, the pipeline marked "new designs").
// settings_crm:edit to change anything (owner/admin by preset); the server refuses everyone else.
const SS_STATUS_EVENTS = [
  ["design_submitted", "A design is submitted"],
  ["estimate_sent", "The estimate is sent"],
  ["estimate_accepted", "The estimate is accepted"],
  ["invoiced", "The invoice is sent"],
  ["paid_in_full", "It is paid in full"],
  ["build_scheduled", "It is added to the build schedule"],
  ["delivered", "It is delivered"],
];
function PipelineSettings({ viewing = false }) {
  const [meta, setMeta] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState(null);   // pipeline object | "new"
  const load = useCallback(async () => {
    try { setMeta(await ssPipeCall("crm_pipelines_list")); setErr(null); }
    catch (e) { setErr(e.message); setMeta((m) => m || { pipelines: [], statuses: [] }); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const run = async (fn) => { setBusy(true); setErr(null); try { await fn(); await load(); } catch (e) { setErr(e.message); await load(); } finally { setBusy(false); } };
  if (!meta) return <div style={S.card}><div style={S.h2}>Pipelines &amp; Statuses</div><p style={{ fontSize: 13, color: "#64748B" }}>Loading…</p></div>;
  const can = !!meta.canManage && !viewing;
  const statuses = meta.statuses || [];
  const save = (t, patch) => run(() => ssPipeCall("crm_status_save", { id: t.id, ...patch }));
  const move = (i, d) => {
    const j = i + d; if (j < 0 || j >= statuses.length) return;
    const ids = statuses.map((t) => t.id); const x = ids[i]; ids[i] = ids[j]; ids[j] = x;
    run(() => ssPipeCall("crm_statuses_reorder", { ids }));
  };
  const small = { ...S.btn("#F1F5F9", "#334155"), padding: "4px 8px" };
  const usedBy = (ev, id) => statuses.some((t) => t.triggerEvent === ev && t.id !== id);
  return (
    <>
      <div style={S.card} data-ss-pipeline-settings="">
        <div style={S.h2}>Statuses</div>
        <p style={{ fontSize: 12, color: "#64748B", marginBottom: 12, lineHeight: 1.5 }}>
          Every card on every pipeline shows its status as a coloured pill, and the system sets it: pick what sets
          each one under <b>Set automatically when</b>. A status only ever moves forward in this order, and nobody
          changes one by hand. Rename them, recolour them, put them in order and add your own.
        </p>
        {err && <div style={S.err}>{err}</div>}
        <div style={{ border: "1px solid #E2E8F0", borderRadius: 8, marginBottom: 10 }}>
          {statuses.map((t, i) => (
            <div key={t.id} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", padding: "7px 9px", borderBottom: i < statuses.length - 1 ? "1px solid #F1F5F9" : "none" }}>
              <select aria-label="Colour" disabled={!can || busy} value={t.color} onChange={(e) => save(t, { color: e.target.value })}
                style={{ width: 34, height: 28, flexShrink: 0, border: "1px solid #CBD5E1", borderRadius: 6, background: t.color, color: "transparent", cursor: can ? "pointer" : "default" }}>
                {SS_STAGE_COLORS.concat(["#84CC16", "#0F766E", "#60A5FA", "#EF4444"]).concat(SS_STAGE_COLORS.includes(t.color) ? [] : [t.color])
                  .filter((c, k, a) => a.indexOf(c) === k).map((c) => <option key={c} value={c} style={{ background: c, color: "#FFF" }}>{c}</option>)}
              </select>
              <input key={t.id + t.name} aria-label="Status name" disabled={!can || busy} style={{ ...S.input, flex: "1 1 150px", minWidth: 120, padding: "5px 8px" }}
                defaultValue={t.name} maxLength={40}
                onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== t.name) save(t, { name: v }); }} />
              <label style={{ display: "flex", alignItems: "center", gap: 6, flex: "1 1 230px", fontSize: 11.5, color: "#64748B", fontWeight: 700 }}>
                Set automatically when
                <select aria-label="Set automatically when" disabled={!can || busy} value={t.triggerEvent || ""}
                  onChange={(e) => save(t, { triggerEvent: e.target.value })} style={{ ...S.input, flex: 1, padding: "5px 6px" }}>
                  <option value="">Nothing yet</option>
                  {SS_STATUS_EVENTS.map(([k, label]) => <option key={k} value={k} disabled={usedBy(k, t.id)}>{label}{usedBy(k, t.id) ? " (used)" : ""}</option>)}
                </select>
              </label>
              {can && <button type="button" title="Move up" disabled={busy || i === 0} onClick={() => move(i, -1)} style={small}>↑</button>}
              {can && <button type="button" title="Move down" disabled={busy || i === statuses.length - 1} onClick={() => move(i, 1)} style={small}>↓</button>}
              {can && <button type="button" title="Remove status" disabled={busy}
                onClick={() => { if (window.confirm(`Remove the “${t.name}” status? Only a status no card has can be removed.`)) save(t, { archive: true }); }}
                style={{ ...small, background: "#FEF2F2", color: "#DC2626" }}>✕</button>}
            </div>
          ))}
        </div>
        {can && (
          <div style={{ display: "flex", gap: 6 }}>
            <input style={{ ...S.input, flex: 1 }} value={newName} maxLength={40} onChange={(e) => setNewName(e.target.value)} placeholder="New status name"
              onKeyDown={(e) => { if (e.key === "Enter" && newName.trim()) { e.preventDefault(); run(async () => { await ssPipeCall("crm_status_save", { name: newName.trim() }); setNewName(""); }); } }} />
            <button type="button" disabled={busy || !newName.trim()} style={S.btn(ACCENT, "#FFF")}
              onClick={() => run(async () => { await ssPipeCall("crm_status_save", { name: newName.trim() }); setNewName(""); })}>Add status</button>
          </div>
        )}
      </div>
      <div style={S.card}>
        <div style={S.h2}>Pipelines</div>
        <p style={{ fontSize: 12, color: "#64748B", marginBottom: 12 }}>
          New designs land in the pipeline marked <b>new designs</b>, in its first open stage. Open a pipeline to
          rename, reorder and add stages and set its lost reasons.
        </p>
        {(meta.pipelines || []).map((p) => (
          <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderTop: "1px solid #F1F5F9" }}>
            <span style={{ flex: 1, fontSize: 13, fontWeight: 700, color: "#1E293B" }}>
              {p.name}
              {p.feedsDesigns && <span style={{ marginLeft: 8, fontSize: 10.5, fontWeight: 800, color: "#1B7895", background: "#E0F2FE", borderRadius: 999, padding: "1px 8px" }}>new designs</span>}
              <span style={{ marginLeft: 8, fontSize: 11.5, fontWeight: 600, color: "#94A3B8" }}>{p.stages.length} stages</span>
            </span>
            {can && <button type="button" onClick={() => setEditing(p)} style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0", padding: "6px 12px" }}>Edit stages</button>}
          </div>
        ))}
        {can && <button type="button" onClick={() => setEditing("new")} style={{ ...S.btn(ACCENT, "#FFF"), marginTop: 10 }}>＋ New pipeline</button>}
      </div>
      {editing && editing !== "new" && <SsPipelineEditor pipeline={editing} onClose={() => { setEditing(null); load(); }} />}
      {editing === "new" && <SsPipelineEditor pipeline={null} onClose={() => setEditing(null)} onCreated={() => { setEditing(null); load(); }} />}
    </>
  );
}
