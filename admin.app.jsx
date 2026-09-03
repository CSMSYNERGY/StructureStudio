const { useState, useEffect, useCallback, useRef } = React;
const { createClient } = window.supabase;

// ─── StructureStudio Operator Admin ───
// Standalone app-creator page (no .jsx twin, like portal.html). Assigns master
// building styles + layout items to each client, and manages the global master
// catalog. Gated by the shared ADMIN_PASSWORD edge-function secret — entered
// here, held only in memory, sent with every admin-catalog call. The anon key
// is used solely to invoke the edge function; ALL data work happens server-side
// (service role) in the admin-catalog function.

const SUPABASE_URL = "https://jzeamjbhdrsbygdnphbm.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp6ZWFtamJoZHJzYnlnZG5waGJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczNDIwNDMsImV4cCI6MjA5MjkxODA0M30.YawJS7aiyTbQdwVnzndyKwD2ejNGYhdBSiectURvxwY";
// SESSION-ISOLATED on purpose. With supabase-js defaults this page shares localStorage with
// portal.html on the same origin, so it silently adopted (and auto-refreshed) whatever portal
// session was signed in and sent THAT user's JWT instead of the anon key. admin-catalog's gate
// is dual-credential, so a signed-in NON-operator then hit the hard 403 that
// `checkAdminAuth` returns for a real-but-unauthorized user and could never reach the password
// path at all — i.e. break-glass was broken in exactly the situation you'd reach for it.
// Also stops `detectSessionInUrl` from consuming an auth fragment that lands on /admin.
// The page's stated model is password-only, no session (see the header above); this makes the
// code match it.
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

// Hide the operator "Email Sender" card for now. Flip to true to restore it — all
// the wiring (connect/disconnect/test + the admin-catalog actions) stays in place.
const SHOW_EMAIL_SENDER = false;

// ── Central error logging → Supabase app_errors (via the log_error RPC). Best-effort:
// never throws, never blocks the UI. Auto-captures uncaught errors + unhandled promise
// rejections, and anything reported explicitly via window.ssLogError(source,msg,code,ctx). ──
const SS_ERR_SOURCE = "admin";
// `severity` is optional and defaults to "error", so every existing call site keeps its
// current meaning. Pass "info" for a REFUSAL — the product correctly declining something
// ("send the invoice first", "that width isn't valid"). Those still get a row, because a
// refusal that fires constantly is a bug in disguise (see migration 140), but they no
// longer sit in the same bucket as things that actually broke.
function ssLogError(source, message, code, context, severity) {
  try {
    const params = new URLSearchParams(location.search);
    fetch(SUPABASE_URL + "/rest/v1/rpc/log_error", {
      method: "POST", keepalive: true,
      headers: { "Content-Type": "application/json", "apikey": SUPABASE_ANON_KEY, "Authorization": "Bearer " + SUPABASE_ANON_KEY },
      body: JSON.stringify({
        p_source: String(source || SS_ERR_SOURCE).slice(0, 100),
        p_message: String(message == null ? "" : (message.message || message)).slice(0, 4000),
        p_code: code == null ? null : String(code).slice(0, 100),
        p_client_id: window.__SS_CLIENT_ID__ || params.get("client") || null,
        p_url: location.href.slice(0, 600),
        p_context: context || null,
        p_severity: severity || "error",
      }),
    }).catch(() => {});
  } catch (_) { /* logging must never break the app */ }
}
window.ssLogError = ssLogError;
window.addEventListener("error", (e) => ssLogError(SS_ERR_SOURCE, (e && e.message) || "window.onerror", e && e.error && e.error.name,
  { stack: e && e.error && e.error.stack ? String(e.error.stack).slice(0, 2000) : null, file: e && e.filename, line: e && e.lineno }));
window.addEventListener("unhandledrejection", (e) => { const r = e && e.reason; ssLogError(SS_ERR_SOURCE, (r && r.message) || String(r), r && r.name,
  { stack: r && r.stack ? String(r.stack).slice(0, 2000) : null }); });

const ACCENT = "#3D3672";  // brand purple
const S = {
  header: { background: "linear-gradient(135deg, #3D3672 0%, #1B7895 100%)", color: "#FFF", padding: "16px 24px", display: "flex", alignItems: "center", gap: 12 },
  badge: { background: ACCENT, borderRadius: 8, width: 38, height: 38, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 15 },
  wrap: { padding: 20 },
  card: { background: "#FFF", border: "1px solid #E2E8F0", borderRadius: 12, padding: 18, marginBottom: 14 },
  h2: { fontSize: 14, fontWeight: 800, letterSpacing: 0.3, marginBottom: 10 },
  lbl: { fontSize: 11, fontWeight: 700, color: "#64748B", textTransform: "uppercase", letterSpacing: 0.5 },
  input: { border: "1px solid #CBD5E1", borderRadius: 6, padding: "7px 9px", fontSize: 13, fontWeight: 600, background: "#FFF", boxSizing: "border-box" },
  btn: (bg, fg) => ({ background: bg, color: fg, border: "none", borderRadius: 8, padding: "8px 14px", fontSize: 13, fontWeight: 700, cursor: "pointer" }),
  tab: (on) => ({ padding: "8px 14px", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer", border: `2px solid ${on ? ACCENT : "#E2E8F0"}`, background: on ? ACCENT : "#FFF", color: on ? "#FFF" : "#334155" }),
  pill: (on) => ({ padding: "6px 10px", borderRadius: 7, fontSize: 12, fontWeight: 700, cursor: "pointer", border: `2px solid ${on ? ACCENT : "#E2E8F0"}`, background: on ? "#DBEAFF" : "#FFF", color: on ? ACCENT : "#64748B" }),
  err: { background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 8, padding: "9px 13px", color: "#DC2626", fontSize: 13, fontWeight: 600, marginBottom: 12 },
  ok:  { background: "#F0FDF4", border: "1px solid #BBF7D0", borderRadius: 8, padding: "9px 13px", color: "#15803D", fontSize: 13, fontWeight: 600, marginBottom: 12 },
  row: { display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: "1px solid #F1F5F9" },
};

// Board-and-batten door glyph — mirrors the designer's palette icon so the door items
// look the same here as in the layout. Rendered for the singleDoor/doubleDoor item keys
// (via layoutItemGlyph) instead of the generic door emoji.
function DoorIcon({ double = false }) {
  const FRAME = "#ECE4D3", PANEL = "#B99A82", PLANK = "#8B7058", IRON = "#2C2A28";
  const leaf = (x, w, hingeLeft) => {
    const planks = [];
    for (let i = 1; i <= 3; i++) { const px = x + (w * i) / 4; planks.push(<line key={i} x1={px} y1={2.6} x2={px} y2={15.4} stroke={PLANK} strokeWidth={0.4} />); }
    const hx = hingeLeft ? x + 0.5 : x + w - 1.8;
    return (
      <g key={x}>
        <rect x={x} y={1} width={w} height={16} rx={0.5} fill={FRAME} stroke="#B5A98E" strokeWidth={0.7} />
        <rect x={x + 1.1} y={2.2} width={w - 2.2} height={13.6} fill={PANEL} />
        {planks}
        <rect x={x + 1.1} y={8.1} width={w - 2.2} height={1.2} fill={FRAME} />
        <rect x={hx} y={3.4} width={1.3} height={0.9} fill={IRON} />
        <rect x={hx} y={12.8} width={1.3} height={0.9} fill={IRON} />
      </g>
    );
  };
  if (double) {
    return (
      <svg width={18} height={16} viewBox="0 0 20 18" style={{ display: "block" }} aria-hidden="true">
        {leaf(0.5, 9, true)}
        {leaf(10.5, 9, false)}
        <rect x={9.2} y={8.3} width={1.6} height={0.9} fill={IRON} />
      </svg>
    );
  }
  return (
    <svg width={11} height={16} viewBox="0 0 12 18" style={{ display: "block" }} aria-hidden="true">
      {leaf(0.5, 11, true)}
      <rect x={9.4} y={8.2} width={1.4} height={0.9} fill={IRON} />
    </svg>
  );
}
// Icon for a layout-item row: the board-and-batten DoorIcon for the door items, the
// item's emoji otherwise.
function layoutItemGlyph(it) {
  if (it.item_key === "singleDoor") return <DoorIcon />;
  if (it.item_key === "doubleDoor") return <DoorIcon double />;
  return it.icon;
}

// Password input with a show/hide (eye) toggle. Forwards all input props; `wrapStyle`
// carries any flex/grid sizing onto the positioned wrapper so layouts are preserved.
function PasswordInput({ style, wrapStyle, ...rest }) {
  const [show, setShow] = useState(false);
  return (
    <div style={{ position: "relative", width: "100%", boxSizing: "border-box", ...wrapStyle }}>
      <input {...rest} type={show ? "text" : "password"} style={{ ...style, width: "100%", boxSizing: "border-box", paddingRight: 38 }} />
      <button type="button" tabIndex={-1} aria-label={show ? "Hide password" : "Show password"} title={show ? "Hide password" : "Show password"} onMouseDown={(e) => e.preventDefault()} onClick={() => setShow((v) => !v)} style={{ position: "absolute", top: 0, right: 0, height: "100%", width: 34, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent", border: "none", padding: 0, margin: 0, cursor: "pointer", color: "#64748B" }}>
        {show ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" /><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" /><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" /><line x1="2" x2="22" y1="2" y2="22" /></svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></svg>
        )}
      </button>
    </div>
  );
}

async function api(action, password, body) {
  const { data, error } = await sb.functions.invoke("admin-catalog", { body: { action, adminPassword: password, ...(body || {}) } });
  if (error) {
    // supabase-js wraps any non-2xx response in a FunctionsHttpError whose .message is the
    // opaque "Edge Function returned a non-2xx status code". The real { error } body the
    // function sent is on error.context (the raw Response) — read it so the operator sees
    // the actual reason (e.g. "No Supabase user with email …. Create the login first").
    let msg = error.message || "request failed";
    try {
      const ctx = error.context;
      if (ctx && typeof ctx.json === "function") {
        const b = await (typeof ctx.clone === "function" ? ctx.clone() : ctx).json();
        if (b && b.error) msg = b.error;
      }
    } catch (_) { /* fall back to the generic message */ }
    throw new Error(msg);
  }
  if (data && data.error) throw new Error(data.error);
  return data;
}

// ── CSV helpers (RFC-4180-ish) ──────────────────────────────────────────────
function csvEscape(v) { const s = String(v == null ? "" : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function toCSV(headers, rows) { return [headers, ...rows].map((r) => r.map(csvEscape).join(",")).join("\r\n"); }
function parseCSV(text) {
  const rows = []; let row = [], field = "", inQ = false;
  text = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ""));
}
function downloadFile(name, text) {
  const b = new Blob([text], { type: "text/csv;charset=utf-8" });
  const u = URL.createObjectURL(b); const a = document.createElement("a");
  a.href = u; a.download = name; document.body.appendChild(a); a.click();
  a.remove(); URL.revokeObjectURL(u);
}

function slugify(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40); }

// ─── Read-only impersonation view (operator "view portal as <client>") ───
// Renders the SAME Designs & Leads table the owner portal shows, from the
function AdminApp() {
  const [pwd, setPwd] = useState("");
  const [authed, setAuthed] = useState(false);
  const [clients, setClients] = useState([]);
  const [master, setMaster] = useState(null);
  const [sel, setSel] = useState("");
  const [cat, setCat] = useState(null);
  const [tab, setTab] = useState("items");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [newStyleName, setNewStyleName] = useState("");
  const [newStyleImg, setNewStyleImg] = useState(null); // { base64, contentType }
  const [csvBusy, setCsvBusy] = useState(false);
  const [csvResult, setCsvResult] = useState(null); // { imported, skipped[] }
  const [fileKey, setFileKey] = useState(0); // bump to remount the (uncontrolled) file input
  const [newOpen, setNewOpen] = useState(false);
  const [ncId, setNcId] = useState("");
  const [ncCompany, setNcCompany] = useState("");
  const [ncTemplate, setNcTemplate] = useState("__none__");
  const [ncIdTouched, setNcIdTouched] = useState(false);
  // Non-billable = CSM Synergy's own / demo / testing accounts: they skip the billing
  // gate. A normal new client is billable, so this defaults OFF.
  const [ncExempt, setNcExempt] = useState(false);
  // Account-level discount (migration 058) — an attribute of the customer, not of a
  // purchase, so it follows them onto every feature they add later.
  const [ncDiscount, setNcDiscount] = useState("0");
  // Scope: all features, or only the ones ticked. Empty list on the wire = everything.
  const [ncAllFeat, setNcAllFeat] = useState(true);
  const [ncFeat, setNcFeat] = useState([]);
  // Per-client billing editor: the customers who need a discount usually already exist.
  const [billOpen, setBillOpen] = useState(false);
  const [billPct, setBillPct] = useState("0");
  const [billExempt, setBillExempt] = useState(false);
  const [billAllFeat, setBillAllFeat] = useState(true);
  const [billFeat, setBillFeat] = useState([]);
  // Dated free period (059) — yyyy-mm-dd, blank = none.
  const [billUntil, setBillUntil] = useState("");
  // Card payments (174): the tenant's master switch + the builder's OWN Fiserv/CardConnect
  // merchant id. Read on demand (get_payments), never carried in the clients list — a MID
  // names somebody else's bank account, so it loads only for the builder being looked at.
  const [payOpen, setPayOpen] = useState(false);
  const [payLoaded, setPayLoaded] = useState(null);   // null=unread · {paymentsEnabled,merchid} · {error}
  const [payEnabled, setPayEnabled] = useState(false);
  const [payMerchid, setPayMerchid] = useState("");
  // Deliberate friction: switching payments ON requires ticking this first. The field is not
  // a preference — it decides whose account a customer's card payment lands in.
  const [payConfirm, setPayConfirm] = useState(false);
  // Billable features, from billing_plans via list_clients — never hardcoded here.
  const [features, setFeatures] = useState([]);
  const [linkOpen, setLinkOpen] = useState(false);
  const [ownerEmail, setOwnerEmail] = useState("");
  const [linkRole, setLinkRole] = useState("owner");
  const [linkResult, setLinkResult] = useState(null); // { email, client, roleLabel, created, emailSent, setupLink, movedFrom }
  const [reassignFrom, setReassignFrom] = useState(null); // email already linked elsewhere: { email, role, fromClient } — drives the one-click Reassign prompt
  const [itemSel, setItemSel] = useState(() => new Set()); // staged layout-item picks (applied together on Save)
  const itemsDirty = useRef(false); // true while itemSel holds unsaved ticks — see the re-sync effect below
  const [delOpen, setDelOpen] = useState(false);
  const [delConfirm, setDelConfirm] = useState("");
  // Operator-global email sender (Supabase Auth custom SMTP → a Google account).
  const [emailSender, setEmailSender] = useState(null); // null=unloaded · {connected,senderEmail} · {error}
  const [emailOpen, setEmailOpen] = useState(false);
  const [emailAddr, setEmailAddr] = useState("carolyn@csmsynergy.com");
  const [emailPwd, setEmailPwd] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailTestTo, setEmailTestTo] = useState(""); // recipient for the "Send test email" button (must be an existing login)
  const [emailTestBusy, setEmailTestBusy] = useState(false);

  // Auto-dismiss clears only the message it announced: the timer captures its own m and
  // the functional update checks identity, so a newer message flashed inside the 2.5s
  // window (e.g. an error from the next action) is never wiped by the stale timer.
  const flash = (m) => { setMsg(m); if (m && m.ok) setTimeout(() => setMsg((cur) => (cur === m ? null : cur)), 2500); else if (m && m.err) ssLogError(SS_ERR_SOURCE, m.err, null, { ui: "flash" }); };

  const login = async () => {
    setBusy(true); setMsg(null);
    try {
      const c = await api("list_clients", pwd);
      const m = await api("get_master", pwd);
      setClients(c.clients || []); setFeatures(c.features || []); setMaster(m); setAuthed(true);
      loadEmailSender();   // best-effort; never blocks login
    } catch (e) { flash({ err: e.message }); }
    setBusy(false);
  };
  // Read the current Auth email-sender status (best-effort: a missing
  // MGMT_TOKEN or API hiccup must never break the admin page).
  const loadEmailSender = async () => {
    try { setEmailSender(await api("get_email_sender", pwd)); }
    catch (e) { setEmailSender({ error: e.message }); }
  };
  const connectEmail = async () => {
    const addr = emailAddr.trim();
    const pass = emailPwd.replace(/\s+/g, "");   // Google shows it as 4 spaced groups
    if (!addr || !pass) return;
    setEmailBusy(true); setMsg(null);
    try {
      const r = await api("connect_email", pwd, { email: addr, appPassword: pass });
      setEmailSender({ connected: true, senderEmail: r.senderEmail || addr });
      setEmailPwd(""); setEmailOpen(false);
      flash({ ok: `Connected — login & invite emails now send from ${r.senderEmail || addr}.` });
    } catch (e) { flash({ err: e.message }); }
    setEmailBusy(false);
  };
  const disconnectEmail = async () => {
    setEmailBusy(true); setMsg(null);
    try {
      await api("disconnect_email", pwd);
      setEmailSender({ connected: false, senderEmail: null });
      flash({ ok: "Disconnected — emails will use the Supabase default sender." });
    } catch (e) { flash({ err: e.message }); }
    setEmailBusy(false);
  };
  // Send a real auth email (a password reset) through the connected sender to
  // confirm delivery + the From address. Recipient must be an existing login.
  const sendTestEmail = async () => {
    const to = emailTestTo.trim();
    if (!to) return;
    setEmailTestBusy(true); setMsg(null);
    try {
      const r = await api("test_email", pwd, { email: to, portalUrl: location.origin + "/portal" });
      flash({ ok: `Test sent to ${r.sentTo}${r.senderEmail ? ` from ${r.senderEmail}` : ""} — check the inbox. It's a password-reset email; nothing changes unless you click the link.` });
    } catch (e) { flash({ err: e.message }); }
    setEmailTestBusy(false);
  };
  // `freshClients` lets a caller that JUST refetched the list pass it in: this closure's
  // `clients` is the array from the render it was created in, so right after create_client
  // the new id isn't in it, the billing seed below would read exempt=false / 0%, and one
  // Save would silently wipe the exemption/discount the create form persisted seconds ago.
  const loadClient = async (cid, freshClients) => {
    setSel(cid); setCat(null); setMsg(null); setCsvResult(null); setReassignFrom(null);
    setNewStyleName(""); setNewStyleImg(null); setFileKey((k) => k + 1); // don't carry a half-filled create-style form to another client
    setDelOpen(false); setDelConfirm("");                                // close any open delete confirmation when switching clients
    setBillOpen(false);
    // Close and BLANK the payments panel on every builder switch. Its two fields are read
    // per-tenant, so leaving one builder's merchant id on screen under another builder's
    // name is the one mistake this card must never make.
    setPayOpen(false); setPayLoaded(null); setPayEnabled(false); setPayMerchid(""); setPayConfirm(false);
    // Seed the billing editor from the list row so it opens showing what is actually set.
    const row = (freshClients || clients).find((c) => c.client_id === cid);
    setBillPct(String(row?.discountPercent ?? 0)); setBillExempt(Boolean(row?.billingExempt));
    // NULL / empty in the database means "every feature", which is the radio default.
    const scoped = Array.isArray(row?.discountFeatures) ? row.discountFeatures : [];
    setBillAllFeat(scoped.length === 0); setBillFeat(scoped);
    setBillUntil(row?.exemptUntil ? String(row.exemptUntil).slice(0, 10) : "");
    if (!cid) return;
    setBusy(true);
    try { setCat(await api("get_client_catalog", pwd, { clientId: cid })); }
    catch (e) { flash({ err: e.message }); }
    setBusy(false);
  };
  const createNewClient = async () => {
    const id = ncId.trim().toLowerCase();
    if (!id || !ncCompany.trim()) return;
    setBusy(true); setMsg(null);
    try {
      await api("create_client", pwd, { clientId: id, companyName: ncCompany.trim(), templateClientId: ncTemplate, billingExempt: ncExempt, discountPercent: ncExempt ? 0 : (Number(ncDiscount) || 0), discountFeatures: ncAllFeat ? [] : ncFeat });
      const c = await api("list_clients", pwd); setClients(c.clients || []); setFeatures(c.features || []);
      setNewOpen(false); setNcId(""); setNcCompany(""); setNcTemplate("__none__"); setNcIdTouched(false); setNcExempt(false); setNcDiscount("0"); setNcAllFeat(true); setNcFeat([]);
      await loadClient(id, c.clients || []); // the refetched list, NOT this closure's stale `clients` — see loadClient
      flash({ ok: `Builder "${id}" created. Next: add styles/items/pricing in the tabs, then create the owner login in Supabase Auth + map client_users.` });
    } catch (e) { flash({ err: e.message }); }
    setBusy(false);
  };
  // Which features a discount covers. All (empty list on the wire) or a chosen few.
  // Rendered in both the New client form and the per-client Billing panel.
  const FeatureScope = ({ all, setAll, picked, setPicked, disabled }) => (
    <div style={{ marginTop: 8, opacity: disabled ? 0.5 : 1, pointerEvents: disabled ? "none" : "auto" }}>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13, color: "#1E293B" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
          <input type="radio" checked={all} onChange={() => setAll(true)} />
          <span>Every feature</span>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
          <input type="radio" checked={!all} onChange={() => setAll(false)} />
          <span>Only the ones I pick</span>
        </label>
      </div>
      {!all && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px", marginTop: 8, paddingLeft: 2 }}>
          {features.length === 0 && <span style={{ fontSize: 12, color: "#B91C1C" }}>No billable features found.</span>}
          {features.map((f) => (
            <label key={f.feature} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "#334155", cursor: "pointer" }}>
              <input type="checkbox" checked={picked.indexOf(f.feature) !== -1}
                onChange={(e) => setPicked(e.target.checked
                  ? picked.concat([f.feature])
                  : picked.filter((x) => x !== f.feature))} />
              <span>{f.name}{f.required ? " (required)" : ""}{f.availability === "coming_soon" ? " — soon" : ""}</span>
            </label>
          ))}
        </div>
      )}
      {!all && picked.length === 0 && (
        <div style={{ fontSize: 11.5, color: "#B91C1C", marginTop: 6 }}>
          Pick at least one feature, or choose "Every feature" — an empty list means no discount applies anywhere.
        </div>
      )}
    </div>
  );

  const saveBilling = async () => {
    if (!sel) return;
    const pct = Math.round(Number(billPct));
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) { flash({ err: "Discount must be a whole number from 0 to 100." }); return; }
    if (pct > 0 && !billExempt && !billAllFeat && billFeat.length === 0) {
      flash({ err: "Choose which features the discount applies to, or select \"Every feature\"." }); return;
    }
    setBusy(true); setMsg(null);
    try {
      const r = await api("set_billing", pwd, { clientId: sel, billingExempt: billExempt, discountPercent: pct,
        discountFeatures: billAllFeat ? [] : billFeat, exemptUntil: billUntil });
      const c = await api("list_clients", pwd); setClients(c.clients || []); setFeatures(c.features || []);
      setBillOpen(false);
      flash({ ok: `Billing saved for ${sel}. ${r.note || ""}`.trim() });
    } catch (e) { flash({ err: e.message }); }
    setBusy(false);
  };

  // ── Card payments (174) ───────────────────────────────────────────────────────────
  // Read the tenant's live pair. Not folded into loadClient: the values only matter when
  // somebody opens this card, and one builder's merchant id should not sit in the page's
  // memory because an operator clicked through the builder list.
  const loadPayments = async (cid) => {
    setPayLoaded(null);
    try {
      const r = await api("get_payments", pwd, { clientId: cid });
      setPayLoaded(r);
      setPayEnabled(Boolean(r.paymentsEnabled));
      setPayMerchid(String(r.merchid || ""));
      setPayConfirm(false);
    } catch (e) { setPayLoaded({ error: e.message }); }
  };
  const togglePayments = () => {
    const next = !payOpen;
    setPayOpen(next);
    if (next && sel) loadPayments(sel);
  };
  // Every check here is duplicated server-side (admin-catalog set_payments) and the server's
  // copy is the control — this one exists so the operator is told before the round trip,
  // never so the server can trust the browser.
  const savePayments = async () => {
    if (!sel) return;
    const mid = payMerchid.trim();
    if (mid && !/^[0-9]{12,16}$/.test(mid)) {
      flash({ err: `"${mid}" isn't a merchant id — 12–16 digits and nothing else. Copy it exactly from this builder's Fiserv boarding paperwork; don't retype it.` }); return;
    }
    if (payEnabled && !mid) {
      flash({ err: "Add this builder's own merchant id before switching payments on — enabled with no id sends their customers' payments to the wrong account." }); return;
    }
    if (payEnabled && !payConfirm) {
      flash({ err: "Tick the confirmation first. This decides whose bank account customer card payments land in." }); return;
    }
    setBusy(true); setMsg(null);
    try {
      const r = await api("set_payments", pwd, { clientId: sel, paymentsEnabled: payEnabled, merchid: mid });
      setPayLoaded({ paymentsEnabled: r.paymentsEnabled, merchid: r.merchid });
      setPayMerchid(String(r.merchid || "")); setPayConfirm(false);
      flash({ ok: r.note || "Saved." });
    } catch (e) { flash({ err: e.message }); }
    setBusy(false);
  };
  // reassign=false → normal link; reassign=true → move a login already mapped to another
  // client (the backend refuses to silently re-home one without this explicit flag).
  const linkOwner = async (reassign = false) => {
    if (!sel || !ownerEmail.trim()) return;
    setBusy(true); setMsg(null); setLinkResult(null);
    try {
      const email = ownerEmail.trim();
      const r = await api("link_owner", pwd, {
        clientId: sel, email, role: linkRole,
        portalUrl: location.origin + "/portal",
        ...(reassign ? { reassign: true } : {}),
      });
      const roleLabel = (r && r.role === "user") ? "team member (Designs & Leads only)" : "admin";
      const movedFrom = (reassign && reassignFrom) ? reassignFrom.fromClient : null;
      // keep the panel open so the operator can copy the setup link
      setLinkResult({ email, client: sel, roleLabel, created: !!(r && r.created), emailSent: !!(r && r.emailSent), setupLink: (r && r.setupLink) || null, movedFrom });
      setOwnerEmail(""); setReassignFrom(null);
      flash({ ok: `"${email}" ${movedFrom ? `reassigned from "${movedFrom}" to` : "linked to"} "${sel}" as ${roleLabel}.` });
    } catch (e) {
      // Email already belongs to another tenant: rather than dead-end on the error, offer a
      // one-click Reassign. We key off the backend's stable "reassign:true" instruction and
      // pull the current client out of its message so the prompt can name it.
      const errMsg = (e && e.message) || String(e);
      if (/reassign\s*:\s*true/i.test(errMsg)) {
        // Tolerates BOTH wordings: the server said "client" before the 2026-08-02
        // builder rename, and an operator's browser can be running a cached page
        // against a newer function (or vice versa) — a strict match would silently
        // stop naming the tenant in the reassign prompt.
        const m = /already linked to (?:client|builder) "([^"]+)"/.exec(errMsg);
        setReassignFrom({ email: ownerEmail.trim(), role: linkRole, fromClient: m ? m[1] : null });
      } else {
        setReassignFrom(null);
      }
      flash({ err: errMsg });
    }
    setBusy(false);
  };
  // Operator hard-delete: server wipes the tenant + all its data (catalog,
  // designs, settings, logins, storage). Guarded by typing the builder id.
  const deleteClient = async () => {
    const id = sel;
    if (!id || delConfirm.trim() !== id) return;
    setBusy(true); setMsg(null);
    try {
      const r = await api("delete_client", pwd, { clientId: id, confirmClientId: delConfirm.trim() });
      const c = await api("list_clients", pwd); setClients(c.clients || []); setFeatures(c.features || []);
      setDelOpen(false); setDelConfirm(""); setSel(""); setCat(null);
      const parts = (r && r.deleted) ? Object.entries(r.deleted).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(", ") : "";
      flash({ ok: `Builder "${id}" deleted${parts ? ` (${parts})` : ""}.` });
    } catch (e) { flash({ err: e.message }); }
    setBusy(false);
  };
  const act = async (action, body, ok) => {
    setBusy(true); setMsg(null);
    try {
      await api(action, pwd, body);                 // the actual write
    } catch (e) { flash({ err: e.message }); setBusy(false); return; }
    flash({ ok: ok || "Saved" });                   // write succeeded — report it BEFORE refreshing
    try {                                            // refresh reads are best-effort; a failure here must not
      if (sel) setCat(await api("get_client_catalog", pwd, { clientId: sel }));  // mask the successful write or
      const m = await api("get_master", pwd); setMaster(m);                       // corrupt the on-screen pill state
    } catch (_) { /* UI catches up on the next action */ }
    setBusy(false);
  };

  // Layout-item editing is staged: the pills toggle a local selection and nothing is
  // written until "Save". Re-sync the staged set when the loaded builder or catalog
  // changes — but NOT while the operator has unsaved ticks: cat also refreshes after
  // UNRELATED writes (act()'s best-effort refresh — e.g. a Building Styles active-pill
  // toggle — createStyle, a CSV import), and re-syncing then would silently discard
  // the staged picks. itemsDirty is set by the tick handlers, cleared on a builder
  // switch (stale staging must not leak into the next tenant's view) and by saveItems
  // once its writes land — its post-save refresh is a cat change that SHOULD re-sync.
  useEffect(() => { itemsDirty.current = false; }, [sel]);   // declared first so a builder switch re-syncs below
  useEffect(() => {
    if (itemsDirty.current) return;
    setItemSel(new Set((((cat && cat.clientLayoutItems) || []).filter((i) => i.active)).map((i) => i.item_key)));
  }, [sel, cat]);
  const toggleItemSel = (key) => { itemsDirty.current = true; setItemSel((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; }); };
  const selectAllItems = () => { itemsDirty.current = true; setItemSel(new Set(((master && master.layoutItemTypes) || []).map((i) => i.item_key))); };
  const clearAllItems = () => { itemsDirty.current = true; setItemSel(new Set()); };
  // Diff the staged set against what's actually assigned, then apply only the changes
  // (enable newly-ticked, disable newly-unticked) and refresh once at the end — so the
  // operator ticks everything and clicks Save once instead of one request per pill.
  const saveItems = async () => {
    if (!sel || !cat || !master) return;
    const saved = new Set(((cat.clientLayoutItems) || []).filter((i) => i.active).map((i) => i.item_key));
    const keys = (master.layoutItemTypes || []).map((i) => i.item_key);
    const toEnable  = keys.filter((k) => itemSel.has(k) && !saved.has(k));
    const toDisable = keys.filter((k) => !itemSel.has(k) && saved.has(k));
    const total = toEnable.length + toDisable.length;
    // Staged set matches what's saved (ticks toggled back, or none touched): nothing
    // unsaved left to protect, so let the next catalog refresh re-sync again.
    if (total === 0) { itemsDirty.current = false; flash({ ok: "No changes to save." }); return; }
    setBusy(true); setMsg(null);
    try {
      for (const k of toEnable)  await api("toggle_item", pwd, { clientId: sel, itemKey: k, active: true });
      for (const k of toDisable) await api("toggle_item", pwd, { clientId: sel, itemKey: k, active: false });
    } catch (e) { flash({ err: e.message }); setBusy(false); return; }
    // Writes landed: the staging is no longer "unsaved", so clear the dirty flag BEFORE
    // the refresh below — that refresh is the one cat change that must re-sync itemSel.
    itemsDirty.current = false;
    flash({ ok: `Saved ${total} change${total === 1 ? "" : "s"}.` });
    try { setCat(await api("get_client_catalog", pwd, { clientId: sel })); setMaster(await api("get_master", pwd)); }
    catch (_) { /* UI catches up on the next action */ }
    setBusy(false);
  };
  const ALLOWED_IMG = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  const onPickStyleImg = (file) => {
    if (!file) { setNewStyleImg(null); return; }
    if (!ALLOWED_IMG.includes(file.type)) { flash({ err: "Use a JPG, PNG, WEBP or GIF image." }); setFileKey((k) => k + 1); return; }
    if (file.size > 3_000_000) { flash({ err: "Image too large (max 3MB)." }); setFileKey((k) => k + 1); return; }
    const r = new FileReader();
    r.onerror = () => flash({ err: "Could not read that image." });
    r.onload = () => setNewStyleImg({ base64: r.result, contentType: file.type || "image/jpeg" });
    r.readAsDataURL(file);
  };
  const createStyle = async () => {
    if (!sel || !newStyleName.trim()) return;
    setBusy(true); setMsg(null);
    try {
      let imageUrl = null;
      if (newStyleImg) {
        const up = await api("upload_image", pwd, { clientId: sel, imageBase64: newStyleImg.base64, contentType: newStyleImg.contentType });
        imageUrl = up.url;
      }
      await api("create_style", pwd, { clientId: sel, label: newStyleName.trim(), imageUrl });
      setNewStyleName(""); setNewStyleImg(null); setFileKey((k) => k + 1);
      setCat(await api("get_client_catalog", pwd, { clientId: sel }));
      flash({ ok: "Style created" });
    } catch (e) { flash({ err: e.message }); }
    setBusy(false);
  };

  // CSV pricing/inclusion: active items for this client with display labels.
  const csvItems = () => {
    const labelByKey = {}; (master && master.layoutItemTypes || []).forEach((it) => { labelByKey[it.item_key] = it.label; });
    return ((cat && cat.clientLayoutItems) || []).filter((i) => i.active)
      .map((i) => ({ key: i.item_key, label: i.label_override || labelByKey[i.item_key] || i.item_key }));
  };
  const downloadTemplate = () => {
    const items = csvItems();
    const headers = ["style", "width", "length", "price", ...items.map((it) => it.label), "active"];
    // Item cells carry the included QUANTITY (loft = sq ft, doors = count); 0 = not included.
    // Legacy "yes"/"no" sheets still upload fine (yes imports as quantity 1).
    const incBySize = {}; ((cat && cat.inclusions) || []).forEach((x) => { if (x.included) (incBySize[x.size_id] = incBySize[x.size_id] || {})[x.item_key] = Number(x.qty) || 1; });
    const rows = [];
    ((cat && cat.buildingStyles) || []).filter((s) => s.active).forEach((s) => {
      const sizes = ((cat && cat.buildingSizes) || []).filter((z) => z.style_id === s.id);
      if (sizes.length === 0) {
        rows.push([s.label, "", "", "", ...items.map(() => "0"), "yes"]);
      } else {
        sizes.forEach((z) => {
          const inc = incBySize[z.id] || {};
          rows.push([s.label, z.width_ft, z.length_ft, z.base_price == null ? "" : z.base_price,
            ...items.map((it) => String(inc[it.key] || 0)), z.active ? "yes" : "no"]);
        });
      }
    });
    downloadFile(`${sel}-pricing.csv`, toCSV(headers, rows));
  };
  const onUploadCsv = async (file) => {
    if (!file || !sel) return;
    setCsvBusy(true); setMsg(null); setCsvResult(null);
    try {
      if (file.size > 5_000_000) throw new Error("CSV too large (max 5MB).");
      const matrix = parseCSV(await file.text());
      if (matrix.length < 2) throw new Error("CSV has no data rows.");
      const header = matrix[0].map((h) => String(h).trim());
      const lc = header.map((h) => h.toLowerCase());
      const iStyle = lc.indexOf("style"), iWidth = lc.indexOf("width"), iLength = lc.indexOf("length"), iPrice = lc.indexOf("price"), iActive = lc.indexOf("active");
      if (iStyle < 0 || iWidth < 0 || iLength < 0 || iPrice < 0) throw new Error('CSV needs "style", "width", "length" and "price" columns.');
      const reserved = new Set([iStyle, iWidth, iLength, iPrice, iActive]);
      const labelToKey = {}; csvItems().forEach((it) => { labelToKey[it.label.toLowerCase()] = it.key; labelToKey[it.key.toLowerCase()] = it.key; });
      const colKey = header.map((h, idx) => reserved.has(idx) ? null : (labelToKey[h.toLowerCase()] || null));
      const rows = matrix.slice(1).map((cols) => {
        const inclusions = {}; colKey.forEach((k, idx) => { if (k) inclusions[k] = cols[idx]; });
        return { style: cols[iStyle], width: cols[iWidth], length: cols[iLength], price: cols[iPrice], active: iActive >= 0 ? cols[iActive] : "", inclusions };
      });
      const res = await api("import_pricing_csv", pwd, { clientId: sel, rows });
      setCsvResult(res);
      setCat(await api("get_client_catalog", pwd, { clientId: sel }));
      const parts = []; if (res.created) parts.push(`${res.created} added`); if (res.updated) parts.push(`${res.updated} updated`);
      flash({ ok: `Imported ${res.imported || 0} size(s)` + (parts.length ? ` (${parts.join(", ")})` : "") + (res.skipped && res.skipped.length ? `, ${res.skipped.length} skipped` : "") });
    } catch (e) { flash({ err: e.message }); }
    setCsvBusy(false);
  };

  if (!authed) {
    return (
      <div>
        <div style={S.header}><div style={S.badge}>SS</div><div style={{ fontWeight: 800 }}>Operator Admin</div></div>
        <div style={{ ...S.wrap, maxWidth: 420 }}>
          <div style={S.card}>
            <div style={S.h2}>🔒 Enter operator password</div>
            {msg && msg.err && <div style={S.err}>{msg.err}</div>}
            <PasswordInput value={pwd} onChange={(e) => setPwd(e.target.value)} placeholder="ADMIN_PASSWORD"
              onKeyDown={(e) => e.key === "Enter" && pwd && login()} style={{ ...S.input, width: "100%" }} wrapStyle={{ marginBottom: 10 }} />
            <button onClick={login} disabled={busy || !pwd} style={S.btn(busy ? "#9CA3AF" : ACCENT, "#FFF")}>{busy ? "…" : "Unlock"}</button>
          </div>
        </div>
      </div>
    );
  }

  const styleAssigned = (key) => (cat?.buildingStyles || []).some((s) => s.key === key && s.active);

  return (
    <div>
      <div style={S.header}><div style={S.badge}>SS</div><div style={{ fontWeight: 800 }}>Operator Admin</div>
        <div style={{ marginLeft: "auto", fontSize: 12, opacity: 0.8 }}>{clients.length} builders</div></div>
      <div style={S.wrap}>
        {msg && msg.err && <div style={S.err}>{msg.err}</div>}
        {msg && msg.ok && <div style={S.ok}>{msg.ok}</div>}

        <div style={{ ...S.card, display: "flex", alignItems: "center", gap: 12 }}>
          <span style={S.lbl}>Builder</span>
          <select value={sel} onChange={(e) => loadClient(e.target.value)} style={{ ...S.input, minWidth: 240 }}>
            <option value="">— select a builder —</option>
            {clients.map((c) => <option key={c.client_id} value={c.client_id}>{c.company_name || c.client_id} ({c.client_id})</option>)}
          </select>
          <button onClick={() => setNewOpen((o) => !o)} style={S.btn("#F1F5F9", "#334155")}>{newOpen ? "Cancel" : "+ New builder"}</button>
          <button onClick={() => setLinkOpen((o) => !o)} style={S.btn("#F1F5F9", "#334155")}>{linkOpen ? "Cancel" : "Link owner"}</button>
          <button onClick={() => setBillOpen((o) => !o)} disabled={!sel} style={S.btn(sel ? "#F1F5F9" : "#F1F5F9", sel ? "#334155" : "#94A3B8")} title={sel ? `Billing posture for ${sel}` : "Select a builder first"}>{billOpen ? "Cancel" : "Billing"}</button>
          <button onClick={togglePayments} disabled={!sel} style={S.btn(sel ? "#FEF3C7" : "#F1F5F9", sel ? "#92400E" : "#94A3B8")} title={sel ? `Card payments + merchant id for ${sel}` : "Select a builder first"}>{payOpen ? "Cancel" : "Card payments"}</button>
          <button onClick={() => setDelOpen((o) => !o)} disabled={!sel} style={S.btn(sel ? "#FEE2E2" : "#F1F5F9", sel ? "#B91C1C" : "#94A3B8")} title={sel ? `Delete ${sel} and all its data` : "Select a builder first"}>{delOpen ? "Cancel" : "Delete builder"}</button>
          {/* GHL-subaccounts-style jump: opens the real owner portal focused on this
              client (portal.html auto-opens ?view= for logged-in operators). */}
          {sel && <a href={`/portal?view=${encodeURIComponent(sel)}`} target="_blank" rel="noopener" style={{ ...S.btn("#3D3672", "#FFF"), textDecoration: "none", display: "inline-flex", alignItems: "center" }}>Open portal ↗</a>}
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <div style={S.tab(tab === "items")} onClick={() => setTab("items")}>Layout Items</div>
            <div style={S.tab(tab === "styles")} onClick={() => setTab("styles")}>Building Styles</div>
            <div style={S.tab(tab === "csv")} onClick={() => setTab("csv")}>CSV / Pricing</div>
            <div style={S.tab(tab === "master")} onClick={() => setTab("master")}>Master Items</div>
          </div>
        </div>

        {newOpen && (
          <div style={{ ...S.card, background: "#DBEAFF", border: "1px solid #75E6DA" }}>
            <div style={S.h2}>Create a new builder</div>
            <div style={{ fontSize: 13, color: "#475569", marginBottom: 10, lineHeight: 1.5 }}>
              Creates the tenant config. <b>No template</b> starts blank (standard contact form, no sizes/options — you
              add everything in the tabs). Or clone a template to copy its contact fields, default sizes &amp; options.
              After this: add building styles, layout items &amp; pricing in the tabs, then create the owner login in
              Supabase Auth and map <code>client_users</code>.
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <input value={ncCompany} onChange={(e) => { const v = e.target.value; setNcCompany(v); if (!ncIdTouched) setNcId(slugify(v)); }} placeholder="Company name (e.g. Acme Barns)" style={{ ...S.input, minWidth: 220 }} />
              <input value={ncId} onChange={(e) => { setNcId(e.target.value.toLowerCase()); setNcIdTouched(true); }} placeholder="builder-id (auto from name)" title="Auto-generated from the company name; edit to override" style={{ ...S.input, minWidth: 200 }} />
              <select value={ncTemplate} onChange={(e) => setNcTemplate(e.target.value)} style={{ ...S.input }}>
                <option value="__none__">No template — blank (recommended)</option>
                <option value="">Clone template: junior-barns</option>
                {clients.map((c) => <option key={c.client_id} value={c.client_id}>Clone: {c.client_id}</option>)}
              </select>
              <button onClick={createNewClient} disabled={busy || !ncId.trim() || !ncCompany.trim()} style={S.btn(busy || !ncId.trim() || !ncCompany.trim() ? "#9CA3AF" : ACCENT, "#FFF")}>Create builder</button>
            </div>
            <label style={{ display: "flex", alignItems: "flex-start", gap: 8, marginTop: 12, fontSize: 13, color: "#1E293B", cursor: "pointer" }}>
              <input type="checkbox" checked={ncExempt} onChange={(e) => setNcExempt(e.target.checked)} style={{ marginTop: 2 }} />
              <span>
                <b>Non-billable</b> — CSM Synergy internal / demo / testing account
                <div style={{ fontSize: 11.5, color: "#475569", marginTop: 2, lineHeight: 1.45 }}>
                  Skips the billing gate: the portal opens normally with no subscription and is never charged.
                  Leave this OFF for a real customer — they'll land on Billing and activate before anything unlocks.
                </div>
              </span>
            </label>
            {/* Account discount, not a coupon: it belongs to the ACCOUNT, so it applies to
                whatever they subscribe to whenever, with no code to re-enter or share. */}
            <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginTop: 10, fontSize: 13, color: "#1E293B" }}>
              <input type="number" min="0" max="100" step="1" value={ncDiscount}
                onChange={(e) => setNcDiscount(e.target.value)} disabled={ncExempt}
                style={{ ...S.input, width: 74, marginTop: -2, opacity: ncExempt ? 0.5 : 1 }} />
              <span>
                <b>% off</b> — ongoing discount on recurring price
                <div style={{ fontSize: 11.5, color: "#475569", marginTop: 2, lineHeight: 1.45 }}>
                  Leave 0 for full price. Applies for as long as each subscription runs — no coupon code to
                  re-enter. Setup fees are never discounted.
                  {ncExempt && <b> Not applicable to a non-billable account.</b>}
                </div>
              </span>
            </div>
            {/* Always rendered, greyed until a percentage exists — hiding it entirely meant
                the per-feature option was undiscoverable unless you already knew it existed. */}
            {!ncExempt && (
              <div style={{ marginTop: 4, paddingLeft: 2 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: Number(ncDiscount) > 0 ? "#334155" : "#94A3B8" }}>
                  Discount applies to
                  {!(Number(ncDiscount) > 0) && <span style={{ fontWeight: 600 }}> — enter a % above to choose</span>}
                </div>
                <FeatureScope all={ncAllFeat} setAll={setNcAllFeat} picked={ncFeat} setPicked={setNcFeat}
                  disabled={!(Number(ncDiscount) > 0)} />
              </div>
            )}
          </div>
        )}

        {billOpen && (
          <div style={{ ...S.card, background: "#F0FDF4", border: "1px solid #86EFAC" }}>
            <div style={S.h2}>Billing — {sel}</div>
            <div style={{ fontSize: 13, color: "#475569", marginBottom: 12, lineHeight: 1.5 }}>
              The discount belongs to the <b>account</b>, so it applies to every feature this tenant ever
              subscribes to, for as long as each subscription runs. Recurring price only — setup fees are
              never discounted.
            </div>
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#1E293B" }}>
                <input type="number" min="0" max="100" step="1" value={billPct}
                  onChange={(e) => setBillPct(e.target.value)} disabled={billExempt}
                  style={{ ...S.input, width: 74, opacity: billExempt ? 0.5 : 1 }} />
                <b>% off recurring</b>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#1E293B", cursor: "pointer" }}>
                <input type="checkbox" checked={billExempt} onChange={(e) => setBillExempt(e.target.checked)} />
                <b>Non-billable</b> (never charged, skips the gate)
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#1E293B" }}>
                <b>Free until</b>
                <input type="date" value={billUntil} onChange={(e) => setBillUntil(e.target.value)} style={{ ...S.input, width: 160 }} />
                {billUntil && <button type="button" onClick={() => setBillUntil("")} style={{ ...S.btn("#F1F5F9", "#64748B"), padding: "5px 9px", fontSize: 11 }}>clear</button>}
              </label>
              <button onClick={saveBilling} disabled={busy} style={S.btn(busy ? "#9CA3AF" : ACCENT, "#FFF")}>Save billing</button>
            </div>
            {!billExempt && (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: Number(billPct) > 0 ? "#334155" : "#94A3B8" }}>
                  Discount applies to
                  {!(Number(billPct) > 0) && <span style={{ fontWeight: 600 }}> — enter a % above to choose</span>}
                </div>
                <FeatureScope all={billAllFeat} setAll={setBillAllFeat} picked={billFeat} setPicked={setBillFeat}
                  disabled={!(Number(billPct) > 0)} />
              </div>
            )}
            {/* Two ways to get this wrong, both expensive, so say them out loud. */}
            <div style={{ fontSize: 12, color: "#166534", marginTop: 12, lineHeight: 1.55, background: "#DCFCE7", borderRadius: 8, padding: "9px 12px" }}>
              <b>Applies to future subscriptions only.</b> The gateway stores the amount on each subscription,
              so changing the discount does not re-price anything already running — it affects what they
              subscribe to next.
              <div style={{ marginTop: 6 }}>
                <b>Non-billable vs Free until.</b> Non-billable is permanent and silent — a failed payment on
                such an account produces no warning and no lock, because it bypasses the gate entirely. "Free
                until" is a dated window: they keep working and see a countdown with their rate, then the normal
                gate takes over. Subscribing ends the countdown early. Use the date for a customer you intend to
                convert; use Non-billable for our own accounts.
              </div>
              {billExempt === false && clients.find((c) => c.client_id === sel)?.billingExempt && (
                <div style={{ marginTop: 6, color: "#991B1B" }}>
                  <b>Careful:</b> you are removing Non-billable. If {sel} has no active subscription they will be
                  locked out of their portal the moment this saves. Set the discount first, have them subscribe,
                  then remove the exemption.
                </div>
              )}
            </div>
          </div>
        )}

        {/* Card payments (174). Amber, not the green of the Billing card, on purpose: this is
            not our money and not a preference — it points a builder's customer card payments
            at a bank account, and a wrong id here succeeds rather than fails. */}
        {payOpen && (
          <div style={{ ...S.card, background: "#FFFBEB", border: "1px solid #FDE68A" }}>
            <div style={S.h2}>💳 Card payments — {sel}</div>
            {!sel ? (
              <div style={{ fontSize: 13, color: "#B91C1C" }}>Select a builder above first.</div>
            ) : payLoaded === null ? (
              <div style={{ fontSize: 13, color: "#92400E" }}>Reading this builder's payment settings…</div>
            ) : payLoaded.error ? (
              <div style={{ fontSize: 13, color: "#B91C1C" }}>Couldn't read their payment settings: {payLoaded.error}</div>
            ) : (
              <div>
                <div style={{ fontSize: 13, color: "#78350F", marginBottom: 12, lineHeight: 1.55 }}>
                  <b>{sel} boards and underwrites directly with Fiserv.</b> The merchant id below is
                  theirs — the money goes to <b>their</b> account and the chargeback liability is
                  <b> theirs</b>. We only pass the card through and keep a token plus the last 4 digits.
                  <div style={{ marginTop: 6 }}>
                    Nothing here charges anybody. It is the switch the customer pay page, the card
                    modal and the swipe reader all check before they will take a payment.
                  </div>
                </div>

                {/* What is actually set right now, stated before anything is editable. */}
                <div style={{ fontSize: 12.5, color: "#334155", background: "#FFF", border: "1px solid #FDE68A", borderRadius: 8, padding: "9px 12px", marginBottom: 12 }}>
                  <b>Right now:</b>{" "}
                  {payLoaded.paymentsEnabled
                    ? <span style={{ color: "#15803D", fontWeight: 700 }}>ON</span>
                    : <span style={{ color: "#B45309", fontWeight: 700 }}>OFF — this builder has no way to take a card</span>}
                  {" · "}
                  <b>Merchant id:</b>{" "}
                  {payLoaded.merchid
                    ? <code style={{ fontSize: 12.5 }}>{payLoaded.merchid}</code>
                    : <span style={{ color: "#B45309" }}>none set</span>}
                </div>

                <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#1E293B" }}>
                    <b>Their merchant id</b>
                    <input value={payMerchid} onChange={(e) => { setPayMerchid(e.target.value); setPayConfirm(false); }}
                      inputMode="numeric" autoComplete="off" spellCheck={false}
                      placeholder="12–16 digits" title="Paste it from their Fiserv/CardConnect boarding paperwork — do not retype it"
                      style={{ ...S.input, width: 200, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }} />
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#1E293B", cursor: "pointer" }}>
                    <input type="checkbox" checked={payEnabled} onChange={(e) => { setPayEnabled(e.target.checked); setPayConfirm(false); }} />
                    <b>Take card payments for this builder</b>
                  </label>
                  <button onClick={savePayments} disabled={busy || (payEnabled && !payConfirm)}
                    style={S.btn(busy || (payEnabled && !payConfirm) ? "#9CA3AF" : "#B45309", "#FFF")}>Save payment settings</button>
                </div>
                <div style={{ fontSize: 11.5, color: "#78350F", marginTop: 6 }}>
                  Digits only — no spaces, dashes or letters. A mistyped id is not rejected by anyone
                  downstream; it just sends the money somewhere else. Clearing the box removes the id.
                </div>

                {/* The tick is required only for switching ON. Turning payments off is a safe
                    direction and should not need ceremony. */}
                {payEnabled && (
                  <label style={{ display: "flex", alignItems: "flex-start", gap: 8, marginTop: 12, fontSize: 13, color: "#7F1D1D", background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 8, padding: "10px 12px", cursor: "pointer" }}>
                    <input type="checkbox" checked={payConfirm} onChange={(e) => setPayConfirm(e.target.checked)} style={{ marginTop: 2 }} />
                    <span>
                      I have checked this merchant id against <b>{sel}</b>'s own Fiserv boarding
                      paperwork, character for character.
                      <div style={{ fontSize: 11.5, marginTop: 2, lineHeight: 1.45 }}>
                        Once this is on, their customers' cards are charged to whatever account this id
                        names. Nothing in the payment path will tell us it was the wrong builder.
                      </div>
                    </span>
                  </label>
                )}

                {payLoaded.paymentsEnabled && !payEnabled && (
                  <div style={{ fontSize: 12, color: "#B45309", marginTop: 10, lineHeight: 1.5 }}>
                    <b>Turning payments off.</b> Their customers' pay page and the card modal stop
                    working as soon as this saves. Payments already taken are unaffected.
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {linkOpen && (
          <div style={{ ...S.card, background: "#EFF6FF", border: "1px solid #BFDBFE" }}>
            <div style={S.h2}>Link an owner login</div>
            {!sel ? (
              <div style={{ fontSize: 13, color: "#B91C1C" }}>Select a builder above first.</div>
            ) : (
              <div>
                <div style={{ fontSize: 13, color: "#475569", marginBottom: 10, lineHeight: 1.5 }}>
                  Enter the owner's email — we'll create their portal login automatically (no manual Supabase step), map it to <b>{sel}</b>, and give you a one-time set-password link to send them (also emailed automatically if SMTP is configured).
                </div>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                  <input value={ownerEmail} onChange={(e) => { setOwnerEmail(e.target.value); setReassignFrom(null); }} placeholder="owner@theirbusiness.com" style={{ ...S.input, minWidth: 240 }} />
                  <select value={linkRole} onChange={(e) => setLinkRole(e.target.value)} style={{ ...S.input, width: 230 }}>
                    <option value="owner">Admin (full access)</option>
                    <option value="user">Team member (Designs &amp; Leads only)</option>
                  </select>
                  <button onClick={() => linkOwner(false)} disabled={busy || !ownerEmail.trim()} style={S.btn(busy || !ownerEmail.trim() ? "#9CA3AF" : ACCENT, "#FFF")}>Link to {sel}</button>
                </div>
                <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 6 }}>Admins see Pricing &amp; Settings; team members only see Designs &amp; Leads.</div>
                {reassignFrom && (
                  <div style={{ marginTop: 12, padding: 12, background: "#DBEAFF", border: "1px solid #75E6DA", borderRadius: 8 }}>
                    <div style={{ fontSize: 13, color: "#1B7895", marginBottom: 8, lineHeight: 1.5 }}>
                      <b>{reassignFrom.email}</b> already has a login linked to {reassignFrom.fromClient ? <b>{reassignFrom.fromClient}</b> : "another builder"}. Reassigning <b>moves</b> that same login to <b>{sel}</b> — they'll no longer see {reassignFrom.fromClient || "the other builder"}'s designs &amp; leads.
                    </div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <button onClick={() => linkOwner(true)} disabled={busy} style={S.btn(busy ? "#9CA3AF" : "#B45309", "#FFF")}>{busy ? "Reassigning…" : `Reassign to ${sel}`}</button>
                      <button onClick={() => setReassignFrom(null)} disabled={busy} style={S.btn("#E2E8F0", "#0F172A")}>Cancel</button>
                    </div>
                  </div>
                )}
                {linkResult && (
                  <div style={{ marginTop: 12, padding: 12, background: "#FFF", border: "1px solid #BFDBFE", borderRadius: 8 }}>
                    <div style={{ fontSize: 13, color: "#15803D", fontWeight: 600, marginBottom: 6 }}>
                      ✓ {linkResult.email} {linkResult.movedFrom ? `reassigned from ${linkResult.movedFrom} to` : "linked to"} {linkResult.client} as {linkResult.roleLabel}.
                      {linkResult.movedFrom ? "" : (linkResult.created ? (linkResult.emailSent ? " Login created and invite email sent." : " Login created.") : " (login already existed)")}
                    </div>
                    {linkResult.setupLink ? (
                      <div>
                        <div style={{ fontSize: 12, color: "#475569", marginBottom: 6 }}>
                          Send them this one-time set-password link{linkResult.emailSent ? " (in case the email doesn't arrive)" : ""}:
                        </div>
                        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                          <input readOnly value={linkResult.setupLink} onFocus={(e) => e.target.select()} style={{ ...S.input, flex: 1, minWidth: 260, fontSize: 12 }} />
                          <button onClick={() => { (navigator.clipboard && navigator.clipboard.writeText(linkResult.setupLink)); flash({ ok: "Setup link copied." }); }} style={S.btn(ACCENT, "#FFF")}>Copy link</button>
                        </div>
                      </div>
                    ) : (
                      <div style={{ fontSize: 12, color: "#B45309" }}>Couldn't generate a setup link — have them use the portal's “Forgot password” to set one.</div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {delOpen && (
          <div style={{ ...S.card, background: "#FEF2F2", border: "1px solid #FECACA" }}>
            <div style={S.h2}>⚠️ Delete builder</div>
            {!sel ? (
              <div style={{ fontSize: 13, color: "#B91C1C" }}>Select a builder above first.</div>
            ) : (
              <div>
                <div style={{ fontSize: 13, color: "#7F1D1D", marginBottom: 10, lineHeight: 1.5 }}>
                  This permanently deletes <b>{sel}</b> and <b>all of its data</b> — designs/leads, building styles &amp; sizes,
                  pricing &amp; inclusions, layout items, settings (incl. GHL credentials), error logs, owner/team logins, and
                  uploaded floor-plan &amp; branding files. <b>This cannot be undone.</b> (GoHighLevel contacts/estimates live in
                  GHL and are not affected.)
                </div>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                  <input value={delConfirm} onChange={(e) => setDelConfirm(e.target.value)} placeholder={`Type "${sel}" to confirm`}
                    onKeyDown={(e) => e.key === "Enter" && delConfirm.trim() === sel && deleteClient()} style={{ ...S.input, minWidth: 260 }} />
                  <button onClick={deleteClient} disabled={busy || delConfirm.trim() !== sel}
                    style={S.btn(busy || delConfirm.trim() !== sel ? "#9CA3AF" : "#DC2626", "#FFF")}>{busy ? "Deleting…" : "Delete permanently"}</button>
                </div>
              </div>
            )}
          </div>
        )}

        {tab === "master" && master && (
          <div style={S.card}>
            <div style={S.h2}>🧱 Master layout items</div>
            {master.layoutItemTypes.map((it) => (
              <div key={it.item_key} style={S.row}>
                <span style={{ fontSize: 16, display: "inline-flex", alignItems: "center" }}>{layoutItemGlyph(it)}</span>
                <b style={{ minWidth: 120 }}>{it.item_key}</b>
                <span style={{ color: "#64748B" }}>{it.label}</span>
                <span style={{ marginLeft: "auto", fontSize: 11, color: "#94A3B8" }}>
                  {it.default_width}×{it.default_height}ft {it.wall_only ? "· wallOnly" : ""}{it.wall_snap ? "· wallSnap" : ""}{it.door_snap ? "· doorSnap" : ""}{it.active ? "" : " · INACTIVE"}
                </span>
              </div>
            ))}
            <div style={{ fontSize: 12, color: "#64748B", marginTop: 12 }}>Global layout-item defaults. Per-builder building styles &amp; sizes live under the <b>Building Styles</b> and <b>CSV / Pricing</b> tabs; new builders are seeded with the <b>Clone</b> feature.</div>
          </div>
        )}

        {tab !== "master" && !sel && <div style={S.card}>Select a builder above to manage their styles and items.</div>}


        {tab === "items" && sel && cat && master && (() => {
          const saved = new Set((cat.clientLayoutItems || []).filter((i) => i.active).map((i) => i.item_key));
          const pending = (master.layoutItemTypes || []).reduce((acc, it) => acc + ((itemSel.has(it.item_key) !== saved.has(it.item_key)) ? 1 : 0), 0);
          return (
          <div style={S.card}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <div style={{ ...S.h2, marginBottom: 0 }}>Layout items for <span style={{ color: ACCENT }}>{sel}</span></div>
              <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
                <button onClick={selectAllItems} disabled={busy} style={S.btn("#F1F5F9", "#334155")}>Select all</button>
                <button onClick={clearAllItems} disabled={busy} style={S.btn("#F1F5F9", "#334155")}>Clear</button>
                <button onClick={saveItems} disabled={busy || pending === 0} style={S.btn(busy || pending === 0 ? "#9CA3AF" : ACCENT, "#FFF")}>
                  {busy ? "Saving…" : (pending > 0 ? `Save (${pending})` : "Saved")}
                </button>
              </div>
            </div>
            <div style={{ fontSize: 12, color: "#64748B", margin: "8px 0 10px" }}>Tick the placeable items this builder gets, then click <b>Save</b> to apply them all at once.</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {master.layoutItemTypes.map((it) => {
                const on = itemSel.has(it.item_key);
                return (
                  <div key={it.item_key} style={S.pill(on)}
                    onClick={() => !busy && toggleItemSel(it.item_key)}>
                    <span style={{ marginRight: 6, display: "inline-flex", alignItems: "center", verticalAlign: "middle" }}>{layoutItemGlyph(it)}</span>{it.label} {on ? "✓" : ""}
                  </div>
                );
              })}
            </div>
            {pending > 0 && <div style={{ fontSize: 12, color: ACCENT, fontWeight: 700, marginTop: 10 }}>{pending} unsaved change{pending === 1 ? "" : "s"} — click Save to apply.</div>}
          </div>
          );
        })()}

        {tab === "styles" && sel && cat && master && (
          <div style={S.card}>
            <div style={S.h2}>Building styles for <span style={{ color: ACCENT }}>{sel}</span></div>

            {/* This client's own styles (created here or assigned from master) */}
            <span style={S.lbl}>This builder's styles</span>
            {(cat.buildingStyles || []).length === 0 &&
              <div style={{ color: "#94A3B8", fontSize: 13, padding: "6px 0" }}>None yet — create one below.</div>}
            {(cat.buildingStyles || []).map((row) => {
              const sizes = (cat.buildingSizes || []).filter((z) => z.style_id === row.id);
              return (
                <div key={row.id} style={{ borderBottom: "1px solid #F1F5F9", padding: "10px 0" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    {row.image_url
                      ? <img src={row.image_url} alt={row.label} style={{ width: 40, height: 40, borderRadius: 6, objectFit: "cover", flexShrink: 0 }} />
                      : <div style={{ width: 40, height: 40, borderRadius: 6, background: "#F1F5F9", flexShrink: 0 }} />}
                    <div style={{ display: "flex", flexDirection: "column" }}>
                      <b>{row.label}</b>
                      <span style={{ fontSize: 11, color: "#94A3B8" }}>{row.key} · {row.client_id}</span>
                    </div>
                    <div style={{ marginLeft: "auto" }}>
                      <div style={S.pill(row.active)} onClick={() => !busy && act("save_style", { clientId: sel, styleKey: row.key, active: !row.active }, row.active ? "Hidden" : "Shown")}>
                        {row.active ? "✓ Active" : "Hidden"}
                      </div>
                    </div>
                  </div>
                  {sizes.length > 0 && (
                    <div style={{ marginTop: 8, paddingLeft: 50 }}>
                      <span style={S.lbl}>Sizes &amp; base prices</span>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                        {sizes.map((z) => (
                          <span key={z.id} style={{ fontSize: 12, padding: "3px 8px", borderRadius: 6, background: z.active ? "#F1F5F9" : "#FEF2F2", color: z.active ? "#334155" : "#B91C1C" }}>
                            {z.label}: {z.base_price == null ? "—" : "$" + z.base_price}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {/* Create a new per-client style (name + image) */}
            <div style={{ marginTop: 16, padding: 12, background: "#DBEAFF", border: "1px solid #75E6DA", borderRadius: 8 }}>
              <span style={S.lbl}>Create a new style for this builder</span>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6, flexWrap: "wrap" }}>
                <input value={newStyleName} onChange={(e) => setNewStyleName(e.target.value)} placeholder="Style name (e.g. Garage)" style={{ ...S.input, minWidth: 200 }} />
                <input key={fileKey} type="file" accept="image/*" onChange={(e) => onPickStyleImg(e.target.files && e.target.files[0])} style={{ fontSize: 12 }} />
                {newStyleImg && <img src={newStyleImg.base64} alt="" style={{ width: 36, height: 36, borderRadius: 6, objectFit: "cover" }} />}
                <button onClick={createStyle} disabled={busy || !newStyleName.trim()} style={S.btn(busy || !newStyleName.trim() ? "#9CA3AF" : ACCENT, "#FFF")}>Create style</button>
              </div>
              <div style={{ fontSize: 11, color: "#1B7895", marginTop: 6 }}>Add sizes &amp; prices afterward via CSV import. Styles are private to this builder.</div>
            </div>

          </div>
        )}

        {tab === "csv" && sel && cat && (
          <div style={S.card}>
            <div style={S.h2}>CSV pricing &amp; inclusions for <span style={{ color: ACCENT }}>{sel}</span></div>
            <div style={{ fontSize: 13, color: "#475569", marginBottom: 12, lineHeight: 1.5 }}>
              Download the template (one row per style, pre-filled with any existing sizes), then add a row for every
              size: type <b>width</b> and <b>length</b> (feet) and the <b>price</b>. The option columns hold the
              <b> quantity included in the price</b> — loft = included <b>sq ft</b> (e.g. 50), doors/windows = <b>count</b>
              (e.g. 1); <b>0</b> = not included (charged). Declined included items credit quantity × rate on the estimate.
              Sizes are created/updated on upload, matched by style + width + length (no duplicates).
              <b> Styles must exist first</b> (Building Styles tab). A blank price — or <b>active = no</b> — hides that size.
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <button onClick={downloadTemplate} style={S.btn("#F1F5F9", "#334155")}>⬇ Download template</button>
              <label style={{ ...S.btn(csvBusy ? "#9CA3AF" : ACCENT, "#FFF"), cursor: csvBusy ? "default" : "pointer", display: "inline-block" }}>
                {csvBusy ? "Importing…" : "⬆ Upload filled CSV"}
                <input type="file" accept=".csv,text/csv" disabled={csvBusy} style={{ display: "none" }}
                  onChange={(e) => { const f = e.target.files && e.target.files[0]; e.target.value = ""; onUploadCsv(f); }} />
              </label>
            </div>
            {csvResult && (
              <div style={{ marginTop: 14, fontSize: 13 }}>
                <div style={{ color: "#15803D", fontWeight: 700 }}>✓ Imported {csvResult.imported} row(s).</div>
                {csvResult.skipped && csvResult.skipped.length > 0 && (
                  <div style={{ marginTop: 6 }}>
                    <div style={{ color: "#B91C1C", fontWeight: 700 }}>{csvResult.skipped.length} row(s) skipped:</div>
                    <ul style={{ margin: "4px 0 0 18px", color: "#B91C1C", maxHeight: 160, overflow: "auto" }}>
                      {csvResult.skipped.slice(0, 30).map((s, i) => <li key={i}>{s}</li>)}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Email Sender card (operator-global) — HIDDEN FOR NOW via SHOW_EMAIL_SENDER
            (flip the flag near the top to true to restore). Connects a Google account so
            the portal's login / invite / password-reset emails send from it, not Supabase. */}
        {SHOW_EMAIL_SENDER && (
        <div style={{ ...S.card, marginTop: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <div style={{ ...S.h2, marginBottom: 0 }}>📧 Email Sender</div>
            <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
              {emailSender && emailSender.connected &&
                <button onClick={disconnectEmail} disabled={emailBusy} style={S.btn("#FEE2E2", "#B91C1C")}>{emailBusy ? "…" : "Disconnect"}</button>}
              <button onClick={() => setEmailOpen((o) => !o)} style={S.btn(emailOpen ? "#F1F5F9" : ACCENT, emailOpen ? "#334155" : "#FFF")}>
                {emailOpen ? "Cancel" : (emailSender && emailSender.connected ? "Reconnect Google account" : "Connect Google account")}
              </button>
            </div>
          </div>
          <div style={{ fontSize: 13, color: "#475569", marginTop: 8, lineHeight: 1.5 }}>
            {emailSender && emailSender.error
              ? <span style={{ color: "#B45309" }}>⚠ Couldn't read email status: {emailSender.error}</span>
              : emailSender && emailSender.connected
                ? <span>Portal login &amp; invite emails send from <b style={{ color: ACCENT }}>{emailSender.senderEmail}</b>.</span>
                : <span>Not connected — login &amp; invite emails use the <b>Supabase default sender</b>. Connect a Google account to send them from your own address.</span>}
          </div>
          {emailSender && emailSender.connected && !emailOpen && (
            <div style={{ marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <input value={emailTestTo} onChange={(e) => setEmailTestTo(e.target.value)} placeholder="send a test to an owner/operator login email"
                autoComplete="off" onKeyDown={(e) => e.key === "Enter" && emailTestTo.trim() && sendTestEmail()} style={{ ...S.input, minWidth: 300 }} />
              <button onClick={sendTestEmail} disabled={emailTestBusy || !emailTestTo.trim()}
                style={S.btn(emailTestBusy || !emailTestTo.trim() ? "#9CA3AF" : "#F1F5F9", emailTestBusy || !emailTestTo.trim() ? "#FFF" : "#334155")}>
                {emailTestBusy ? "Sending…" : "Send test email"}
              </button>
            </div>
          )}
          {emailOpen && (
            <div style={{ marginTop: 12, padding: 12, background: "#DBEAFF", border: "1px solid #75E6DA", borderRadius: 8 }}>
              <div style={{ fontSize: 12, color: "#475569", marginBottom: 8, lineHeight: 1.5 }}>
                Enter the Google account and its <b>app password</b> (Google Account → Security → 2-Step Verification → App passwords).
                2-step verification must be on. The password is stored securely server-side and never shown again.
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                <input value={emailAddr} onChange={(e) => setEmailAddr(e.target.value)} placeholder="name@yourdomain.com" autoComplete="off" style={{ ...S.input, minWidth: 240 }} />
                <PasswordInput value={emailPwd} onChange={(e) => setEmailPwd(e.target.value)} placeholder="paste the 16-char app password" autoComplete="new-password"
                  onKeyDown={(e) => e.key === "Enter" && emailAddr.trim() && emailPwd.trim() && connectEmail()} style={S.input} wrapStyle={{ minWidth: 240 }} />
                <button onClick={connectEmail} disabled={emailBusy || !emailAddr.trim() || !emailPwd.trim()}
                  style={S.btn(emailBusy || !emailAddr.trim() || !emailPwd.trim() ? "#9CA3AF" : ACCENT, "#FFF")}>{emailBusy ? "Connecting…" : "Connect & save"}</button>
              </div>
            </div>
          )}
        </div>
        )}
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<AdminApp />);

// The boot guard's DOMContentLoaded check reads this sentinel: a compiled app
// script that ran to completion is the definition of "the app booted". Without
// it, a 404'd or syntax-broken app artifact was a silent blank page - the one
// failure class the old inline-babel world could not even see.
window.__ssAppBooted = true;
