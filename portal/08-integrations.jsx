// `sub`/`onSub` are supplied by Dashboard so the sub-page lives in the URL
// (/portal/settings/colors). The internal fallback keeps the shell usable if it is ever
// ─── QuickBooks (Settings → QuickBooks) ─────────────────────────────────────
// Connection card + the estimate-line → QuickBooks-item mapping grid. All data flows
// through portal-settings (qbo_status / list_item_map / save_item_map / list_qbo_items /
// qbo_test / disconnect_qbo) and qbo-oauth-connect; tokens never reach the browser.
//
// The OAuth round trip lands back on /portal/settings/quickbooks?connected=… — this view
// reads that flag once, shows a banner, and strips it from the URL so a refresh doesn't
// re-announce a stale result.
const QBO_KINDS = [
  ["building", "Building", "The base building price line"],
  ["paint", "Paint", "Paint / color upgrade lines"],
  ["roof", "Roof", "Roof upgrade lines"],
  ["door", "Doors", "Catalog doors placed on the design"],
  ["window", "Windows", "Catalog windows placed on the design"],
  ["ramp", "Ramps", "Ramps — from the catalog or the simple per-ramp price"],
  ["layout_item", "Layout items", "One mapping per built-in placeable (lofts, workbenches, rough openings…)"],
  ["custom_option", "Custom options", "Tenant-defined add-on options"],
  ["discount", "Discount", "Optional — QuickBooks' built-in discount is used when unmapped"],
  ["delivery", "Delivery", "Non-taxable unless Settings → Options → Delivery says otherwise"],
  // 239: the kinds the estimate already emitted but the map could not name, plus foundation.
  ["wall_height", "Taller walls", "Wall-height increase lines"],
  ["build_on_site", "Built on site", "The on-site build fee a tall wall triggers"],
  ["cladding", "Cladding", "Priced siding lines"],
  ["insulation", "Insulation", "One line per insulated area"],
  ["electrical", "Electrical package", "The standard wiring package"],
  ["electrical_item", "Electrical items", "Devices placed beyond the standard layout"],
  ["foundation", "Foundation & site work", "Gravel pads, fence removal, piers and slabs"],
  ["fallback", "Fallback", "Used for any line with no mapping of its own"],
];

const QBO_REASONS = {
  denied: "You cancelled the connection at Intuit. Nothing was changed.",
  state: "That connection attempt expired or didn't match. Start it again from this page.",
  exchange: "Intuit didn't accept the connection. Try again.",
  verify: "Connected at Intuit, but QuickBooks couldn't be reached to confirm. Try again.",
  realm_in_use: "That QuickBooks company is already connected to a different StructureStudio account. Disconnect it there first, or choose a different company at Intuit.",
  unconfigured: "QuickBooks isn't fully set up on the server yet. Tell CSM Synergy.",
  save: "The connection couldn't be saved. Try again, and tell CSM Synergy if it persists.",
  // Connected, but leftover item mappings (another company's, or ones saved before migration 265
  // that say no company) couldn't be tidied up. Since 265 they are ignored (the grid and the
  // invoice push read only the connected company's rows), so the risk is gone; what is left is a
  // grid that may need filling in. Worded for no company in particular: the tidy-up runs on every
  // connect, so a SAME-company reconnect can land here too, with no "old company" to speak of.
  item_map_stale: "Connected, but some leftover item mappings couldn't be tidied up. They won't be used. Check the mappings below before sending an invoice.",
  // Connected to a DIFFERENT company than the mappings were made for, so those were cleared
  // (item numbers belong to one company's books). Without this the owner lands on an emptier
  // grid than they left, with nothing saying why.
  company_changed: "Connected to a different QuickBooks company, so the item mappings for the old one were cleared. Pick your items below before sending an invoice.",
  // Success, but with a consequence on an account this user can't see (migration 084). Worth
  // saying plainly: the usual cause is picking the wrong company at Intuit, and that is undone
  // by reconnecting the right one. The other account is never named.
  displaced_other: "Connected. This QuickBooks company was moved here from another StructureStudio account, so it no longer syncs there. If that wasn't intended, reconnect and choose a different company at Intuit.",
  // Both at once: the company came from another account AND this account was mapped against a
  // different one, so those mappings were cleared. displaced_other alone left the owner on an
  // emptied grid with nothing saying why, the very case company_changed exists for.
  displaced_company_changed: "Connected. This QuickBooks company was moved here from another StructureStudio account, so it no longer syncs there. The item mappings for the company you used before were cleared, so pick your items below before sending an invoice. If that wasn't intended, reconnect and choose a different company at Intuit.",
};

// realm_in_use optionally carries `company` — the QuickBooks company the user just authorised
// (qbo-oauth-callback adds it). Naming it is the difference between an actionable message and
// a dead end, because the usual cause is simply picking the wrong company in Intuit's selector.
// The other tenant is never named: that would leak one customer's identity to another.
function qboReasonText(reason, company) {
  if (reason === "realm_in_use" && company) {
    return `“${company}” is already connected to a different StructureStudio account. `
      + "Disconnect it there first, or choose a different company at Intuit.";
  }
  return QBO_REASONS[reason];
}

// Grouped <select> of QuickBooks items; keeps a saved-but-vanished id selectable so a
// transient QuickBooks outage can't blank a stored mapping on save (the stage-dropdown
// idiom used across Settings).
// HOISTED to module scope on purpose, like FeatureScope in 07-admin.jsx: declared inside
// QuickBooksView it was a new component type on every render, so React remounted every
// dropdown whenever the view re-rendered — an open list snapped shut when a background
// fetch landed, and focus was lost after every pick. Everything it reads arrives as props
// (mappedId/setMapped/qboItems/mappings); it closes over nothing from the view. Qbo-prefixed
// because the portal parts concatenate into one shared scope, like QBO_KINDS above.
function QboItemSelect({ kind, itemKey, styleId, placeholder, mappedId, setMapped, qboItems, mappings, fallbackLabel }) {
  const val = mappedId(kind, itemKey, styleId);
  // What the EMPTY choice means, said where it is picked. A line with no mapping of its own bills
  // as the Fallback item, so "— not mapped —" on Delivery (left unmapped on purpose) read as
  // "delivery doesn't go into QuickBooks" when it does, as the Fallback item: Carolyn's "a lot of
  // options in here that are not going into QuickBooks" (2026-09-10). Two rows keep "— not
  // mapped —": Fallback itself, and Discount, which the push never bills as an item (it sends
  // QuickBooks' own discount line). With no Fallback picked, "not mapped" is true for every row:
  // an unmapped line then stops the push.
  const empty = placeholder
    || (fallbackLabel && kind !== "fallback" && kind !== "discount" ? fallbackLabel : "— not mapped —");
  const items = qboItems || [];
  // Group by the item's QuickBooks CATEGORY, taken from the qualified path — that is how
  // a builder's own list is organised ("Options:Doors" / "Buildings:Cabins"), so it is the
  // grouping they can navigate. Items with no category (and any response from a
  // not-yet-updated function, where fullName is absent) fall back to the old grouping by
  // Type, so this degrades to previous behaviour instead of collapsing into one blob.
  const groupOf = (i) => {
    const fn = i.fullName || "";
    const cut = fn.lastIndexOf(":");
    return cut > 0 ? fn.slice(0, cut) : (i.type || "Other");
  };
  const byGroup = {};
  items.forEach((i) => { const g = groupOf(i); (byGroup[g] = byGroup[g] || []).push(i); });
  const stale = val && !items.some((i) => i.id === val);
  const savedRow = stale ? (mappings || []).find((m) => m.qbo_item_id === val) : null;
  return (
    <select value={val} onChange={(e) => setMapped(kind, itemKey, styleId, e.target.value)}
      style={{ ...S.input, maxWidth: 340 }}>
      <option value="">{empty}</option>
      {stale && <option value={val}>{(savedRow && savedRow.qbo_item_name) || val} (saved)</option>}
      {Object.keys(byGroup).sort().map((g) => (
        <optgroup key={g} label={g}>
          {byGroup[g].map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

function QuickBooksView({ clientId, viewingLabel = null }) {
  const [status, setStatus] = useState(null);   // qbo_status response; null = loading
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);      // connect/test/disconnect in flight
  const [msg, setMsg] = useState(null);         // { ok } | { err } one-shot banner
  // Mapping grid state
  const [grid, setGrid] = useState(null);       // list_item_map response
  const [gridLoading, setGridLoading] = useState(false); // list_item_map in flight (drives Card 2's skeleton)
  const [qboItems, setQboItems] = useState(null); // null = not loaded, [] = loaded empty
  const [itemsErr, setItemsErr] = useState(null);
  const [itemsTruncated, setItemsTruncated] = useState(false); // hit the server's page cap
  const [draft, setDraft] = useState({});       // key(kind|itemKey|styleId) -> qboItemId
  const [saving, setSaving] = useState(false);

  // Reason from a FAILED OAuth landing, kept so `load` can reconcile it against server truth.
  // A ref, not state: it must be readable inside the []-dep `load` without re-creating it.
  const landFailRef = useRef(null);

  // One-shot OAuth landing banner, then strip the params so refresh stays quiet.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (!p.has("connected")) return;
    // connected=1 WITH a reason means "it connected, but read this" (today: item_map_stale). Show
    // the reason rather than the cheerful default, or the caveat is lost.
    const landCompany = p.get("company");
    if (p.get("connected") === "1" && p.get("reason") && QBO_REASONS[p.get("reason")]) setMsg({ err: qboReasonText(p.get("reason"), landCompany) });
    else if (p.get("connected") === "1") setMsg({ ok: "QuickBooks connected. Check the company name below is the right business." });
    else { landFailRef.current = p.get("reason") || ""; setMsg({ err: qboReasonText(p.get("reason"), landCompany) || "The connection didn't complete. Try again." }); }
    p.delete("connected"); p.delete("reason"); p.delete("company");
    const qs = p.toString();
    window.history.replaceState({}, "", window.location.pathname + (qs ? `?${qs}` : ""));
  }, []);

  const load = useCallback(async () => {
    setError(null);
    const { data: d, error: e } = await sb.functions.invoke("portal-settings", { body: { action: "qbo_status" } });
    if (e || (d && d.error)) { setError((e && e.message) || d.error); setStatus({}); return; }
    setStatus(d || {});
    // The landing banner reports on ONE callback hit; qbo_status reports the tenant's actual state.
    // When they disagree the server wins, or a stale failure sits above a green "Connected" card and
    // reads as a broken connect. `state` specifically: the nonce is one-shot and burned on first
    // match, so a callback that runs twice ALWAYS fails the second time — the first hit is the one
    // that connected us. Scoped to `state` on purpose: `realm_in_use` and `denied` stay visible,
    // because those describe an attempt whose outcome still matters even while connected.
    if (landFailRef.current === "state" && d && d.connected && !d.broken) {
      landFailRef.current = null;
      setMsg((m) => (m && m.err === QBO_REASONS.state ? null : m));  // never clobber a newer message
    }
    if (d && d.connected && !d.broken) {
      // The connection card above is already painted by now — qbo_status was the only thing it
      // waited on. This second call fills Card 2, so the flag lets that card draw its shape
      // meanwhile instead of leaving a heading over blank space. Cleared either way: a
      // list_item_map that FAILS must fall back to today's behaviour, not leave a skeleton
      // claiming to still be loading something nobody is fetching any more.
      setGridLoading(true);
      const g = await sb.functions.invoke("portal-settings", { body: { action: "list_item_map" } });
      if (!g.error && g.data && !g.data.error) setGrid(g.data);
      setGridLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Invoices that were emailed but never landed in QuickBooks. Before this the push was write-only:
  // send_invoice returned ok, the design read "Invoiced", and an aborted push (usually an unmapped
  // line) left the books untouched with nothing to notice it and no way to retry.
  const [pending, setPending] = useState([]);
  const [retrying, setRetrying] = useState(null);   // shortCode in flight
  const loadPending = useCallback(async () => {
    const { data: d, error: e } = await sb.functions.invoke("portal-settings", { body: { action: "qbo_pending" } });
    if (!e && d && !d.error) setPending(d.pending || []);
  }, []);
  const retryPush = async (shortCode) => {
    setRetrying(shortCode); setMsg(null);
    const { data: d, error: e } = await sb.functions.invoke("portal-settings", { body: { action: "retry_qbo_push", shortCode } });
    setRetrying(null);
    if (e || (d && d.error)) { setMsg({ err: (e && e.message) || d.error }); return; }
    // otherCompany (migration 265): it went into the company this account was connected to
    // before a switch. It stays there and is not copied into the new books; say where it is.
    // Only reachable from a list gone stale in an open tab (pushed, then a switch, then Retry):
    // qbo_pending lists invoices with no QuickBooks id, so a fresh page never offers one. The
    // standing answer is the connection card's otherCompanyInvoices line.
    setMsg({ ok: d && d.alreadyPushed
      ? (d.otherCompany ? "That invoice is already in the QuickBooks company you were connected to before." : "That invoice is already in QuickBooks.")
      : "Pushed to QuickBooks." });
    loadPending();
  };

  const loadQboItems = useCallback(async () => {
    setItemsErr(null); setQboItems(null); setItemsTruncated(false);
    const { data: d, error: e } = await sb.functions.invoke("portal-settings", { body: { action: "list_qbo_items" } });
    if (e || (d && d.error)) { setItemsErr((e && e.message) || d.error); setQboItems([]); return; }
    // Not-connected / needs-reconnect come back 200 with no `error` on purpose (see the
    // action in portal-settings). The connection card above already says both, so stand down
    // quietly instead of stacking a second, redundant failure under the grid.
    if (d && (d.notConnected || d.broken)) { setQboItems([]); return; }
    setQboItems(d.items || []);
    setItemsTruncated(!!(d && d.truncated));
  }, []);
  // Fetch the QuickBooks item list once the connection is known-good.
  useEffect(() => { if (status && status.connected && !status.broken && qboItems === null) loadQboItems(); },
    [status, qboItems, loadQboItems]);
  // Only meaningful once connected — an unconnected tenant has no pushes to have failed.
  useEffect(() => { if (status && status.connected) loadPending(); }, [status, loadPending]);

  const connect = async () => {
    setBusy(true); setMsg(null);
    // Land back on THIS host (beta stays on beta). Validated server-side against a hard
    // allowlist — anything else falls back to production.
    const { data: d, error: e } = await sb.functions.invoke("qbo-oauth-connect", { body: { returnTo: window.location.hostname } });
    setBusy(false);
    if (e || (d && d.error) || !(d && d.authorizeUrl)) {
      setMsg({ err: (d && d.error) || (e && e.message) || "Could not start the QuickBooks connection." });
      return;
    }
    window.location.assign(d.authorizeUrl); // full navigation — Intuit refuses to render framed
  };

  const test = async () => {
    setBusy(true); setMsg(null);
    const { data: d } = await sb.functions.invoke("portal-settings", { body: { action: "qbo_test" } });
    setBusy(false);
    if (d && d.ok) setMsg({ ok: `QuickBooks answered${d.companyName ? ` — connected to ${d.companyName}` : ""}.` });
    else setMsg({ err: (d && d.error) || "Could not reach QuickBooks." });
    if (d && d.broken) load();
  };

  const disconnect = async () => {
    if (!window.confirm("Disconnect QuickBooks?\n\nSyncing stops immediately. Your item mappings are kept, so reconnecting the same company later picks up where you left off.")) return;
    setBusy(true); setMsg(null);
    const { data: d, error: e } = await sb.functions.invoke("portal-settings", { body: { action: "disconnect_qbo" } });
    setBusy(false);
    if (e || (d && d.error)) { setMsg({ err: (d && d.error) || e.message }); return; }
    setMsg({ ok: "QuickBooks disconnected. Your mappings were kept." });
    // Mark disconnected in the SAME commit that clears the item list. `load()` is async, so
    // until its qbo_status lands `status` still reads connected — while setQboItems(null) has
    // just re-armed the auto-load effect below, whose condition is exactly
    // (status.connected && qboItems === null). That fired list_qbo_items against a tenant
    // disconnected milliseconds earlier and filed a FunctionsHttpError in app_errors
    // (2026-08-03, structure-studio: disconnect at 16:35:56, error at 16:35:59). The server
    // no longer serves a disconnect tombstone either way; this stops the call being made.
    // Safe as optimistic state: disconnect_qbo has already returned ok, so we KNOW the
    // answer, and load() overwrites it with server truth a moment later regardless.
    setStatus((s) => ({ ...(s || {}), connected: false, broken: false }));
    setGrid(null); setQboItems(null); setDraft({});
    load();
  };

  const kFor = (kind, itemKey, styleId) => `${kind}|${itemKey || ""}|${styleId || ""}`;
  const mappedId = (kind, itemKey, styleId) => {
    const k = kFor(kind, itemKey, styleId);
    if (Object.prototype.hasOwnProperty.call(draft, k)) return draft[k];
    const row = (grid && grid.mappings || []).find((m) =>
      m.line_kind === kind && (m.item_key || "") === (itemKey || "") && (m.style_id || "") === (styleId || ""));
    return row ? row.qbo_item_id : "";
  };
  const setMapped = (kind, itemKey, styleId, v) => setDraft((p) => ({ ...p, [kFor(kind, itemKey, styleId)]: v }));

  const saveGrid = async () => {
    if (!grid) return;
    setSaving(true); setMsg(null);
    // Post the FULL grid — server-side validation decides row by row. Name captured from
    // the loaded item list so the grid can label a mapping even if QuickBooks is briefly
    // unreachable next load.
    // Prefer the qualified path ("Options:Doors:OP Door 4") — two categories can hold the
    // same leaf name, and this label is all an unmapped-line error has to identify by.
    const nameOf = (id) => { const it = (qboItems || []).find((i) => i.id === id); return it ? (it.fullName || it.name) : null; };
    const rows = [];
    const pushRow = (kind, itemKey, styleId) => {
      const k = kFor(kind, itemKey, styleId);
      if (!Object.prototype.hasOwnProperty.call(draft, k)) return; // untouched
      rows.push({ lineKind: kind, itemKey: itemKey || "", styleId: styleId || null, qboItemId: draft[k] || "", qboItemName: nameOf(draft[k]) });
    };
    QBO_KINDS.forEach(([kind]) => {
      if (kind === "layout_item") (grid.layoutItems || []).forEach((li) => pushRow(kind, li.item_key, null));
      else pushRow(kind, "", null);
    });
    // Style overrides for the building line.
    (grid.styles || []).forEach((s) => pushRow("building", "", s.id));
    if (!rows.length) { setSaving(false); setMsg({ ok: "Nothing to save." }); return; }
    // companyTag: the company this grid was loaded against (list_item_map). The server refuses the
    // save if the account has switched company since, rather than stamp these item ids, picked
    // from the old company's list, as the new one's. Sent only when the grid carried one.
    const tag = Object.prototype.hasOwnProperty.call(grid, "companyTag") ? { companyTag: grid.companyTag } : {};
    const { data: d, error: e } = await sb.functions.invoke("portal-settings", { body: { action: "save_item_map", rows, ...tag } });
    setSaving(false);
    if (e || (d && d.error)) { setMsg({ err: (d && d.error) || e.message }); return; }
    const parts = [];
    if (d.saved) parts.push(`${d.saved} saved`);
    if (d.deleted) parts.push(`${d.deleted} removed`);
    const skipped = Array.isArray(d.skipped) ? d.skipped : [];
    // Name what was skipped and why. A bare "N skipped" is how seven whole line kinds went
    // unmappable without anyone noticing (2026-09-17): the rows looked saved, the count was easy
    // to miss, and those lines kept billing against the fallback item.
    if (skipped.length) {
      const shown = skipped.slice(0, 3).join("; ");
      const more = skipped.length > 3 ? `; and ${skipped.length - 3} more` : "";
      setMsg({ err: `Mappings updated${parts.length ? ` (${parts.join(", ")})` : ""}, but ${skipped.length} ${skipped.length === 1 ? "wasn't" : "weren't"} saved: ${shown}${more}.` });
    } else {
      setMsg({ ok: `Mappings updated${parts.length ? ` (${parts.join(", ")})` : ""}.` });
    }
    setDraft({});
    const g = await sb.functions.invoke("portal-settings", { body: { action: "list_item_map" } });
    if (!g.error && g.data && !g.data.error) setGrid(g.data);
  };

  // Wiring for the module-scope QboItemSelect (hoisted — see its comment). The functions
  // are re-created each render, which is fine as PROPS: the component TYPE stays stable, so
  // nothing remounts.
  // The Fallback row's CURRENT pick, unsaved edits included, so every other row's empty choice
  // follows it as it changes. Named by its leaf, as the dropdowns list items; a saved name can be
  // the full "Category:Item" path. No name to be had (an item gone from QuickBooks with no saved
  // name) still says where the line goes, just without the name.
  const fallbackPick = grid ? mappedId("fallback", "", null) : "";
  const fallbackName = fallbackPick
    ? String(((qboItems || []).find((i) => i.id === fallbackPick) || {}).name
        || (((grid && grid.mappings) || []).find((m) => m.line_kind === "fallback" && m.qbo_item_id === fallbackPick) || {}).qbo_item_name
        || "").split(":").pop().trim()
    : "";
  const fallbackLabel = fallbackPick ? (fallbackName ? `— use Fallback (${fallbackName}) —` : "— use Fallback —") : null;
  const selProps = { mappedId, setMapped, qboItems, mappings: grid && grid.mappings, fallbackLabel };

  // The two cards in the shape they will occupy while qbo_status is out, rather than the word
  // "Loading" on an empty page — the SkelBar rationale in 01-core.jsx applies here verbatim.
  // The connection card's contents differ by state (Connect button vs. company + Test /
  // Disconnect), so the bars describe the FRAME both share — a status dot, two lines of text,
  // a button pair — and never commit to a connection state the server has not reported yet.
  if (status === null) return (
    <div>
      <div style={S.card}>
        <SkelBar w={178} h={14} />
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 18, flexWrap: "wrap" }}>
          <SkelBar w={10} h={10} style={{ borderRadius: 5, flexShrink: 0 }} />
          <div style={{ flex: "1 1 260px", minWidth: 0 }}>
            <SkelBar w="44%" h={13} />
            <SkelBar w="66%" h={9} style={{ marginTop: 7 }} />
          </div>
          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
            <SkelBar w={54} h={31} /><SkelBar w={92} h={31} />
          </div>
        </div>
      </div>
      <div style={S.card}>
        <SkelBar w={192} h={14} />
        <SkelBar w="88%" h={9} style={{ marginTop: 13 }} />
        <SkelBar w="61%" h={9} style={{ marginTop: 6 }} />
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} style={{ padding: "12px 0", borderBottom: "1px solid #F1F5F9" }}>
            <SkelBar w={128} h={12} style={{ opacity: 1 - i * 0.11 }} />
            <SkelBar w={196} h={8} style={{ marginTop: 7, opacity: 1 - i * 0.11 }} />
            <SkelBar w={262} h={30} style={{ marginTop: 8, opacity: 1 - i * 0.11 }} />
          </div>
        ))}
      </div>
    </div>
  );

  const connected = !!status.connected;
  const broken = !!status.broken;
  const ready = status.oauthReady !== false;
  const dirty = Object.keys(draft).length > 0;

  return (
    <div>
      {error && <div style={S.err}>{error}</div>}
      {msg && msg.ok && <div style={S.okMsg}>{msg.ok}</div>}
      {msg && msg.err && <div style={S.err}>{msg.err}</div>}

      {/* ── Card 1: Connection ── */}
      <div style={S.card}>
        <div style={S.h2}>QuickBooks connection</div>
        {/* Why it stopped, when this tenant did not stop it themselves — currently only:
            another StructureStudio account took the QuickBooks company over (migration 084).
            Server sends it only while disconnected. Without it the displaced tenant finds a
            bare "Connect" card and no explanation for why their invoices stopped syncing. */}
        {!connected && status.disconnectReason && (
          <div style={{ background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 8, padding: "10px 14px", marginBottom: 12 }}>
            <div style={{ fontSize: 13, color: "#92400E", fontWeight: 600 }}>{status.disconnectReason}</div>
          </div>
        )}
        {!connected && !ready && (
          <div>
            <div style={{ background: "#EFF6FF", border: "1px solid #BFDBFE", borderRadius: 8, padding: "10px 14px", color: "#1D4ED8", fontSize: 13, fontWeight: 600, marginBottom: 12 }}>
              QuickBooks is almost here — we're waiting on Intuit's approval. The button below lights up automatically when it lands.
            </div>
            <button disabled style={{ ...S.btn("#CBD5E1", "#64748B"), cursor: "not-allowed" }}>Connect to QuickBooks</button>
          </div>
        )}
        {!connected && ready && (
          <div>
            <p style={{ fontSize: 13, color: "#64748B", marginBottom: 12 }}>
              Intuit opens in this tab — sign in and approve access there, and you'll land right back
              here. Your QuickBooks password is never seen or stored by StructureStudio.
            </p>
            <button onClick={connect} disabled={busy} style={S.btn(ACCENT, "#FFF")}>
              {busy ? "Starting…" : "Connect to QuickBooks"}
            </button>
          </div>
        )}
        {connected && (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ width: 10, height: 10, borderRadius: 5, background: broken ? "#DC2626" : "#16A34A", flexShrink: 0 }} />
              <div style={{ minWidth: 0, flex: "1 1 260px" }}>
                <div style={{ fontSize: 14, fontWeight: 800, color: broken ? "#DC2626" : "#1E293B" }}>
                  {broken ? "Action needed — reconnect QuickBooks" : `Connected to ${status.companyName || "QuickBooks"}`}
                </div>
                <div style={{ fontSize: 12, color: "#64748B", marginTop: 2 }}>
                  {status.companyName ? `${status.companyName} · ` : ""}Company {status.realmIdMasked || "—"}
                  {status.connectedAt ? ` · connected ${fmtDate(status.connectedAt)}` : ""}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                <button onClick={test} disabled={busy} style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0" }}>{busy ? "…" : "Test"}</button>
                <button onClick={disconnect} disabled={busy} style={{ ...S.btn("#FFF", "#DC2626"), border: "1px solid #FECACA" }}>Disconnect</button>
              </div>
            </div>
            {broken && (
              <div style={{ background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 8, padding: "10px 14px", marginTop: 12 }}>
                <div style={{ fontSize: 13, color: "#92400E", fontWeight: 600 }}>{status.brokenReason || "QuickBooks refused the saved connection."}</div>
                <button onClick={connect} disabled={busy} style={{ ...S.btn(ACCENT, "#FFF"), marginTop: 8 }}>
                  {busy ? "Starting…" : "Reconnect QuickBooks"}
                </button>
              </div>
            )}
            {/* Invoices that went into the company this account used before a switch (migration
                265). They stay there and are never pushed again; this is where the owner hears
                it, since the "didn't reach QuickBooks" card below lists only invoices that never
                got in anywhere. Counted by qbo_status from where each invoice was recorded. */}
            {status.otherCompanyInvoices > 0 && (
              <div style={{ fontSize: 12.5, color: "#475569", marginTop: 10 }}>
                {status.otherCompanyInvoices === 1 ? "1 earlier invoice stays" : `${status.otherCompanyInvoices} earlier invoices stay`} in
                the QuickBooks company you were connected to before. {status.otherCompanyInvoices === 1 ? "It wasn't" : "They weren't"} copied
                into this one.
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Card 1b: invoices that never reached QuickBooks ──
          Deliberately ABOVE the mapping grid: the usual cause is a missing mapping, so the fix is
          the next thing on screen. Renders only when there is something wrong, so a healthy tenant
          never sees an empty scary panel. Before this, send_invoice returned ok and the design read
          "Invoiced" while the books were silently untouched — the outcome was written to
          invoice_sends and a retry action existed, but nothing in the portal read either. */}
      {connected && pending.length > 0 && (
        <div style={{ ...S.card, border: "1px solid #F59E0B", background: "#FFFBEB" }}>
          <div style={{ ...S.h2, color: "#92400E" }}>
            {pending.length} invoice{pending.length === 1 ? "" : "s"} didn’t reach QuickBooks
          </div>
          <p style={{ fontSize: 12, color: "#92400E", marginBottom: 12 }}>
            The customer was emailed and the design shows as invoiced, but the entry was not created
            in QuickBooks. Fix the cause below (usually an unmapped line), then Retry.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {pending.map((p) => (
              <div key={p.shortCode} style={{ display: "flex", alignItems: "flex-start", gap: 10, flexWrap: "wrap", background: "#FFF", border: "1px solid #FDE68A", borderRadius: 8, padding: "9px 11px" }}>
                <div style={{ flex: "1 1 260px", minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: "#1E293B" }}>
                    {p.invoiceNumber ? `Invoice ${p.invoiceNumber}` : p.shortCode}
                    {p.attempts > 1 && <span style={{ fontWeight: 600, color: "#92400E" }}> · {p.attempts} attempts</span>}
                  </div>
                  <div style={{ fontSize: 11.5, color: "#64748B", marginTop: 3, wordBreak: "break-word" }}>{p.error}</div>
                </div>
                <button type="button" disabled={retrying === p.shortCode} onClick={() => retryPush(p.shortCode)}
                  style={{ ...S.btn("#92400E", "#FFF"), padding: "6px 12px", fontSize: 12, flexShrink: 0 }}>
                  {retrying === p.shortCode ? "Retrying…" : "Retry"}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Card 2: Item mappings ── */}
      <div style={{ ...S.card, opacity: connected && !broken ? 1 : 0.55 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <div style={S.h2}>Invoice item mappings</div>
          {connected && !broken && (
            <button onClick={loadQboItems} title="Reload the product/service list from QuickBooks"
              style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0", padding: "6px 12px" }}>↻ Refresh items</button>
          )}
        </div>
        <p style={{ fontSize: 12, color: "#64748B", marginBottom: 14 }}>
          Which QuickBooks product or service each line of an estimate is billed as when an invoice
          is pushed to QuickBooks. Lines without a mapping fall back to the Fallback item; if that's
          not set either, the push is skipped for that invoice.
          <br /><br />
          <b>Tip:</b> most builders keep this simple with one broad QuickBooks product per line — a
          single “Buildings” item, one “Doors”, one “Windows” — mapped here once, rather than a
          separate QuickBooks item for every size and option. The size and option details still ride
          along on each invoice line's description.
        </p>
        {!connected && <p style={{ fontSize: 13, color: "#64748B" }}>Connect QuickBooks above to set up mappings.</p>}
        {/* `grid` arrives on a SECOND call (list_item_map), fired only after qbo_status has
            already unblocked the card above — so for the length of that round trip this
            heading and its blurb sat over NOTHING: no message, no rows, no skeleton. That is
            Carolyn's "the page opens and there's nothing there", happening inside a card that
            has already painted. Label/control pairs in the shape the grid will take. */}
        {connected && !broken && !grid && gridLoading && (
          <div>
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} style={{ padding: "12px 0", borderBottom: "1px solid #F1F5F9" }}>
                <SkelBar w={128} h={12} style={{ opacity: 1 - i * 0.11 }} />
                <SkelBar w={196} h={8} style={{ marginTop: 7, opacity: 1 - i * 0.11 }} />
                <SkelBar w={262} h={30} style={{ marginTop: 8, opacity: 1 - i * 0.11 }} />
              </div>
            ))}
          </div>
        )}
        {connected && !broken && grid && (
          <div>
            {itemsErr && <div style={S.err}>{itemsErr}</div>}
            {qboItems === null && !itemsErr && <p style={{ fontSize: 12, color: "#64748B" }}>Loading products &amp; services from QuickBooks…</p>}
            {itemsTruncated && (
              <p style={{ fontSize: 11.5, color: "#94A3B8", marginBottom: 8 }}>
                Showing the first 5,000 products &amp; services from QuickBooks. If an item you need
                isn't listed, tell CSM Synergy.
              </p>
            )}
            {QBO_KINDS.map(([kind, label, hint]) => (
              <div key={kind} style={{ padding: "10px 0", borderBottom: "1px solid #F1F5F9" }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#1E293B" }}>{label}</div>
                <div style={{ fontSize: 11.5, color: "#94A3B8", marginBottom: 6 }}>{hint}</div>
                {kind === "layout_item" ? (
                  (grid.layoutItems || []).length
                    ? (grid.layoutItems || []).map((li) => (
                        <div key={li.item_key} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6, flexWrap: "wrap" }}>
                          <span style={{ fontSize: 12.5, fontWeight: 600, color: "#475569", minWidth: 140 }}>{li.label || li.item_key}</span>
                          <QboItemSelect kind="layout_item" itemKey={li.item_key} styleId={null} {...selProps} />
                        </div>
                      ))
                    : <p style={{ fontSize: 12, color: "#94A3B8" }}>No active layout items.</p>
                ) : kind === "building" ? (
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 12.5, fontWeight: 600, color: "#475569", minWidth: 140 }}>Default (all styles)</span>
                      <QboItemSelect kind="building" itemKey="" styleId={null} {...selProps} />
                    </div>
                    {(grid.styles || []).map((s) => (
                      <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 12.5, fontWeight: 600, color: "#94A3B8", minWidth: 140 }}>{s.label}</span>
                        <QboItemSelect kind="building" itemKey="" styleId={s.id} placeholder="— use default —" {...selProps} />
                      </div>
                    ))}
                  </div>
                ) : (
                  <QboItemSelect kind={kind} itemKey="" styleId={null} {...selProps} />
                )}
              </div>
            ))}
            <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 10 }}>
              <button onClick={saveGrid} disabled={saving || !dirty} style={S.btn(dirty ? ACCENT : "#CBD5E1", "#FFF")}>
                {saving ? "Saving…" : "Save mappings"}
              </button>
              {dirty && <span style={{ fontSize: 12, color: "#64748B" }}>Unsaved changes</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Email sending (Settings → Email Settings) ───
// Own-domain estimate/invoice email (Postmark-backed, but the provider never appears in
// tenant-facing copy). Follows QuickBooksView's shape: one status call drives everything,
// every action re-pulls status afterwards, and the server (portal-settings, area
// settings_email) is the enforcement point — this component only decides what to show.
// email_status contract (portal-settings): { platformReady, domainStatus:
//   "not_configured"|"pending"|"verified"|"failed", domain, fromName, fromLocal,
//   fromAddress, verifiedAt, lastError, active, dnsRecords: [{type,host,value,verified,tracking?}],
//   recentSends: [{id?, kind, to, status, error?, bounceReason?, createdAt, openedAt, complainedAt}],
//   existingDmarc: {present, policy, count, host} | null }.
//   `tracking: true` marks the optional open-tracking record (B4); `openedAt` is migration 262's.
//   `existingDmarc` is public DNS's answer for the sending domain (_shared/dmarcLookup.ts); null,
//   or missing on an older server, means nobody knows, and then nothing is said about DMARC.
// `failed` renders the same remediation panel as `pending` (plus lastError): the fix for
// both is "add the records, check again", so a separate dead-end state helps nobody.

// The wording fields a save's answer left out of what was sent, in the editor's own words. A
// field the server knows comes back whenever it said something; one it doesn't know (an older
// server build) is dropped with an ok, and this is the only place that shows. The photo switch
// is stored only when it is OFF, so only an unticked box can go missing.
const SS_WORDING_FIELDS = [["subject", "subject"], ["intro", "opening line"], ["closing", "closing message"], ["button", "button text"]];
function ssWordingDropped(sent, kept) {
  const out = [];
  for (const kind of ["estimate", "quote", "invoice"]) {
    const s = (sent && sent[kind]) || {};
    const k = (kept && kept[kind]) || {};
    for (const [f, words] of SS_WORDING_FIELDS) {
      if (typeof s[f] === "string" && s[f].trim() && !k[f] && out.indexOf(words) === -1) out.push(words);
    }
    if (kind !== "invoice" && s.picture === false && k.picture !== false && out.indexOf("photo setting") === -1) out.push("photo setting");
  }
  return out;
}
// "a", "a and b", "a, b and c".
function ssJoinWords(list) {
  return list.length < 2 ? (list[0] || "") : list.slice(0, -1).join(", ") + " and " + list[list.length - 1];
}

function EmailSendingView({ clientId, viewingLabel = null }) {
  const [status, setStatus] = useState(null);   // email_status response; null = loading
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);      // any action in flight
  const [msg, setMsg] = useState(null);         // { ok } | { err } one-shot banner
  // Connect form (not_configured state only)
  const [domain, setDomain] = useState("");
  const [fromName, setFromName] = useState("");
  const [fromLocal, setFromLocal] = useState("info");
  // Verification feedback + per-row copy state (pending state)
  // Tenant wording for the document emails (migration 138). Seeded from email_status.
  const [tplKind, setTplKind] = useState("estimate");
  const [tpl, setTpl] = useState({});           // { estimate:{subject,intro,closing,button,picture}, ... }
  const [tplMsg, setTplMsg] = useState(null);
  const [tplBusy, setTplBusy] = useState(false);
  // The wording's Preview: { kind, subject, html, photo } or { kind, err }. Kept per kind so a
  // preview never sits under the wrong tab.
  const [pv, setPv] = useState(null);
  const [pvBusy, setPvBusy] = useState(false);
  // Seed the wording boxes ONCE from the server. A ref rather than a "is it empty?" test,
  // and an effect rather than a render-time set: the empty check would have been true
  // forever for a tenant with no saved copy, so setting state on it during render was an
  // infinite loop waiting for a background refresh to trigger it. The ref also means a
  // later refresh never clobbers what someone is halfway through typing.
  const tplSeeded = useRef(false);
  useEffect(() => {
    if (tplSeeded.current || !status || !status.templateCopy) return;
    tplSeeded.current = true;
    setTpl(status.templateCopy);
  }, [status]);
  const [checkNote, setCheckNote] = useState(null);
  const [copied, setCopied] = useState(null);   // "v<i>" | "fail:v<i>" | null
  // Test send (verified state)
  const [testTo, setTestTo] = useState("");
  const [testResult, setTestResult] = useState(null);  // { ok } | { err }

  const load = useCallback(async () => {
    setError(null);
    const { data: d, error: e } = await sb.functions.invoke("portal-settings", { body: { action: "email_status" } });
    if (e || (d && d.error)) { setError((e && e.message) || (d && d.error)); setStatus({}); return; }
    setStatus(d || {});
  }, []);
  useEffect(() => { load(); }, [load]);

  // Write, report, then refresh from server truth — the QuickBooksView rhythm. A failing
  // refresh never masks a write that landed (the next action's load catches up).
  const act = async (body, after) => {
    setBusy(true); setMsg(null); setCheckNote(null);
    const { data: d, error: e } = await sb.functions.invoke("portal-settings", { body });
    setBusy(false);
    if (e || (d && d.error)) { setMsg({ err: (e && e.message) || (d && d.error) }); return; }
    if (after) after(d || {});
    load();
  };

  // Awaited clipboard write (the AdmAccount lesson: an unawaited copy reports "Copied"
  // even when the write rejected), keyed per row so only the copied row lights up.
  const copy = async (text, key) => {
    try { await navigator.clipboard.writeText(text); setCopied(key); }
    catch (_e) { setCopied("fail:" + key); }
    setTimeout(() => setCopied(null), 2000);
  };

  const domainOk = /^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(domain.trim());
  const localOk = /^[a-z0-9._%+-]+$/i.test(fromLocal.trim());
  const canConnect = domainOk && localOk && fromName.trim().length > 0 && !busy;

  const connect = () => act(
    { action: "email_connect_domain", domain: domain.trim().toLowerCase(), fromName: fromName.trim(), fromLocal: fromLocal.trim().toLowerCase() },
    () => setMsg({ ok: "Domain connected — now add the DNS records below at your DNS host." }));

  const verify = () => act({ action: "email_verify_domain" }, (d) => {
    if (d.verified || d.domainStatus === "verified") setMsg({ ok: "Domain verified — you can activate sending below." });
    else setCheckNote("Not verified yet — give DNS a little longer, then check again.");
  });

  const active = !!(status && status.active);

  const toggleActive = () => act({ action: "email_activate", enabled: !active }, () =>
    setMsg({ ok: !active
      ? "Your own domain now sends your estimate and invoice emails."
      : "Reverted — estimate and invoice emails send through your CRM again." }));

  const disconnect = () => {
    const warn = active
      ? "Disconnect this email domain?\n\nEstimate and invoice emails immediately go back to sending through your CRM. You can connect a domain again at any time."
      : "Disconnect this domain?\n\nEmails keep sending through your CRM. You can connect a domain again at any time.";
    if (!window.confirm(warn)) return;
    act({ action: "email_disconnect" }, () => {
      setMsg({ ok: "Domain disconnected." });
      setDomain(""); setFromName(""); setFromLocal("info"); setTestTo(""); setTestResult(null);
    });
  };

  // ── Receiving replies ──────────────────────────────────────────────────────────────
  // The address is DERIVED SERVER-SIDE from the verified sending domain (reply.<domain>) and
  // deliberately not an input here. A free-text field is where a builder types their apex —
  // the one value that would take over their real company inbox — and it would also let
  // someone point a customer's replies at a host they do not own.
  const [inboundNote, setInboundNote] = useState(null);

  const inboundConnect = () => act({ action: "email_inbound_connect" }, () =>
    setMsg({ ok: "Reply address set up — add the mail record below, then check it." }));

  const inboundVerify = () => act({ action: "email_inbound_verify" }, (d) => {
    if (d.verified) setMsg({ ok: "Replies are switched on — customer replies now land in the portal." });
    else setInboundNote("Not working yet — mail records can take up to an hour. Check again shortly.");
  });

  // ── See when emails are opened (B4, migration 262) ─────────────────────────────────
  // One button for the whole card: it switches open tracking on when it is off, and otherwise
  // asks whether the tracking record is in DNS yet. The server never lets this touch the
  // domain's sending status (portal-settings email_tracking_check).
  //
  // "checking" means Resend is looking right now (this press asked, or an earlier one did and it
  // is not done). Another press before it finishes would only restart that look, so the note says
  // when to come back instead of "not seen yet", which reads as "press it again".
  // "not_found" means the last look is over and Resend did not see the record (it has been asked
  // again). Saying "checking" there too would have the builder wait on a missing, mistyped or
  // proxied record for good, so this note sends them back to what they added.
  const [trackNote, setTrackNote] = useState(null);
  const trackingCheck = () => {
    setTrackNote(null);
    act({ action: "email_tracking_check" }, (d) => {
      if (d.openTracking === "on") setMsg({ ok: "Email opens are on — opened emails now show “Opened” on the customer's record." });
      else if (d.openTracking === "not_found") setTrackNote("Our last look didn't find this record. Check it's added exactly as shown, and on Cloudflare set it to DNS only (the grey cloud). We've asked again, so press Check it in about 5 minutes.");
      else if (d.openTracking === "checking") setTrackNote("Checking now. This takes a few minutes, so press Check it again in about 5 minutes.");
      else setTrackNote("Not seen yet — add the record above at your DNS host, then check again. It can take up to an hour to appear.");
    });
  };

  const inboundDisconnect = () => {
    if (!window.confirm(
      "Turn off replies in the portal?\n\nCustomer replies go back to the inbox of whoever sent the email. Your quotes and invoices are not affected.",
    )) return;
    act({ action: "email_inbound_disconnect" }, () => setMsg({ ok: "Replies switched off." }));
  };

  const sendTest = async () => {
    if (!ssIsEmail(testTo)) { setTestResult({ err: "Enter a valid email address." }); return; }
    setBusy(true); setMsg(null); setTestResult(null);
    const { data: d, error: e } = await sb.functions.invoke("portal-settings", { body: { action: "email_send_test", to: testTo.trim() } });
    setBusy(false);
    if (e || (d && d.error)) { setTestResult({ err: (e && e.message) || (d && d.error) || "The test send failed." }); return; }
    setTestResult({ ok: "Sent — check the inbox. Delivery status shows in the list below (press ↻ Refresh in a minute)." });
    load();
  };

  // ── Your wording: save and preview ─────────────────────────────────────────────────
  // Save sends every tab at once (the server stores the whole map) and then reads the answer:
  // a server build that predates a field drops it from the map and still says ok, so "Saved."
  // is only shown when everything that was sent came back (ssWordingDropped). What came back is
  // put in the boxes, so the builder sees what is actually stored (spaces tidied, and so on);
  // after a drop, what they typed stays on screen next to the message instead.
  const saveWording = async () => {
    const sent = tpl;
    setTplBusy(true); setTplMsg(null);
    const { data: r, error: err } = await sb.functions.invoke("portal-settings", { body: { action: "email_save_template", copy: sent } });
    setTplBusy(false);
    const e2 = (r && r.error) || (err && err.message);
    if (e2) { setTplMsg({ err: e2 }); return; }
    const dropped = ssWordingDropped(sent, r && r.copy);
    if (dropped.length) {
      setTplMsg({ err: `Saved, but this server build didn't keep your ${ssJoinWords(dropped)}, so your emails use ours there for now. Tell CSM Synergy.` });
      return;
    }
    setTpl((r && r.copy) || {});
    setTplMsg({ ok: "Saved." });
  };
  // Preview draws the wording in the boxes for the open tab, saved or not, so a builder can try
  // words before committing them. The server renders the real email (their own header, footer
  // and photo, a sample customer); it sends nothing.
  const previewWording = async () => {
    const kind = tplKind;
    setPvBusy(true); setPv(null);
    const { data: r, error: err } = await sb.functions.invoke("portal-settings", {
      body: { action: "email_preview_template", kind, copy: tpl[kind] || {} },
    });
    setPvBusy(false);
    let e2 = (r && r.error) || (err && err.message);
    if (!e2 && !(r && typeof r.html === "string")) e2 = "The preview couldn't be made. Try again.";
    // A server from before Preview existed answers "Unrecognised action".
    if (e2 && /unrecognised action/i.test(e2)) e2 = "Preview isn't available on this server yet. Tell CSM Synergy.";
    setPv(e2 ? { kind, err: e2 } : { kind, subject: r.subject || "", html: r.html, photo: r.photo || null });
  };

  const fmtWhen = (iso) => {
    if (!iso) return "—";
    try { return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
    catch { return iso; }
  };
  const chipStyle = (s) => {
    const good = s === "sent" || s === "delivered" || s === "opened";
    const bad = s === "failed" || s === "bounced" || s === "marked as spam";
    return {
      background: good ? "#F0FDF4" : bad ? "#FEF2F2" : "#F1F5F9",
      color: good ? "#15803D" : bad ? "#DC2626" : "#475569",
      border: "1px solid " + (good ? "#BBF7D0" : bad ? "#FECACA" : "#E2E8F0"),
      borderRadius: 999, padding: "2px 9px", fontSize: 11, fontWeight: 700, flexShrink: 0,
    };
  };

  // ONE honest card frame, not a guess at which panel is coming. `status.domainStatus` chooses
  // between the connect form, the DNS-records table and the verified panel, and painting the
  // wrong one for a beat would tell a tenant something false about their own sending setup —
  // "add these DNS records" to someone already verified, or a connect form to someone who is
  // halfway through. All three share this frame: heading, a line of explanation, a status line,
  // then label/field pairs. Nothing is reordered above: email_status is genuinely one cheap
  // call (an indexed client_settings row plus ten capped email_sends rows, and deliberately no
  // vendor round trip; the one DNS question it asks runs beside the sends read and gives up
  // after 2.5 s) and its result IS the screen, so there is no slow leg to defer.
  if (status === null) return (
    <div style={S.card}>
      <SkelBar w={214} h={14} />
      <SkelBar w="90%" h={9} style={{ marginTop: 13 }} />
      <SkelBar w="72%" h={9} style={{ marginTop: 6 }} />
      <SkelBar w={168} h={11} style={{ marginTop: 18 }} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 12, marginTop: 14 }}>
        {[0, 1, 2].map((i) => (
          <div key={i}>
            <SkelBar w={86} h={8} />
            <SkelBar w="100%" h={34} style={{ marginTop: 7 }} />
            <SkelBar w="78%" h={8} style={{ marginTop: 7 }} />
          </div>
        ))}
      </div>
      <SkelBar w={146} h={34} style={{ marginTop: 20 }} />
    </div>
  );

  const platformReady = status.platformReady !== false;
  const st = status.domainStatus || "not_configured";
  const dns = Array.isArray(status.dnsRecords) ? status.dnsRecords : [];
  // Resend returns SPF + DKIM and NEVER a DMARC record, but a domain with no sending
  // history that publishes only SPF + DKIM goes to Gmail spam — verified live 2026-08-21.
  // So the table shows a fourth, advisory row. `advisory` keeps it out of the verified
  // tally: Resend does not check DMARC, so it can never report this one as verified, and a
  // permanent grey dot next to a correct record would read as broken.
  // ⚠️ BUILD THIS FROM THE PROVIDER'S DOMAIN, NOT OUR STORED STRING. Resend normalizes what
  // it is handed — give it "www.example.com" and it registers DKIM, MX and SPF against
  // "example.com" — so the two can silently disagree. When they did (2026-08-26) this row
  // told a tenant to publish _dmarc.www.csmsynergy.com, which protects nothing, with reports
  // going to carolyn@www.csmsynergy.com, an address that cannot receive mail. Meanwhile the
  // apex already had a correct _dmarc record.
  //
  // The record hostnames Resend RETURNED are the fact; our stored domain is only a claim.
  // Derive the apex from them and fall back to our copy only when there are none.
  const dnsApex = (() => {
    const dkim = dns.find((r) => String(r.host || "").startsWith("resend._domainkey."));
    if (dkim) return String(dkim.host).replace(/^resend\._domainkey\./, "");
    const send = dns.find((r) => String(r.host || "").startsWith("send."));
    if (send) return String(send.host).replace(/^send\./, "");
    return String(status.domain || "").replace(/^www\./, "");
  })();
  // ── Is there a DMARC record already? (2026-10-05) ──
  // This row used to show for every domain, and every builder domain waiting to connect already
  // had a record, one of them p=reject. Following the row there either ADDS a second record
  // (receivers then ignore both, so the domain has none) or swaps the builder's own policy for
  // p=none. So email_status asks public DNS first (existingDmarc, _shared/dmarcLookup.ts):
  //   • none there: the row, exactly as before;
  //   • one: no row, and a line saying leave it as it is;
  //   • two or more: no row, and a warning, because that is already broken;
  //   • DNS couldn't say (null), or a server from before the check sent nothing: no row and no
  //     line. Advising p=none blind is the mistake being fixed.
  // The answer has to be about THIS domain: `host` is where the server looked (from the same
  // DKIM host dnsApex reads) or where it found a record (this domain, or a parent whose record
  // covers it). A host that is neither counts as unknown.
  const dmarc = status.existingDmarc && typeof status.existingDmarc === "object" ? status.existingDmarc : null;
  const dmarcHost = dmarc && typeof dmarc.host === "string" ? dmarc.host : "";
  const dmarcNone = !!dmarc && dmarc.present === false && !!dnsApex && dmarcHost === "_dmarc." + dnsApex;
  const dmarcFound = !!dmarc && dmarc.present === true && !!dnsApex && dmarcHost.startsWith("_dmarc.")
    && ("." + dnsApex).endsWith("." + dmarcHost.slice("_dmarc.".length));
  const dmarcCount = dmarcFound ? Number(dmarc.count) || 1 : 0;
  const dmarcHave = dmarcFound && dmarcCount === 1;
  // Two records at one name cancel each other out, and nothing else on the screen would say so:
  // Resend never checks DMARC. Shown on the records card and on the verified one, because a
  // domain that verified long ago can still be carrying the extra record.
  const dmarcDupNote = dmarcFound && dmarcCount > 1 ? (
    <p data-ss-dmarc="duplicate" style={{ fontSize: 12.5, color: "#B91C1C", fontWeight: 600, marginTop: 10, marginBottom: 10, lineHeight: 1.55 }}>
      ⚠ Your domain has {dmarcCount} DMARC records (at <span style={{ fontFamily: "ui-monospace, monospace" }}>{dmarcHost}</span>).
      {dmarcCount === 2
        ? " Two records cancel each other out: inboxes ignore both, as if you had none. Ask whoever manages your DNS to delete the extra one."
        : " More than one cancels them all out: inboxes ignore every one, as if you had none. Ask whoever manages your DNS to keep one and delete the rest."}
    </p>
  ) : null;
  const dnsAdvisory = dns.length > 0 && dnsApex && dmarcNone
    ? [{
      type: "TXT",
      host: "_dmarc." + dnsApex,
      // The reports address has to be one that RECEIVES mail. A fromAddress on some other
      // host would send every DMARC report into a black hole, so it is used only when it
      // sits on this apex.
      value: "v=DMARC1; p=none; rua=mailto:" + (status.fromAddress && status.fromAddress.endsWith("@" + dnsApex) ? status.fromAddress : "you@" + dnsApex),
      verified: false,
      advisory: true,
    }]
    : [];
  // ── Receiving ────────────────────────────────────────────────────────────────────────
  const inbound = status.inbound || {};
  const inboundSt = inbound.status || "off";
  const inboundRows = Array.isArray(inbound.dnsRecords) ? inbound.dnsRecords : [];
  // ⚠️ THE INBOUND MX GOES INTO **THIS** ARRAY, not a table of its own, because
  // webmasterMailto is built from dnsRows. A builder who forwards the records to their web
  // guy and silently omits the MX gets sending working and receiving dead, with nothing on
  // screen to explain why — and that hand-off is the step where this whole flow already dies
  // (Carolyn: "so many people are going to be like, I don't know anything about this").
  // Ordered before the advisory row so the required records stay together.
  const dnsRows = dns.concat(inboundRows, dnsAdvisory);
  // The open-tracking record (B4) rides in `dns` with `tracking: true`. It is OPTIONAL — mail
  // sends the same without it, only the opens go uncounted — so every place that lists it says
  // so, and the verified screen gives it a card of its own. No tracking row at all means open
  // tracking was never switched on (a domain verified before it existed).
  const trackRows = dns.filter((r) => r.tracking);
  const trackSt = trackRows.length === 0 ? "off" : trackRows.every((r) => r.verified) ? "on" : "waiting";

  // ── "Email this to my webmaster" (Carolyn, 2026-08-25) ──────────────────────────────
  // Her words: "so many people are going to be like, I don't know anything about this."
  // The tenant is a shed builder; the person who can actually add a TXT record is their web
  // guy, and the gap between those two people is where domain verification dies. She
  // explicitly ruled out the auto-detect-their-DNS-host idea for now — "let's not right
  // now... instead let's put in here, email this to my webmaster."
  //
  // mailto: and nothing else. No send from our servers: the builder's own client puts it in
  // their Sent folder, uses whatever address their webmaster already answers, and keeps the
  // reply on a thread they own. It also means this works with zero backend, which matters
  // because the tenants who need it most are the ones whose sending is NOT yet verified.
  //
  // ⚠️ The DMARC row goes in the email. It is the one Resend never returns, and pasting
  // exactly what the portal shows without it is what put a live A/B test in Gmail's spam
  // folder (2026-08-21). A webmaster who adds three records and stops has done the work and
  // still gets spam-foldered, and nobody would know why.
  // It goes in ONLY when the row is on screen, i.e. DNS said there is no record (dnsAdvisory
  // is empty otherwise, which also drops its note below). Asking a webmaster to "add" one where
  // a record exists is how a domain ends up with two, or with p=none in place of its own.
  const webmasterMailto = (() => {
    if (dnsRows.length === 0) return "";
    const dom = dnsApex || status.domain || "our domain";
    // The open-tracking row(s) (B4). Its per-row label stays SHORT because every version of this
    // email below repeats it, and that budget is what keeps the required records in. The longer
    // Cloudflare sentence is said once, in the full email's prose (the terse one drops it).
    const optRows = dnsRows.filter((r) => r.tracking);
    const oneOpt = optRows.length === 1;
    const listOf = (rows) => rows.map((r, i) => {
      const bits = [
        `${i + 1}. ${r.type} record${r.advisory ? "  (recommended — see note below)" : r.tracking ? "  (optional, email opens; DNS only on Cloudflare)" : ""}`,
        `   Name/Host: ${r.host}`,
        `   Value:     ${r.value}`,
      ];
      // An MX without its priority cannot be created — same reason it is on screen.
      if (r.priority != null) bits.push(`   Priority:  ${r.priority}`);
      return bits.join("\n");
    }).join("\n\n");
    const lines = listOf(dnsRows);
    const body = [
      `Hi,`,
      ``,
      `Please add the following DNS records for ${dom}. They let our quoting software send`,
      `email from our own address instead of a shared one, and they prove to Gmail and`,
      `Outlook that the mail really is from us.`,
      ``,
      lines,
      ``,
      dnsAdvisory.length > 0
        ? `Note on the DMARC record: it is marked recommended rather than required. Our provider\ndoes not check it, so nothing will report it missing — but without it mail from a new\ndomain frequently lands in spam. "p=none" only asks for reports; it never blocks mail.`
        : ``,
      // Cloudflare proxies a new CNAME by default, and a proxied one is invisible to the provider.
      ...(optRows.length > 0
        ? [``, `Note on the ${oneOpt ? "record" : "records"} marked optional: ${oneOpt ? "it lets" : "they let"} us see when our emails are opened.\nIf our DNS is on Cloudflare, set ${oneOpt ? "it" : "them"} to "DNS only" (the grey cloud), not "Proxied" —\nwith the proxy on, our provider can't see ${oneOpt ? "it" : "them"}.`]
        : []),
      ``,
      `Nothing else needs changing — this does not affect the website or existing email.`,
      `Please let me know once they are in and I will run the verification check.`,
      ``,
      `Thanks!`,
    ].filter((l) => l !== undefined).join("\n");
    const build = (b) => `mailto:?subject=${encodeURIComponent(`DNS records to add for ${dom}`)}&body=${encodeURIComponent(b)}`;
    const full = build(body);
    // ⚠️ Windows/Outlook stop reading a mailto: at ~2,083 characters, and they TRUNCATE
    // rather than refuse -- the webmaster would get an email ending mid-record, with the
    // DMARC row (always last, always the one nobody else supplies) the first thing lost.
    // Measured 1,869 chars for csmsynergy.com and 2,079 for a 44-char domain, because a
    // 1024-bit DKIM value alone is ~218 chars and percent-encoding inflates every newline
    // to 3. So the prose is what gets dropped, never a record: the records ARE the email.
    if (full.length <= 1900) return full;
    const terseOf = (list, extra) => build([
      `Hi,`,
      ``,
      `Please add these DNS records for ${dom}:`,
      ``,
      list,
      ``,
      dnsAdvisory.length > 0 ? `The DMARC record is recommended, not required — without it mail from a new domain\noften lands in spam. "p=none" only asks for reports; it never blocks mail.` : ``,
      ...(extra ? [``, extra] : []),
      ``,
      `This does not affect the website or existing email. Thanks!`,
    ].filter((l) => l !== undefined).join("\n"));
    const short = terseOf(lines);
    if (short.length <= 1900) return short;
    // Still too long. The open-tracking record is the one OPTIONAL row (mail sends the same
    // without it), so it goes before any required one does: a webmaster with SPF, DKIM, the
    // reply MX and DMARC can finish the part that matters. The opens card still shows it, with
    // its Copy button, and says the email left it out (webmasterHasTracking). The line saying so
    // goes next if it has to: without it this is exactly the email a domain with no tracking
    // record gets, so switching opens on never costs a required record.
    if (optRows.length > 0) {
      const required = listOf(dnsRows.filter((r) => !r.tracking));
      for (const extra of [
        oneOpt
          ? `One more record is optional: it lets us see when emails are opened. I will send it separately.`
          : `${optRows.length} more records are optional: they let us see when emails are opened. I will send them separately.`,
        null,
      ]) {
        const m = terseOf(required, extra);
        if (m.length <= 1900) return m;
      }
    }
    // Even that can overflow (many records, or a long domain). Better a short email the
    // webmaster can reply to than a long one that arrives cut in half -- the on-screen
    // table with its per-row Copy buttons is still the complete source.
    return build(`Hi,\n\nPlease add the DNS records for ${dom} that I am sending separately —\nthere are ${dnsRows.length} of them and they are too long for one email.\n\nThanks!`);
  })();
  // Whether that email carries the open-tracking record, so the opens card does not promise it
  // when a long domain pushed it out.
  const webmasterHasTracking = trackRows.length > 0 && trackRows.every((r) => webmasterMailto.includes(encodeURIComponent(`Name/Host: ${r.host}`)));
  const sends = Array.isArray(status.recentSends) ? status.recentSends : [];

  const fromAddress = status.fromAddress || (status.fromLocal && status.domain ? `${status.fromLocal}@${status.domain}` : "");

  return (
    <div>
      {error && <div style={S.err}>{error}</div>}
      {msg && msg.ok && <div style={S.okMsg}>{msg.ok}</div>}
      {msg && msg.err && <div style={S.err}>{msg.err}</div>}

      {!platformReady && (
        <div style={{ ...S.card, opacity: 0.7 }}>
          <div style={S.h2}>Email sending</div>
          <p style={{ fontSize: 13, color: "#64748B", margin: 0 }}>
            Email sending isn't available yet — it's being set up.
          </p>
        </div>
      )}

      {/* ── not_configured: explainer + connect form ── */}
      {platformReady && st === "not_configured" && (
        <div style={S.card}>
          <div style={S.h2}>Send from your own email address</div>
          <p style={{ fontSize: 13, color: "#64748B", lineHeight: 1.55, marginBottom: 14 }}>
            Send estimates and invoices from your own email address, like info@yourbusiness.com.
            Connect your domain here, add the DNS records we give you at your DNS host, and your
            emails arrive from your business instead of a shared address.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 12 }}>
            <div>
              <label style={S.lbl}>Domain</label>
              <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="yourbusiness.com" style={S.input} />
              <div style={{ fontSize: 11, color: domain.trim() && !domainOk ? "#DC2626" : "#94A3B8", marginTop: 6 }}>
                {domain.trim() && !domainOk ? "That doesn't look like a domain — just the part after the @, like yourbusiness.com." : "The domain your business email lives on — no https:// and no @."}
              </div>
            </div>
            <div>
              <label style={S.lbl}>From name</label>
              <input value={fromName} onChange={(e) => setFromName(e.target.value)} placeholder="Your Business" style={S.input} />
              <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 6 }}>What customers see as the sender's name.</div>
            </div>
            <div>
              <label style={S.lbl}>From address</label>
              <input value={fromLocal} onChange={(e) => setFromLocal(e.target.value)} placeholder="info" style={S.input} />
              <div style={{ fontSize: 11, color: fromLocal.trim() && !localOk ? "#DC2626" : "#94A3B8", marginTop: 6 }}>
                Emails will come from <strong style={{ color: "#475569" }}>{(fromLocal.trim() || "info") + "@" + (domain.trim() || "yourbusiness.com")}</strong>
              </div>
            </div>
          </div>
          <div style={{ marginTop: 16 }}>
            <button type="button" onClick={connect} disabled={!canConnect}
              title={!canConnect && !busy ? "Enter your domain, a from name, and a from address" : undefined}
              style={{ ...S.btn(ACCENT, "#FFF"), opacity: canConnect ? 1 : 0.6, cursor: canConnect ? "pointer" : "not-allowed" }}>
              {busy ? "Connecting…" : "Connect domain"}
            </button>
          </div>
        </div>
      )}

      {/* ── pending / failed: DNS records + verification ──
          BRAND COLOURS, not amber (Carolyn 2026-09-11: "Does this need to be yellow? I'd like
          it to follow the brand colors"). #EEF2FF / #C7D2FE / ACCENT is the pairing the portal
          already uses wherever it wants a brand-toned panel — STATUS_COLORS.sent,
          INV_SALE_COLORS, the "checkout isn't switched on yet" notice, every selected row.

          Three things deliberately did NOT go purple with the body copy. A `failed` lastError
          is a real failure and reads RED now, where before it was amber text on an amber card
          — the one thing on this screen that should not blend in. The ★ marker, the MX
          priority and the verification result keep a contrasting tone (#1B7895, the brand's
          teal-blue) so they still stand off the panel; the MX priority in particular is a
          number somebody has to retype, not decoration. */}
      {platformReady && (st === "pending" || st === "failed") && (
        <div style={{ ...S.card, background: "#EEF2FF", border: "1px solid #C7D2FE" }}>
          <div style={{ ...S.h2, color: ACCENT }}>Add these records at your DNS host</div>
          {st === "failed" && status.lastError && (
            <div style={{ fontSize: 12.5, color: "#B91C1C", fontWeight: 600, marginBottom: 10 }}>{status.lastError}</div>
          )}
          <p style={{ fontSize: 12.5, color: ACCENT, marginBottom: 12, lineHeight: 1.5 }}>
            These records prove to inbox providers that {status.domain || "your domain"} really is
            yours. Add them wherever your DNS is managed (Cloudflare, GoDaddy, your web host),
            then check verification below.
          </p>
          {dns.length === 0 && (
            <p style={{ fontSize: 12.5, color: ACCENT, fontWeight: 600 }}>
              The records are being prepared — check again in a moment.
            </p>
          )}
          {dnsAdvisory.length > 0 && (
            <p style={{ fontSize: 12, color: ACCENT, marginTop: 10, marginBottom: 0, lineHeight: 1.55 }}>
              ★ The <strong>_dmarc</strong> record is strongly recommended but not required to
              verify. Without it many inboxes — Gmail especially — send mail from a new domain
              straight to spam. <strong>p=none</strong> only asks for reports; it never blocks
              your mail.
            </p>
          )}
          {/* The record is already there (existingDmarc): no row to add, and the builder told not
              to touch it, since "fixing" it to ours would weaken or cancel theirs. */}
          {dmarcHave && (
            <p data-ss-dmarc="present" style={{ fontSize: 12, color: ACCENT, marginTop: 10, marginBottom: 10, lineHeight: 1.55 }}>
              ✓ You already have a DMARC record{dmarc.policy ? <> (<strong>p={dmarc.policy}</strong>)</> : null}. Leave it as it is — don't add another one.
            </p>
          )}
          {dmarcDupNote}
          {dnsRows.length > 0 && (
            <div style={{ overflowX: "auto", background: "#FFF", border: "1px solid #C7D2FE", borderRadius: 8 }}>
              <table style={{ borderCollapse: "collapse", width: "100%" }}>
                <thead>
                  <tr>
                    <th style={{ ...S.th, width: 28 }} aria-label="Verified" />
                    <th style={S.th}>Type</th>
                    <th style={S.th}>Host</th>
                    <th style={S.th}>Value</th>
                    <th style={{ ...S.th, width: 90 }} aria-label="Copy" />
                  </tr>
                </thead>
                <tbody>
                  {dnsRows.map((r, i) => (
                    <tr key={i}>
                      <td style={{ ...S.td, textAlign: "center" }}>
                        {r.advisory
                          ? <span title="Recommended, not checked by us" style={{ color: "#1B7895", fontWeight: 800 }}>★</span>
                          : r.verified
                          ? <span title="Verified" style={{ color: "#16A34A", fontWeight: 800 }}>✓</span>
                          : <span title="Not verified yet" style={{ color: "#CBD5E1" }}>•</span>}
                      </td>
                      <td style={{ ...S.td, fontWeight: 700, whiteSpace: "nowrap" }}>
                        {r.type}
                        {/* The open-tracking CNAME (B4) is optional: verification never waits on it.
                            Cloudflare proxies a new CNAME by default, which hides it from Resend,
                            so the one host most builders use gets named. */}
                        {r.tracking && (
                          <span style={{ display: "block", fontSize: 10.5, fontWeight: 700, color: "#1B7895" }}>
                            optional · email opens
                          </span>
                        )}
                        {r.tracking && (
                          <span style={{ display: "block", fontSize: 10.5, fontWeight: 600, color: "#64748B" }}>
                            DNS only (grey cloud) on Cloudflare
                          </span>
                        )}
                        {/* An MX WITHOUT its priority cannot be created — the tenant DNS panel refuses
                            it, so the number has to sit on screen next to the type. */}
                        {r.priority != null && (
                          <span style={{ display: "block", fontSize: 10.5, fontWeight: 700, color: "#1B7895" }}>
                            priority {r.priority}
                          </span>
                        )}
                      </td>
                      <td style={{ ...S.td, fontFamily: "ui-monospace, monospace", fontSize: 11.5, wordBreak: "break-all" }}>{r.host}</td>
                      <td style={{ ...S.td, fontFamily: "ui-monospace, monospace", fontSize: 11.5, wordBreak: "break-all" }}>{r.value}</td>
                      <td style={{ ...S.td, whiteSpace: "nowrap" }}>
                        <button type="button" onClick={() => copy(r.value, "v" + i)}
                          style={{ ...S.btn(copied === "v" + i ? "#15803D" : "#F1F5F9", copied === "v" + i ? "#FFF" : "#334155"), border: "1px solid #E2E8F0", padding: "5px 10px", fontSize: 11.5 }}>
                          {copied === "v" + i ? "✓ Copied" : copied === "fail:v" + i ? "Copy failed" : "Copy"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 14, flexWrap: "wrap" }}>
            <button type="button" onClick={verify} disabled={busy}
              style={{ ...S.btn(ACCENT, "#FFF"), opacity: busy ? 0.6 : 1 }}>
              {busy ? "Checking…" : "Check verification"}
            </button>
            {webmasterMailto && (
              <a href={webmasterMailto}
                title="Opens your email program with the records already written out"
                style={{ ...S.btn("#FFF", ACCENT), border: "1px solid #C7D2FE", textDecoration: "none", display: "inline-block" }}>
                ✉️ Email this to my webmaster
              </a>
            )}
            {checkNote && <span style={{ fontSize: 12.5, color: "#1B7895", fontWeight: 600 }}>{checkNote}</span>}
          </div>
          {webmasterMailto && (
            <p style={{ fontSize: 12, color: ACCENT, marginTop: 8, marginBottom: 0, lineHeight: 1.5 }}>
              Not the person who manages your website? The button above opens your email program with
              every record written out, ready to send to whoever does.
            </p>
          )}
          <p style={{ fontSize: 12, color: ACCENT, marginTop: 12, marginBottom: 0 }}>
            DNS changes can take up to an hour to appear — keep this tab open and check again.
          </p>
          <div style={{ marginTop: 10 }}>
            <button type="button" onClick={disconnect} disabled={busy}
              style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 600, color: "#475569", textDecoration: "underline" }}>
              Start over with a different domain
            </button>
          </div>
        </div>
      )}

      {/* ── verified: status + activate + test + recent sends ── */}
      {platformReady && st === "verified" && (
        <div>
          <div style={S.card}>
            <div style={S.h2}>Email sending</div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ width: 10, height: 10, borderRadius: 5, background: "#16A34A", flexShrink: 0 }} />
              <div style={{ minWidth: 0, flex: "1 1 260px" }}>
                <div style={{ fontSize: 14, fontWeight: 800, color: "#1E293B", wordBreak: "break-word" }}>
                  {active
                    ? `Sending as ${status.fromName ? status.fromName + " " : ""}<${fromAddress}>`
                    : `Verified — ready to send as ${status.fromName ? status.fromName + " " : ""}<${fromAddress}>`}
                </div>
                <div style={{ fontSize: 12, color: "#64748B", marginTop: 2 }}>
                  {status.domain || "Your domain"} is verified{status.verifiedAt ? ` · ${fmtDate(status.verifiedAt)}` : ""}
                </div>
              </div>
              <button type="button" onClick={disconnect} disabled={busy}
                style={{ ...S.btn("#FFF", "#DC2626"), border: "1px solid #FECACA", flexShrink: 0 }}>Disconnect</button>
            </div>
            <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid #F1F5F9" }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 600, color: "#1E293B", cursor: busy ? "default" : "pointer" }}>
                <input type="checkbox" checked={active} disabled={busy} onChange={toggleActive} />
                Send estimate &amp; invoice emails from my domain
              </label>
              <p style={{ fontSize: 12, color: "#64748B", marginTop: 6, marginBottom: 0, lineHeight: 1.5 }}>
                Activating switches your estimate and invoice emails to send from your own domain.
                Deactivating instantly reverts to sending through your CRM — nothing else changes.
              </p>
            </div>
            {dmarcDupNote}
            {/* Verified is not forever: a DNS host migration, a zone rebuild or a webmaster
                tidying up "unused" TXT records drops these silently, and the first symptom is
                mail going to spam. The records have to stay reachable AFTER verification, not
                only while chasing it -- so the same button lives here too. */}
            {webmasterMailto && (
              <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid #F1F5F9" }}>
                <a href={webmasterMailto}
                  title="Opens your email program with the records already written out"
                  style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0", textDecoration: "none", display: "inline-block" }}>
                  ✉️ Email these records to my webmaster
                </a>
                <p style={{ fontSize: 12, color: "#64748B", marginTop: 8, marginBottom: 0, lineHeight: 1.5 }}>
                  Changing DNS host or rebuilding your website? Send these to whoever does it —
                  removing them stops your email verifying and sends it to spam.
                </p>
              </div>
            )}
          </div>

          {/* ── Replies in the portal ──────────────────────────────────────────────────
              Ahsan, 2026-08-26: "if Junior Barns connects his domain, he should be able to
              send AND receive emails in there."

              Only rendered once SENDING is verified, because the reply address is a
              subdomain of the sending domain — there is nothing to offer before that. */}
          <div style={S.card}>
            <div style={S.h2}>Replies in the portal</div>

            {inboundSt === "off" && (
              <div>
                <p style={{ fontSize: 13, color: "#475569", marginTop: 0, marginBottom: 10, lineHeight: 1.6 }}>
                  Right now when a customer replies to a quote, it goes to the personal inbox of
                  whoever sent it. Switch this on and replies land here instead, on the customer's
                  record, so anyone on your team can pick the conversation up.
                </p>
                {/* THE REASSURANCE IS THE FEATURE. A builder who thinks we are taking over
                    @theirdomain.com will refuse, and they would be right to — it is their
                    company inbox. Say the safe thing before asking for the click. */}
                <p style={{ fontSize: 12.5, color: "#475569", marginTop: 0, marginBottom: 12, lineHeight: 1.6, background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 8, padding: "10px 12px" }}>
                  This uses a separate address at <strong>reply.{status.domain}</strong> and adds
                  one record there. <strong>Your normal email at @{status.domain} is not touched</strong> —
                  it keeps working exactly as it does now.
                </p>
                <button type="button" onClick={inboundConnect} disabled={busy}
                  style={{ ...S.btn(ACCENT, "#FFF"), opacity: busy ? 0.6 : 1 }}>
                  {busy ? "Setting up…" : "Set up replies"}
                </button>
              </div>
            )}

            {inboundSt === "pending" && (
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 5, background: "#F59E0B", flexShrink: 0 }} />
                  <div style={{ fontSize: 14, fontWeight: 800, color: "#1E293B" }}>One record to add</div>
                </div>
                <p style={{ fontSize: 12.5, color: "#475569", marginTop: 0, marginBottom: 10, lineHeight: 1.6 }}>
                  Add this at the same place you added the others. It only affects
                  <strong> reply.{status.domain}</strong> — your normal email is unaffected.
                </p>
                {inboundRows.length > 0 && (
                  <div style={{ overflowX: "auto", background: "#FFF", border: "1px solid #E2E8F0", borderRadius: 8 }}>
                    <table style={{ borderCollapse: "collapse", width: "100%" }}>
                      <thead>
                        <tr>
                          <th style={S.th}>Type</th>
                          <th style={S.th}>Host</th>
                          <th style={S.th}>Value</th>
                          <th style={{ ...S.th, width: 90 }} aria-label="Copy" />
                        </tr>
                      </thead>
                      <tbody>
                        {inboundRows.map((r, i) => (
                          <tr key={i}>
                            <td style={{ ...S.td, fontWeight: 700, whiteSpace: "nowrap" }}>
                              {r.type}
                              {/* An MX without its priority is refused by every DNS panel. */}
                              {r.priority != null && (
                                <span style={{ display: "block", fontSize: 10.5, fontWeight: 700, color: "#B45309" }}>
                                  priority {r.priority}
                                </span>
                              )}
                            </td>
                            <td style={{ ...S.td, fontFamily: "ui-monospace, monospace", fontSize: 11.5, wordBreak: "break-all" }}>{r.host}</td>
                            <td style={{ ...S.td, fontFamily: "ui-monospace, monospace", fontSize: 11.5, wordBreak: "break-all" }}>{r.value}</td>
                            <td style={{ ...S.td, whiteSpace: "nowrap" }}>
                              <button type="button" onClick={() => copy(r.value, "mx" + i)}
                                style={{ ...S.btn(copied === "mx" + i ? "#15803D" : "#F1F5F9", copied === "mx" + i ? "#FFF" : "#334155"), border: "1px solid #E2E8F0", padding: "5px 10px", fontSize: 11.5 }}>
                                {copied === "mx" + i ? "✓ Copied" : copied === "fail:mx" + i ? "Copy failed" : "Copy"}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
                  <button type="button" onClick={inboundVerify} disabled={busy}
                    style={{ ...S.btn(ACCENT, "#FFF"), opacity: busy ? 0.6 : 1 }}>
                    {busy ? "Checking…" : "Check it"}
                  </button>
                  <button type="button" onClick={inboundDisconnect} disabled={busy}
                    style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 600, color: "#64748B", textDecoration: "underline" }}>
                    Cancel
                  </button>
                  {inboundNote && <span style={{ fontSize: 12.5, color: "#B45309", fontWeight: 600 }}>{inboundNote}</span>}
                </div>
                {/* The webmaster button up in the sending card already carries this record —
                    dnsRows includes it — so there is deliberately no second one here. */}
                <p style={{ fontSize: 12, color: "#64748B", marginTop: 10, marginBottom: 0, lineHeight: 1.5 }}>
                  Someone else manages your DNS? The “Email these records to my webmaster” button
                  above includes this one too.
                </p>
                {inbound.lastError && (
                  <p style={{ fontSize: 12, color: "#B45309", marginTop: 8, marginBottom: 0 }}>{inbound.lastError}</p>
                )}
              </div>
            )}

            {inboundSt === "active" && (
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <span style={{ width: 10, height: 10, borderRadius: 5, background: "#16A34A", flexShrink: 0 }} />
                  <div style={{ minWidth: 0, flex: "1 1 260px" }}>
                    <div style={{ fontSize: 14, fontWeight: 800, color: "#1E293B" }}>
                      Replies come back here
                    </div>
                    <div style={{ fontSize: 12, color: "#64748B", marginTop: 2 }}>
                      {inbound.domain}{inbound.verifiedAt ? ` · since ${fmtDate(inbound.verifiedAt)}` : ""}
                    </div>
                  </div>
                  <button type="button" onClick={inboundDisconnect} disabled={busy}
                    style={{ ...S.btn("#FFF", "#DC2626"), border: "1px solid #FECACA", flexShrink: 0 }}>Turn off</button>
                </div>
                <p style={{ fontSize: 12.5, color: "#475569", marginTop: 10, marginBottom: 0, lineHeight: 1.6 }}>
                  When a customer replies to a quote it appears on their record, and on the design
                  they were asking about. Each email gets its own reply address so we know what it
                  belongs to — they look like <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 11.5 }}>{inbound.replyExample}</span>.
                  Customers never type it; their email program fills it in when they press Reply.
                </p>
              </div>
            )}
          </div>

          {/* ── See when emails are opened (B4) ──────────────────────────────────────────
              Carolyn, 2026-10-01: a prospective client "asked to be able to see if an email is
              read or not." Only rendered once sending is verified: the tracking record lives on
              the sending domain, so there is nothing to offer before that. */}
          <div style={S.card}>
            <div style={S.h2}>See when emails are opened</div>
            {trackSt === "off" && (
              <div>
                <p style={{ fontSize: 13, color: "#475569", marginTop: 0, marginBottom: 12, lineHeight: 1.6 }}>
                  Switch this on and an email you send shows <strong>Opened</strong> on the customer's
                  record — in the portal and in the phone app — once they open it. It needs one more
                  record at your DNS host. Your email keeps sending the same either way.
                </p>
                <button type="button" onClick={trackingCheck} disabled={busy}
                  style={{ ...S.btn(ACCENT, "#FFF"), opacity: busy ? 0.6 : 1 }}>
                  {busy ? "Switching on…" : "Turn on"}
                </button>
                {trackNote && <div style={{ fontSize: 12.5, color: "#B45309", fontWeight: 600, marginTop: 8 }}>{trackNote}</div>}
              </div>
            )}
            {trackSt === "waiting" && (
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 5, background: "#F59E0B", flexShrink: 0 }} />
                  <div style={{ fontSize: 14, fontWeight: 800, color: "#1E293B" }}>One record to add</div>
                </div>
                <p style={{ fontSize: 12.5, color: "#475569", marginTop: 0, marginBottom: 10, lineHeight: 1.6 }}>
                  Add this at the same place you added the others. If your DNS is on Cloudflare, set
                  it to <strong>DNS only</strong> (the grey cloud), not Proxied. Cloudflare turns the
                  proxy on by default, and with it on we can't see the record. Until it is in place
                  nothing is counted as opened — your email keeps sending the same either way.
                </p>
                <div style={{ overflowX: "auto", background: "#FFF", border: "1px solid #E2E8F0", borderRadius: 8 }}>
                  <table style={{ borderCollapse: "collapse", width: "100%" }}>
                    <thead>
                      <tr>
                        <th style={S.th}>Type</th>
                        <th style={S.th}>Host</th>
                        <th style={S.th}>Value</th>
                        <th style={{ ...S.th, width: 90 }} aria-label="Copy" />
                      </tr>
                    </thead>
                    <tbody>
                      {trackRows.map((r, i) => (
                        <tr key={i}>
                          <td style={{ ...S.td, fontWeight: 700, whiteSpace: "nowrap" }}>
                            {r.type}
                            {r.verified && <span title="In place" style={{ color: "#16A34A", fontWeight: 800, marginLeft: 6 }}>✓</span>}
                          </td>
                          <td style={{ ...S.td, fontFamily: "ui-monospace, monospace", fontSize: 11.5, wordBreak: "break-all" }}>{r.host}</td>
                          <td style={{ ...S.td, fontFamily: "ui-monospace, monospace", fontSize: 11.5, wordBreak: "break-all" }}>{r.value}</td>
                          <td style={{ ...S.td, whiteSpace: "nowrap" }}>
                            <button type="button" onClick={() => copy(r.value, "tr" + i)}
                              style={{ ...S.btn(copied === "tr" + i ? "#15803D" : "#F1F5F9", copied === "tr" + i ? "#FFF" : "#334155"), border: "1px solid #E2E8F0", padding: "5px 10px", fontSize: 11.5 }}>
                              {copied === "tr" + i ? "✓ Copied" : copied === "fail:tr" + i ? "Copy failed" : "Copy"}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
                  <button type="button" onClick={trackingCheck} disabled={busy}
                    style={{ ...S.btn(ACCENT, "#FFF"), opacity: busy ? 0.6 : 1 }}>
                    {busy ? "Checking…" : "Check it"}
                  </button>
                  {trackNote && <span style={{ fontSize: 12.5, color: "#B45309", fontWeight: 600 }}>{trackNote}</span>}
                </div>
                <p style={{ fontSize: 12, color: "#64748B", marginTop: 10, marginBottom: 0, lineHeight: 1.5 }}>
                  {webmasterHasTracking
                    ? <>Someone else manages your DNS? The “Email these records to my webmaster” button
                      above includes this one too.</>
                    : <>Someone else manages your DNS? Copy this record to them yourself: your domain
                      name is long, so the “Email these records to my webmaster” email above has no
                      room for it.</>}
                </p>
              </div>
            )}
            {trackSt === "on" && (
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <span style={{ width: 10, height: 10, borderRadius: 5, background: "#16A34A", flexShrink: 0 }} />
                <div style={{ fontSize: 14, fontWeight: 800, color: "#1E293B" }}>On — opened emails show “Opened” on the customer's record</div>
              </div>
            )}
            {/* THE CAVEAT IS PART OF THE FEATURE. An open is the provider's guess from a tracking
                image: a builder who reads "Opened" as proof, or "not opened" as "never read",
                will chase the wrong customer. Same sentence as the record page's tooltip. */}
            <p style={{ fontSize: 12, color: "#64748B", marginTop: 12, marginBottom: 0, lineHeight: 1.5 }}>
              Opens are approximate: some mail apps block the tracking image, and some open emails automatically.
            </p>
          </div>

          <div style={S.card}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <div style={S.h2}>Send a test email</div>
              <button type="button" onClick={load} title="Re-check delivery status"
                style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0", padding: "6px 12px" }}>↻ Refresh</button>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <input style={{ ...S.input, flex: "1 1 240px", maxWidth: 340 }} type="email" value={testTo}
                onChange={(e) => setTestTo(e.target.value)} placeholder="you@yourbusiness.com" />
              <button type="button" onClick={sendTest} disabled={busy || !ssIsEmail(testTo)}
                title={!ssIsEmail(testTo) ? "Enter a valid email address" : undefined}
                style={{ ...S.btn(ACCENT, "#FFF"), opacity: (busy || !ssIsEmail(testTo)) ? 0.6 : 1 }}>
                {busy ? "Sending…" : "Send test"}
              </button>
            </div>
            {testResult && (
              <div style={{ marginTop: 10, fontSize: 12.5, fontWeight: 600, color: testResult.err ? "#DC2626" : "#15803D" }}>
                {testResult.err || testResult.ok}
              </div>
            )}
            {/* ── YOUR WORDING ────────────────────────────────────────────────────────
                Carolyn, 2026-08-21: "I don't know what it's going to take to create like a
                template that they can edit, you know, for images and all of that stuff too."
                Her CRM quote email is a picture, the details, then a "View Shed Quote" button.

                What is editable is the builder's voice: the SUBJECT, the OPENING LINE, a
                CLOSING MESSAGE under the links, the BUTTON'S WORDS, and whether the BUILDING
                PHOTO shows (quotes and estimates; it is the style's own photo, behind its
                "Image on estimate" switch under Structures). The branded header, the quote/total
                rows, where the button goes and the PDF links stay ours, because those are the
                parts that DO something and a wording edit has no business near them. Logo and
                colours are already theirs under Branding.
                Plain text only: markup is refused with a message, not silently stripped. The
                limits match the server's (_shared/emailTemplates.ts TEMPLATE_LIMITS), so what is
                saved is what was typed. */}
            <div data-ss-email-wording style={{ marginTop: 14, borderTop: "1px solid #F1F5F9", paddingTop: 12 }}>
              <div style={S.lbl}>Your wording</div>
              <div style={{ fontSize: 12, color: "#64748B", margin: "2px 0 8px" }}>
                Leave blank to use ours. Use {"{business}"}, {"{number}"}, {"{total}"}, {"{building}"}, {"{customer}"} (the customer's name) and they fill in automatically.
                {/* Plan 3.1 (Carolyn 2026-09-14, the quote email she highlighted): the quote
                    email no longer prints the total, so the customer meets the price on the
                    quote itself. {total} still fills in — saved wording must never print a
                    literal "{total}" — it is just the one token that works against that. */}
                {tplKind === "quote" && (
                  <span data-token-hint="total"> <b>{"{total}"}</b> is not recommended for quotes — the quote email leaves the price out, so the customer sees it when they open the quote.</span>
                )}
              </div>
              <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                {[["estimate", "Estimate"], ["quote", "Quote"], ["invoice", "Invoice"]].map(([k, label]) => (
                  <button key={k} type="button" onClick={() => setTplKind(k)}
                    style={{ background: tplKind === k ? ACCENT : "#FFF", color: tplKind === k ? "#FFF" : "#334155", border: "1px solid " + (tplKind === k ? ACCENT : "#E2E8F0"), borderRadius: 8, padding: "5px 12px", fontSize: 12.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>{label}</button>
                ))}
              </div>
              {(() => {
                const cur = tpl[tplKind] || {};
                const setField = (f, v) => setTpl((p) => ({ ...p, [tplKind]: { ...(p[tplKind] || {}), [f]: v } }));
                const fieldLbl = { fontSize: 11.5, fontWeight: 700, color: "#475569", margin: "6px 0 3px" };
                const docWord = tplKind === "invoice" ? "invoice" : tplKind;
                return (
                  <>
                    <div style={fieldLbl}>Subject</div>
                    <input data-ss-wording="subject" aria-label="Subject" maxLength={300}
                      value={cur.subject || ""}
                      onChange={(e) => setField("subject", e.target.value)}
                      placeholder={"e.g. Your " + tplKind + " {number} from {business}"}
                      style={S.input} />
                    <div style={fieldLbl}>Opening line</div>
                    <textarea data-ss-wording="intro" aria-label="Opening line" maxLength={300}
                      value={cur.intro || ""}
                      onChange={(e) => setField("intro", e.target.value)}
                      rows={3}
                      placeholder={tplKind === "quote"
                        ? "e.g. Thanks for designing with {business}! Your quote {number} is ready."
                        : "e.g. Thanks for designing with {business}! Your {total} quote is ready."}
                      style={{ ...S.input, resize: "vertical" }} />
                    <div style={fieldLbl}>Closing message <span style={{ fontWeight: 500, color: "#94A3B8" }}>(under the button)</span></div>
                    <textarea data-ss-wording="closing" aria-label="Closing message" maxLength={1000}
                      value={cur.closing || ""}
                      onChange={(e) => setField("closing", e.target.value)}
                      rows={3}
                      placeholder={"e.g. Questions about your " + docWord + "? Just reply to this email or give us a call."}
                      style={{ ...S.input, resize: "vertical" }} />
                    <div style={fieldLbl}>Button text</div>
                    <input data-ss-wording="button" aria-label="Button text" maxLength={40}
                      value={cur.button || ""}
                      onChange={(e) => setField("button", e.target.value)}
                      placeholder={tplKind === "invoice" ? "e.g. Review & Sign Your Invoice" : tplKind === "quote" ? "e.g. View Shed Quote" : "e.g. View Your Estimate"}
                      style={{ ...S.input, maxWidth: 340 }} />
                    {tplKind !== "invoice" && (
                      <label style={{ display: "flex", alignItems: "flex-start", gap: 8, marginTop: 10, fontSize: 12.5, color: "#334155", cursor: "pointer" }}>
                        <input data-ss-wording="picture" type="checkbox" checked={cur.picture !== false}
                          onChange={(e) => setField("picture", e.target.checked)}
                          style={{ width: 15, height: 15, marginTop: 1, cursor: "pointer", flexShrink: 0 }} />
                        <span>
                          <b>Show the building photo</b>
                          <span style={{ display: "block", color: "#64748B", fontSize: 12, marginTop: 1 }}>
                            The photo of the style they picked, above the details. It shows only for styles with “Image on estimate” ticked under Structures.
                          </span>
                        </span>
                      </label>
                    )}
                  </>
                );
              })()}
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
                <button type="button" disabled={tplBusy} onClick={saveWording}
                  style={{ ...S.btn(ACCENT, "#FFF"), opacity: tplBusy ? 0.6 : 1 }}>{tplBusy ? "Saving…" : "Save wording"}</button>
                <button type="button" disabled={pvBusy} onClick={previewWording}
                  style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0", opacity: pvBusy ? 0.6 : 1 }}>{pvBusy ? "Making preview…" : "Preview"}</button>
                {tplMsg && tplMsg.ok && <span style={{ fontSize: 12.5, color: "#065F46", fontWeight: 700 }}>{tplMsg.ok}</span>}
                {tplMsg && tplMsg.err && <span style={{ fontSize: 12.5, color: "#B91C1C", fontWeight: 700 }}>{tplMsg.err}</span>}
              </div>
              {/* THE PREVIEW IS THE SERVER'S RENDER of the real email, so it cannot drift from what
                  a customer gets. It is drawn in a frame with sandbox="" (no scripts, no forms,
                  links that can't open) from srcdoc, so nothing in it can reach this page. */}
              {pv && pv.kind === tplKind && (
                <div data-ss-email-preview style={{ marginTop: 12 }}>
                  {pv.err ? (
                    <div style={{ fontSize: 12.5, color: "#B91C1C", fontWeight: 700 }}>{pv.err}</div>
                  ) : (
                    <>
                      <div style={{ fontSize: 12.5, color: "#334155", marginBottom: 6, wordBreak: "break-word" }}>
                        <span style={{ color: "#64748B", fontWeight: 700 }}>Subject:</span> <b data-ss-preview-subject>{pv.subject}</b>
                      </div>
                      {pv.photo === "none" && (
                        <div style={{ fontSize: 12, color: "#B45309", marginBottom: 6 }}>
                          No building photo yet: none of your styles has a photo with “Image on estimate” ticked. Add one under Settings → Structures.
                        </div>
                      )}
                      {/* "not_own": the photos ARE there and ticked, but were copied from another
                          account's catalog, so they live in that account's folder and no email (or
                          estimate) may show them. The "none" sentence would send them to a screen
                          where every tick is already on. */}
                      {pv.photo === "not_own" && (
                        <div style={{ fontSize: 12, color: "#B45309", marginBottom: 6 }}>
                          No building photo: your style photos were copied from another account, so they can't go in emails. Upload them again under Settings → Structures.
                        </div>
                      )}
                      <iframe title={"Preview of your " + tplKind + " email"} sandbox="" srcDoc={pv.html}
                        style={{ display: "block", width: "100%", height: 560, border: "1px solid #E2E8F0", borderRadius: 8, background: "#F1F5F9" }} />
                      <div style={{ fontSize: 11.5, color: "#94A3B8", marginTop: 6 }}>
                        A made-up customer and number, with your own business details. Nothing is sent. Save to use these words.
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
            {sends.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <div style={S.lbl}>Recent sends</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {sends.map((sd, i) => (
                    <div key={sd.id || i} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", border: "1px solid #F1F5F9", borderRadius: 8, padding: "7px 10px" }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: "#64748B", textTransform: "uppercase", letterSpacing: 0.5, minWidth: 56 }}>{sd.kind || "email"}</span>
                      <span style={{ fontSize: 12.5, color: "#1E293B", fontWeight: 600, flex: "1 1 180px", minWidth: 0, wordBreak: "break-all" }}>{sd.to}</span>
                      {/* "opened" once the customer opened it (migration 262) — unless it bounced
                          since, which is the news that matters. "marked as spam" beats both: the
                          email arrived, and the one thing to do is not email them again. */}
                      {(() => {
                        const shown = sd.complainedAt ? "marked as spam"
                          : sd.openedAt && sd.status !== "bounced" ? "opened" : sd.status;
                        const tip = shown === "marked as spam" ? "They marked this email as spam. Don't email them again."
                          : shown === "opened" ? "Opens are approximate: some mail apps block the tracking image, and some open emails automatically."
                          : undefined;
                        return <span style={chipStyle(shown)} title={tip}>{shown || "—"}</span>;
                      })()}
                      <span style={{ fontSize: 11.5, color: "#94A3B8", flexShrink: 0 }}>{fmtWhen(sd.createdAt)}</span>
                      {(sd.status === "failed" || sd.status === "bounced") && (sd.error || sd.bounceReason) && (
                        <span style={{ fontSize: 11.5, color: "#DC2626", flexBasis: "100%" }}>{sd.error || sd.bounceReason}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Commission structure (owner-only Settings sub-tab) ───
// The tenant's commission RULES: who earns by default, the base, the earned-on date, the
// payout cadence, and the cancel-clawback rule. Owner-only — the row is RLS-gated to the
// owner (commission_settings_owner_* + current_user_is_owner()), so a direct read/write
// here is safe. The confidential per-user RATES and the payouts report are separate slices
// (service-role only), built next. See migration 076_commission_settings.
function CommissionStructure({ clientId }) {
  const [s, setS] = useState(null);       // settings row (or defaults if none saved yet)
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);   // { ok } | { err }

  const load = useCallback(async () => {
    setLoading(true); setMsg(null);
    let { data, error } = await sb.from("commission_settings").select("*").eq("client_id", clientId).limit(1);
    // An empty read is ambiguous exactly as it is for the tenant read in 09-shell.jsx: a
    // request that went out without a user token gets zero rows and NO error. Here that is
    // worse than misleading, because zero rows becomes the hard-coded DEFAULTS below and the
    // next Save upserts them — replacing a tenant's live commission terms with "disabled,
    // biweekly", and reporting "Commission structure saved." while doing it. So prove a
    // session first and let a second read agree before believing this tenant has no row.
    if (!error && !(data && data[0])) {
      const { data: ssSess } = await sb.auth.getSession();
      if (!ssSess || !ssSess.session) {
        // Leave `s` null: the card above renders its loading state and no form exists, so
        // nothing can be written over. Reopening the tab re-runs this.
        setLoading(false); return;
      }
      const retry = await sb.from("commission_settings").select("*").eq("client_id", clientId).limit(1);
      data = retry.data; error = retry.error;
    }
    if (error) setMsg({ err: error.message });
    setS((data && data[0]) || { enabled: false, base_type: "pretax_subtotal", earned_on: "collected", payout_frequency: "biweekly", custom_days: null, clawback_on_cancel: true });
    setLoading(false);
  }, [clientId]);
  useEffect(() => { load(); }, [load]);

  const set = (k, v) => setS((p) => ({ ...p, [k]: v }));

  const save = async () => {
    setSaving(true); setMsg(null);
    let uid = null;
    try { const { data } = await sb.auth.getUser(); uid = data && data.user ? data.user.id : null; } catch (_e) {}
    const row = {
      client_id: clientId, enabled: !!s.enabled, base_type: s.base_type, earned_on: s.earned_on,
      payout_frequency: s.payout_frequency,
      custom_days: s.payout_frequency === "custom" ? (Number(s.custom_days) || null) : null,
      clawback_on_cancel: !!s.clawback_on_cancel, updated_at: new Date().toISOString(), updated_by: uid,
    };
    const { error } = await sb.from("commission_settings").upsert(row, { onConflict: "client_id" });
    setSaving(false);
    setMsg(error ? { err: error.message } : { ok: "Commission structure saved." });
  };

  // Segmented single-choice control bound to a field. opts: [value, label, disabled?].
  const seg = (field, opts) => (
    <div style={{ display: "inline-flex", border: "1px solid #E2E8F0", borderRadius: 9, overflow: "hidden", flexWrap: "wrap" }}>
      {opts.map(([val, label, disabled]) => (
        <button key={String(val)} type="button" disabled={disabled} onClick={() => set(field, val)}
          style={{ background: s[field] === val ? ACCENT : (disabled ? "#F8FAFC" : "#FFF"), color: s[field] === val ? "#FFF" : (disabled ? "#94A3B8" : "#475569"), border: "none", borderRight: "1px solid #E2E8F0", padding: "8px 14px", fontSize: 12.5, fontWeight: 700, cursor: disabled ? "not-allowed" : "pointer", fontFamily: "inherit" }}>
          {label}
        </button>
      ))}
    </div>
  );
  const lab = (t) => <span style={{ ...S.lbl, display: "block", marginBottom: 7 }}>{t}</span>;

  // This screen is not slow — one indexed single-row select, no fan-out, no edge function. Its
  // whole problem was saying "Loading" on an empty card, which reads as broken rather than as
  // coming. So: skeleton only, and load() is untouched.
  //
  // ⚠️ It must stay a SKELETON and never a greyed-out copy of the form. The session re-check
  // above deliberately leaves `s` null and returns, so this branch is also the guard's safe
  // state — and a disabled form would render the hard-coded DEFAULTS ("disabled", "biweekly",
  // "pre-tax subtotal"). A tenant glimpsing their live commission terms as "disabled" is a lie
  // about their own configuration, told by the very branch that exists to stop us writing that
  // lie into their row. Grey bars claim nothing.
  if (loading || !s) return (
    <div style={{ ...S.card, maxWidth: 720 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <SkelBar w={186} h={15} />
        <SkelBar w={72} h={15} style={{ borderRadius: 999 }} />
      </div>
      <SkelBar w="94%" h={9} />
      <SkelBar w="66%" h={9} style={{ marginTop: 6 }} />
      <SkelBar w={252} h={14} style={{ marginTop: 20 }} />
      {/* Five label+control pairs, matching the five blocks the real form lays out below the
          on/off checkbox: the who-earns note (the tall one), then base, earned-on, cadence and
          clawback — so the form lands into its own outline instead of pushing the page around. */}
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} style={{ marginTop: 18 }}>
          <SkelBar w={i % 2 ? 214 : 168} h={8} style={{ opacity: 1 - i * 0.09 }} />
          <SkelBar w={i === 0 ? "100%" : 318} h={i === 0 ? 46 : 34} style={{ marginTop: 8, opacity: 1 - i * 0.09 }} />
        </div>
      ))}
      <SkelBar w={204} h={36} style={{ marginTop: 24 }} />
    </div>
  );

  return (
    <div style={{ ...S.card, maxWidth: 720 }}>
      {msg && msg.err && <div style={S.err}>{msg.err}</div>}
      {msg && msg.ok && <div style={S.okMsg}>{msg.ok}</div>}

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
        <div style={{ ...S.h2, marginBottom: 0 }}>Commission structure</div>
        <span style={{ background: "#EDE9FE", color: "#5B21B6", fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.5, borderRadius: 999, padding: "3px 9px" }}>Owner only</span>
      </div>
      <p style={{ fontSize: 12.5, color: "#64748B", lineHeight: 1.5, margin: "0 0 16px" }}>
        Set the rules once — they decide who earns and what they're owed on every order. Splits, reassignments, and adjustments happen per sale on the Commissions report.
      </p>

      <label style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18, cursor: "pointer" }}>
        <input type="checkbox" checked={!!s.enabled} onChange={(e) => set("enabled", e.target.checked)} />
        <span style={{ fontSize: 13.5, fontWeight: 700 }}>Turn on commission tracking for this account</span>
      </label>

      <div style={{ marginBottom: 16 }}>
        {lab("Who earns by default")}
        <div style={{ background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 9, padding: "12px 14px", fontSize: 12.5, color: "#475569", lineHeight: 1.5 }}>
          The user who <b>submits</b> the order. A public customer self-design (no rep) is <b>non-commissionable until you assign an earner</b> on the report.
        </div>
      </div>

      <div style={{ marginBottom: 16 }}>
        {lab("Commission is a % of")}
        {seg("base_type", [["pretax_subtotal", "Pre-tax subtotal"], ["gross_profit", "Gross profit (soon)", true]])}
      </div>

      <div style={{ marginBottom: 16 }}>
        {lab("Commission is earned on the …")}
        {seg("earned_on", [["sold", "Sold date"], ["delivered", "Delivered date (soon)", true], ["collected", "Money-collected date"]])}
      </div>

      <div style={{ marginBottom: 16 }}>
        {lab("Pay commissions")}
        {seg("payout_frequency", [["weekly", "Weekly"], ["biweekly", "Every 2 weeks"], ["monthly", "Monthly"], ["custom", "Custom"]])}
        {s.payout_frequency === "custom" && (
          <div style={{ marginTop: 8, fontSize: 12.5, color: "#475569" }}>
            Every <input value={s.custom_days || ""} onChange={(e) => set("custom_days", e.target.value.replace(/[^0-9]/g, ""))} style={{ ...S.input, width: 70, display: "inline-block", textAlign: "right", margin: "0 6px" }} /> days
          </div>
        )}
      </div>

      <div style={{ marginBottom: 18 }}>
        {lab("If an order is cancelled after its commission was already paid")}
        {seg("clawback_on_cancel", [[true, "Claw it back"], [false, "Leave it — no clawback"]])}
        <div style={{ fontSize: 11.5, color: "#94A3B8", marginTop: 6, lineHeight: 1.5 }}>
          A clawback is deducted in the pay period the cancellation happens in.
        </div>
      </div>

      <button onClick={save} disabled={saving} style={{ ...S.btn(saving ? "#9CA3AF" : ACCENT, "#FFF") }}>
        {saving ? "Saving…" : "Save commission structure"}
      </button>
      <div style={{ fontSize: 11.5, color: "#94A3B8", marginTop: 12, lineHeight: 1.5 }}>
        This sets the rules that per-person rates (Settings → Team) and the Commissions report run on. Every period is still reviewed and approved by you before it's payable.
        {" "}Commissions cover the sales you invoice from Structure Studio; an invoice raised in your CRM isn't included.
      </div>
    </div>
  );
}

// ─── Team & commission rates (owner + admin Settings sub-tab) ───
// Tenant-facing team management. Everything routes through the portal-commissions edge fn
// (service-role), which is the ONLY thing that can read/write the confidential
// commission_members table. Admins can add/remove people but see rates as ••• and cannot
// touch grants; only the owner sees rates and flips the two grants. clientId is resolved
// server-side from the caller's JWT — the prop is display-only here.
// ─── Per-person access grid (Settings → Team) ───
// Carolyn, 2026-08-06: "I want the access to each to be as dynamic as possible per
// individual. Admins and Owners should assign each user the access they want to give them
// (tab by tab) and they may choose to give the Read or edit access."
//
// Everything this renders — the areas, their labels, the level vocabulary for each row, the
// per-title presets — arrives from the server in `meta` (accessMetadata()). Nothing about
// permissions is hard-coded here. That is deliberate: a second copy of the area list in the
// browser drifts the day someone adds an area, and a permission screen that disagrees with
// the server is worse than no screen at all, because people trust what it shows them.
//
// What is SAVED is only the deviations from the title's preset, which is how the column is
// defined (migration 100). So changing a preset later improves everyone who never customised
// their people, and "is this person customised?" stays a real question with a real answer.
// ─── Team: per-person access (Settings → Team) ───
// Carolyn, 2026-08-06: "I want the access to each to be as dynamic as possible per
// individual. Admins and Owners should assign each user the access they want to give them
// (tab by tab) and they may choose to give the Read or edit access."
//
// Everything rendered below — areas, labels, hints, the level vocabulary of each row, the
// per-title presets — arrives from the server in `meta` (accessMetadata()). Nothing about
// permissions is hard-coded here. A second copy of the area list in the browser drifts the
// day someone adds an area, and a permission screen that disagrees with the server is worse
// than no screen at all, because people believe what it shows them.

// own_view (contacts, migration 286) reads like own and view. Rank says nothing about writes; canGrant
// asks that separately, the way mayGrant does on the server.
const LEVEL_RANK = { none: 0, own_view: 1, own: 1, view: 1, edit: 2 };

// Commissions speaks a different language from the rest: its three settings are about WHOSE
// payouts you see, not how much you can change. "Everyone's" is the honest word for the top
// of that row — calling it "Edit" invites an owner to grant it thinking it means edit rights.
// ⚠️ EVERY AREA THAT ADDS A NON-STANDARD LEVEL NEEDS A LINE HERE. The fallback is `|| lv`,
// which renders the raw slug — so a new level does not throw, it just puts a switch reading
// "own" in front of a builder. `contacts` gained one on 2026-09-05 and did exactly that until
// this line landed.
function ssLevelLabel(areaKey, lv) {
  if (areaKey === "commissions") return ({ none: "No access", own: "Own only", edit: "Everyone's" })[lv] || lv;
  // Contacts reads all five, as two questions in one row: WHOSE customers (Own = the ones they are
  // assigned to or follow, All = everyone's) and WHAT they may do (View or Edit). 'own_view' arrived
  // 2026-10-06 (Carolyn: "a per-user setting the builder controls: edit or view only"); 'own'
  // writes since 09-07 and is "Own · Edit" — the Dealer preset, unchanged. 'view' stays beside them
  // rather than being replaced — dropping it would have silently demoted everyone stored on it.
  if (areaKey === "contacts") return ({ none: "No access", own_view: "Own · View", own: "Own · Edit", view: "All · View", edit: "All · Edit" })[lv] || lv;
  // Approving unlocks is a yes/no, and "Edit" is the wrong word for it — nothing is being
  // edited. Two levels, so this row renders two buttons rather than three.
  if (areaKey === "change_order_approve") return ({ none: "No", edit: "Can approve" })[lv] || lv;
  // Override prices (migration 277) is a yes/no as well: may this person type a line's price in
  // the Designer. "Edit" would read as editing something else.
  if (areaKey === "price_override") return ({ none: "No", edit: "Can change prices" })[lv] || lv;
  // My Synergy Phone (254): four levels, and the middle two are about WHOSE calls, not read-vs-write —
  // 'own' makes and takes calls and sees their own, 'view' also sees the team's (the Calls
  // report, the Team tab in the apps), 'edit' also changes the phone settings.
  if (areaKey === "phone") return ({ none: "No access", own: "Own calls", view: "Team calls", edit: "Edit" })[lv] || lv;
  return ({ none: "No access", view: "View", edit: "Edit" })[lv] || lv;
}

// Which switches are locked, and why — driven by the AREA FLAGS the server ships in its
// metadata (access.ts is the one definition; hard-coding keys here is the drift this
// screen's design forbids). Two different locks:
//   * byTitleOnly (Team): comes with the job title, never a switch, for anyone. Team hands
//     out every other area, so a grantable Team switch would let admins mint peers.
//   * ownerGranted (Billing, 2026-08-08): a real switch, but only an OWNER may set it and
//     only an ADMIN may hold it. Default for every admin is off — the owner grants the one
//     admin they trust with the card. (Was "Owner only" — ungrantable — until Carolyn's
//     audit decision made it per-admin.)
// Returns the lock label, or null when this viewer may use the switch on this person.
function ssSwitchLock(area, isOwner, title) {
  if (area.byTitleOnly) return "By title";
  if (area.ownerGranted) {
    if (title !== "admin") return "Admins only";
    if (!isOwner) return "Owner grants";
  }
  return null;
}

// One colour per job title, grouped so the Team table reads at a glance: purple/blue for the
// two that run the business, green for everyone who sells, amber for everyone who builds,
// indigo for everyone who moves buildings. Ten of them since 2026-09-07 — a title with no
// entry here falls back to grey, which is legible but says nothing, so keep this in step with
// TITLES in _shared/access.ts. (The server ships TITLES; this is presentation only, and a
// missing colour is the one drift here that is genuinely harmless.)
const TITLE_CHIP = {
  owner:         ["#EDE9FE", "#5B21B6"],
  admin:         ["#DBEAFE", "#1E40AF"],
  office_staff:  ["#E0F2FE", "#075985"],
  sales_manager: ["#D1FAE5", "#065F46"],
  sales_rep:     ["#DCFCE7", "#166534"],
  dealer:        ["#ECFCCB", "#3F6212"],
  scheduler:     ["#FAE8FF", "#86198F"],
  crew_leader:   ["#FEF3C7", "#92400E"],
  crew_member:   ["#FFEDD5", "#9A3412"],
  driver:        ["#E0E7FF", "#3730A3"],
};

function ssInitials(name, email) {
  const src = (name || "").trim() || (email || "").split("@")[0] || "?";
  const bits = src.split(/[\s._-]+/).filter(Boolean);
  return ((bits[0] || "")[0] + (bits.length > 1 ? (bits[bits.length - 1] || "")[0] : "")).toUpperCase() || "?";
}

function ssRelTime(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (!isFinite(ms) || ms < 0) return null;
  const m = Math.floor(ms / 60000);
  if (m < 2) return "now";
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  const d = Math.floor(h / 24);
  if (d === 1) return "yesterday";
  if (d < 30) return d + "d ago";
  return new Date(iso).toLocaleDateString();
}

// The Access column in plain English, so the whole company can be audited at a glance
// without opening anyone. Reads off the RESOLVED map, not the stored deviations — the
// honest answer to "what can Dana actually do?" is the resolved one.
function ssAccessSummary(m, meta) {
  if (m.role === "owner") return "Everything";
  const areas = (meta && meta.areas) || [];
  const presets = (meta && meta.presets) || {};
  const eff = m.effective || {};
  const lvl = (k) => eff[k] || "none";
  if (!areas.length) return "";
  // An untouched Admin is every tab plus every settings card except Billing — worth saying
  // in four words rather than listing seventeen areas. An admin who has been GRANTED
  // Billing is not untouched, so they fall through to the itemised summary below and the
  // grant is visible in the list rather than hidden behind this shorthand.
  const adminPreset = presets.admin || {};
  if (m.title === "admin" && areas.every((a) => lvl(a.key) === (adminPreset[a.key] || "none"))) {
    return "All tabs · Settings except Billing";
  }
  if (m.title === "admin" && lvl("settings_billing") !== "none" &&
      areas.every((a) => a.key === "settings_billing" || lvl(a.key) === (adminPreset[a.key] || "none"))) {
    return "All tabs · Settings incl. Billing";
  }
  // ...and the same courtesy for the other eight titles, generically. Before 2026-09-07 only
  // Admin had a shorthand and everyone else got the itemised list, which was tolerable at
  // five titles and is not at ten: an untouched Office Staff itemises eleven area names into
  // a table cell. Anyone sitting exactly on their preset is described by the preset.
  //
  // ⚠️ IT MUST FALL THROUGH THE MOMENT ANYTHING DEVIATES. This column is what an owner scans
  // to answer "what can Dana actually do?", so a person carrying a single override has to
  // look different from one who does not — "Standard Dealer" on someone who has been handed
  // Structures would be the exact lie the column exists to prevent. Compared against the
  // RESOLVED map, so an override that merely restates the preset correctly reads as standard.
  const ownPreset = presets[m.title];
  if (ownPreset && areas.every((a) => lvl(a.key) === (ownPreset[a.key] || "none"))) {
    const label = ((meta && meta.titles) || []).find((t) => t.key === m.title);
    if (label) return "Standard " + label.label;
  }
  const names = (level) => areas.filter((a) => lvl(a.key) === level).map((a) => a.label);
  const parts = [];
  const e = names("edit"), v = names("view"), o = names("own"), ov = names("own_view");
  if (e.length) parts.push(e.join(", ") + " Edit");
  if (v.length) parts.push(v.join(", ") + " View");
  if (o.length) parts.push(o.join(", ") + " own only");
  // Own · View (contacts, migration 286): their own customers, and look only.
  if (ov.length) parts.push(ov.join(", ") + " own, view only");
  const n = Object.keys(m.access || {}).length;
  const base = parts.length ? parts.join(" · ") : "No access yet";
  return n ? base + " (+" + n + " changed)" : base;
}

// One person's switches. Full width, because eighteen areas in a nested table cell is how
// the first cut ended up with a horizontal scrollbar and a clipped Remove button.
function AccessGrid({ member, meta, myAccess, isOwner, busy, onCancel, onSave }) {
  const areas = (meta && meta.areas) || [];
  const titles = (meta && meta.titles) || [];
  const presets = (meta && meta.presets) || {};
  const [title, setTitle] = useState(member.title || "sales_rep");
  // The map being edited is the EFFECTIVE one — what this person will actually be able to
  // do. Editing raw deviations would show an owner a blank grid for someone who has plenty
  // of access, which is exactly the arithmetic this screen exists to remove.
  const [map, setMap] = useState(() => ({ ...(member.effective || {}) }));

  // Picking a title reseeds every switch from its preset. Anything customised in this
  // unsaved session is deliberately discarded: a title is a starting point, and silently
  // keeping stale overrides on top of a new one is how a "Driver" ends up holding
  // Structures because it survived from when they were an Admin.
  const pickTitle = (t) => { setTitle(t); setMap({ ...(presets[t] || {}) }); };

  // What may THIS granter hand out? Never above their own level. The server enforces the
  // same rules (mayGrant in _shared/access.ts, through mayGrantMap); this only keeps the UI from
  // offering a click that will 403. Rules 3 and 4 are mirrored too, because rank alone ties
  // own_view, own and view:
  //   3. someone limited to their own customers (own or own_view) passes on only an own level;
  //   4. nobody passes on a WRITE they do not hold (edit, or own where the area says own writes),
  //      so an Own · View or All · View holder can hand out Own · View but never Own · Edit.
  const canGrant = (area, level) => {
    if (ssSwitchLock(area, isOwner, title)) return false;
    if (level === "none") return true;                      // taking away is always allowed
    if (isOwner) return true;
    const held = (myAccess || {})[area.key] || "none";
    const ownScope = (lv) => lv === "own" || lv === "own_view";
    if (ownScope(held) && !ownScope(level)) return false;
    const writes = (lv) => lv === "edit" || (lv === "own" && !!area.ownWrites);
    if (writes(level) && !writes(held)) return false;
    return LEVEL_RANK[level] <= LEVEL_RANK[held];
  };

  const preset = presets[title] || {};
  // by-title areas never count as deviations; an owner-granted one (Billing) does — a
  // granted admin IS a deviation from the preset and the owner should see it flagged.
  const deviations = areas.filter((a) => !a.byTitleOnly && (map[a.key] || "none") !== (preset[a.key] || "none"));
  const sub = member.email + (member.lastActive ? " · last active " + ssRelTime(member.lastActive)
    : member.invitePending ? " · invite pending" : "");

  const row = (a) => {
    const cur = map[a.key] || "none";
    const lockLabel = ssSwitchLock(a, isOwner, title);
    const locked = !!lockLabel;
    const changed = !a.byTitleOnly && (preset[a.key] || "none") !== cur;
    // WRAPS, and only when it has to. Contacts has five buttons since migration 286 (Own · View
    // joined the row), about 400px, which overflowed the card on a 768px screen. The hint's flex
    // basis is 0 (`flex: 1`), so the wrap decision counts only the label, the badges and the
    // buttons: wherever the row fit before it lays out exactly as before (the hint still takes
    // what is left), and where it does not, the buttons drop to a line of their own instead of
    // running off the card.
    return (
      <div key={a.key} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: 14, rowGap: 8, padding: "10px 0", borderBottom: "1px solid #F1F5F9", opacity: locked ? 0.55 : 1 }}>
        <div style={{ width: 190, flexShrink: 0, fontSize: 13.5, fontWeight: 700, color: locked ? "#94A3B8" : "#1E293B" }}>{a.label}</div>
        <div style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: "#94A3B8" }}>{a.hint}</div>
        {changed && <div style={{ fontSize: 11, fontWeight: 700, color: ACCENT, whiteSpace: "nowrap" }}>changed from title</div>}
        {locked && <div style={{ fontSize: 11, fontWeight: 700, color: "#94A3B8", whiteSpace: "nowrap" }}>🔒 {lockLabel}</div>}
        <div style={{ display: "inline-flex", border: "1px solid #E2E8F0", borderRadius: 8, overflow: "hidden", flexShrink: 0 }}>
          {a.levels.map((lv) => {
            const on = cur === lv;
            const allowed = canGrant(a, lv);
            return (
              <button key={lv} type="button" disabled={busy || !allowed}
                title={allowed ? undefined : (a.byTitleOnly
                  ? a.label + " comes with the job title, and can't be handed out one switch at a time."
                  : a.ownerGranted
                    ? (title !== "admin"
                      ? a.label + " can only be held by an Admin — change their job title first."
                      : "Only an owner can grant " + a.label + ".")
                    : ((myAccess || {})[a.key] || "none") !== "none"
                      ? "You can't give more " + a.label + " access than you have yourself."
                      : "You don't have " + a.label + " yourself, so you can't give it to anyone.")}
                onClick={() => setMap((prev) => ({ ...prev, [a.key]: lv }))}
                style={{
                  border: "none", borderLeft: a.levels[0] === lv ? "none" : "1px solid #E2E8F0",
                  background: on ? (locked ? "#CBD5E1" : ACCENT) : "#FFF",
                  color: on ? "#FFF" : (allowed ? "#475569" : "#CBD5E1"),
                  fontSize: 11.5, fontWeight: 700, padding: "6px 12px", fontFamily: "inherit",
                  cursor: busy || !allowed ? "default" : "pointer", whiteSpace: "nowrap",
                }}>
                {ssLevelLabel(a.key, lv)}
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  const groupHead = (t) => (
    <div style={{ fontSize: 11, fontWeight: 800, color: "#94A3B8", textTransform: "uppercase", letterSpacing: 0.7, margin: "18px 0 2px" }}>{t}</div>
  );

  return (
    <div style={{ background: "#FFF", border: "1px solid #E2E8F0", borderRadius: 12, padding: 20, marginTop: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", paddingBottom: 16, borderBottom: "1px solid #F1F5F9" }}>
        <div style={{ width: 38, height: 38, borderRadius: "50%", background: "#EDE9FE", color: "#5B21B6", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 13, flexShrink: 0 }}>
          {ssInitials(member.fullName, member.email)}
        </div>
        <div style={{ flex: 1, minWidth: 160 }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: "#0F172A" }}>{member.fullName || member.email}</div>
          <div style={{ fontSize: 12, color: "#94A3B8" }}>{sub}</div>
        </div>
        <button type="button" onClick={onCancel} disabled={busy} style={{ ...S.btn("#FFF", "#475569"), border: "1px solid #E2E8F0" }}>Cancel</button>
        <button type="button" disabled={busy}
          onClick={() => {
            // Deviations only — the column stores the same shape, so what is saved is what
            // this screen computed, not a snapshot that goes stale when a preset improves.
            const access = {};
            for (const a of deviations) access[a.key] = map[a.key] || "none";
            onSave({ title, access });
          }}
          style={S.btn(busy ? "#9CA3AF" : ACCENT, "#FFF")}>Save access</button>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", margin: "16px 0 4px" }}>
        <span style={{ ...S.lbl, width: 40 }}>Title</span>
        {titles.filter((t) => isOwner || (t.key !== "owner" && t.key !== "admin")).map((t) => {
          const on = title === t.key;
          return (
            <button key={t.key} type="button" disabled={busy} onClick={() => pickTitle(t.key)} title={t.blurb}
              style={{ border: on ? "1px solid #0F172A" : "1px solid #E2E8F0", background: on ? "#0F172A" : "#FFF",
                color: on ? "#FFF" : "#475569", borderRadius: 20, padding: "6px 14px", fontSize: 12.5,
                fontWeight: 700, fontFamily: "inherit", cursor: busy ? "default" : "pointer" }}>
              {t.label}
            </button>
          );
        })}
      </div>
      <div style={{ fontSize: 12, color: "#94A3B8", marginBottom: 4 }}>
        Choosing a title fills the switches below — change any of them afterwards.
        {deviations.length > 0 && <span style={{ color: ACCENT, fontWeight: 700 }}>{" "}{deviations.length} changed from the standard.</span>}
      </div>

      {groupHead("Workspace")}
      {areas.filter((a) => a.group === "workspace").map(row)}
      {groupHead("Settings")}
      {areas.filter((a) => a.group === "settings").map(row)}

      {title === "driver" && (
        <div style={{ display: "flex", gap: 9, alignItems: "flex-start", background: "#EFF6FF", border: "1px solid #BFDBFE", borderRadius: 10, padding: "11px 13px", marginTop: 16, fontSize: 12, color: "#1E40AF", lineHeight: 1.55 }}>
          <span>🚚</span>
          <div>
            <b>Driver setup</b> — a Driver shows up in the Delivery Schedule, and their truck
            decides what fits on a load.
            {member.driver
              ? <> Theirs is on file: <b>{member.driver}</b>.</>
              : <> They have no truck on file yet, so the load planner can't size their deck.</>}
            {" "}Truck and territory live in <b>Crews, drivers &amp; territories</b> above — one
            place that writes that record, rather than two that can disagree.
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 9, alignItems: "flex-start", background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 10, padding: "11px 13px", marginTop: 12, fontSize: 12, color: "#92400E", lineHeight: 1.55 }}>
        <span>🔒</span>
        <div>
          <b>Two things you can't hand out.</b> Billing and Team come with the job title —
          they're the keys to the kingdom. And nobody can grant access they don't hold
          themselves: an admin without QuickBooks sees that row greyed out, so no one can
          quietly promote themselves.
        </div>
      </div>
    </div>
  );
}

function CommissionTeam({ viewingLabel = null }) {
  // portal-commissions resolves the tenant from the CALLER's own client_users row and takes
  // no targetClientId — it predates the shared resolveTenant. So in operator view-as every
  // action here silently acts on the OPERATOR's own account while the banner names someone
  // else: "Add & send invite" would put the person on CSM Synergy's team, not the builder's.
  // Nothing crosses tenants (the scoping is what makes it wrong, not unsafe), but a screen
  // that quietly does something other than what it says is worse than one that is absent.
  // Moving these actions onto portal-settings' resolveTenant is the real fix.
  if (viewingLabel) {
    return (
      <div style={{ ...S.card, maxWidth: 860, color: "#64748B", fontSize: 13, lineHeight: 1.6 }}>
        <div style={{ ...S.h2, marginBottom: 6 }}>Team &amp; access</div>
        People and access for <b>{viewingLabel}</b> aren't editable from view-as — this screen
        would act on your own account instead. Manage their team from the Admin console, or ask
        an owner there to do it.
      </div>
    );
  }
  return <CommissionTeamInner />;
}

function CommissionTeamInner() {
  const [data, setData] = useState(null);       // { members, canSeeRates, isOwner, role } | { members: [] }
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);         // { ok } | { err }
  const [add, setAdd] = useState({ fullName: "", email: "", title: "sales_rep" });
  const [editingAccess, setEditingAccess] = useState(null);  // userId whose access grid is open
  const [addOpen, setAddOpen] = useState(false);              // the "+ Add person" form
  const [edits, setEdits] = useState({});       // userId -> in-progress rate string
  const [removing, setRemoving] = useState(null); // member awaiting unlink/deactivate choice
  const [invite, setInvite] = useState(null);   // { email, link, emailSent } after an add
  // Declared up here, not beside the table, because every early return below this point would
  // otherwise skip a hook. No page-reset effect: this list has no filters, and PageBar's own
  // clamp already walks you back when a removal shortens the team under you.
  const [pageSize, setPageSize] = usePageSize("team");
  const [page, setPage] = useState(1);

  const call = async (body) => {
    const { data: r, error } = await sb.functions.invoke("portal-commissions", { body });
    if (error) { let m = error.message; try { const c = await error.context.json(); if (c && c.error) m = c.error; } catch (_x) {} throw new Error(m); }
    if (r && r.error) throw new Error(r.error);
    return r;
  };
  const load = useCallback(async () => {
    setErr(null);
    try { setData(await call({ action: "list" })); }
    catch (e) { setErr(e.message); setData({ members: [] }); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const addUser = async () => {
    if (!add.email.trim()) { setMsg({ err: "Enter an email address." }); return; }
    setBusy(true); setMsg(null); setInvite(null);
    try {
      const r = await call({ action: "add_user", email: add.email.trim(), fullName: add.fullName.trim(), title: add.title });
      if (r.alreadyOnTeam) setMsg({ ok: `${add.email.trim()} is already on your team.` });
      else { setMsg({ ok: `Invited ${add.email.trim()}.` }); if (r.setupLink) setInvite({ email: add.email.trim(), link: r.setupLink, emailSent: r.emailSent }); }
      setAdd({ fullName: "", email: "", title: "sales_rep" });
      setAddOpen(false);
      await load();
    } catch (e) { setMsg({ err: e.message }); }
    setBusy(false);
  };
  const commitRate = async (m) => {
    const raw = edits[m.userId];
    if (raw === undefined) return;                       // nothing typed
    const norm = raw.trim();
    const current = m.commissionPercent == null ? "" : String(m.commissionPercent);
    setEdits((p) => { const n = { ...p }; delete n[m.userId]; return n; });
    if (norm === current) return;                        // unchanged
    setBusy(true); setMsg(null);
    try { await call({ action: "set_rate", userId: m.userId, percent: norm === "" ? null : norm }); await load(); }
    catch (e) { setMsg({ err: e.message }); }
    setBusy(false);
  };
  const setGrant = async (m, field, value) => {
    setBusy(true); setMsg(null);
    try { await call({ action: "set_grants", userId: m.userId, [field]: value }); await load(); }
    catch (e) { setMsg({ err: e.message }); }
    setBusy(false);
  };
  const doRemove = async (m, mode) => {
    setBusy(true); setMsg(null); setRemoving(null);
    try { await call({ action: "remove_user", userId: m.userId, mode }); setMsg({ ok: `${m.fullName || m.email} ${mode === "deactivate" ? "removed — their login is deactivated" : "removed from your team"}.` }); await load(); }
    catch (e) { setMsg({ err: e.message }); }
    setBusy(false);
  };

  const saveAccess = async (m, next) => {
    setBusy(true); setMsg(null);
    try {
      await call({ action: "set_access", userId: m.userId, title: next.title, access: next.access });
      setMsg({ ok: `Updated ${m.fullName || m.email}'s access.` });
      setEditingAccess(null);
      await load();
    } catch (e) { setMsg({ err: e.message }); }
    setBusy(false);
  };

  // Titles, not the three legacy roles. Falls back to the role when a row predates
  // migration 100 and has no title yet, so an older account never renders a blank cell.
  const titleChip = (m, titles) => {
    const t = (titles || []).find((x) => x.key === m.title);
    // Reads TITLE_CHIP rather than its own two-entry copy. That copy predated the other
    // eight titles and would have rendered every one of them the same grey, in the column
    // whose whole job is telling them apart.
    const c = TITLE_CHIP[m.title] || ["#F1F5F9", "#475569"];
    return <span style={{ background: c[0], color: c[1], borderRadius: 20, padding: "3px 10px", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" }}>{t ? t.label : (m.role || "user")}</span>;
  };
  const sw = (on) => <span style={{ display: "inline-block", width: 34, height: 20, borderRadius: 20, background: on ? ACCENT : "#CBD5E1", position: "relative", verticalAlign: "middle", transition: "background .12s" }}><span style={{ position: "absolute", top: 2, [on ? "right" : "left"]: 2, width: 16, height: 16, borderRadius: "50%", background: "#FFF" }} /></span>;

  // NO TWO-PHASE PAINT HERE, AND THAT IS THE FINDING, NOT AN OMISSION.
  //
  // The slow leg is inside the one `list` call and cannot be split off from the browser: the
  // server loops `auth.admin.getUserById` once per member, sequentially, so a 20-person builder
  // waits on 20 GoTrue round trips inside a single request. Shortening that is server work.
  //
  // And there is nothing safe to paint ahead of it. `canSeeRates` decides whether the
  // Commission % column exists at all, and `isOwner` gates the two grant switches — both ride
  // the SAME response as the rows they hide. Painting rows early would mean either rendering
  // the rate column before the server has said this caller may see it, or guessing at a
  // permission in the browser. Neither is worth a second of load time, so this tab gets the
  // skeleton and the page control only.
  //
  // FIVE columns: Name / Title / Access / Last active / Actions is the minimum view — Commission
  // %, Sees all payouts and Full access are all conditional. Under-showing is the safe
  // direction; the table can only GAIN columns when the response lands, and a grey bar carries
  // no data either way.
  if (data === null) return (
    <div style={S.card}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <SkelBar w={62} h={15} />
        <SkelBar w={26} h={15} style={{ borderRadius: 999 }} />
      </div>
      <SkelBar w="92%" h={9} />
      <SkelBar w="58%" h={9} style={{ marginTop: 6, marginBottom: 16 }} />
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>
            {["Name", "Title", "Access", "Last active", "Actions"].map((h) => <th key={h} style={S.th}>{h}</th>)}
          </tr></thead>
          <tbody><SkelRows cols={5} rows={6} /></tbody>
        </table>
      </div>
    </div>
  );
  const isOwner = !!data.isOwner;
  const canSeeRates = !!data.canSeeRates;
  const members = data.members || [];
  // Page the ROWS only. The count chip above still reads `members.length` — the whole team, not
  // the page — the same convention Contacts uses, and the "No one here yet" row below still
  // keys off the full list so an out-of-range page can never claim an empty team.
  const memberPages = Math.max(1, Math.ceil(members.length / pageSize));
  const memberPage = Math.min(page, memberPages);
  const pagedMembers = members.slice((memberPage - 1) * pageSize, memberPage * pageSize);
  // Areas, titles and presets all come from the server (accessMetadata) — see AccessGrid.
  const meta = data.meta || { areas: [], titles: [], presets: {} };
  const canManageTeam = !!data.canManageTeam;

  const th = { textAlign: "left", fontSize: 11, fontWeight: 700, color: "#64748B", textTransform: "uppercase", letterSpacing: 0.5, padding: "8px 10px", borderBottom: "1px solid #E2E8F0", whiteSpace: "nowrap" };
  const td = { fontSize: 13, padding: "12px 10px", borderBottom: "1px solid #F1F5F9", verticalAlign: "middle" };
  const editing = members.find((m) => m.userId === editingAccess) || null;

  return (
    <div style={S.card}>
      {err && <div style={S.err}>{err}</div>}
      {msg && msg.err && <div style={S.err}>{msg.err}</div>}
      {msg && msg.ok && <div style={S.okMsg}>{msg.ok}</div>}

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 4 }}>
        <div style={{ ...S.h2, margin: 0 }}>Team</div>
        <span style={{ background: "#F1F5F9", color: "#475569", borderRadius: 20, padding: "2px 9px", fontSize: 12, fontWeight: 800 }}>{members.length}</span>
        <div style={{ flex: 1 }} />
        {canManageTeam && (
          <button type="button" onClick={() => setAddOpen(!addOpen)} style={S.btn(addOpen ? "#FFF" : ACCENT, addOpen ? "#475569" : "#FFF")}>
            {addOpen ? "Cancel" : "+ Add person"}
          </button>
        )}
      </div>
      <p style={{ fontSize: 12.5, color: "#64748B", lineHeight: 1.5, margin: "0 0 14px" }}>
        Job titles are starting points, not cages: pick one and it fills in sensible access, then
        change any switch for that one person — tab by tab, each one No access / View / Edit.
        {isOwner
          ? " Commission rates and other people's payouts stay visible to you only."
          : " Commission rates are set by the owner and shown as ••• here."}
      </p>

      {addOpen && canManageTeam && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 10, padding: 14, marginBottom: 16 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <span style={S.lbl}>Full name</span>
            <input value={add.fullName} onChange={(e) => setAdd((p) => ({ ...p, fullName: e.target.value }))} placeholder="Jordan Blake" style={{ ...S.input, width: 160 }} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <span style={S.lbl}>Email</span>
            <input value={add.email} onChange={(e) => setAdd((p) => ({ ...p, email: e.target.value }))} placeholder="jordan@company.com" style={{ ...S.input, width: 220 }} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <span style={S.lbl}>Job title</span>
            <select value={add.title} onChange={(e) => setAdd((p) => ({ ...p, title: e.target.value }))} style={{ ...S.input, width: 150 }}>
              {(meta.titles || []).filter((t) => isOwner || (t.key !== "owner" && t.key !== "admin")).map((t) => (
                <option key={t.key} value={t.key}>{t.label}</option>
              ))}
            </select>
          </div>
          <button onClick={addUser} disabled={busy} style={S.btn(busy ? "#9CA3AF" : ACCENT, "#FFF")}>Add &amp; send invite</button>
          <div style={{ flexBasis: "100%", fontSize: 11.5, color: "#94A3B8" }}>
            They get an email with a link to set their own password. You can fine-tune their access straight after.
          </div>
        </div>
      )}

      {invite && (
        <div style={{ background: "#EEF2FF", border: "1px solid #C7D2FE", borderRadius: 9, padding: "11px 13px", marginBottom: 14, fontSize: 12.5, color: "#3730A3" }}>
          <b>{invite.email}</b> {invite.emailSent ? "was emailed a setup link." : "was added."}
          {invite.link
            ? <> Share this one-time set-password link if the email doesn't arrive:
                <div style={{ marginTop: 6 }}><input readOnly value={invite.link} onFocus={(e) => e.target.select()} style={{ ...S.input, width: "100%", fontSize: 11.5, color: "#475569" }} /></div></>
            : <> They already had a password, so no setup link was created — they sign in with the one they have, or use “Forgot password”.</>}
        </div>
      )}

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>
            <th style={th}>Name</th>
            <th style={th}>Title</th>
            <th style={th}>Access</th>
            {(data.locations || []).length > 0 && <th style={th} title="Their home sales lot. Delivery is measured from here when Settings → Options → Delivery says 'from the rep's location'.">Home lot</th>}
            {canSeeRates && <th style={th}>Commission&nbsp;%</th>}
            <th style={th}>Last active</th>
            {isOwner && <th style={th}>Sees all payouts</th>}
            {isOwner && <th style={th}>Full access</th>}
            <th style={{ ...th, textAlign: "right" }}>Actions</th>
          </tr></thead>
          <tbody>
            {pagedMembers.map((m) => {
              const nCustom = Object.keys(m.access || {}).length;
              return (
              <tr key={m.userId} style={editingAccess === m.userId ? { background: "#F8FAFC" } : undefined}>
                <td style={td}>
                  <div style={{ fontWeight: 700, color: "#0F172A" }}>
                    {m.fullName || <span style={{ color: "#94A3B8" }}>—</span>}
                    {m.isSelf && <span style={{ fontSize: 11, color: "#94A3B8", fontWeight: 500 }}> (you)</span>}
                  </div>
                  <div style={{ fontSize: 11.5, color: "#94A3B8" }}>{m.email}</div>
                </td>
                <td style={td}>
                  {titleChip(m, meta.titles)}
                  {nCustom > 0 && m.role !== "owner" && (
                    <div style={{ marginTop: 4 }}>
                      <span title={nCustom + " switch" + (nCustom === 1 ? "" : "es") + " differ from the standard for this title"}
                        style={{ background: "#F1F5F9", color: "#64748B", borderRadius: 20, padding: "2px 8px", fontSize: 10, fontWeight: 800 }}>Custom</span>
                    </div>
                  )}
                </td>
                <td style={{ ...td, fontSize: 12, color: "#475569", maxWidth: 340, lineHeight: 1.45 }}>{ssAccessSummary(m, meta)}</td>
                {(data.locations || []).length > 0 && <td style={td}>
                  {(canManageTeam || m.isSelf)
                    ? <select value={m.locationId || ""} disabled={busy}
                        onChange={async (e) => { const v = e.target.value || null; setBusy(true); try { await call({ action: "set_home_location", userId: m.userId, locationId: v }); await load(); } catch (err) { setErr(err.message); } setBusy(false); }}
                        style={{ ...S.input, width: 150, padding: "5px 8px", fontSize: 12 }}>
                        <option value="">— none —</option>
                        {data.locations.map((l) => <option key={l.id} value={l.id}>{l.name}{l.city ? " (" + l.city + ")" : ""}</option>)}
                      </select>
                    : <span style={{ fontSize: 12, color: "#475569" }}>{(data.locations.find((l) => l.id === m.locationId) || {}).name || <span style={{ color: "#94A3B8" }}>—</span>}</span>}
                </td>}
                {canSeeRates && <td style={td}>
                  {m.role === "owner"
                    ? <span style={{ color: "#94A3B8" }}>—</span>
                    : <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                        <input
                          value={edits[m.userId] !== undefined ? edits[m.userId] : (m.commissionPercent == null ? "" : String(m.commissionPercent))}
                          onChange={(e) => setEdits((p) => ({ ...p, [m.userId]: e.target.value.replace(/[^0-9.]/g, "") }))}
                          onBlur={() => commitRate(m)}
                          onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); }}
                          placeholder="—" disabled={busy}
                          style={{ ...S.input, width: 60, textAlign: "right", padding: "6px 8px" }} />
                        <span style={{ color: "#94A3B8" }}>%</span>
                      </span>}
                </td>}
                <td style={{ ...td, fontSize: 12, color: "#94A3B8", whiteSpace: "nowrap" }}>
                  {m.deactivated ? <span style={{ color: "#DC2626", fontWeight: 700 }}>deactivated</span>
                    : ssRelTime(m.lastActive) || <span title="They haven't set a password yet">invite pending</span>}
                </td>
                {/* Buttons with role="switch", not clickable spans. These two GRANT ACCESS to
                    other people's pay — the last controls on the page that should be
                    mouse-only. A span carries no role, no focus and no Enter/Space handling,
                    so a keyboard or screen-reader user could read the state and never change
                    it. `sw()` still draws the switch; only the element around it changed. */}
                {isOwner && <td style={td}>{m.role === "owner" ? <span style={{ fontSize: 11, color: "#94A3B8" }}>Always</span> : <button type="button" role="switch" aria-checked={!!m.seesAllPayouts} aria-label={`Let ${m.fullName || m.email || "this person"} see everyone's payouts`} disabled={busy} onClick={() => !busy && setGrant(m, "seesAllPayouts", !m.seesAllPayouts)} style={{ background: "none", border: "none", padding: 0, cursor: busy ? "default" : "pointer", font: "inherit", lineHeight: 0 }} title="Let this person see everyone's payouts">{sw(!!m.seesAllPayouts)}</button>}</td>}
                {isOwner && <td style={td}>{m.role === "owner" ? <span style={{ fontSize: 11, color: "#94A3B8" }}>Always</span> : <button type="button" role="switch" aria-checked={!!m.fullAccess} aria-label={`Let ${m.fullName || m.email || "this person"} see and edit commission rates`} disabled={busy} onClick={() => !busy && setGrant(m, "fullAccess", !m.fullAccess)} style={{ background: "none", border: "none", padding: 0, cursor: busy ? "default" : "pointer", font: "inherit", lineHeight: 0 }} title="Let this person see and edit commission rates">{sw(!!m.fullAccess)}</button>}</td>}
                <td style={{ ...td, whiteSpace: "nowrap", textAlign: "right" }}>
                  {m.role === "owner"
                    ? <span style={{ fontSize: 11.5, color: "#94A3B8" }}>{m.isSelf ? "Own account" : "Owner"}</span>
                    : m.isSelf
                      ? <span style={{ fontSize: 11.5, color: "#94A3B8" }} title="Access is something you receive, not something you set for yourself">Own account</span>
                      : removing && removing.userId === m.userId ? (
                        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                          <button onClick={() => doRemove(m, "unlink")} disabled={busy} style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0", padding: "5px 9px", fontSize: 11 }}>Remove from team</button>
                          <button onClick={() => doRemove(m, "deactivate")} disabled={busy} style={{ ...S.btn("#FEF2F2", "#DC2626"), border: "1px solid #FECACA", padding: "5px 9px", fontSize: 11 }}>Deactivate login</button>
                          <button onClick={() => setRemoving(null)} style={{ background: "none", border: "none", color: "#94A3B8", cursor: "pointer", fontSize: 11, fontWeight: 700, fontFamily: "inherit" }}>Cancel</button>
                        </span>
                      ) : (
                        <span style={{ display: "inline-flex", gap: 10, alignItems: "center" }}>
                          {canManageTeam && (
                            <button onClick={() => setEditingAccess(editingAccess === m.userId ? null : m.userId)}
                              style={{ background: "none", border: "none", color: ACCENT, cursor: "pointer", fontSize: 12, fontWeight: 700, fontFamily: "inherit", padding: 0 }}>
                              {editingAccess === m.userId ? "Close" : "Edit"}
                            </button>
                          )}
                          {canManageTeam && (
                            <button onClick={() => setRemoving(m)} disabled={busy} style={{ background: "none", border: "none", color: "#94A3B8", cursor: "pointer", fontSize: 12, fontWeight: 700, fontFamily: "inherit", padding: 0 }}>Remove</button>
                          )}
                        </span>
                      )}
                </td>
              </tr>);
            })}
            {members.length === 0 && (
              <tr><td colSpan={9} style={{ ...td, color: "#64748B", textAlign: "center", padding: "26px 10px" }}>
                No one here yet. Add the people who work in your account and give each of them
                just the parts of StructureStudio they need.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      {/* noun is "team member", not "person": PageBar pluralises by appending an "s", and this
          bar sits under a table of named colleagues where "12 persons" reads as a form. */}
      {members.length > 0 && <PageBar size={pageSize} onSize={setPageSize} page={memberPage} onPage={setPage} total={members.length} noun="team member" />}

      {/* `editing` is resolved against the FULL members array, so the access panel still opens
          for someone who is not on the visible page. That is correct — leave it. */}
      {editing && canManageTeam && (
        <AccessGrid key={editing.userId} member={editing} meta={meta} myAccess={data.myAccess} isOwner={isOwner}
          busy={busy} onCancel={() => setEditingAccess(null)} onSave={(next) => saveAccess(editing, next)} />
      )}

      {isOwner && (
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start", background: "#FFF7ED", border: "1px solid #FED7AA", borderRadius: 9, padding: "10px 12px", marginTop: 14, fontSize: 11.5, color: "#9A3412", lineHeight: 1.5 }}>
          <span>🔒</span>
          <div>Commission rates and everyone's payouts are visible to you only. An admin who isn't granted <b>Full access</b> sees rates as ••• and only their own payout. Nothing about pay is visible unless you turn it on.</div>
        </div>
      )}
    </div>
  );
}

// ─── Commissions report (main nav "Commissions" tab) ───
// The payout report. One component serves everyone via server-side scoping: an owner or a
// user granted "sees all payouts" sees the whole team; a plain rep sees only their own rows
// and never a rate column. All data + actions go through portal-commissions (service-role);
// the confidential ledger is never read directly by the browser.
function CommissionsReport({ clientId }) {
  const [data, setData] = useState(() => ssCacheGet("portal-commissions", "list_entries", clientId));  // list_entries response | { entries: [] }
  const [err, setErr] = useState(null);
  // True from mount until the background compute has finished and the ledger has been
  // re-read. The figures on screen before that are the LAST computed ones, which is a
  // different claim from "these are current" — the tab says so, and every control that
  // commits to a number stays disabled until it clears. See the note on `load`.
  const [reconciling, setReconciling] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [assign, setAssign] = useState(null);  // entry id whose rep dropdown is open
  const [splitFor, setSplitFor] = useState(null); // { orderId, orderNo, rows:[{userId, share}], alsoRemoved } while the split modal is open
  // Filter / sort / search state for the report view.
  const [q, setQ] = useState("");
  const [fRep, setFRep] = useState("");        // earnerUserId | "__none__" (unassigned) | ""
  const [fPeriod, setFPeriod] = useState("");  // periodKey | ""
  const [fStatus, setFStatus] = useState("");  // pending|payable|paid|excluded | ""
  const [fFrom, setFFrom] = useState("");      // earned-on >= (YYYY-MM-DD)
  const [fTo, setFTo] = useState("");          // earned-on <= (YYYY-MM-DD)
  const [sortBy, setSortBy] = useState("");    // "" = default period order; else date|amount|order|customer|rep
  const [sortDir, setSortDir] = useState("desc");
  // Paging state lives up here because every early return below would otherwise skip a hook.
  // The slicing itself is the LAST step of the render — see the comment at the slice.
  const [pageSize, setPageSize] = usePageSize("commissions");
  const [page, setPage] = useState(1);
  // Staying on page 7 of a filter that now returns four lines shows an empty report and reads
  // as broken, so any change to WHAT is being listed goes back to page 1.
  useEffect(() => { setPage(1); }, [q, fRep, fPeriod, fStatus, fFrom, fTo, sortBy, sortDir]);

  const call = async (body) => {
    const { data: r, error } = await sb.functions.invoke("portal-commissions", { body });
    if (error) { let m = error.message; try { const c = await error.context.json(); if (c && c.error) m = c.error; } catch (_x) {} throw new Error(m); }
    if (r && r.error) throw new Error(r.error);
    return r;
  };
  // Guards against two computes from THIS mount (a double Refresh click, StrictMode's double
  // effect). It cannot cover a remount or a second browser tab — see the note below.
  const inflight = useRef(null);
  // THE LEDGER PAINTS BEFORE `compute` RUNS — and that is safe ONLY because of migration 148.
  // Read this before reordering anything here.
  //
  // FOUR earlier attempts at painting early were each rejected in review, all for one reason:
  // painting early means CONTROLS EXIST while compute runs, and compute was not safe to
  // overlap. It read commission_entries once and then bare-INSERTed a line for any order it
  // did not find, with no upsert, no lock, and no unique constraint behind it. A second
  // overlapping compute inserted the same orders again, the period double-counted, and
  // because mark_paid freezes a paid row forever, approving and paying that period paid the
  // rep TWICE with nothing flagging it. Every guard tried was a client-side approximation of
  // a server invariant that did not exist: a re-entrancy ref covers one mount, not a remount,
  // a second browser tab or a reload; a timeout either re-armed the writers mid-insert or
  // locked a slow tenant out of their own report.
  //
  // The invariant exists now. Migration 148 puts a partial unique index on
  // commission_entries (client_id, order_id) WHERE kind='commission' AND is_override=false —
  // narrow on purpose, because splits deliberately create several rows per order and a plain
  // unique index would break them — and compute treats the losing insert's 23505 as "another
  // compute already wrote this line" and skips it. Overlapping computes are idempotent, so
  // the ledger can paint from list_entries first and reconcile behind it.
  //
  // ⛔ Do not weaken the index predicate or the 23505 skip; this ordering rests on both.
  // ⛔ Do not add a fifth client-side guard. The database holds this now.
  //
  // What still protects the money is `reconciling`: figures painted before compute finishes
  // are not the reconciled ones, so they are labelled as such and every control that COMMITS
  // to a number stays disabled until the post-compute read lands. Money never paints
  // optimistically — it just no longer makes the whole tab wait.
  //
  // ⏱ SINCE 2026-10-02 THE PAINT RUNS BESIDE compute, NOT BEFORE IT, and compute returns the
  // post-compute ledger itself (`withEntries`), so an open is two calls side by side instead of
  // three in a row (the three took 4.6 s on beta from Pakistan, 2026-10-01). What that changes,
  // and why it holds:
  //   • The paint can now land MID-compute — some lines updated, new ones missing, retired ones
  //     still shown. Still safe for the same reason as above: `reconciling` stays true until the
  //     ledger compute returned (read after every one of its writes) is on screen.
  //   • `settled` is the guard against the paint arriving LATE: once that ledger is applied, an
  //     older read may not repaint or re-cache over it. Without it a slow paint (cold isolate,
  //     a preflight) would put pre-compute rows back on screen with the controls enabled — the
  //     double-pay class described above.
  //   • WHO may reconcile is decided by the server: compute with withEntries answers a caller
  //     without rate access with the ledger and no 403, so the tab asks everyone the same way
  //     and a rep's open files no refusal row. The old "only if painted.canSeeRates" check is
  //     gone with it.
  //   • No ledger back (compute failed, was refused, or an older server ignored withEntries):
  //     today's path — wait for the paint, then read list_entries AFTER compute. If that read
  //     fails too and nothing from this run is on screen, the tab falls back to the empty
  //     scaffold, exactly as a failed first read always did; cached figures are never left
  //     armed. A caller with no Commissions access at all files one more 403 per open than
  //     before (the tab is hidden at that level).

  // Entries only. This is what every mutation needs: the server actions do their own writes,
  // so re-running compute after each one bought nothing and cost the user eight seconds of
  // spinner per click.
  const refreshEntries = useCallback(async () => {
    const r = await call({ action: "list_entries" });
    setData(r);
    ssCachePut("portal-commissions", "list_entries", clientId, r);
    return r;
  }, [clientId]);
  const load = useCallback(() => {
    if (inflight.current) return inflight.current;
    const run = (async () => {
      setErr(null);
      setReconciling(true);
      // The cache key is built from whoever is signed in WHEN THE ANSWER LANDS (ssCacheKey reads
      // ssCurrentUserId). A slow compute that outlives a sign-out and a different sign-in on this
      // machine must not seed that person's tab with this run's ledger, so a run only writes for
      // the user it started as (2026-10-02, review finding).
      const who = ssCurrentUserId;
      const put = (r) => { if (ssCurrentUserId !== who) return; setData(r); ssCachePut("portal-commissions", "list_entries", clientId, r); };
      let settled = false;   // the post-compute ledger is applied: older reads may not repaint or re-cache
      let fresh = false;     // some read from THIS run is on screen (not just the cache seed)
      // 1. Paint the ledger as it stands, BESIDE the reconcile (see the note above). A cache hit is
      //    already painted by the useState seed, so it needs no paint leg.
      const paint = ssCacheGet("portal-commissions", "list_entries", clientId) ? null
        : call({ action: "list_entries" })
          .then((r) => { if (!settled) { put(r); fresh = true; } return r; })
          .catch((e) => { if (!settled) { setErr(e.message); setData({ entries: [] }); fresh = true; } return null; });
      // 2. Reconcile, and get the ledger as it stands AFTER every write compute made.
      let ledger = null;
      try { const c = await call({ action: "compute", withEntries: true }); ledger = c && c.ledger ? c.ledger : null; }
      catch (_e) { /* transient, refused, or an older server: fall back below */ }
      if (ledger) { settled = true; setErr(null); put(ledger); }
      else {
        // Today's path: a read that STARTS after compute. Let the paint finish first so it
        // cannot land on top of this one.
        if (paint) await paint;
        settled = true;
        try { await refreshEntries(); }
        catch (e) {
          // As a failed first read always did: never leave cached figures armed.
          if (!fresh) { setErr(e.message); setData({ entries: [] }); }
        }
      }
      setReconciling(false);
    })().finally(() => { inflight.current = null; });
    inflight.current = run;
    return run;
  }, [refreshEntries, clientId]);
  useEffect(() => { load(); }, [load]);

  // What every control that COMMITS to a figure is disabled by. `busy` alone is not enough
  // now that the ledger paints before compute finishes: approving, paying, splitting,
  // adjusting or reassigning against a pre-reconcile number would commit the owner to an
  // amount the reconcile is about to change. Reading the report is free during that window;
  // acting on it is not. (The Refresh button deliberately keeps plain `busy` — re-entering
  // load() while it is in flight is already a no-op via `inflight`.)
  const committing = busy || reconciling;
  const money = (c) => c == null ? "—" : "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });



  // Every mutation below re-reads the LEDGER, not the whole compute→read pair. Each of these
  // server actions rebuilds the lines it touches (reset_order included), so re-running the
  // GHL reconcile afterwards changed nothing and made the button sit busy for eight seconds.
  const assignEarner = async (entryId, userId) => {
    setBusy(true); setMsg(null); setAssign(null);
    try { await call({ action: "assign_earner", entryId, userId: userId || null }); await refreshEntries(); }
    catch (e) { setMsg({ err: e.message }); }
    setBusy(false);
  };
  const markPeriodPaid = async (periodKey, label) => {
    if (!window.confirm(`Mark every payable commission in “${label}” as paid?`)) return;
    setBusy(true); setMsg(null);
    try { const r = await call({ action: "mark_paid", periodKey }); setMsg({ ok: `Marked ${r.paid} commission${r.paid === 1 ? "" : "s"} paid.` }); await refreshEntries(); }
    catch (e) { setMsg({ err: e.message }); }
    setBusy(false);
  };
  const act = async (body, okMsg) => {
    setBusy(true); setMsg(null);
    try { await call(body); if (okMsg) setMsg({ ok: okMsg }); await refreshEntries(); }
    catch (e) { setMsg({ err: e.message }); }
    setBusy(false);
  };
  const adjustEntry = (e) => {
    const cur = e.amountCents != null ? (e.amountCents / 100).toFixed(2) : "";
    const v = window.prompt(`Set the commission amount for order #${e.orderNo} (dollars):`, cur);
    if (v == null) return;
    // Test the CLEANED string, not only the number it parses to. An emptied prompt — or "n/a",
    // "same as last time" — strips to "" and Number("") is 0, which passed the finite check and
    // wrote a PERMANENT $0.00: adjust_amount stamps is_override, so compute never rebuilds the
    // line and only Reset-to-default on the whole order clears it. Zero and negatives typed on
    // purpose stay legal (a negative is a real adjustment; it renders red below).
    const cleaned = String(v).replace(/[^0-9.\-]/g, "");
    const cents = Math.round(Number(cleaned) * 100);
    if (!cleaned || !Number.isFinite(cents)) { setMsg({ err: "Enter a dollar amount." }); return; }
    act({ action: "adjust_amount", entryId: e.id, amountCents: cents });
  };
  // ORDER-level allocation editor (Carolyn 2026-08-05): opening Split shows EVERYONE currently
  // on the order with their shares — add or remove people here; shares always apply to the
  // order's FULL base. (The old per-line split compounded: splitting an already-split line
  // halved a half.) Saving replaces the order's unpaid lines via split_order.
  //
  // ⚠️ "Everyone" is only as complete as `data.entries`, and split_order DELETES every unpaid
  // commission line on the order before re-inserting what was submitted — so anything missing
  // from these rows is destroyed, silently and with no record of what it was. Two gaps, both
  // closed here rather than left to the modal copy:
  //   • Rows the caller may not see. list_entries scopes the response to the caller's own lines
  //     unless they have "sees all payouts", so a Full-access/not-sees-all admin would author a
  //     one-person allocation and take an unseen rep's commission with it. The Split button is
  //     gated on `seesAll` below for that reason — this list is only trustworthy there.
  //   • Excluded and unassigned lines. They carry no share so they cannot be listed as people,
  //     but the delete does not spare them, so COUNT them and warn in the modal. Reset-to-default
  //     already words the same removal plainly; Split was the one path that stayed quiet.
  const openSplit = (e) => {
    const onOrder = ((data && data.entries) || []).filter((x) => x.orderId === e.orderId && x.kind === "commission" && x.status !== "paid");
    const sibs = onOrder.filter((x) => x.status !== "excluded" && x.earnerUserId);
    const rows = sibs.length
      ? sibs.map((x) => ({ userId: x.earnerUserId, share: String(x.splitShare != null ? Number(x.splitShare) : Math.round(100 / sibs.length)) }))
      : [{ userId: e.earnerUserId || "", share: "100" }];
    setSplitFor({ orderId: e.orderId, orderNo: e.orderNo, rows, alsoRemoved: onOrder.length - sibs.length });
  };
  const saveSplit = () => {
    const rows = splitFor.rows;
    const splits = rows.filter((r) => r.userId && Number(r.share) > 0).map((r) => ({ userId: r.userId, sharePercent: Number(r.share) }));
    const sum = splits.reduce((s, x) => s + x.sharePercent, 0);
    if (splits.length < 1) { setMsg({ err: "Pick at least one person." }); return; }
    if (new Set(splits.map((s) => s.userId)).size !== splits.length) { setMsg({ err: "The same person is listed twice." }); return; }
    if (Math.abs(sum - 100) > 0.01) { setMsg({ err: `Shares must add up to 100% (currently ${sum}%).` }); return; }
    setSplitFor(null);
    act({ action: "split_order", orderId: splitFor.orderId, splits }, "Allocation saved.");
  };
  const resetOrder = () => {
    if (!window.confirm(`Reset order #${splitFor.orderNo} to the default single commission line?\n\nEvery unpaid line on this order (splits, adjustments, excluded) is removed and the normal entry is rebuilt — the rep who sent the invoice, at their standard rate, on the full base.`)) return;
    const orderId = splitFor.orderId;
    setSplitFor(null);
    act({ action: "reset_order", orderId }, "Order reset to the default commission.");
  };
  const deleteEntry = (e) => {
    if (!window.confirm(`Completely remove ${e.earnerName ? e.earnerName + "'s" : "this"} line on order #${e.orderNo}?\n\nUnlike Exclude, a deleted line won't show on any report.`)) return;
    act({ action: "delete_entry", entryId: e.id }, "Line removed.");
  };
  const approvePeriod = (periodKey) => act({ action: "approve_period", periodKey }, "Period approved — ready to pay.");
  const unapprovePeriod = (periodKey) => act({ action: "unapprove_period", periodKey });

  // The report's own shape while the first list_entries is out: heading, the filter card, and
  // one pay-period card whose rows are bars. SIX columns deliberately —
  // Order/Customer/Building/Base/Commission/Status is the minimum (rep) view; Rep and Rate exist
  // only for someone the server says may see them, so the table can only GAIN columns when the
  // response lands, never lose them, and a grey bar leaks nothing either way.
  const skelPeriodCard = (
    <div style={{ ...S.card, marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <SkelBar w={172} h={14} /><SkelBar w={128} h={10} />
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>
            {["Order", "Customer", "Building", "Base", "Commission", "Status"].map((h) => <th key={h} style={S.th}>{h}</th>)}
          </tr></thead>
          <tbody><SkelRows cols={6} rows={6} /></tbody>
        </table>
      </div>
    </div>
  );
  if (data === null) return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <SkelBar w={148} h={16} /><SkelBar w={84} h={28} />
      </div>
      <div style={{ ...S.card, marginBottom: 14, padding: "12px 14px" }}>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
          {[210, 132, 132, 132, 132, 132].map((w, i) => (
            <div key={i} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <SkelBar w={Math.round(w * 0.4)} h={8} />
              <SkelBar w={w} h={30} />
            </div>
          ))}
        </div>
      </div>
      {skelPeriodCard}
    </div>
  );
  const entries = data.entries || [];
  const isOwner = !!data.isOwner, seesAll = !!data.seesAll, canSeeRates = !!data.canSeeRates;
  const team = data.team || [];

  if (data.enabled === false && entries.length === 0) {
    return (
      <div style={{ ...S.card, maxWidth: 640 }}>
        <div style={{ ...S.h2, marginBottom: 6 }}>Commissions</div>
        <p style={{ fontSize: 13.5, color: "#475569", lineHeight: 1.6, margin: 0 }}>
          {isOwner
            ? <>Commission tracking isn't turned on yet. Set it up in <b>Settings → Commissions</b> — how reps earn and the payout schedule — and payouts appear here automatically as orders come in.</>
            : <>Commission tracking isn't turned on for your account yet. Once it is, your payouts show up here.</>}
        </p>
      </div>
    );
  }

  // ── Filter / sort / search ──────────────────────────────────────────────
  // Reps and pay periods present in the data drive the dropdown options.
  const repOpts = (() => {
    const m = new Map(); let unassigned = false;
    for (const e of entries) { if (e.earnerUserId) m.set(e.earnerUserId, e.earnerName || "—"); else unassigned = true; }
    const arr = [...m.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
    if (unassigned) arr.push({ id: "__none__", name: "Unassigned" });
    return arr;
  })();
  const periodOpts = (() => {
    const m = new Map();
    for (const e of entries) m.set(e.periodKey || "unscheduled", e.periodLabel || "Unscheduled");
    return [...m.entries()].map(([key, label]) => ({ key, label })).sort((a, b) => String(b.key).localeCompare(String(a.key)));
  })();
  const ql = q.trim().toLowerCase();
  const matches = (e) => {
    if (ql) {
      const hay = [e.orderNo != null ? "#" + e.orderNo : "", e.customer, e.building, e.earnerName].filter(Boolean).join(" ").toLowerCase();
      if (!hay.includes(ql)) return false;
    }
    if (fRep) { if (fRep === "__none__") { if (e.earnerUserId) return false; } else if (e.earnerUserId !== fRep) return false; }
    if (fPeriod && (e.periodKey || "unscheduled") !== fPeriod) return false;
    if (fStatus && e.status !== fStatus) return false;
    if (fFrom && (!e.earnedOn || e.earnedOn < fFrom)) return false;
    if (fTo && (!e.earnedOn || e.earnedOn > fTo)) return false;
    return true;
  };
  const filtered = entries.filter(matches);
  const hasFilters = !!(ql || fRep || fPeriod || fStatus || fFrom || fTo);
  const clearFilters = () => { setQ(""); setFRep(""); setFPeriod(""); setFStatus(""); setFFrom(""); setFTo(""); };
  const sortRows = (rows) => {
    if (!sortBy) return rows;
    const dir = sortDir === "asc" ? 1 : -1;
    const val = (e) => sortBy === "amount" ? (e.amountCents ?? 0)
      : sortBy === "order" ? (e.orderNo ?? 0)
      : sortBy === "customer" ? String(e.customer || "").toLowerCase()
      : sortBy === "rep" ? String(e.earnerName || "").toLowerCase()
      : String(e.earnedOn || ""); // date
    return [...rows].sort((a, b) => { const va = val(a), vb = val(b); return va < vb ? -dir : va > vb ? dir : 0; });
  };

  // Group the FILTERED rows into pay-period cards; per-period Approve/Pay counts use the FULL
  // period (those actions are whole-period, never just the filtered subset).
  const groups = {};
  for (const e of filtered) { const k = e.periodKey || "unscheduled"; (groups[k] = groups[k] || { label: e.periodLabel, key: e.periodKey, rows: [] }).rows.push(e); }
  const periodAll = {};
  for (const e of entries) { const k = e.periodKey || "unscheduled"; (periodAll[k] = periodAll[k] || []).push(e); }
  const orderedKeys = Object.keys(groups).sort().reverse();

  // PAGING IS THE LAST STEP, and it pages the REPORT rather than each card: flatten the rows in
  // the exact order they render (period by period, sorted inside each), slice once, then let
  // each card draw only the lines that fell on this page. A page boundary can therefore land
  // mid-period and the next page picks it up, which is what makes "31–60 of 214" true.
  //
  // CRITICAL: `groups` and `periodAll` above stay computed from the FULL filtered / full entry
  // sets, so every period header total and every Approve / Mark-paid count keeps describing the
  // WHOLE period. Those actions are whole-period by design (mark_paid takes a period_key, not a
  // row list) and must never start meaning "the part of it you can currently see" — the same
  // reason Contacts pages last, so its counts keep describing the whole tenant.
  const pageRowsByKey = {};
  let flatRows = [];
  for (const k of orderedKeys) { const rs = sortRows(groups[k].rows); pageRowsByKey[k] = rs; flatRows = flatRows.concat(rs); }
  const commPages = Math.max(1, Math.ceil(flatRows.length / pageSize));
  const commPage = Math.min(page, commPages);
  const onPageIds = new Set(flatRows.slice((commPage - 1) * pageSize, commPage * pageSize).map((e) => e.id));

  const ctrlWrap = { display: "flex", flexDirection: "column", gap: 3 };
  const ctrlSel = { ...S.input, padding: "6px 8px", minWidth: 130 };

  const statusChip = (s) => { const c = { pending: ["#FEF3C7", "#92400E", "Pending"], payable: ["#DBEAFE", "#1E40AF", "Approved"], paid: ["#DCFCE7", "#166534", "Paid"], excluded: ["#F1F5F9", "#64748B", "Excluded"] }[s] || ["#F1F5F9", "#64748B", s]; return <span style={{ background: c[0], color: c[1], borderRadius: 20, padding: "3px 10px", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" }}>{c[2]}</span>; };
  const th = { textAlign: "left", fontSize: 11, fontWeight: 700, color: "#64748B", textTransform: "uppercase", letterSpacing: 0.5, padding: "8px 10px", borderBottom: "1px solid #E2E8F0", whiteSpace: "nowrap" };
  const td = { fontSize: 13, padding: "10px 10px", borderBottom: "1px solid #F1F5F9", verticalAlign: "middle" };
  const numTd = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };
  const actLink = (color) => ({ background: "none", border: "none", color, cursor: "pointer", fontSize: 11.5, fontWeight: 700, fontFamily: "inherit", padding: 0 });

  return (
    <div>
      {err && <div style={S.err}>{err}</div>}
      {msg && msg.err && <div style={S.err}>{msg.err}</div>}
      {msg && msg.ok && <div style={S.okMsg}>{msg.ok}</div>}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <div style={{ ...S.h2, marginBottom: 0 }}>{seesAll ? "Commissions" : "Your commissions"}</div>
        <button onClick={load} disabled={busy} style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0", padding: "6px 12px" }}>↻ Refresh</button>
        {/* The ledger is on screen before the reconcile finishes, so it says whose numbers
            these are. Without this the amounts would silently claim to be current while the
            controls that act on them sat disabled for no visible reason. */}
        {reconciling && data && (
          <span style={{ fontSize: 12, color: "#B45309", background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 999, padding: "4px 10px", fontWeight: 600 }}>
            Checking for new orders — amounts may still change
          </span>
        )}
      </div>

            {entries.length === 0 && <div style={{ ...S.card, color: "#64748B", fontSize: 13 }}>{seesAll ? "No commissions yet — they appear here as you invoice sales from Structure Studio." : "You have no commissions yet."}</div>}

      {entries.length > 0 && (
        <div style={{ ...S.card, marginBottom: 14, padding: "12px 14px" }}>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div style={{ ...ctrlWrap, flex: "1 1 220px", minWidth: 170 }}>
              <span style={S.lbl}>Search</span>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Order #, customer, building, rep" style={{ ...S.input, padding: "6px 8px" }} />
            </div>
            {seesAll && repOpts.length > 0 && (
              <div style={ctrlWrap}><span style={S.lbl}>Rep</span>
                <select value={fRep} onChange={(e) => setFRep(e.target.value)} style={ctrlSel}>
                  <option value="">All reps</option>
                  {repOpts.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select></div>
            )}
            <div style={ctrlWrap}><span style={S.lbl}>Pay period</span>
              <select value={fPeriod} onChange={(e) => setFPeriod(e.target.value)} style={ctrlSel}>
                <option value="">All periods</option>
                {periodOpts.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              </select></div>
            <div style={ctrlWrap}><span style={S.lbl}>Status</span>
              <select value={fStatus} onChange={(e) => setFStatus(e.target.value)} style={ctrlSel}>
                <option value="">All statuses</option>
                <option value="pending">Pending</option>
                <option value="payable">Approved</option>
                <option value="paid">Paid</option>
                <option value="excluded">Excluded</option>
              </select></div>
            <div style={ctrlWrap}><span style={S.lbl}>Earned from</span>
              <input type="date" value={fFrom} onChange={(e) => setFFrom(e.target.value)} style={{ ...S.input, padding: "6px 8px" }} /></div>
            <div style={ctrlWrap}><span style={S.lbl}>Earned to</span>
              <input type="date" value={fTo} onChange={(e) => setFTo(e.target.value)} style={{ ...S.input, padding: "6px 8px" }} /></div>
            <div style={ctrlWrap}><span style={S.lbl}>Sort by</span>
              <div style={{ display: "inline-flex", gap: 6 }}>
                <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} style={ctrlSel}>
                  <option value="">Pay period (default)</option>
                  <option value="date">Earned date</option>
                  <option value="amount">Commission</option>
                  <option value="order">Order #</option>
                  <option value="customer">Customer</option>
                  {seesAll && <option value="rep">Rep</option>}
                </select>
                {sortBy && <button onClick={() => setSortDir((d) => d === "asc" ? "desc" : "asc")} title="Toggle direction" style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0", padding: "6px 10px" }}>{sortDir === "asc" ? "↑" : "↓"}</button>}
              </div></div>
            {hasFilters && <button onClick={clearFilters} style={{ ...S.btn("#FEF2F2", "#DC2626"), padding: "6px 12px" }}>Clear</button>}
          </div>
          {hasFilters && <div style={{ fontSize: 12, color: "#64748B", marginTop: 9 }}>Showing <b>{filtered.length}</b> of {entries.length} commission{entries.length === 1 ? "" : "s"}.{filtered.length === 0 ? " Nothing matches — adjust the filters." : ""}</div>}
        </div>
      )}

      {orderedKeys.map((k) => {
        const g = groups[k];
        // Only this page's slice of the period. A period with nothing on this page draws no
        // card at all — an empty period card would read as a period that pays nothing.
        const pageRows = pageRowsByKey[k].filter((e) => onPageIds.has(e.id));
        if (pageRows.length === 0) return null;
        // The header total reads as "what this period pays out", so excluded lines (still listed
        // below for the audit trail) stay OUT of it and are surfaced as their own labeled sum.
        const total = g.rows.reduce((s, e) => s + (e.status === "excluded" ? 0 : (e.amountCents || 0)), 0);
        const excludedTotal = g.rows.reduce((s, e) => s + (e.status === "excluded" ? (e.amountCents || 0) : 0), 0);
        // Split lines share an order, so the "orders" count is distinct orders, not ledger lines.
        const orderCount = new Set(g.rows.map((e) => e.orderId ?? e.id)).size;
        // Approve / pay act on the whole pay period, so count against the FULL period, not the filtered view.
        const fullRows = periodAll[k] || g.rows;
        const pendingRows = fullRows.filter((e) => e.status === "pending" && e.amountCents != null);
        const approvedRows = fullRows.filter((e) => e.status === "payable");
        return (
          <div key={k} style={{ ...S.card, marginBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
              <div style={{ fontSize: 14.5, fontWeight: 800 }}>{g.label || "Unscheduled"}</div>
              <div style={{ fontSize: 12.5, color: "#64748B" }}>{orderCount} order{orderCount === 1 ? "" : "s"} · <b style={{ color: "#1E293B" }}>{money(total)}</b>{excludedTotal !== 0 && <> · {money(excludedTotal)} excluded</>}</div>
              {isOwner && (pendingRows.length > 0 || approvedRows.length > 0) && (
                <div style={{ marginLeft: "auto", display: "inline-flex", gap: 8, alignItems: "center" }}>
                  {/* approve_period targets a period_key server-side and rejects a null one, so the
                      Unscheduled pseudo-group (g.key = null) gets an explanation instead of a button —
                      its lines become approvable once they land in a real period. */}
                  {pendingRows.length > 0 && (g.key
                    ? <button onClick={() => approvePeriod(g.key)} disabled={committing} style={{ ...S.btn(ACCENT, "#FFF"), padding: "6px 13px" }}>Approve period</button>
                    : <span title="These commissions don't have a pay period yet — usually the order isn't fully collected. Once a line lands in a period, approve it there." style={{ fontSize: 11.5, fontWeight: 700, color: "#94A3B8", cursor: "help" }}>Approval waits for a pay period</span>)}
                  {/* unapprove_period and mark_paid reject a null period_key exactly as approve_period
                      does, so these two needed the same g.key gate and never had it, and both buttons
                      answered 400 — leaving the rep's approved commission neither payable nor
                      reversible from here. Say what happened instead of offering dead controls.
                      ⚠️ But do NOT promise the wait ends. An approved line landed here because compute
                      re-derived period_key on an already-approved row and an "on collected" line loses
                      that date when a payment is voided; compute now skips `payable` rows outright
                      (portal-commissions/index.ts:646), which both stops new strandings AND removes the
                      only thing that could ever put one back in a period. There is no automatic
                      recovery, so this branch draws only for lines stranded before that fix shipped.
                      The one real route out is Split → "Reset to default" on the row: reset_order
                      deletes the order's unpaid lines and rebuilds the standard PENDING one, which
                      picks up a period the next time compute runs. It costs that order's split and
                      adjustments, which is why it stays a deliberate two-step behind a confirm rather
                      than a button here — name it in the copy instead. */}
                  {approvedRows.length > 0 && (g.key
                    ? <>
                        <button onClick={() => unapprovePeriod(g.key)} disabled={committing} style={{ background: "none", border: "none", color: "#94A3B8", cursor: "pointer", fontSize: 11.5, fontWeight: 700, fontFamily: "inherit" }}>Un-approve</button>
                        <button onClick={() => markPeriodPaid(g.key, g.label)} disabled={committing} style={{ ...S.btn("#059669", "#FFF"), padding: "6px 13px" }}>Mark period paid</button>
                      </>
                    : <span title="These lines were approved, then lost their pay period — a payment on the order was voided, so it stopped counting as collected. Nothing puts them back on its own. To clear one: open Split on the row, then “Reset to default” — that rebuilds the order's commission as a pending line, which joins a pay period again once the order collects, and can be approved and paid there. Note it also removes any split or adjustment on that order." style={{ fontSize: 11.5, fontWeight: 700, color: "#B45309", cursor: "help" }}>Approved — no pay period</span>)}
                </div>
              )}
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead><tr>
                  <th style={th}>Order</th><th style={th}>Customer</th><th style={th}>Building</th>
                  {seesAll && <th style={th}>Rep</th>}
                  <th style={{ ...th, textAlign: "right" }}>Base</th>
                  {canSeeRates && <th style={{ ...th, textAlign: "right" }}>Rate</th>}
                  <th style={{ ...th, textAlign: "right" }}>Commission</th><th style={th}>Status</th>
                  {canSeeRates && <th style={th}></th>}
                </tr></thead>
                <tbody>
                  {pageRows.map((e) => (
                    <tr key={e.id}>
                      <td style={{ ...td, fontWeight: 700, whiteSpace: "nowrap" }}>{e.orderNo ? "#" + e.orderNo : "—"}</td>
                      <td style={td}>{e.customer}</td>
                      <td style={td}>{e.building}</td>
                      {seesAll && (
                        <td style={td}>
                          {e.earnerName || (canSeeRates
                            ? (assign === e.id
                                ? <select autoFocus disabled={committing} defaultValue="" onChange={(ev) => assignEarner(e.id, ev.target.value)} onBlur={() => setAssign(null)} style={{ ...S.input, padding: "5px 8px" }}>
                                    <option value="" disabled>Assign rep…</option>
                                    {team.map((t) => <option key={t.userId} value={t.userId}>{t.name}</option>)}
                                  </select>
                                : <button onClick={() => setAssign(e.id)} disabled={committing} style={{ background: "none", border: "1px dashed #CBD5E1", borderRadius: 6, color: "#3D3672", fontWeight: 700, fontSize: 11.5, padding: "4px 9px", cursor: "pointer", fontFamily: "inherit" }}>Assign rep</button>)
                            : <span style={{ color: "#94A3B8" }}>Unassigned</span>)}
                        </td>
                      )}
                      <td style={numTd}>{money(e.baseCents)}</td>
                      {canSeeRates && <td style={numTd}>{e.ratePercent == null ? "—" : e.ratePercent + "%"}</td>}
                      <td style={{ ...numTd, fontWeight: 800, color: (e.amountCents != null && e.amountCents < 0) ? "#DC2626" : undefined }}>{money(e.amountCents)}</td>
                      <td style={td}>{statusChip(e.status)}</td>
                      {canSeeRates && (
                        <td style={{ ...td, whiteSpace: "nowrap" }}>
                          {/* Order cancellation is handled entirely in the Orders tab, not here —
                              this table only reflects the resulting clawback/excluded lines. */}
                          {e.kind === "clawback" ? <span style={{ color: "#94A3B8", fontSize: 11 }}>—</span>
                            : e.status === "paid" ? <span style={{ color: "#94A3B8", fontSize: 11 }}>—</span>
                            : e.status === "excluded" ? (
                              <span style={{ display: "inline-flex", gap: 10, flexWrap: "wrap" }}>
                                <button onClick={() => act({ action: "set_excluded", entryId: e.id, excluded: false })} disabled={committing} style={actLink("#3D3672")}>Restore</button>
                                <button onClick={() => deleteEntry(e)} disabled={committing} title="Completely remove this line — unlike Exclude it won't show on any report" style={actLink("#DC2626")}>Delete</button>
                              </span>
                            )
                            : (
                              <span style={{ display: "inline-flex", gap: 10, flexWrap: "wrap" }}>
                                {/* seesAll, not canSeeRates: the two grants are independent, and a
                                    Full-access admin without "sees all payouts" is served only their
                                    OWN lines — Split would then delete a colleague's line it never
                                    showed them. Editing an allocation needs the whole order. */}
                                {seesAll && e.earnerUserId && <button onClick={() => openSplit(e)} disabled={committing} style={actLink("#3D3672")}>Split</button>}
                                {e.earnerUserId && <button onClick={() => adjustEntry(e)} disabled={committing} style={actLink("#3D3672")}>Adjust</button>}
                                <button onClick={() => act({ action: "set_excluded", entryId: e.id, excluded: true })} disabled={committing} style={actLink("#94A3B8")}>Exclude</button>
                                <button onClick={() => deleteEntry(e)} disabled={committing} title="Completely remove this line — unlike Exclude it won't show on any report" style={actLink("#DC2626")}>Delete</button>
                              </span>
                            )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}

      {flatRows.length > 0 && (
        <PageBar size={pageSize} onSize={setPageSize} page={commPage} onPage={setPage} total={flatRows.length} noun="commission" />
      )}

      {splitFor && (
        <div onClick={(ev) => { if (ev.target === ev.currentTarget) setSplitFor(null); }}
          style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.5)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, zIndex: 1200 }}>
          <div style={{ background: "#FFF", borderRadius: 14, maxWidth: 460, width: "100%", boxShadow: "0 24px 60px rgba(0,0,0,0.3)", overflow: "hidden" }}>
            <div style={{ background: ACCENT, color: "#FFF", padding: "15px 18px", fontSize: 15.5, fontWeight: 800 }}>Order #{splitFor.orderNo} — who earns on this sale</div>
            <div style={{ padding: "16px 18px" }}>
              <p style={{ fontSize: 12.5, color: "#64748B", margin: "0 0 12px" }}>Everyone on this order and their share of the sale. Each person earns their own rate on their share of the <b>full order</b>. Add or ✕ remove people; shares must total 100%.</p>
              {splitFor.alsoRemoved > 0 && (
                <p style={{ fontSize: 12, color: "#92400E", background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 8, padding: "9px 11px", margin: "0 0 12px", lineHeight: 1.55 }}>
                  Saving also removes {splitFor.alsoRemoved} other unpaid line{splitFor.alsoRemoved === 1 ? "" : "s"} on this order — excluded or not yet assigned to a rep, so {splitFor.alsoRemoved === 1 ? "it isn't" : "they aren't"} listed above. {splitFor.alsoRemoved === 1 ? "It won't" : "They won't"} come back.
                </p>
              )}
              {splitFor.rows.map((r, i) => (
                <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
                  <select value={r.userId} onChange={(ev) => setSplitFor((s) => ({ ...s, rows: s.rows.map((x, j) => j === i ? { ...x, userId: ev.target.value } : x) }))} style={{ ...S.input, flex: 1 }}>
                    <option value="">Choose rep…</option>
                    {team.map((t) => <option key={t.userId} value={t.userId}>{t.name}</option>)}
                  </select>
                  <input value={r.share} onChange={(ev) => setSplitFor((s) => ({ ...s, rows: s.rows.map((x, j) => j === i ? { ...x, share: ev.target.value.replace(/[^0-9.]/g, "") } : x) }))} style={{ ...S.input, width: 66, textAlign: "right" }} />
                  <span style={{ color: "#94A3B8" }}>%</span>
                  {splitFor.rows.length > 1 && <button onClick={() => setSplitFor((s) => ({ ...s, rows: s.rows.filter((_, j) => j !== i) }))} title="Remove this person from the order" style={{ background: "none", border: "none", color: "#DC2626", cursor: "pointer", fontWeight: 700, fontFamily: "inherit" }}>✕</button>}
                </div>
              ))}
              <button onClick={() => setSplitFor((s) => ({ ...s, rows: [...s.rows, { userId: "", share: "0" }] }))} style={{ background: "none", border: "1px dashed #CBD5E1", borderRadius: 8, color: "#3D3672", fontWeight: 700, fontSize: 12, padding: "6px 11px", cursor: "pointer", fontFamily: "inherit", marginTop: 2 }}>+ Add rep</button>
              <div style={{ fontSize: 12, color: "#64748B", marginTop: 10 }}>Total: <b style={{ color: Math.abs(splitFor.rows.reduce((s, r) => s + (Number(r.share) || 0), 0) - 100) < 0.01 ? "#166534" : "#DC2626" }}>{splitFor.rows.reduce((s, r) => s + (Number(r.share) || 0), 0)}%</b></div>
              <div style={{ display: "flex", gap: 8, marginTop: 15 }}>
                <button onClick={saveSplit} disabled={committing} style={{ ...S.btn(ACCENT, "#FFF"), flex: 1 }}>Save</button>
                <button onClick={resetOrder} disabled={committing} title="Remove every unpaid line on this order and rebuild the normal single entry" style={{ ...S.btn("#FEF2F2", "#DC2626") }}>Reset to default</button>
                <button onClick={() => setSplitFor(null)} style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0" }}>Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── MY VIEW — the settings that configure the PERSON, not the business ───────────
// Carolyn, 2026-08-28 @42:00: "I'm trying to think which I want to have the default. I want
// them to be able to decide if they want the default. I don't want it to always be list.
// They can decide to set their default to be pipeline or list, whichever one that they want."
//
// Saves to client_users.prefs (migration 165) through save_prefs, which is gated "self" --
// the handler keys strictly off the caller's own user id and never off anything in the body.
//
// THE RECORD CARD ORDER CARD (2026-10-05). Carolyn on the same call @39:00: "they can put their
// cards in the order that they want them, and they can have a different order under a contact,
// and a different order under a deal." She called it "obviously later" then; it is built now as
// an up/down list here, the Settings home Ahsan proposed @42:28 and she agreed to, rather than
// dragging on the record: it works by keyboard and on a phone, and it needs no new server write.
// It saves the FULL key list for a kind, the cards that only show sometimes (Sales tax) included,
// so they keep their place; CrmRecord reads it through crmOrderSections (02-sales.jsx). save_prefs
// has kept cardOrder since 2026-08-29 (the column is migration 165's), and the card still checks
// the echo the way the reply-to card does.
//
// THE REPLY-TO CARD BELOW has worked since 2026-09-06, when save_prefs learned to keep
// `replyToEmail`. Since 2026-10-05 it covers every email a customer gets from us, not only the
// ones typed in a record: an estimate, an invoice or a change order carries the address of whoever
// sent it, and a confirmation the customer set off themselves carries their assigned rep's
// (supabase/functions/_shared/repReplyTo.ts has the rule, and why an operator is never named).
// Since 2026-10-07 the copy is OPT-IN: `replyCopy` (only `true` is kept by save_prefs) chooses
// between "StructureStudio only", the default, and "StructureStudio and my inbox". If save_prefs
// ever stops keeping either key, the card still says so on screen rather than "Saved."
//
// The address goes into a mail header, so this box and the server check it with the SAME rule:
// REPLY_ADDRESS_RE is a copy of the one in _shared/repReplyTo.ts, and
// _shared/repReplyToSenders.test.ts fails if the two differ. Change both together.
const REPLY_ADDRESS_RE = /^[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
function MyProfileSettings({ prefs, onSaved, profile = null, email = null, onProfileSaved = null }) {
  const [val, setVal] = useState((prefs && prefs.designsView) === "pipeline" ? "pipeline" : "list");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  // ── The reply-to card's own state ───────────────────────────────────────────────
  // Seeded from prefs but NOT re-synced to it, deliberately: a save that the server refuses
  // to persist (see commit) must leave what the person typed on screen next to the message
  // explaining what happened, rather than silently reverting to the stored value and looking
  // like nothing was ever entered.
  const [addr, setAddr] = useState(((prefs && prefs.replyToEmail) || ""));
  const [addrBusy, setAddrBusy] = useState(false);
  const [addrMsg, setAddrMsg] = useState(null);
  const savedAddr = (prefs && prefs.replyToEmail) || "";
  // Reply copies, OFF unless the saved prefs say exactly true (the server's rule). copyKept is what
  // the server last kept from ANY card's save (commit sets it), so a failed save puts the choice
  // back to something true.
  const [copyOn, setCopyOn] = useState(!!(prefs && prefs.replyCopy === true));
  const [copyBusy, setCopyBusy] = useState(false);
  const [copyMsg, setCopyMsg] = useState(null);
  const copyKept = useRef(!!(prefs && prefs.replyCopy === true));
  // ── The email signature card's own state ────────────────────────────────────────
  // Seeded from prefs and not re-synced, for the same reason as the reply-to address above.
  const [sig, setSig] = useState(((prefs && prefs.emailSignature) || ""));
  const [sigBusy, setSigBusy] = useState(false);
  const [sigMsg, setSigMsg] = useState(null);
  const savedSig = (prefs && prefs.emailSignature) || "";
  // ── The record card order card's own state ──────────────────────────────────────
  // The SAVED list per kind, or null for "never arranged" (the registry order). Seeded from prefs
  // and moved on screen at once, so a run of presses doesn't wait on the server between them;
  // the saves queue behind each other (saveOrder) and only the last arrangement has to land.
  const seedOrder = (p) => {
    const co = (p && p.cardOrder) || {};
    const one = (k) => (Array.isArray(co[k]) && co[k].length ? co[k] : null);
    return { contact: one("contact"), design: one("design") };
  };
  const [cardOrder, setCardOrder] = useState(() => seedOrder(prefs));
  const [orderBusy, setOrderBusy] = useState(false);
  const [orderMsg, setOrderMsg] = useState(null);
  const orderWant = useRef(null);
  const orderSaving = useRef(false);
  const orderKept = useRef(seedOrder(prefs));

  // One writer for every card. save_prefs takes the WHOLE prefs map and replaces the stored
  // blob with it, so every save has to carry the keys it is not changing -- hence the spread.
  //
  // THE SPREAD IS OF WHAT THIS PAGE LAST ASKED FOR, not of the `prefs` prop (review 2026-10-05).
  // The prop is the copy from the render a save started in, and the card order's queue (saveOrder)
  // keeps sending from that render: press ▼ twice, switch the Pipeline default while the first
  // save is out, and the queued order save put the old default back on the server while the card
  // said "Saved.". Every save merges its own keys into prefsWant first, so each one carries every
  // card's latest choice, whichever lands last. This page is the only writer of these prefs, so
  // nothing else can move them underneath it. (A save that fails leaves its value on screen, and
  // the next save of any card now stores it: the same thing the screen already shows.)
  const prefsWant = useRef(prefs || {});
  const commit = async (patch) => {
    prefsWant.current = { ...prefsWant.current, ...patch };
    const body = { action: "save_prefs", prefs: prefsWant.current };
    const { data, error } = await sb.functions.invoke("portal-settings", { body });
    if (error || (data && data.error)) throw new Error((error && error.message) || data.error);
    // What the server now holds for reply copies, from EVERY card's save: each one carries
    // prefsWant.replyCopy, so a signature save can change it too. A failed reply-copy save goes
    // back to this, never to an older answer that another card's save has since overwritten.
    copyKept.current = !!(data && data.prefs && data.prefs.replyCopy === true);
    // Hand the saved map back so the shell stops serving the stale one -- otherwise the
    // setting only takes effect on the next full reload, which reads as not having saved.
    if (onSaved) onSaved(data && data.prefs);
    return (data && data.prefs) || null;
  };

  const save = async (next) => {
    setVal(next); setBusy(true); setMsg(null);
    try { await commit({ designsView: next }); setMsg({ ok: "Saved." }); }
    catch (e) { setMsg({ err: e.message }); }
    setBusy(false);
  };

  // The server's own rule (REPLY_ADDRESS_RE above, 320 characters at most). Checked here so a
  // typo, a name in angle brackets or a second address is caught while the person is still
  // looking at the field -- server-side it is dropped silently, which would read as the setting
  // refusing to save for no reason.
  const looksLikeEmail = (v) => v.length <= 320 && REPLY_ADDRESS_RE.test(v);

  const saveAddr = async () => {
    const next = addr.trim();
    if (next && !looksLikeEmail(next)) { setAddrMsg({ err: "That doesn't look like an email address." }); return; }
    setAddrBusy(true); setAddrMsg(null);
    try {
      const back = await commit({ replyToEmail: next });
      const kept = (back && back.replyToEmail) || "";
      // ⚠️ THE WHITELIST CHECK, and it is not defensive padding -- it is the one signal that
      // separates "saved" from "accepted and thrown away". save_prefs rebuilds the prefs blob
      // from a fixed list of keys and writes the result over the whole column, so a key it
      // does not know is dropped with an { ok: true } response and no error anywhere. Every
      // server since 2026-09-06 keeps this one; an older build, or one that refuses the
      // address, still lands here. Reporting it plainly costs four lines; not reporting it
      // costs somebody an afternoon on a setting that says "Saved." and does nothing.
      if (next && kept !== next) {
        setAddrMsg({ err: "Saved, but this server build didn't keep the address — replies will keep going to your login email for now. Tell CSM Synergy." });
      } else {
        setAddrMsg({ ok: next ? "Saved." : "Cleared — replies go to your login email." });
      }
    } catch (e) { setAddrMsg({ err: e.message }); }
    setAddrBusy(false);
  };

  // Reply copies on or off. OFF is sent as false, which save_prefs drops: no key is OFF. The
  // whitelist check again: a server build that doesn't know the key answers ok and keeps nothing,
  // so asking for ON and getting no `replyCopy: true` back is said plainly, and the choice goes
  // back to what the server holds (the card-order rule: never show a state no email will follow).
  // ⚠️ THE MESSAGE SAYS NOTHING CHANGED, NOT WHERE REPLIES GO. The only build that drops the key
  // is one from before 2026-10-07, and that build's emailSend.ts puts the person's address on
  // every email: replies are still reaching their inbox. "StructureStudio only for now" would be
  // the opposite of the truth in the one case this message exists for.
  // A press while a save is out is ignored, with "Saving…" on screen; the buttons are never
  // `disabled`, which would also throw a keyboard user's focus off them.
  const saveCopy = async (next) => {
    if (copyBusy || next === copyOn) return;
    setCopyOn(next); setCopyBusy(true); setCopyMsg(null);
    try {
      const back = await commit({ replyCopy: next });
      const kept = !!(back && back.replyCopy === true);
      if (next && !kept) {
        prefsWant.current = { ...prefsWant.current, replyCopy: false };
        setCopyOn(false);
        setCopyMsg({ err: "Saved, but this server build didn't keep it, so nothing has changed yet. Tell CSM Synergy." });
      } else {
        setCopyMsg({ ok: "Saved." });
      }
    } catch (e) {
      prefsWant.current = { ...prefsWant.current, replyCopy: copyKept.current };
      setCopyOn(copyKept.current);
      setCopyMsg({ err: e.message });
    }
    setCopyBusy(false);
  };

  // The server trims it and keeps at most 1,000 characters (_shared/emailSignature.ts); the box
  // stops at the same length, so what is saved is what was typed. The kept value is shown back
  // all the same, and an empty answer to a non-empty save is the whitelist check again: an older
  // server build drops the key and still says ok.
  const saveSig = async () => {
    const next = sig.trim();
    setSigBusy(true); setSigMsg(null);
    try {
      const back = await commit({ emailSignature: next });
      const kept = (back && back.emailSignature) || "";
      if (next && !kept) {
        setSigMsg({ err: "Saved, but this server build didn't keep the signature — your emails go out without one for now. Tell CSM Synergy." });
      } else {
        setSig(kept);
        setSigMsg({ ok: next ? "Saved. It goes under every email you send a customer." : "Removed — your emails go out without a signature." });
      }
    } catch (e) { setSigMsg({ err: e.message }); }
    setSigBusy(false);
  };

  // The cards one kind of record can show, in this person's order: every card, the ones that
  // only show sometimes included, because the saved list has to give each of them a place.
  const cardsFor = (kind) => crmOrderSections(CRM_SECTIONS.filter((s) => s.kinds.indexOf(kind) !== -1), cardOrder[kind]);

  // ONE SAVE AT A TIME, THE LATEST ARRANGEMENT LAST. Each press moves the card on screen and asks
  // for a save; a press while one is in flight only replaces what the next save sends. Two saves
  // racing would land in either order, and save_prefs replaces the whole blob, so the older one
  // could win. Every save carries both kinds in full (`send`). The loop goes on calling the
  // `commit` of the render it started in, which is safe only because commit spreads prefsWant (a
  // ref) rather than that render's `prefs`: another card saved mid-run rides along.
  const saveOrder = async (next) => {
    orderWant.current = next;
    if (orderSaving.current) return;
    orderSaving.current = true; setOrderBusy(true); setOrderMsg(null);
    let said = null;
    try {
      while (orderWant.current) {
        const want = orderWant.current;
        orderWant.current = null;
        const send = {};
        for (const k of ["contact", "design"]) if (want[k]) send[k] = want[k];
        const back = await commit({ cardOrder: send });
        // The whitelist check again (see saveAddr): a server that drops the key still says ok.
        const kept = seedOrder(back);
        orderKept.current = kept;
        const same = ["contact", "design"].every((k) => JSON.stringify(kept[k]) === JSON.stringify(send[k] || null));
        said = same
          ? { ok: "Saved." }
          : { err: "Saved, but this server build didn't keep the order — records keep the usual order for now. Tell CSM Synergy." };
        if (!same && !orderWant.current) setCardOrder(kept);
      }
    } catch (e) {
      // Back to what the server last kept, so the list never shows an order no record will use.
      orderWant.current = null;
      setCardOrder(orderKept.current);
      said = { err: e.message };
    }
    orderSaving.current = false; setOrderBusy(false); setOrderMsg(said);
  };

  const moveCard = (kind, key, step) => {
    const keys = cardsFor(kind).map((s) => s.key);
    const i = keys.indexOf(key);
    const j = i + step;
    if (i < 0 || j < 0 || j >= keys.length) return;
    keys[i] = keys[j]; keys[j] = key;
    const next = { ...cardOrder, [kind]: crmMergeCardOrder(cardOrder[kind], keys) };
    setCardOrder(next);
    saveOrder(next);
  };

  const resetCardOrder = (kind) => {
    if (!cardOrder[kind]) return;
    const next = { ...cardOrder, [kind]: null };
    setCardOrder(next);
    saveOrder(next);
  };

  return (
    <div>
      {/* YOUR DETAILS FIRST (Carolyn 2026-09-11: "move the information in Your details to the
          top of my profile"). Who you are, then how the portal behaves for you — and it is the
          card the name-and-phone nudge sends people to, so it should be the one they land on. */}
      <YourDetailsCard profile={profile} email={email} onSaved={onProfileSaved} />
      <div style={S.card}>
        <div style={S.h2}>How the Pipeline tab opens</div>
        <p style={{ fontSize: 13, color: "#64748B", marginBottom: 14, lineHeight: 1.5 }}>
          Your own default, not the business's — everyone on your team picks their own. Opening a
          direct link to a list or a board still shows whichever the link names.
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          {[["list", "List"], ["pipeline", "Pipeline board"]].map(([k, label]) => (
            <button key={k} disabled={busy} onClick={() => save(k)}
              style={{ ...S.btn(val === k ? ACCENT : "#F1F5F9", val === k ? "#FFF" : "#334155"), opacity: busy ? 0.6 : 1 }}>
              {label}
            </button>
          ))}
        </div>
        {msg && <div style={{ marginTop: 10, fontSize: 12, color: msg.err ? "#DC2626" : "#15803D" }}>{msg.err || msg.ok}</div>}
      </div>

      {/* ── RECORD CARD ORDER — Carolyn 2026-08-28 @39:00 ──────────────────────────────
          Next to the Pipeline default because Ahsan put the two together on that call ("all of
          these settings for contact cards, the pipeline cards, and the default one"). Two lists,
          because she asked for "a different order under a contact, and a different order under a
          deal".

          ⚠️ THE ARROWS ARE NEVER `disabled`. Chrome drops focus from a button the moment it
          becomes disabled, so the ▲ on a card that has just reached the top would throw a
          keyboard user's place back to the start of the page. aria-disabled says the same thing
          to a screen reader, and moveCard ignores a step past either end. */}
      <div style={S.card}>
        <div style={S.h2}>Record card order</div>
        <p style={{ fontSize: 13, color: "#64748B", marginBottom: 14, lineHeight: 1.5 }}>
          Put the cards down the side of a customer's record in the order you want them. Your own
          order, not the business's — everyone on your team arranges their own.
        </p>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
          {[["contact", "On a contact"], ["design", "On a deal"]].map(([kind, label]) => {
            const cards = cardsFor(kind);
            return (
              <div key={kind} data-ss-card-order={kind} style={{ flex: "1 1 240px", minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
                  <div style={{ fontSize: 13, fontWeight: 800, color: "#1E293B", flex: 1 }}>{label}</div>
                  <button onClick={() => resetCardOrder(kind)} aria-disabled={!cardOrder[kind]}
                    style={{ background: "none", border: "none", padding: 0, fontSize: 12, fontWeight: 700, fontFamily: "inherit",
                      color: cardOrder[kind] ? ACCENT : "#CBD5E1", cursor: cardOrder[kind] ? "pointer" : "default" }}>
                    Reset to default
                  </button>
                </div>
                <div style={{ border: "1px solid #E2E8F0", borderRadius: 8, overflow: "hidden" }}>
                  {cards.map((s, i) => (
                    <div key={s.key} data-ss-card-order-row={s.key}
                      style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderTop: i ? "1px solid #F1F5F9" : "none", background: "#FFF" }}>
                      <span style={{ width: 18, fontSize: 11.5, color: "#94A3B8", textAlign: "right", flexShrink: 0 }}>{i + 1}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: "#334155" }}>{s.title}</div>
                        {s.note && <div style={{ fontSize: 11.5, color: "#94A3B8", lineHeight: 1.35 }}>{s.note}</div>}
                      </div>
                      {[[-1, "▲", "up"], [1, "▼", "down"]].map(([step, glyph, word]) => {
                        const off = (step < 0 && i === 0) || (step > 0 && i === cards.length - 1);
                        return (
                          <button key={word} onClick={() => moveCard(kind, s.key, step)}
                            aria-label={`Move ${s.title} ${word}`} aria-disabled={off} title={off ? "" : `Move ${word}`}
                            style={{ width: 30, height: 28, flexShrink: 0, border: "1px solid #E2E8F0", borderRadius: 6, background: off ? "#F8FAFC" : "#FFF",
                              color: off ? "#CBD5E1" : "#475569", fontSize: 11, cursor: off ? "default" : "pointer", fontFamily: "inherit", padding: 0 }}>
                            {glyph}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        {(orderBusy || orderMsg) && (
          <div style={{ marginTop: 10, fontSize: 12, color: orderBusy ? "#64748B" : (orderMsg.err ? "#DC2626" : "#15803D") }}>
            {orderBusy ? "Saving…" : (orderMsg.err || orderMsg.ok)}
          </div>
        )}
      </div>

      {/* ── WHERE REPLIES GO — Carolyn 2026-09-04 @35:06 ────────────────────────────
          "the company has to set up their domain to work. And then every user should be able
          to go in and say, when somebody replies to an email, send it here. But that should
          be in their profile."

          Her word was "profile", and this card sat in a tab called "My View" — which is why
          the note here said it was worth revisiting with her. ✅ SETTLED 2026-09-11: she
          renamed the tab itself ("my view should be called my profile in the nav tab and the
          url"), so the card is in My Profile and the wording matches what she asked for.

          Still TWO per-person surfaces, and the distinction is worth keeping straight: this
          tab, and the "Your details" DIALOG off the sidebar identity menu. Both save through
          a "self"-gated action. The dialog is name/phone/password — who you are; this tab is
          how the portal behaves for you. Do not merge them without asking.

          ⚠️ WHAT THE COPY MUST NOT PROMISE. The inbox copy does not REDIRECT replies, it ADDS a
          second address: with copies on, the customer's reply reaches this address AND the
          customer's record in StructureStudio. Wording it as "send replies here" would describe
          GoHighLevel's behaviour, which is what she was comparing us to, and the first person to
          notice a reply still landing in the app would reasonably call it a bug.

          COPIES ARE OPT-IN (2026-10-07). Carolyn asked for a per-person choice, default OFF:
          "StructureStudio only" (the reply shows on the record and nowhere else) or
          "StructureStudio and my inbox". Two buttons in the Pipeline-default style, saved through
          the same commit as every card here; save_prefs keeps `replyCopy` only when it is true.
          With copies off nothing tells the rep a reply came in: it shows on the record and in the
          conversation feed, and the copy says no more than that.

          ⚠️ THE RECORD KEEPS THE WORDS, NOT THE FILES (review 2026-10-07). email-inbound stores a
          reply's subject and text but no attachments (email_inbound has no column for them and
          nothing writes them to crm_files); it notes on the reply how many files there were, and
          the files themselves only reach a person through the inbox copy. So the OFF line says so
          and points at the other choice. Take that sentence out only when attachments land on the
          record. The composer's line in 02-sales.jsx says the same.

          WHICH EMAILS (2026-10-05). Every email a customer gets from us: the ones typed in a
          record, and the estimates, invoices and change orders a person sends. The confirmations
          a customer sets off themselves (accepting an estimate, signing an invoice) go to the rep
          the customer is assigned to, on THAT rep's own choice, so the card says that too. The
          rule is the server's (_shared/repReplyTo.ts, emailSend.ts); keep this wording in step.

          WHAT IT CAN'T PROMISE ON EVERY ACCOUNT. The card shows on every tenant, but the copy
          only rides on email StructureStudio itself sends: on a CRM tenant the estimates and
          invoices go out from GoHighLevel, which this setting never touches. And StructureStudio
          can only receive a reply once the company has set up replies (Settings → Email
          Settings); until then the server keeps putting the person's address on the email
          whatever they picked, so a reply still reaches somebody, and the card says so. Most
          customers have no assigned rep yet, so the confirmation line says "if they have one"
          as well as "if they've switched this on". Worded to be true everywhere rather than
          switched per tenant, because a rep has no right to read the email settings it would
          need.

          The address box stays: it is the inbox used when copies are on, and the one replies
          come to until the company sets up replies. */}
      <div style={S.card}>
        <div style={S.h2}>Where replies to your emails go</div>
        <p style={{ fontSize: 13, color: "#64748B", marginBottom: 14, lineHeight: 1.5 }}>
          When a customer hits Reply on an email you sent them from StructureStudio, whether it's a
          message, an estimate, an invoice or a change order, their reply shows on that customer's
          record here. Pick whether you want a copy in your own inbox as well.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {[[false, "StructureStudio only"], [true, "StructureStudio and my inbox"]].map(([on, label]) => (
            <button key={label} data-ss-reply-copy={on ? "on" : "off"} onClick={() => saveCopy(on)}
              aria-pressed={copyOn === on} aria-disabled={copyBusy}
              style={{ ...S.btn(copyOn === on ? ACCENT : "#F1F5F9", copyOn === on ? "#FFF" : "#334155"), opacity: copyBusy ? 0.6 : 1, cursor: copyBusy ? "default" : "pointer" }}>
              {label}
            </button>
          ))}
        </div>
        <div style={{ marginTop: 10, fontSize: 12.5, color: "#334155", lineHeight: 1.5 }}>
          {copyOn
            ? "Replies show on the customer's record, and a copy comes to your own inbox too."
            : "Replies show on the customer's record in StructureStudio only. Files a customer attaches aren't kept there yet, so pick \"StructureStudio and my inbox\" if you need them."}
        </div>
        {(copyBusy || copyMsg) && (
          <div style={{ marginTop: 6, fontSize: 12, color: copyBusy ? "#64748B" : (copyMsg.err ? "#DC2626" : "#15803D") }}>
            {copyBusy ? "Saving…" : (copyMsg.err || copyMsg.ok)}
          </div>
        )}
        <p style={{ fontSize: 13, color: "#64748B", margin: "12px 0 14px", lineHeight: 1.5 }}>
          Until your company sets up replies under Settings → Email Settings, StructureStudio can't
          receive them, so replies come to your inbox whichever you pick.
        </p>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#334155", marginBottom: 4 }}>Your inbox for replies</div>
        <p style={{ fontSize: 13, color: "#64748B", marginBottom: 8, lineHeight: 1.5 }}>
          Leave this blank to use the email address you sign in with, or fill it in to get replies
          somewhere else.
        </p>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
          <input
            type="email"
            value={addr}
            disabled={addrBusy}
            onChange={(e) => { setAddr(e.target.value); setAddrMsg(null); }}
            onKeyDown={(e) => { if (e.key === "Enter") saveAddr(); }}
            placeholder="you@yourcompany.com"
            style={{ ...S.input, flex: 1, minWidth: 220, opacity: addrBusy ? 0.6 : 1 }}
          />
          <button
            onClick={saveAddr}
            disabled={addrBusy || addr.trim() === savedAddr}
            style={{ ...S.btn(ACCENT, "#FFF"), opacity: (addrBusy || addr.trim() === savedAddr) ? 0.5 : 1 }}>
            Save
          </button>
        </div>
        {addrMsg && <div style={{ marginTop: 10, fontSize: 12, color: addrMsg.err ? "#DC2626" : "#15803D" }}>{addrMsg.err || addrMsg.ok}</div>}
        <p style={{ fontSize: 13, color: "#64748B", margin: "14px 0 0", lineHeight: 1.5 }}>
          This is for email StructureStudio sends. An estimate or invoice your CRM sends for you
          follows the CRM's own settings. When a customer replies to the confirmation they get after
          accepting an estimate or signing an invoice, the copy goes to the person that customer is
          assigned to, if they have one and they've switched this on.
        </p>
      </div>

      {/* ── YOUR EMAIL SIGNATURE — Carolyn 2026-10-01 ─────────────────────────────────
          "The other thing that is like super, super important in this is to be able to set up
          email signatures in the settings ... if I'm sitting here typing a message, I want to
          see my signature right here."

          Per PERSON, so it lives in My Profile beside the reply-to address: each rep signs their
          own emails. It goes under the emails a person writes (a record's Email tab, My Synergy
          Phone) and under test emails. Quotes and invoices are NOT signed: they have their own
          branded footer, and signing them is a later change. Plain text on purpose; the server
          escapes it into the HTML, so no signature can carry markup into a customer's inbox. */}
      <div style={S.card}>
        <div style={S.h2}>Your email signature</div>
        <p style={{ fontSize: 13, color: "#64748B", marginBottom: 14, lineHeight: 1.5 }}>
          Added to the end of every email you write to a customer, and to test emails. Plain
          text, up to 1,000 characters. Quotes and invoices keep their own footer.
        </p>
        <textarea
          value={sig}
          disabled={sigBusy}
          maxLength={1000}
          rows={4}
          onChange={(e) => { setSig(e.target.value); setSigMsg(null); }}
          placeholder={"Jane Smith\nSales, Your Company\n(555) 201-8890"}
          style={{ ...S.input, width: "100%", boxSizing: "border-box", resize: "vertical", lineHeight: 1.5, opacity: sigBusy ? 0.6 : 1 }}
        />
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
          <button
            onClick={saveSig}
            disabled={sigBusy || sig.trim() === savedSig}
            style={{ ...S.btn(ACCENT, "#FFF"), opacity: (sigBusy || sig.trim() === savedSig) ? 0.5 : 1 }}>
            Save
          </button>
          <span style={{ fontSize: 11.5, color: "#94A3B8" }}>{sig.length}/1000</span>
        </div>
        {sigMsg && <div style={{ marginTop: 10, fontSize: 12, color: sigMsg.err ? "#DC2626" : "#15803D" }}>{sigMsg.err || sigMsg.ok}</div>}
      </div>
    </div>
  );
}

// (OptionsGroup lived here until 2026-09-11. It drew the coloured full-height bands that
// separated Building / Exterior / Interior on the one long Options page. The groups are the
// tab clusters in SubTabs now — see ssOptionTabs — so the component had no caller left.)

// ─── Tax codes (Settings → Company → Tax) ───
// Which Avalara tax code each building style and option heading falls under (migration 246,
// 2026-09-17). The owner's ask (2026-09-14): every product, installation and delivery carries a
// code, and each builder codes their own "so they're not coming back to us and saying, oh, it's
// not correct". The screen is Ahsan's design, which the owner preferred: one row per code, each a
// code picker plus a multi-select of everything that code covers.
//
// Four things about it are deliberate:
//   • SAVED, NOT USED. No quote, PDF, acceptance, QuickBooks push or change order reads the
//     mapping yet — per-line tax by code is a later stage. The note under the explainer says so in
//     every state, and nothing on this card may suggest that a code changes today's tax.
//   • ONE CODE PER THING. tax_code_assignments' primary key holds one code per style or heading,
//     and the server refuses a payload naming a target twice. So ticking something another row
//     covers MOVES it, and the checkbox names the code it sits under before you tick.
//   • A ROW WITHOUT A CODE IS NOT SAVED. An empty tenant starts on three suggested rows
//     (Products, Services, Delivery) with their targets ticked and NO code: a code chosen for the
//     builder would be tax advice. What a codeless row covers stays "Not assigned" until it has
//     one, and the save sends only rows with a code and something ticked.
//   • THE SERVER'S ANSWER IS THE STATE. tax_codes_save replaces the whole set and answers with what
//     the database now holds, so the rows are rebuilt from that answer. Codeless rows the builder
//     is still filling in are kept, minus anything the save covered.
// The styles, headings and heading groups all come from tax_codes_get. The heading keys live in
// _shared/taxCodes.ts only: the QuickBooks item map kept its line kinds in three places, and one
// of the three drifted.

const taxTargetId = (type, key) => `${type}:${key}`;
const taxTargetOf = (id) => {
  const i = id.indexOf(":");
  return { type: id.slice(0, i), key: id.slice(i + 1) };
};

// Every target a tax_codes_get answer offers, in display order: the styles, then the headings.
// The styles' group is "buildings", a key no heading group uses.
function taxTargetsOf(d) {
  return [
    ...((d && d.styles) || []).map((s) => ({ id: taxTargetId("style", s.id), group: "buildings", label: s.label || "Unnamed style", inactive: s.active === false })),
    ...((d && d.headings) || []).map((h) => ({ id: taxTargetId("heading", h.key), group: h.group, label: h.label })),
  ];
}

// The checklist's sections: Buildings, then the heading groups in the server's order. A heading
// whose group the answer does not name still gets a section rather than vanishing.
function taxGroupsOf(d) {
  const named = (d && d.headingGroups) || [];
  const seen = new Set(named.map((g) => g.key));
  const extra = [];
  for (const h of (d && d.headings) || []) {
    if (!seen.has(h.group)) { seen.add(h.group); extra.push({ key: h.group, label: h.group }); }
  }
  return [{ key: "buildings", label: "Buildings" }, ...named, ...extra];
}

// The stored mapping as rows: one per code, in the order tax_codes_get lists its codes (the
// common codes first), each row's targets in display order.
function taxSavedRows(d) {
  const rank = new Map(((d && d.codes) || []).map((c, i) => [c.code, i]));
  const byCode = new Map();
  for (const a of (d && d.assignments) || []) {
    if (!byCode.has(a.code)) byCode.set(a.code, new Set());
    byCode.get(a.code).add(taxTargetId(a.targetType, a.targetKey));
  }
  const order = taxTargetsOf(d).map((t) => t.id);
  const at = (code) => (rank.has(code) ? rank.get(code) : Number.MAX_SAFE_INTEGER);
  return [...byCode.keys()]
    .sort((a, b) => at(a) - at(b) || (a < b ? -1 : a > b ? 1 : 0))
    .map((code) => ({ code, targets: order.filter((id) => byCode.get(code).has(id)) }));
}

// Where an empty tenant starts: the owner's three groups, ticked, with no code. The group keys
// are _shared/taxCodes.ts TAX_HEADING_GROUPS'. A key renamed there only leaves a suggestion
// unticked; the save validates every heading key server-side either way.
function taxSuggestedRows(d) {
  const targets = taxTargetsOf(d);
  const inGroups = (groups) => targets.filter((t) => groups.indexOf(t.group) !== -1).map((t) => t.id);
  return [
    { title: "Products", code: "", targets: inGroups(["buildings", "building", "exterior", "interior", "other"]) },
    { title: "Services", code: "", targets: inGroups(["services"]) },
    { title: "Delivery", code: "", targets: inGroups(["delivery"]) },
  ];
}

// target id → code, over the rows a save would send (a codeless row covers nothing yet).
function taxCoverage(rows) {
  const m = new Map();
  for (const r of rows) {
    if (!r.code) continue;
    for (const id of r.targets) m.set(id, r.code);
  }
  return m;
}
const taxSameCoverage = (a, b) => a.size === b.size && [...a].every(([id, code]) => b.get(id) === code);

// A portal-settings older than this page has no tax code actions: resolveTenant answers 403
// "Unrecognised action" (no GATES line), the dispatcher 400 "Unknown action". The frontend deploys
// on push and functions deploy separately, so that window reads "not here yet", not a fault. Any
// OTHER 403 is a real refusal and shows its sentence — unlike ssTaxReadUnavailable, which treats
// every 403 as "nothing to show" because its callers render no tax text at all on one.
function taxCodesUnavailable(err) {
  if (!err || (err.ssStatus !== 403 && err.ssStatus !== 400)) return false;
  return /Unrecogni[sz]ed action|^Unknown action\b/i.test(String(err.message || ""));
}

// One row's code picker: the chosen code with a Change button, or a type-ahead over
// tax_codes_search — debounced 300ms while typing, at once for an empty box, which lists the
// common codes first with their hints. The search reads the stored catalog; nothing here reaches
// Avalara.
function TaxCodePicker({ code, info, onPick, disabled = false }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  // The latest answer, with the (trimmed) text it answers: { q, codes, err }; null before the first.
  const [answer, setAnswer] = useState(null);
  const [hi, setHi] = useState(0);             // the highlighted option, for the arrow keys
  const seq = useRef(0);
  const inputRef = useRef(null);
  const searching = open || !code;
  useEffect(() => {
    if (!open) return undefined;
    const my = ++seq.current;
    const asked = q.trim();
    const t = setTimeout(async () => {
      const { data, error } = await sb.functions.invoke("portal-settings", { body: { action: "tax_codes_search", q } });
      // Latest search wins: a slow answer for "FR" must not replace the one for "FR01".
      if (my !== seq.current) return;
      if (error || !data || data.error) {
        setAnswer({ q: asked, codes: [], err: (data && data.error) || (error && error.message) || "Couldn't search the tax codes." });
        return;
      }
      setAnswer({ q: asked, codes: data.codes || [], err: null });
      setHi(0);
    }, asked ? 300 : 0);
    return () => clearTimeout(t);
  }, [open, q]);
  // Only an answer to what is in the box now counts. The previous answer stays in state through
  // the debounce and the round trip, and Enter on it would pick a code the builder never searched
  // for: the empty box's P0000000 still highlighted while "FR010200" waits. Until the answer
  // catches up the list reads "Searching…", so nothing stale can be picked, clicked or counted.
  const fresh = !!answer && answer.q === q.trim();
  const list = fresh ? answer.codes : null;
  const err = fresh ? answer.err : null;
  // "Change" swaps the chosen code for the search box; the box should take the typing at once.
  useEffect(() => { if (open && inputRef.current) inputRef.current.focus(); }, [open]);

  const pick = (c) => {
    if (!c) return;
    onPick(c);
    setQ("");
    setOpen(false);
  };
  const onKey = (e) => {
    const n = (list || []).length;
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); if (n) setHi((h) => (h + 1) % n); }
    else if (e.key === "ArrowUp") { e.preventDefault(); if (n) setHi((h) => (h - 1 + n) % n); }
    else if (e.key === "Enter") { if (open && n) { e.preventDefault(); pick(list[Math.min(hi, n - 1)]); } }
    else if (e.key === "Escape") { e.currentTarget.blur(); }
  };
  const linkBtn = { background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit", fontSize: 12.5, color: ACCENT, fontWeight: 700 };
  const note = { padding: "9px 11px", fontSize: 12.5, color: "#64748B" };
  const head = { padding: "7px 11px 3px", fontSize: 10.5, fontWeight: 800, letterSpacing: 0.5, textTransform: "uppercase", color: "#94A3B8" };
  const empty = !q.trim();
  return (
    <div style={{ position: "relative", maxWidth: 640 }}>
      {!searching ? (
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10, border: "1px solid #CBD5E1", borderRadius: 8, padding: "8px 11px", background: "#F8FAFC" }}>
          <div style={{ flex: 1, minWidth: 0, fontSize: 13, color: "#1E293B", lineHeight: 1.4 }}>
            <strong style={{ fontVariantNumeric: "tabular-nums" }}>{code}</strong>
            {info && info.description ? <span> — {info.description}</span> : null}
            {info && info.hint && <div style={{ fontSize: 11.5, color: "#64748B", marginTop: 2 }}>{info.hint}</div>}
          </div>
          {/* Hidden, not disabled, while the card saves: the Save button's "Saving…" is the reason. */}
          {!disabled && <button type="button" onClick={() => setOpen(true)} style={linkBtn}>Change</button>}
        </div>
      ) : (
        <input ref={inputRef} style={S.input} value={q} disabled={disabled}
          placeholder={code ? `Replace ${code} — search by code or words` : "Pick a code — search by code or words, e.g. delivery or FR01"}
          aria-label="Search tax codes" role="combobox" aria-expanded={open} aria-autocomplete="list"
          onFocus={() => setOpen(true)}
          onBlur={() => { setOpen(false); setQ(""); }}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onKeyDown={onKey} />
      )}
      {searching && open && (
        // mousedown is swallowed so a click on an option (or the list's scrollbar) does not blur
        // the box and close the list before the click lands.
        <div role="listbox" onMouseDown={(e) => e.preventDefault()}
          style={{ position: "absolute", zIndex: 30, left: 0, right: 0, top: "calc(100% + 4px)", background: "#FFF", border: "1px solid #CBD5E1", borderRadius: 8, boxShadow: "0 10px 28px rgba(15,23,42,0.14)", maxHeight: 320, overflowY: "auto" }}>
          {err && <div style={{ ...note, color: "#B91C1C" }}>{err}</div>}
          {list === null && !err && <div style={note}>Searching…</div>}
          {list && list.length === 0 && !err && <div style={note}>No active tax codes match “{q.trim()}”.</div>}
          {(list || []).map((c, i) => (
            <React.Fragment key={c.code}>
              {empty && i === 0 && c.hint && <div style={head}>Common codes</div>}
              {empty && i > 0 && !c.hint && list[i - 1].hint && <div style={{ ...head, borderTop: "1px solid #E2E8F0" }}>More codes</div>}
              <button type="button" role="option" aria-selected={i === hi}
                onMouseEnter={() => setHi(i)} onClick={() => pick(c)}
                style={{ display: "block", width: "100%", textAlign: "left", fontFamily: "inherit", cursor: "pointer", border: "none", background: i === hi ? "#F1F5F9" : "#FFF", padding: "8px 11px" }}>
                <div style={{ fontSize: 13, color: "#1E293B", lineHeight: 1.35 }}>
                  <strong style={{ fontVariantNumeric: "tabular-nums" }}>{c.code}</strong> — {c.description || "No description"}
                </div>
                {c.hint && <div style={{ fontSize: 11.5, color: "#64748B", marginTop: 2 }}>{c.hint}</div>}
              </button>
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

function TaxCodesCard({ canReadTax = false, canEditTax = false }) {
  const [data, setData] = useState(null);       // tax_codes_get answer | { err, unavailable } | null while loading
  const [rows, setRows] = useState([]);         // the editor's working copy: [{ rid, title, code, targets: [id] }]
  const [codeInfo, setCodeInfo] = useState({}); // code → { code, description, typeId, isActive, hint }
  const [openRid, setOpenRid] = useState(null); // the row whose checklist is open
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);         // { ok } | { err }
  const ridSeq = useRef(0);
  // Latest load wins, the LocationsCard rule: a slow first answer must not land over a retry's.
  const loadSeq = useRef(0);
  const withRids = (list) => list.map((r) => ({ title: null, ...r, rid: ++ridSeq.current }));
  const learnCodes = (codes) => setCodeInfo((cur) => {
    const next = { ...cur };
    for (const c of codes || []) {
      if (c && c.code) next[c.code] = c;
    }
    return next;
  });

  const load = useCallback(async () => {
    if (!canReadTax) return;
    const seq = ++loadSeq.current;
    const { data: d, error } = await sb.functions.invoke("portal-settings", { body: { action: "tax_codes_get" } });
    if (seq !== loadSeq.current) return;
    // The invoke wrapper has already swapped a refusal's generic "non-2xx" for the server's sentence.
    if (error || !d || d.error) {
      setData({ err: (d && d.error) || (error && error.message) || "Couldn't load your tax codes.", unavailable: taxCodesUnavailable(error) });
      return;
    }
    learnCodes(d.codes);
    const saved = taxSavedRows(d);
    setRows(withRids(saved.length ? saved : taxSuggestedRows(d)));
    setOpenRid(null);
    setData(d);
  }, [canReadTax]);
  useEffect(() => { load(); }, [load]);

  const d = data && !data.err ? data : null;
  const targets = useMemo(() => taxTargetsOf(d), [d]);
  const groups = useMemo(() => taxGroupsOf(d), [d]);
  const savedRows = useMemo(() => (d ? taxSavedRows(d) : []), [d]);
  const savedCoverage = useMemo(() => taxCoverage(savedRows), [savedRows]);
  const coverage = taxCoverage(rows);
  const editing = !!d && canEditTax;
  // A reader sees what is STORED, never the suggested rows: those are an editor's starting point,
  // and to someone who cannot change them they would read as codes the business had chosen.
  const shownCoverage = editing ? coverage : savedCoverage;
  const dirty = editing && !taxSameCoverage(coverage, savedCoverage);
  const unassigned = targets.filter((t) => !shownCoverage.has(t.id));
  const codeless = editing && rows.some((r) => !r.code && r.targets.length > 0);

  // Tick moves the targets into this row (out of any other); untick takes them out of this row.
  const toggleTargets = (rid, ids, on) => {
    setMsg(null);
    const order = targets.map((t) => t.id);
    setRows((rs) => rs.map((r) => {
      if (r.rid === rid) {
        const have = new Set(r.targets);
        for (const id of ids) {
          if (on) have.add(id);
          else have.delete(id);
        }
        return { ...r, targets: order.filter((id) => have.has(id)) };
      }
      return on ? { ...r, targets: r.targets.filter((id) => ids.indexOf(id) === -1) } : r;
    }));
  };
  const pickCode = (rid, c) => {
    setMsg(null);
    learnCodes([c]);
    setRows((rs) => rs.map((r) => (r.rid === rid ? { ...r, code: c.code } : r)));
  };
  const addRow = () => {
    setMsg(null);
    const [r] = withRids([{ code: "", targets: [] }]);
    setRows((rs) => [...rs, r]);
    setOpenRid(r.rid);
  };
  const removeRow = (rid) => {
    setMsg(null);
    setRows((rs) => rs.filter((r) => r.rid !== rid));
    setOpenRid((o) => (o === rid ? null : o));
  };

  const save = async () => {
    // tax_codes_save REPLACES the whole set, so a codeless row is dropped from the payload. That is
    // harmless for a suggested row nobody has coded yet, but an item MOVED into it from a saved row
    // would have its saved code deleted without a word. Refuse only that case: a codeless row
    // holding something that already has a code on the server.
    const saved = data && !data.err ? taxCoverage(taxSavedRows(data)) : new Map();
    const orphaned = rows.filter((r) => !r.code && r.targets.some((id) => saved.has(id)));
    if (orphaned.length) {
      setMsg({ err: "Some items that already have a tax code are now in a row with no code. Pick a code for that row, or move those items back, then save." });
      return;
    }
    const send = rows.filter((r) => r.code && r.targets.length > 0)
      .map((r) => ({ code: r.code, targets: r.targets.map(taxTargetOf) }));
    setBusy(true); setMsg(null);
    const { data: res, error } = await sb.functions.invoke("portal-settings", { body: { action: "tax_codes_save", rows: send } });
    setBusy(false);
    if (error || !res || res.error || !Array.isArray(res.assignments)) {
      setMsg({ err: (res && res.error) || (error && error.message) || "Couldn't save your tax codes." });
      return;
    }
    learnCodes(res.codes);
    const stored = taxSavedRows(res);
    const covered = taxCoverage(stored);
    // A suggested row's title follows its code into the rebuilt list.
    const titleOf = new Map(rows.filter((r) => r.code && r.title).map((r) => [r.code, r.title]));
    // Codeless rows were not sent. Keep them, minus whatever the save now covers, and drop one that
    // covered something and has nothing left (a freshly added, still-empty row stays).
    const pending = [];
    for (const r of rows) {
      if (r.code) continue;
      const left = r.targets.filter((id) => !covered.has(id));
      if (left.length || !r.targets.length) pending.push({ ...r, targets: left });
    }
    setRows([...withRids(stored.map((r) => ({ ...r, title: titleOf.get(r.code) || null }))), ...pending]);
    setOpenRid(null);
    setData(res);
    const total = taxTargetsOf(res).length;
    setMsg({ ok: `Tax codes saved — ${covered.size} of your ${total} building styles and option headings ${covered.size === 1 ? "has" : "have"} a code.` });
  };

  const lbl = { fontSize: 10.5, fontWeight: 800, letterSpacing: 0.5, textTransform: "uppercase", color: "#94A3B8" };
  const linkBtn = { background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit", fontSize: 12.5, color: ACCENT, fontWeight: 700 };
  const chipStyle = { background: "#EEF2FF", color: "#3D3672", borderRadius: 12, fontSize: 11.5, fontWeight: 700, padding: "3px 9px" };
  const checkRow = { display: "flex", alignItems: "flex-start", gap: 7, fontSize: 12.5, fontWeight: 600, color: "#1E293B", marginTop: 6, cursor: "pointer", lineHeight: 1.35 };
  // Something another row already covers reads dimmed — the greyed convention the Projects
  // screen uses. It is NOT disabled: under ONE CODE PER THING, ticking it MOVES the target to
  // this row, and that is the only one-click way to re-assign one. Colour and title only.
  const checkRowTaken = { ...checkRow, color: "#94A3B8" };
  const warn = !!d && (d.ssMode !== true || d.lookupEnabled !== true);
  // What a row covers, as chips. A whole group collapses to one chip, so a Products row reads
  // "All buildings (9) · Exterior (all 5)" rather than twenty names.
  const chipsFor = (ids) => {
    const have = new Set(ids);
    const out = [];
    for (const g of groups) {
      const inGroup = targets.filter((t) => t.group === g.key);
      const mine = inGroup.filter((t) => have.has(t.id));
      if (!mine.length) continue;
      if (inGroup.length > 1 && mine.length === inGroup.length) {
        out.push({ key: "all:" + g.key, text: g.key === "buildings" ? `All buildings (${inGroup.length})` : `${g.label} (all ${inGroup.length})` });
      } else {
        for (const t of mine) out.push({ key: t.id, text: t.label });
      }
    }
    return out;
  };
  const chipList = (ids) => {
    const chips = chipsFor(ids);
    return chips.length
      ? chips.map((c) => <span key={c.key} style={chipStyle}>{c.text}</span>)
      : <span style={{ fontSize: 12.5, color: "#94A3B8" }}>Nothing yet</span>;
  };

  return (
    <div style={S.card}>
      <div style={S.h2}>Tax codes</div>
      <div style={{ fontSize: 12.5, color: "#64748B", marginBottom: 12, lineHeight: 1.5, maxWidth: 780 }}>
        Every building, option and service you sell falls under a tax code from Avalara's list. Pick a code, then tick
        everything that code covers — each building style and option heading takes one code. You (or your accountant)
        choose the codes, so they match how you file. The notes beside common codes are suggestions, not tax advice.
        {/* Said up front rather than left to missing buttons, as on the location rates. */}
        {d && !canEditTax && " Only someone who can edit CRM Connection settings can change these codes."}
      </div>
      {/* Every state gets the note, because in none of them does a code change a quote yet. It is
          the amber warning when this account is not on per-line-ready tax at all (CRM mode, or
          verified lookups off) and a plain note otherwise. */}
      {d && (
        <div data-tax-note="" style={warn
          ? { background: "#FFFBEB", border: "1px solid #FDE68A", color: "#92400E", borderRadius: 8, padding: "9px 12px", fontSize: 12.5, fontWeight: 600, lineHeight: 1.55, marginBottom: 14, maxWidth: 780 }
          : { background: "#F8FAFC", border: "1px solid #E2E8F0", color: "#475569", borderRadius: 8, padding: "9px 12px", fontSize: 12.5, fontWeight: 500, lineHeight: 1.55, marginBottom: 14, maxWidth: 780 }}>
          These codes are saved now and will be used when per-line tax with Avalara is switched on for your account.
          Until then they don't change the tax on any quote.
        </div>
      )}

      {!canReadTax && <p style={{ fontSize: 13, color: "#64748B" }}>Only someone who can view CRM Connection settings can see your tax codes.</p>}
      {canReadTax && !data && <p style={{ fontSize: 13, color: "#64748B" }}>Loading…</p>}
      {data && data.err && data.unavailable && (
        <p style={{ fontSize: 13, color: "#64748B" }}>Tax codes aren't available on your account yet — check back soon.</p>
      )}
      {data && data.err && !data.unavailable && (
        <div style={S.err}>
          {data.err}{" "}
          <button type="button" onClick={() => { setData(null); load(); }} style={{ ...linkBtn, color: "#B91C1C", textDecoration: "underline" }}>Try again</button>
        </div>
      )}

      {/* ── The editor: one row per code ── */}
      {editing && rows.map((r, i) => {
        const info = r.code ? codeInfo[r.code] : null;
        const open = openRid === r.rid;
        return (
          <div key={r.rid} data-tax-row={i} style={{ border: "1px solid #E2E8F0", borderRadius: 10, padding: "12px 14px", marginBottom: 10, background: "#FFF" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
              <span style={lbl}>{r.title || "Tax code"}</span>
              {!r.code && (
                <span style={{ background: "#FFFBEB", border: "1px solid #FDE68A", color: "#92400E", borderRadius: 12, fontSize: 11, fontWeight: 700, padding: "1px 8px" }}>Pick a code</span>
              )}
              {/* Hidden while the card saves, like every row control: the answer rebuilds the rows. */}
              {!busy && <button type="button" onClick={() => removeRow(r.rid)} style={{ ...linkBtn, color: "#94A3B8", marginLeft: "auto" }}>Remove</button>}
            </div>
            <TaxCodePicker code={r.code} info={info} disabled={busy} onPick={(c) => pickCode(r.rid, c)} />
            {info && info.isActive === false && (
              <div style={{ fontSize: 12, color: "#B45309", fontWeight: 600, marginTop: 6 }}>
                Avalara no longer lists {r.code} as active, so this row can't be saved with it — pick another code.
              </div>
            )}
            <div style={{ marginTop: 10 }}>
              <span style={lbl}>Covers</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 5, alignItems: "center" }}>
                {chipList(r.targets)}
                {!busy && (
                  <button type="button" onClick={() => setOpenRid(open ? null : r.rid)} aria-expanded={open} style={{ ...linkBtn, marginLeft: 4 }}>
                    {open ? "Done" : "Change what it covers"}
                  </button>
                )}
              </div>
            </div>
            {open && !busy && (
              <div style={{ marginTop: 10, background: "#F8FAFC", border: "1px dashed #CBD5E1", borderRadius: 10, padding: "11px 12px", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: "12px 18px" }}>
                {groups.map((g) => {
                  const inGroup = targets.filter((t) => t.group === g.key);
                  if (g.key !== "buildings" && !inGroup.length) return null;
                  const allOn = inGroup.length > 0 && inGroup.every((t) => r.targets.indexOf(t.id) !== -1);
                  return (
                    <div key={g.key}>
                      <div style={lbl}>{g.label}</div>
                      {g.key === "buildings" && (inGroup.length ? (
                        <label style={checkRow}>
                          <input type="checkbox" checked={allOn} onChange={(e) => toggleTargets(r.rid, inGroup.map((t) => t.id), e.target.checked)} />
                          <span>All buildings</span>
                        </label>
                      ) : (
                        <div style={{ fontSize: 12, color: "#94A3B8", marginTop: 6 }}>No building styles yet — add them under Structures.</div>
                      ))}
                      {inGroup.map((t) => {
                        const mine = r.targets.indexOf(t.id) !== -1;
                        const other = mine ? null : rows.find((o) => o.rid !== r.rid && o.targets.indexOf(t.id) !== -1);
                        return (
                          <label key={t.id} style={other ? checkRowTaken : checkRow}
                            title={other ? `Currently under ${other.code || "a row with no code yet"}. Ticking this moves it here.` : undefined}>
                            <input type="checkbox" checked={mine} onChange={(e) => toggleTargets(r.rid, [t.id], e.target.checked)} />
                            <span>
                              {t.label}
                              {t.inactive && <span style={{ color: "#94A3B8", fontWeight: 500 }}> · not offered right now</span>}
                              {other && <span style={{ color: "#B45309", fontWeight: 500 }}> · under {other.code || "a row with no code yet"}</span>}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {/* ── Read-only: the stored mapping, no controls ── */}
      {d && !editing && (savedRows.length ? savedRows.map((r) => {
        const info = codeInfo[r.code];
        return (
          <div key={r.code} data-tax-row="" style={{ border: "1px solid #E2E8F0", borderRadius: 10, padding: "12px 14px", marginBottom: 10 }}>
            <div style={{ fontSize: 13, color: "#1E293B", lineHeight: 1.4 }}>
              <strong style={{ fontVariantNumeric: "tabular-nums" }}>{r.code}</strong>
              {info && info.description ? <span> — {info.description}</span> : null}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>{chipList(r.targets)}</div>
          </div>
        );
      }) : <p style={{ fontSize: 13, color: "#64748B" }}>No tax codes have been chosen yet.</p>)}

      {d && (
        <div data-tax-unassigned="" style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid #F1F5F9" }}>
          <span style={lbl}>Not assigned</span>
          {unassigned.length === 0 ? (
            <div style={{ fontSize: 12.5, color: "#15803D", fontWeight: 600, marginTop: 5 }}>Every building style and option heading has a code.</div>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 5 }}>
              {unassigned.map((t) => (
                <span key={t.id} style={{ background: "#F1F5F9", color: "#475569", borderRadius: 12, fontSize: 11.5, fontWeight: 700, padding: "3px 9px" }}>{t.label}</span>
              ))}
            </div>
          )}
          {codeless && unassigned.length > 0 && (
            <div style={{ fontSize: 11.5, color: "#94A3B8", marginTop: 6 }}>A row marked “Pick a code” isn't saved until it has one, so what it covers is listed here.</div>
          )}
        </div>
      )}

      {editing && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 14 }}>
          <button type="button" onClick={addRow} disabled={busy} style={S.btn("#F1F5F9", "#334155")}>+ Add tax code</button>
          <button type="button" onClick={save} disabled={busy || !dirty} style={S.btn(dirty ? ACCENT : "#CBD5E1", "#FFF")}>
            {busy ? "Saving…" : "Save tax codes"}
          </button>
          {/* A disabled Save says why beside it. */}
          {!busy && <span style={{ fontSize: 12, color: "#64748B" }}>{dirty ? "Unsaved changes" : "No changes to save"}</span>}
        </div>
      )}
      {msg && msg.ok && <div style={{ ...S.okMsg, marginTop: 12, marginBottom: 0 }}>{msg.ok}</div>}
      {msg && msg.err && <div style={{ ...S.err, marginTop: 12, marginBottom: 0 }}>{msg.err}</div>}

      {d && d.catalog && (
        <div style={{ fontSize: 11.5, color: "#94A3B8", marginTop: 12 }}>
          {d.catalog.syncedAt
            ? `The codes come from Avalara's list: ${Number(d.catalog.count || 0).toLocaleString("en-US")} codes, last updated ${new Date(d.catalog.syncedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}.`
            : "Only Avalara's common codes are listed until CSM Synergy loads the full list."}
        </div>
      )}
    </div>
  );
}

// ── Company: one rail item, six tabs ─────────────────────────────────────────────────────
// Carolyn 2026-09-11: "I want to create some top navigation inside company. The first tab is
// business details, next branding, then we want team, then Locations and move the locations
// from Team to that tab, then next is Crews and move the crews there, then Drivers with
// delivery territories and drivers."
//
// So Branding and Team stopped being rail items, and Team gave up three of the four cards it
// was carrying: Locations, Crews and Drivers each became a tab. What is left under Team is
// the people-and-rates grid, which is what the name always meant.
//
// The bar is the underline strip Settings itself used to wear before the rail replaced it —
// kept here because within ONE page it is a sub-navigation, which is exactly what it is good
// at, and dropped from Settings because across fourteen pages it was a wall.
// The underline strip Settings itself used to wear before the rail replaced it. Kept, and now
// shared by both hubs: within ONE page it is a sub-navigation, which is what it is good at;
// across fourteen pages it was a wall, which is why the rail exists.
function SubTabs({ tabs, sub, onSub }) {
  const active = tabs.find((t) => t[0] === sub) || tabs[0];
  // GROUPED when the tabs carry a 4th element, flat when they do not — Company, Colors and
  // Billing pass three-element tuples and render exactly as before. The clustering rule is the
  // one the rail uses for its own groups (settingsGroups in 12-shell.jsx): start a new run
  // whenever the group CHANGES, and label it only when it is non-null. One rule, one shape,
  // two renderers — a second rule here would drift from the rail's the first time either moved.
  const groups = [];
  tabs.forEach((t) => {
    const last = groups[groups.length - 1];
    if (!last || last.group !== (t[3] || null)) groups.push({ group: t[3] || null, items: [t] });
    else last.items.push(t);
  });
  const tab = ([id, label]) => (
    <button key={id} type="button" onClick={() => onSub(id)}
      aria-current={sub === id ? "page" : undefined}
      style={{
        background: "none", border: "none", cursor: "pointer", fontFamily: "inherit",
        padding: "12px 14px 10px", fontSize: 13, fontWeight: 700, letterSpacing: 0.2,
        color: sub === id ? ACCENT : "#64748B",
        borderBottom: sub === id ? `2px solid ${ACCENT}` : "2px solid transparent",
        marginBottom: -2,
      }}>
      {label}
    </button>
  );
  const labelled = groups.some((g) => g.group);
  return (<>
    {/* One shared bottom rule under the whole bar either way, so the active tab's underline
        still reads as part of a single strip rather than of its own cluster. */}
    <div style={{ display: "flex", gap: labelled ? 22 : 2, flexWrap: "wrap", alignItems: "flex-end", borderBottom: "2px solid #E2E8F0", marginBottom: 14 }}>
      {groups.map((g) => (
        <div key={g.items[0][0]} style={{ display: "flex", flexDirection: "column" }}>
          {g.group && (
            <div style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: "0.13em", textTransform: "uppercase", color: "#94A3B8", padding: "2px 2px 0", whiteSpace: "nowrap" }}>{g.group}</div>
          )}
          <div style={{ display: "flex", gap: 2, flexWrap: "wrap" }}>{g.items.map(tab)}</div>
        </div>
      ))}
    </div>
    <div style={{ fontSize: 12, color: "#64748B", margin: "0 0 12px 2px", fontWeight: 600 }}>{active[1]} — {active[2]}</div>
  </>);
}

// ── Options: one rail item, nine tabs in three groups ────────────────────────────────────
// ⚠️ NINE SEPARATE MOUNTS here, unlike ColorsShell and BillingShell. Those two hand a `section`
// prop to ONE component because their tabs share a single fetch and a single unsaved-edit
// buffer, and remounting would throw someone's typing away. These nine are independent
// components with independent loads, so mounting only the visible one is both correct and a
// real improvement: opening Options used to fire all nine cards' reads before you had looked
// at anything.
function OptionsShell({ sub: rawSub, onSub, tabs, clientId, viewingLabel = null }) {
  const sub = tabs.some((t) => t[0] === rawSub) ? rawSub : tabs[0][0];
  const p = { viewingLabel, clientId };
  return (
    <div>
      <SubTabs tabs={tabs} sub={sub} onSub={onSub} />
      {sub === "options" && <WallHeights {...p} />}
      {sub === "doors" && <DoorsView {...p} />}
      {sub === "windows" && <WindowsView {...p} />}
      {sub === "vents" && <VentsView {...p} />}
      {sub === "ramps" && <RampsView {...p} />}
      {sub === "cladding" && <CladdingView {...p} />}
      {sub === "interior" && <LayoutPricing {...p} />}
      {sub === "electrical" && <Electrical {...p} />}
      {sub === "insulation" && <Insulation {...p} />}
      {sub === "delivery" && <DeliveryView {...p} />}
      {sub === "foundation" && <Foundation {...p} />}
    </div>
  );
}

// ── Colors: one rail item, three tabs ────────────────────────────────────────────────────
// ⚠️ ONE <ColorsView>, with the section as a PROP. Not three mounts behind {sub === ...}
// branches: the component holds every category in one unsaved-edit buffer and saves the lot,
// so remounting on a tab switch would discard edits without a word. Same element, same
// position, so React keeps the instance.
function ColorsShell({ sub: rawSub, onSub, tabs, viewingLabel = null }) {
  const sub = tabs.some((t) => t[0] === rawSub) ? rawSub : tabs[0][0];
  const section = sub === "shingles" ? "shingle" : sub === "metal" ? "metal" : "paint";
  return (
    <div>
      <SubTabs tabs={tabs} sub={sub} onSub={onSub} />
      <ColorsView viewingLabel={viewingLabel} section={section} />
    </div>
  );
}

// ── Billing: one rail item, two tabs ─────────────────────────────────────────────────────
// ⚠️ ONE <BillingView>, section as a PROP — see the note on that component. Its single status
// call carries the plans, the subscriptions AND the wallet, so three of anything here would
// be two wasted round trips and a tab switch that re-fetched for nothing.
function BillingShell({ sub: rawSub, onSub, tabs, viewingLabel = null }) {
  const sub = tabs.some((t) => t[0] === rawSub) ? rawSub : tabs[0][0];
  return (
    <div>
      <SubTabs tabs={tabs} sub={sub} onSub={onSub} />
      <BillingView viewingLabel={viewingLabel} section={sub === "wallet" ? "wallet" : "subscription"} />
    </div>
  );
}

function CompanyShell({ sub: rawSub, onSub, tabs, clientId, viewingLabel = null, canReadTax = false, canEditTax = false, view3d = false }) {
  // Same clamp SettingsShell runs, for the same reason and one more. A person granted only
  // settings_team has no Business Details tab, so the rail's Company link cannot be the
  // `company` slug for them — it points at their first visible tab instead (see 12-shell).
  // This is the belt to that braces: an unclamped `company` would match no branch below and
  // render an empty page under a caption that confidently named a different tab.
  const sub = tabs.some((t) => t[0] === rawSub) ? rawSub : tabs[0][0];
  return (
    <div>
      <SubTabs tabs={tabs} sub={sub} onSub={onSub} />
      {/* Business Details and Branding are the SAME component in two sections. Its form state
          covers every field whichever section renders and its save is global, so the two tabs
          cannot save half a form between them — see the note at the top of SettingsView. */}
      {/* Building serial numbers ride with Business Details (Carolyn 2026-09-11). They are a
          shop-wide counter, not a property of any one lot, which is why they left Locations. */}
      {/* view3d: Business Details shows the four-corner quote switch only where 3D is unlocked. */}
      {sub === "company" && (<><SettingsView section="company" view3d={view3d} /><SerialNumbersCard /></>)}
      {sub === "branding" && (<><ShareLinkCard clientId={clientId} /><SettingsView section="branding" /></>)}
      {sub === "team" && <CommissionTeam viewingLabel={viewingLabel} />}
      {sub === "commissions" && <CommissionStructure clientId={clientId} />}
      {/* The tab and its lots ride on the team/branding areas; the tax rates on it are settings_crm. See LocationsCard. */}
      {sub === "locations" && <LocationsCard canReadTax={canReadTax} canEditTax={canEditTax} />}
      {/* Crews and Drivers are two sections of one component — it holds them together because
          they arrive in one call and reference each other. The tabs only exist when the
          scheduling entitlement is on (ssCompanyTabs), which is the gate they had in Team. */}
      {sub === "crews" && <DriversTerritoriesCard section="crews" />}
      {sub === "drivers" && <DriversTerritoriesCard section="drivers" />}
      {/* The whole tab is settings_crm (SETTINGS_TAB_AREA.tax), so reading is already implied by
          the tab being here; editing is passed separately, the same pair LocationsCard gets. */}
      {sub === "tax" && <TaxCodesCard canReadTax={canReadTax} canEditTax={canEditTax} />}
    </div>
  );
}

function SettingsShell({ clientId, viewingLabel = null, sub: subProp = null, onSub = null, isOwner = false, isAdmin = false, schedUnlocked = false, qboUnlocked = false, rtpUnlocked = false, access = null, setup3d = null, view3d = false, canBill = false, advanced = null, prefs = null, onPrefsSaved = null, profile = null, profileEmail = null, onProfileSaved = null, phoneOffered = false }) {
  const [subState, setSubState] = useState("structures");
  const setSub = onSub || setSubState;
  // phoneOffered rides into BOTH lists (this body and the rail in 12-shell.jsx) from the same
  // ssPhoneOffered answer, or the rail would offer a Phone tab the body clamps to Structures.
  const TABS = ssSettingsTabs({ isOwner, isAdmin, access, phoneOffered });
  // Company's six tabs are valid settings slugs too — the clamp below has to know them or
  // /portal/settings/branding, a link people hold, would fall back to Structures.
  const hubs = ssSettingsHubs({ isOwner, isAdmin, access, schedUnlocked });
  // An unknown slug in the URL falls back to the first tab rather than rendering nothing.
  // `|| TABS[0][0]` only catches null/empty — a truthy-but-unknown slug (a typo, or a bookmark to
  // a renamed sub-tab like /portal/settings/color) survived as-is, and since every content branch
  // below is an equality match on a KNOWN slug, nothing rendered: the banner and sub-tab bar
  // appeared, the caption claimed "Structures — Building styles, sizes and base prices", the body
  // was empty and no tab was underlined. `active` already fell back, so only the label was right.
  // Clamp the slug itself so the fallback is real, and so Dashboard's URL-normalise effect (which
  // compares p.sub against this value) rewrites the bad slug out of the address bar too.
  const rawSub = (onSub ? subProp : subState) || TABS[0][0];
  const knownSub = (x) => TABS.some((t) => t[0] === x) || Object.values(hubs).some((ts) => ts.some((t) => t[0] === x));
  const sub = knownSub(rawSub) ? rawSub : TABS[0][0];
  return (
    <div>
      {/* NO banner and NO tab strip here any more (2026-09-11). The fourteen sub-pages ARE
          the left rail now, and the topbar names the one you are on — so this component is
          purely the body of the selected sub-page.

          Three things used to say "Settings" on this screen at once: the topbar, a gradient
          banner repeating it word for word, and a caption line under the tabs. The rail
          replaced the tabs, the topbar absorbed the caption, and the banner had nothing left
          to add.

          The `active` tuple this component used to hold went with the caption. The topbar
          derives its own from the SAME list and the SAME clamp — see settingsTabs/settingsSub
          in 12-shell.jsx, mirrored deliberately so the rail and the body can never disagree
          about which sub-page is open. */}
      {/* Real-Time Pricing renders UNDER the pricing card (Carolyn 2026-08-27: "will you
          build another block down here … underneath here that has the real time pricing in
          it"). The component gates itself on rtpUnlocked — not-entitled renders a compact
          teaser with a Billing deep link, so the block is also the feature's shop window. */}
      {sub === "structures" && (<>
        <PricingCsv viewingLabel={viewingLabel} onGoToOptions={() => setSub("options")} />
        <RealTimePricing viewingLabel={viewingLabel} clientId={clientId} unlocked={rtpUnlocked} canAdmin={isAdmin} onSeeBilling={() => setSub("billing")} />
      </>)}
      {hubs.options.some((t) => t[0] === sub) && (
        <OptionsShell sub={sub} onSub={setSub} tabs={hubs.options} clientId={clientId}
          viewingLabel={viewingLabel} />
      )}
      {hubs.colors.some((t) => t[0] === sub) && (
        <ColorsShell sub={sub} onSub={setSub} tabs={hubs.colors} viewingLabel={viewingLabel} />
      )}
      {/* 3D Style Calibration used to sit at the top of the Designer TAB. It is setup, not
          design work, so it lives here now; the tab itself no longer receives setup3d. */}
      {/* `advanced` is the Advanced mode switch (06-3d.jsx AdvancedModeCard), null where it must not show. */}
      {sub === "designer" && <DesignerSettings clientId={clientId} setup3d={setup3d} view3d={view3d} canBill={canBill} advanced={advanced} />}
      {/* COMPANY is a hub with its own top navigation — six sub-pages behind one rail item.
          Every one of them is still a real /portal/settings/<slug>, so the bookmarks and the
          Client Setup links that point at branding and team are untouched. */}
      {hubs.company.some((t) => t[0] === sub) && (
        <CompanyShell sub={sub} onSub={setSub} tabs={hubs.company} clientId={clientId}
          viewingLabel={viewingLabel} view3d={view3d}
          /* Location tax rates and the Tax tab's codes are settings_crm — the area that owns the
             company rate — not the team/branding areas Locations rides on. Same unclamped reading as ssCompanyTabs: an
             owner/admin, or a null map (a platform operator in view-as, whose rights come
             from app_operators), sees and edits; everyone else by their own map. The server
             refuses regardless, and a refusal shows its own sentence. */
          canReadTax={isAdmin || !access || ssCanRead(access, "settings_crm")}
          canEditTax={isAdmin || !access || ssCanWrite(access, "settings_crm")} />
      )}
      {sub === "connection" && <SettingsView section="connection" />}
      {/* The SECOND mount of QuickBooks. Gating only the top-level tab would leave this one
          open, and /portal/settings/quickbooks is a link people actually have. */}
      {sub === "quickbooks" && (qboUnlocked
        ? <QuickBooksView clientId={clientId} viewingLabel={viewingLabel} />
        : <QuickBooksLocked canAdmin={isAdmin} onSeeBilling={() => setSub("billing")} />)}
      {sub === "email" && <EmailSendingView clientId={clientId} viewingLabel={viewingLabel} />}
      {/* Self-serve carrier registration. canEdit mirrors the server's own split: reading the
          status is contacts-level, but every action that submits or spends is
          settings_billing:'edit'. The component still renders read-only for everyone else
          rather than vanishing — a rep should be able to see that texting is coming. */}
      {sub === "sms" && <SmsMessagingView clientId={clientId} viewingLabel={viewingLabel}
        canEdit={isAdmin || ssCanWrite(access, "settings_billing")} />}
      {/* My Synergy Phone's calling setup (11-sms.jsx). canEdit is phone:'edit' — the same level
          phone_settings_save / phone_status_set / phone_signout_user are gated on — read the
          unclamped way CompanyShell's tax flags are: an owner/admin, or a null map (a platform
          operator in view-as, whose rights come from app_operators). 'own' never writes here:
          phone is not an ownWrites area, so ssCanWrite answers false for it. The server
          refuses regardless. */}
      {sub === "phone" && <PhoneSettingsView clientId={clientId} viewingLabel={viewingLabel}
        canEdit={isAdmin || !access || ssCanWrite(access, "phone")}
        onOpenTexting={() => setSub("sms")} />}
      {hubs.billing.some((t) => t[0] === sub) && (
        <BillingShell sub={sub} onSub={setSub} tabs={hubs.billing} viewingLabel={viewingLabel} />
      )}
      {sub === "myprofile" && <MyProfileSettings prefs={prefs} onSaved={onPrefsSaved}
        profile={profile} email={profileEmail} onProfileSaved={onProfileSaved} />}
    </div>
  );
}

