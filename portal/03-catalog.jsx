// ─── Settings (via portal-settings edge function; API key is write-only) ───
function SettingsView({ section }) {
  // Which settings cards to render: "connection" (GHL creds + pipeline mapping)
  // or "branding" (customer-link look & feel + business details + pricing
  // display + testing). No section = all (legacy). Form state always covers
  // every field (prefilled from status), so the global save stays safe no
  // matter which section is on screen.
  const show = (k) => !section || section === k;
  const [status, setStatus] = useState(null);   // response of action:"status"
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  // GHL credential inputs are intentionally NOT prefilled: location id + API key
  // come back masked/withheld, so prefilling would save the mask back. Leave
  // blank = keep current value.
  const [ghlLocationId, setGhlLocationId] = useState("");
  const [ghlApiKey, setGhlApiKey] = useState("");
  const [ghlBusy, setGhlBusy] = useState(false);
  const [ghlMsg, setGhlMsg] = useState(null);   // { ok } | { err }
  // CRM (GoHighLevel) pipelines + stages for the (post-connect) dropdowns. Fetched via
  // the edge fn using the stored key — the browser never holds it.
  const [pipelines, setPipelines] = useState([]);   // [{id,name,stages:[{id,name}]}]
  const [pipesBusy, setPipesBusy] = useState(false);   // loading pipelines
  const [pipesSaving, setPipesSaving] = useState(false);
  const [pipesMsg, setPipesMsg] = useState(null);   // { ok } | { err }
  const [form, setForm] = useState({
    ghlPipelineId: "", ghlStageSendQuoteId: "",
    ghlStageAcceptedId: "", ghlStageInvoicedId: "", ghlStageDeliveredId: "",
    ghlPipelineAcceptedId: "", ghlPipelineInvoicedId: "", ghlPipelineDeliveredId: "",
    businessName: "", businessPhone: "", businessWebsite: "", businessLogoUrl: "",
    addr1: "", addrCity: "", addrState: "", addrZip: "",
    quoteTerms: "", betaMode: false, betaEmail: "", showPricing: false,
    // designer branding (client_configs — drives the public ?client= link)
    brandName: "", brandTagline: "", brandAccent: "#D97706", brandHeaderBg: "#1E293B",
  });
  const set = (k) => (e) => {
    const v = e && e.target ? (e.target.type === "checkbox" ? e.target.checked : e.target.value) : e;
    setForm((p) => ({ ...p, [k]: v }));
  };
  // Branding logo upload state (separate save → client_configs via save_branding)
  const [logoDataUrl, setLogoDataUrl] = useState("");   // new upload preview/payload
  const [logoCt, setLogoCt] = useState("");
  const [currentLogo, setCurrentLogo] = useState(null);  // saved logo from status
  const [brandBusy, setBrandBusy] = useState(false);
  const [brandMsg, setBrandMsg] = useState(null);
  const onLogoFile = (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    if (f.size > 2_000_000) { setBrandMsg({ err: "Logo must be under 2MB." }); return; }
    const r = new FileReader();
    r.onload = () => { setLogoDataUrl(r.result); setLogoCt(f.type || "image/png"); setBrandMsg(null); };
    r.readAsDataURL(f);
  };
  // `clearLogo` is a THIRD state, distinct from "no new file picked". save_branding only
  // touches logo_url when the payload carries logoBase64 or logoUrl, so an ordinary save
  // leaves the saved logo alone — which is right, and is also why there was no way to get
  // rid of one: a logo could be replaced forever but never removed. An explicit empty
  // `logoUrl` is the server's own clear path (see its `else if ("logoUrl" in payload)`).
  const [clearLogo, setClearLogo] = useState(false);
  const saveBranding = async () => {
    setBrandBusy(true); setBrandMsg(null);
    const body = { action: "save_branding", companyName: form.brandName, tagline: form.brandTagline,
      accentColor: form.brandAccent, headerBg: form.brandHeaderBg };
    if (logoDataUrl) { body.logoBase64 = logoDataUrl; body.logoContentType = logoCt; }
    else if (clearLogo) { body.logoUrl = ""; }
    const { data, error: err } = await sb.functions.invoke("portal-settings", { body });
    setBrandBusy(false);
    if (err || (data && data.error)) { setBrandMsg({ err: (data && data.error) || err.message }); return; }
    setBrandMsg({ ok: clearLogo && !logoDataUrl ? "Branding saved — your logo was removed, so the designer shows your company initials." : "Branding saved — your designer link now reflects it." });
    if (data.logoUrl) setCurrentLogo(data.logoUrl);
    if (clearLogo && !logoDataUrl) setCurrentLogo(null);
    setLogoDataUrl(""); setLogoCt(""); setClearLogo(false);
  };
  // Business-logo (estimates) upload → uploads to the branding bucket and fills
  // the Logo URL field with the public URL; persisted by the normal Save action.
  const [bizLogoBusy, setBizLogoBusy] = useState(false);
  const onBizLogoFile = (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    if (f.size > 2_000_000) { setError("Logo must be under 2MB."); return; }
    const r = new FileReader();
    r.onload = async () => {
      setBizLogoBusy(true); setError(null);
      const { data, error: err } = await sb.functions.invoke("portal-settings", { body: { action: "upload_logo", kind: "business", logoBase64: r.result, logoContentType: f.type || "image/png" } });
      setBizLogoBusy(false);
      if (err || (data && data.error)) { setError((data && data.error) || err.message); return; }
      setForm((p) => ({ ...p, businessLogoUrl: data.url }));
    };
    r.readAsDataURL(f);
  };

  useEffect(() => {
    (async () => {
      const { data, error: err } = await sb.functions.invoke("portal-settings", { body: { action: "status" } });
      if (err || (data && data.error)) { setError((data && data.error) || err.message); return; }
      if (!data) { setError("Couldn't load settings (empty response). Please refresh."); return; }
      setStatus(data);
      if (data.configured) loadPipelines();   // connected → populate the pipeline/stage dropdowns
      const a = data.businessAddress || {};
      const b = data.branding || {};
      setCurrentLogo(b.logoUrl || null);
      setForm({
        ghlPipelineId: data.ghlPipelineId || "",
        ghlStageSendQuoteId: data.ghlStageSendQuoteId || "",
        ghlStageAcceptedId: data.ghlStageAcceptedId || "",
        ghlStageInvoicedId: data.ghlStageInvoicedId || "",
        ghlStageDeliveredId: data.ghlStageDeliveredId || "",
        businessName: data.businessName || "",
        businessPhone: data.businessPhone || "",
        businessWebsite: data.businessWebsite || "",
        businessLogoUrl: data.businessLogoUrl || "",
        addr1: a.addressLine1 || "", addrCity: a.city || "", addrState: a.state || "", addrZip: a.postalCode || "",
        quoteTerms: data.quoteTerms || "",
        betaMode: Boolean(data.betaMode), betaEmail: data.betaEmail || "", showPricing: Boolean(data.showPricing),
        brandName: b.companyName || "", brandTagline: b.tagline || "",
        brandAccent: b.accentColor || "#D97706", brandHeaderBg: b.headerBg || "#1E293B",
      });
    })();
  }, []);

  const save = async (e) => {
    e.preventDefault();
    setError(null); setSaved(false);
    // Caught here as well as server-side so the owner is stopped at the control they just
    // touched, rather than after a round trip. The server check is the one that counts.
    if (form.betaMode && !ssIsEmail(form.betaEmail)) {
      setError("Beta mode needs a working test inbox — that's the address estimates go to instead of your customers. Add one, or turn beta mode off.");
      return;
    }
    setBusy(true);
    const hasAddr = form.addr1 || form.addrCity || form.addrState || form.addrZip;
    const body = {
      action: "save",
      businessName: form.businessName,
      businessPhone: form.businessPhone,
      businessWebsite: form.businessWebsite,
      businessLogoUrl: form.businessLogoUrl,
      businessAddress: hasAddr ? { addressLine1: form.addr1, city: form.addrCity, state: form.addrState, postalCode: form.addrZip, countryCode: "US" } : null,
      quoteTerms: form.quoteTerms,
      betaMode: form.betaMode,
      betaEmail: form.betaEmail,
      showPricing: form.showPricing,
    };
    const { data, error: err } = await sb.functions.invoke("portal-settings", { body });
    setBusy(false);
    if (err || (data && data.error)) { setError((data && data.error) || err.message); return; }
    setSaved(true);
    // refresh masked status
    const { data: st } = await sb.functions.invoke("portal-settings", { body: { action: "status" } });
    if (st && !st.error) setStatus(st);
  };

  // GHL connection: verify the location id + API key against GoHighLevel and save
  // only if they're valid. Location/key fall back to the stored values when left
  // blank. Also surfaces a warning when the location has no users (estimates would
  // fail) or no products (line items unpriced).
  const saveGhl = async () => {
    setGhlMsg(null); setGhlBusy(true);
    // Connection step handles credentials only; pipeline + stages are configured
    // in the "Pipeline & Stages" card that appears once connected.
    const body = { action: "verify_save_ghl" };
    if (ghlLocationId.trim()) body.ghlLocationId = ghlLocationId.trim();
    if (ghlApiKey.trim()) body.ghlApiKey = ghlApiKey.trim();
    const { data, error: err } = await sb.functions.invoke("portal-settings", { body });
    setGhlBusy(false);
    if (err || (data && data.error)) { setGhlMsg({ err: (data && data.error) || (err && err.message) || "Verification failed." }); return; }
    setGhlMsg({ ok: data.warning ? `Verified & saved. ${data.warning}` : "Verified & saved — the connection works.", warn: Boolean(data.warning) });
    setGhlApiKey(""); setGhlLocationId("");
    const { data: st } = await sb.functions.invoke("portal-settings", { body: { action: "status" } });
    if (st && !st.error) setStatus(st);
    loadPipelines();   // now connected → load pipelines/stages for the dropdowns
  };

  // Fetch this tenant's CRM (GoHighLevel) pipelines + stages (server-side, using the
  // stored key) to populate the dropdowns. Re-run by the "Refresh" button.
  const loadPipelines = async () => {
    setPipesBusy(true); setPipesMsg(null);
    const { data, error: err } = await sb.functions.invoke("portal-settings", { body: { action: "list_ghl_pipelines" } });
    setPipesBusy(false);
    if (err || (data && data.error)) { setPipesMsg({ err: (data && data.error) || (err && err.message) || "Couldn't load pipelines." }); return; }
    setPipelines(Array.isArray(data.pipelines) ? data.pipelines : []);
  };

  // Save just the pipeline + stage selection (no re-verify of credentials).
  const savePipelines = async () => {
    setPipesSaving(true); setPipesMsg(null);
    const { data, error: err } = await sb.functions.invoke("portal-settings", {
      body: {
        action: "save",
        ghlPipelineId: form.ghlPipelineId,
        ghlStageSendQuoteId: form.ghlStageSendQuoteId,
        ghlStageAcceptedId: form.ghlStageAcceptedId,
        ghlStageInvoicedId: form.ghlStageInvoicedId,
        ghlStageDeliveredId: form.ghlStageDeliveredId,
      },
    });
    setPipesSaving(false);
    if (err || (data && data.error)) { setPipesMsg({ err: (data && data.error) || (err && err.message) || "Save failed." }); return; }
    setPipesMsg({ ok: "Pipeline & stages saved." });
    const { data: st } = await sb.functions.invoke("portal-settings", { body: { action: "status" } });
    if (st && !st.error) setStatus(st);
  };

  // The 4 fulfillment stages map to GHL pipeline stages, each optionally in a DIFFERENT
  // pipeline. "Send Quote" also needs its PIPELINE persisted (submit-estimate places the opp
  // there → ghl_pipeline_id). Accepted/Invoiced/Delivered are matched by their globally-unique
  // STAGE id, so only the stage id is persisted; their pipeline dropdown is UI-only, derived
  // from the saved stage id (fallback: the send-quote pipeline).
  const selectedPipeline = pipelines.find((p) => p.id === form.ghlPipelineId) || null;
  const stageOptions = selectedPipeline ? selectedPipeline.stages : [];
  const onPipelineChange = (e) => {
    const pid = e.target.value;
    const ids = new Set(((pipelines.find((x) => x.id === pid) || {}).stages || []).map((s) => s.id));
    setForm((prev) => ({ ...prev, ghlPipelineId: pid,
      ghlStageSendQuoteId: ids.has(prev.ghlStageSendQuoteId) ? prev.ghlStageSendQuoteId : "" }));
  };
  // Render one derived-pipeline stage-mapping row (Accepted / Invoiced / Delivered).
  const derivedRow = (title, transientPipeKey, stageKey) => {
    const pid = form[transientPipeKey]
      || (pipelines.find((p) => (p.stages || []).some((s) => s.id === form[stageKey])) || {}).id
      || form.ghlPipelineId;
    const opts = (pipelines.find((p) => p.id === pid) || {}).stages || [];
    const onPipe = (e) => {
      const np = e.target.value;
      const ids = new Set(((pipelines.find((x) => x.id === np) || {}).stages || []).map((s) => s.id));
      setForm((prev) => ({ ...prev, [transientPipeKey]: np, [stageKey]: ids.has(prev[stageKey]) ? prev[stageKey] : "" }));
    };
    return (
      <div style={{ border: "1px solid #E2E8F0", borderRadius: 8, padding: 12 }}>
        <div style={{ ...S.lbl, marginBottom: 8 }}>{title}</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
          <div><span style={S.lbl}>Pipeline</span>
            <select style={S.input} value={pid} onChange={onPipe}>
              <option value="">— None —</option>
              {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              {pid && !pipelines.some((p) => p.id === pid) && <option value={pid}>saved: {pid} (refresh to update)</option>}
            </select></div>
          <div><span style={S.lbl}>Stage</span>
            <select style={S.input} value={form[stageKey]} onChange={set(stageKey)} disabled={!pid}>
              <option value="">— None —</option>
              {opts.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              {form[stageKey] && !opts.some((s) => s.id === form[stageKey]) && <option value={form[stageKey]}>saved: {form[stageKey]}</option>}
            </select></div>
        </div>
      </div>
    );
  };

  if (!status && !error) return <div style={S.card}><p style={{ fontSize: 13, color: "#64748B" }}>Loading settings…</p></div>;

  return (
    <form onSubmit={save} autoComplete="off">
      {error && <div style={S.err}>{error}</div>}
      {saved && <div style={S.okMsg}>Settings saved.</div>}

      {show("connection") && (<>
      <div style={S.card}>
        <div style={S.h2}>CRM Connection</div>
        <p style={{ fontSize: 12, color: "#64748B", marginBottom: 12 }}>
          {status && status.configured
            ? <>Connected — location <b>{status.ghlLocationIdMasked}</b>. Leave the fields blank to keep current credentials.</>
            : <>Not connected yet. Estimates can't be sent until your CRM Location ID and API key are saved.</>}
        </p>
        {ghlMsg && ghlMsg.err && <div style={S.err}>{ghlMsg.err}</div>}
        {ghlMsg && ghlMsg.ok && <div style={ghlMsg.warn ? { ...S.okMsg, background: "#DBEAFF", color: "#1B7895", border: "1px solid #75E6DA" } : S.okMsg}>{ghlMsg.ok}</div>}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
          <div><span style={S.lbl}>CRM Location ID</span>
            <input style={S.input} name="ss-ghl-location-id" autoComplete="off" data-lpignore="true" data-1p-ignore data-form-type="other" spellCheck={false} value={ghlLocationId} onChange={(e) => setGhlLocationId(e.target.value)} placeholder={status && status.ghlLocationIdMasked ? `saved: ${status.ghlLocationIdMasked}` : "e.g. sp58arigVfqozsJSPe1z"} /></div>
          <div><span style={S.lbl}>CRM API Key</span>
            <PasswordInput style={S.input} name="ss-ghl-api-key" autoComplete="new-password" data-lpignore="true" data-1p-ignore data-form-type="other" value={ghlApiKey} onChange={(e) => setGhlApiKey(e.target.value)} placeholder={status && status.hasApiKey ? "•••• saved — type to replace" : "pit-…"} /></div>
        </div>
        <button type="button" onClick={saveGhl} disabled={ghlBusy} style={{ ...S.btn(ACCENT, "#FFF"), marginTop: 12, opacity: ghlBusy ? 0.6 : 1 }}>{ghlBusy ? "Verifying…" : "Verify & Save Connection"}</button>
        <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 6 }}>Checks the Location ID + API key against your CRM and saves only if they work. Once connected, choose your pipeline &amp; stages below. (On Synergy or another GoHighLevel-based CRM, both values come from your sub-account settings.)</div>
      </div>

      {status && status.configured && (
        <div style={S.card}>
          <div style={S.h2}>Pipeline &amp; Stages</div>
          <p style={{ fontSize: 12, color: "#64748B", marginBottom: 12 }}>
            Map each fulfillment stage to a pipeline stage in your CRM. StructureStudio places a new deal at your
            <b> "Send Quote"</b> stage; then the badge in your Contacts list advances <b>Quote Accepted → Invoiced →
            Delivered</b> as you move that opportunity into the matching stage in your CRM. Each stage can live
            in a <b>different pipeline</b> (e.g. Send Quote in "Building", Invoiced/Delivered in "Invoiced"). All
            optional — leave any blank to skip that stage.
          </p>
          {pipesMsg && pipesMsg.err && <div style={S.err}>{pipesMsg.err}</div>}
          {pipesMsg && pipesMsg.ok && <div style={S.okMsg}>{pipesMsg.ok}</div>}
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
            <button type="button" onClick={loadPipelines} disabled={pipesBusy} style={{ ...S.btn("#FFFFFF", ACCENT), border: `1px solid ${ACCENT}`, opacity: pipesBusy ? 0.6 : 1 }}>
              {pipesBusy ? "Refreshing…" : "↻ Refresh from CRM"}
            </button>
            <span style={{ fontSize: 11, color: "#94A3B8" }}>Pulls the latest pipelines &amp; stages from your connected account.</span>
          </div>
          {!pipesBusy && pipelines.length === 0 && !(pipesMsg && pipesMsg.err) && (
            <p style={{ fontSize: 12, color: "#94A3B8", marginBottom: 12 }}>No pipelines loaded yet — click Refresh (or this location has none).</p>
          )}
          <div className="ss-stage-grid">
          {/* Send Quote — its own pipeline + stage (where new estimates land; persisted as ghl_pipeline_id + ghl_stage_send_quote_id) */}
          <div style={{ border: "1px solid #E2E8F0", borderRadius: 8, padding: 12 }}>
            <div style={{ ...S.lbl, marginBottom: 8 }}>Send Quote — where new estimates land</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
              <div><span style={S.lbl}>Pipeline</span>
                <select style={S.input} value={form.ghlPipelineId} onChange={onPipelineChange}>
                  <option value="">— None (skip pipeline automation) —</option>
                  {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  {form.ghlPipelineId && !pipelines.some((p) => p.id === form.ghlPipelineId) &&
                    <option value={form.ghlPipelineId}>saved: {form.ghlPipelineId} (refresh to update)</option>}
                </select></div>
              <div><span style={S.lbl}>Stage</span>
                <select style={S.input} value={form.ghlStageSendQuoteId} onChange={set("ghlStageSendQuoteId")} disabled={!form.ghlPipelineId}>
                  <option value="">— None —</option>
                  {stageOptions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  {form.ghlStageSendQuoteId && !stageOptions.some((s) => s.id === form.ghlStageSendQuoteId) &&
                    <option value={form.ghlStageSendQuoteId}>saved: {form.ghlStageSendQuoteId}</option>}
                </select></div>
            </div>
          </div>
          {derivedRow("Quote Accepted — customer accepted the estimate", "ghlPipelineAcceptedId", "ghlStageAcceptedId")}
          {derivedRow("Invoiced — an invoice was sent", "ghlPipelineInvoicedId", "ghlStageInvoicedId")}
          {derivedRow("Delivered — marks the Delivered badge", "ghlPipelineDeliveredId", "ghlStageDeliveredId")}
          </div>
          <button type="button" onClick={savePipelines} disabled={pipesSaving} style={{ ...S.btn(ACCENT, "#FFF"), marginTop: 12, opacity: pipesSaving ? 0.6 : 1 }}>
            {pipesSaving ? "Saving…" : "Save Pipeline & Stages"}
          </button>
        </div>
      )}
      </>)}

      {show("branding") && (
      <div style={S.card}>
        <div style={S.h2}>Designer Branding (your customer link)</div>
        <p style={{ fontSize: 12, color: "#64748B", marginBottom: 12 }}>
          Shown on your public designer link.{status && status.clientId && <> <a href={`/?client=${status.clientId}`} target="_blank" rel="noreferrer" style={{ color: ACCENT, fontWeight: 700 }}>Preview ↗</a></>}
        </p>
        {brandMsg && brandMsg.err && <div style={S.err}>{brandMsg.err}</div>}
        {brandMsg && brandMsg.ok && <div style={S.okMsg}>{brandMsg.ok}</div>}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginBottom: 12 }}>
          <div><span style={S.lbl}>Company name</span><input style={S.input} value={form.brandName} onChange={set("brandName")} /></div>
          <div><span style={S.lbl}>Tagline</span><input style={S.input} value={form.brandTagline} onChange={set("brandTagline")} placeholder="Design & Quote" /></div>
          <div><span style={S.lbl}>Accent color</span>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="color" value={form.brandAccent} onChange={set("brandAccent")} style={{ width: 44, height: 34, border: "1px solid #CBD5E1", borderRadius: 6, background: "#FFF", cursor: "pointer" }} />
              <input style={{ ...S.input, flex: 1 }} value={form.brandAccent} onChange={set("brandAccent")} /></div></div>
          <div><span style={S.lbl}>Header background</span>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="color" value={form.brandHeaderBg} onChange={set("brandHeaderBg")} style={{ width: 44, height: 34, border: "1px solid #CBD5E1", borderRadius: 6, background: "#FFF", cursor: "pointer" }} />
              <input style={{ ...S.input, flex: 1 }} value={form.brandHeaderBg} onChange={set("brandHeaderBg")} /></div></div>
        </div>
        <div style={{ marginBottom: 12 }}>
          <span style={S.lbl}>Logo</span>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ width: 96, height: 64, borderRadius: 8, border: "1px solid #E2E8F0", background: form.brandHeaderBg, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", flexShrink: 0 }}>
              {(logoDataUrl || (currentLogo && !clearLogo))
                ? <img src={logoDataUrl || currentLogo} alt="logo" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
                : <span style={{ color: "#94A3B8", fontSize: 11 }}>no logo</span>}
            </div>
            <input key={clearLogo ? "cleared" : "picker"} type="file" accept="image/png,image/jpeg,image/webp"
              onChange={(e) => { setClearLogo(false); onLogoFile(e); }} style={{ fontSize: 12 }} />
            {/* Removal is staged, not immediate: it shares the Save Branding button with the
                rest of the card, so the preview shows what saving will do and the owner can
                back out. Picking a file cancels a pending removal (the `key` also resets the
                input so re-picking the same file still fires onChange). */}
            {(logoDataUrl || (currentLogo && !clearLogo)) && (
              <button type="button" onClick={() => { setLogoDataUrl(""); setLogoCt(""); if (currentLogo) setClearLogo(true); }}
                style={{ ...S.btn("#FEF2F2", "#DC2626"), whiteSpace: "nowrap" }}>Remove</button>
            )}
            {clearLogo && !logoDataUrl && (
              <button type="button" onClick={() => setClearLogo(false)}
                style={{ ...S.btn("#F1F5F9", "#334155"), whiteSpace: "nowrap" }}>Undo</button>
            )}
          </div>
          {clearLogo && !logoDataUrl && (
            <div style={{ fontSize: 11.5, color: "#B45309", background: "#FEF3C7", border: "1px solid #FDE68A", borderRadius: 8, padding: "7px 11px", marginTop: 6, lineHeight: 1.45 }}>
              Logo will be removed when you click <b>Save Branding</b> — your designer will show your company initials instead.
            </div>
          )}
          {/* No SVG: the upload actions in portal-settings deliberately allowlist raster
              types only (an SVG is a script-capable document, and this one is served from
              a public bucket onto the tenant's own designer page). The text used to offer
              it while both the input and the server refused it. */}
          <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 4 }}>PNG / JPG / WebP, under 2MB. Preview shows it on your header color.</div>
        </div>
        <button type="button" onClick={saveBranding} disabled={brandBusy} style={{ ...S.btn(ACCENT, "#FFF"), opacity: brandBusy ? 0.6 : 1 }}>{brandBusy ? "Saving…" : "Save Branding"}</button>
      </div>
      )}

      {show("branding") && (<>
      <div style={S.card}>
        <div style={S.h2}>Business Details (shown on estimates)</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginBottom: 12 }}>
          <div><span style={S.lbl}>Business name</span><input style={S.input} value={form.businessName} onChange={set("businessName")} /></div>
          <div><span style={S.lbl}>Phone</span><input style={S.input} value={form.businessPhone} onChange={set("businessPhone")} placeholder="+17075551234" /></div>
          <div><span style={S.lbl}>Website</span><input style={S.input} value={form.businessWebsite} onChange={set("businessWebsite")} placeholder="yourbusiness.com" /></div>
          <div><span style={S.lbl}>Logo URL</span>
            <input style={S.input} value={form.businessLogoUrl} onChange={set("businessLogoUrl")} placeholder="https://…/logo.png" />
            <div style={{ marginTop: 5, display: "flex", alignItems: "center", gap: 8 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: ACCENT, cursor: bizLogoBusy ? "wait" : "pointer" }}>
                {bizLogoBusy ? "Uploading…" : "⬆ Upload image"}
                <input type="file" accept="image/png,image/jpeg,image/webp" onChange={onBizLogoFile} disabled={bizLogoBusy} style={{ display: "none" }} />
              </label>
              <span style={{ fontSize: 11, color: "#94A3B8" }}>or paste a URL above</span>
              {form.businessLogoUrl && <img src={form.businessLogoUrl} alt="" style={{ height: 24, maxWidth: 90, objectFit: "contain", borderRadius: 4, border: "1px solid #E2E8F0" }} />}
            </div>
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
          <div><span style={S.lbl}>Street address</span><input style={S.input} value={form.addr1} onChange={set("addr1")} /></div>
          <div><span style={S.lbl}>City</span><input style={S.input} value={form.addrCity} onChange={set("addrCity")} /></div>
          <div><span style={S.lbl}>State</span><input style={S.input} value={form.addrState} onChange={set("addrState")} /></div>
          <div><span style={S.lbl}>Zip</span><input style={S.input} value={form.addrZip} onChange={set("addrZip")} /></div>
        </div>
        <div><span style={S.lbl}>Quote terms (printed on every estimate)</span>
          <textarea style={{ ...S.input, minHeight: 70, resize: "vertical", fontFamily: "inherit" }} value={form.quoteTerms} onChange={set("quoteTerms")} /></div>
      </div>

      <div style={S.card}>
        <div style={S.h2}>Pricing</div>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 600, color: "#1E293B" }}>
          <input type="checkbox" checked={form.showPricing} onChange={set("showPricing")} />
          Show pricing to customers on the design page
        </label>
        <p style={{ fontSize: 12, color: "#64748B", marginTop: 6, marginBottom: 0, lineHeight: 1.5 }}>
          When on, layout-item prices (e.g. rough openings) show on the customer designer. When off, customers see no prices there.
        </p>
      </div>

      {/* Testing. The checkbox states a real consequence: submit-estimate redirects the
          estimate email to `betaEmail` while this is on. It said so for a long time while
          doing nothing, which is how a verification quote reached a real customer — so the
          UI now refuses to arm the switch without an inbox, and the server refuses too
          (portal-settings' save guard + submit-estimate's pre-flight check). Three places,
          because the only failure that matters here is the silent one.
          Since the own-domain email work (2026-08-10), the redirect exists ONLY on the
          own-domain (Postmark) send path — the CRM/GHL path emails the customer regardless —
          and the copy below says so rather than promising a redirect that half the tenants
          don't get. */}
      <div style={S.card}>
        <div style={S.h2}>Testing</div>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 600, color: "#1E293B", marginBottom: 10 }}>
          <input type="checkbox" checked={form.betaMode} onChange={set("betaMode")} />
          Beta mode — when your own email domain is connected and active, estimate emails go to the test inbox below instead of customers. When sending through your CRM (the default), estimate emails always go to the customer.
        </label>
        <div style={{ maxWidth: 320 }}><span style={S.lbl}>Test inbox</span>
          <input style={S.input} type="email" value={form.betaEmail} onChange={set("betaEmail")} placeholder="you@yourbusiness.com" /></div>
        {form.betaMode && !ssIsEmail(form.betaEmail) && (
          <div style={{ marginTop: 10, background: "#FEF3C7", border: "1px solid #FDE68A", color: "#B45309", borderRadius: 8, padding: "9px 13px", fontSize: 12.5, fontWeight: 600, lineHeight: 1.5 }}>
            Beta mode needs a working test inbox before it can be saved. Until one is set,
            leave beta mode off — estimates would otherwise go to your customers.
          </div>
        )}
        {form.betaMode && ssIsEmail(form.betaEmail) && (
          <div style={{ marginTop: 10, background: "#EFF6FF", border: "1px solid #BFDBFE", color: "#1E3A8A", borderRadius: 8, padding: "9px 13px", fontSize: 12.5, fontWeight: 600, lineHeight: 1.5 }}>
            While this is on and your own email domain is active, <strong>every</strong> estimate
            goes to {form.betaEmail} — your customers receive nothing. Turn it off when you're
            done testing.
          </div>
        )}
      </div>

      <button type="submit" disabled={busy} style={{ ...S.btn(ACCENT, "#FFF"), opacity: busy ? 0.6 : 1, marginBottom: 24 }}>{busy ? "Saving…" : "Save Settings"}</button>
      </>)}
    </form>
  );
}

// ─── CSV helpers (RFC-4180-ish) ───
// Besides quoting, csvEscape neutralizes spreadsheet FORMULA INJECTION: a cell starting
// with = + - @ (or a tab/CR-led variant) gets a leading apostrophe — the standard
// mitigation — so a tenant-typed label like =HYPERLINK(...) can't execute when the CSV
// fallback is opened in Excel (audit 2026-08-20). Only these CSV paths need it; the
// primary .xlsx path is safe because ExcelJS writes strings as inline strings.
function csvEscape(v) {
  let s = String(v == null ? "" : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCSV(headers, rows) { return [headers, ...rows].map((r) => r.map(csvEscape).join(",")).join("\r\n"); }
function parseCSV(text) {
  const rows = []; let row = [], field = "", inQ = false;
  text = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; } else field += c; }
    else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ""));
}
function downloadFile(name, text) {
  const b = new Blob([text], { type: "text/csv;charset=utf-8" });
  downloadBlob(name, b);
}
function downloadBlob(name, blob) {
  const u = URL.createObjectURL(blob); const a = document.createElement("a");
  a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(u);
}

// ─── Excel (.xlsx) helpers ───
// ExcelJS is LAZY-LOADED (only when the pricing sheet is downloaded/uploaded) via dynamic script
// injection — deliberately NOT a static <script> tag, which the preflight's CDN version-lock
// check would flag (index/portal/admin.html must carry byte-identical CDN script tags). It's the
// one browser lib that can colour cells, which SheetJS's free build cannot.
let _exceljsPromise = null;
function loadExcelJS() {
  if (typeof window !== "undefined" && window.ExcelJS) return Promise.resolve(window.ExcelJS);
  if (_exceljsPromise) return _exceljsPromise;
  _exceljsPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js";
    s.crossOrigin = "anonymous";
    s.onload = () => {
      if (window.ExcelJS) { resolve(window.ExcelJS); return; }
      // Loaded-but-empty (e.g. a proxy served 200 HTML that ran without defining ExcelJS).
      // Clear the memo like onerror does — it used to cache this rejection for the whole
      // session, so every later export/import failed instantly even after connectivity
      // came back, and only a full reload recovered (audit 2026-08-20).
      _exceljsPromise = null;
      reject(new Error("The spreadsheet library didn't initialise (the download may have been altered by a proxy or captive portal) — try again."));
    };
    s.onerror = () => { _exceljsPromise = null; reject(new Error("Could not load the spreadsheet library — check your connection and try again.")); };
    document.head.appendChild(s);
  });
  return _exceljsPromise;
}
// A cell's plain text, tolerant of ExcelJS rich-text / formula / hyperlink cell shapes.
function xlsxCellText(v) {
  if (v == null) return "";
  if (typeof v === "object") {
    if (v.text != null) return String(v.text);
    if (v.result != null) return String(v.result);
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join("");
    if (v.hyperlink != null) return String(v.hyperlink);
    return "";
  }
  return String(v);
}
// Read the first worksheet of an .xlsx File into a row/col matrix of strings (same shape parseCSV returns).
async function readXlsxMatrix(file, ExcelJS) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await file.arrayBuffer());
  const ws = wb.worksheets[0];
  if (!ws) throw new Error("The spreadsheet has no sheets.");
  const sv = ws.getSheetValues(); // 1-indexed rows; each row is a 1-indexed array
  const matrix = [];
  for (let r = 1; r < sv.length; r++) {
    const row = sv[r]; if (!row) continue;
    const arr = [];
    for (let c = 1; c < row.length; c++) arr[c - 1] = xlsxCellText(row[c]);
    if (arr.some((x) => String(x).trim() !== "")) matrix.push(arr);
  }
  return matrix;
}

// ─── Billing (per-feature subscriptions via portal-billing; Deposyt/NMI gateway) ───
// Each feature (Simple Layout, RealTime Pricing, …) is its own recurring
// subscription, chosen monthly or yearly independently. Simple Layout is the
// required base; features not yet launched render with a COMING SOON overlay and
// can't be selected. Card entry happens in Collect.js's hosted lightbox (loaded
// from the gateway with the PUBLIC tokenization key) — card data never touches the
// portal or Supabase; a returning tenant's card on file (gateway vault) is reused
// so the lightbox only shows the first time.
function BillingView({ viewingLabel = null }) {
  const [data, setData] = useState(null);   // status response; null = loading
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);   // subscribe/cancel in flight
  const [msg, setMsg] = useState(null);      // { ok } | { err }
  const [sel, setSel] = useState({});        // feature -> "monthly" | "annual"
  const [crmIv, setCrmIv] = useState({});    // Synergy CRM tier -> "monthly" | "annual" (display only)

  const load = useCallback(async () => {
    setError(null);
    const { data: d, error: e } = await sb.functions.invoke("portal-billing", { body: { action: "status" } });
    if (e || (d && d.error)) { setError((e && e.message) || d.error); setData({}); return; }
    setData(d || {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const plans = (data && data.plans) || [];
  const subs = (data && data.subscriptions) || [];
  const planById = {}; plans.forEach((p) => { planById[p.id] = p; });
  // Group the plan rows into features (monthly + annual pair per feature).
  const features = []; const byFeature = {};
  plans.forEach((p) => {
    if (!byFeature[p.feature]) { byFeature[p.feature] = { feature: p.feature, name: p.name, availability: p.availability, required: p.required, setup: p.setup_fee_cents, priceVisible: p.price_visible !== false, plans: {} }; features.push(byFeature[p.feature]); }
    byFeature[p.feature].plans[p.billing_interval] = p;
  });
  const liveSubs = subs.filter((s) => s.status !== "cancelled");
  const liveFeatures = {}; liveSubs.forEach((s) => { const p = planById[s.plan_id]; if (p) liveFeatures[p.feature] = s; });
  const baseLive = !!liveFeatures["simple_layout"];

  // The Structure Studio Suite bundles everything except Self Serve Displays. When it's chosen
  // (in the cart) or already live, its member features are covered — shown "Included" and not
  // separately purchasable — and it satisfies the required base in place of Simple Layout.
  const SUITE_MEMBERS = ["simple_layout", "schedule_builds", "view_3d", "quickbooks_sync", "on_demand_pricing"];
  const suiteChosen = !!sel["full_suite"] || !!liveFeatures["full_suite"];
  const memberCovered = (feat) => SUITE_MEMBERS.includes(feat) && suiteChosen;

  // Simple Layout is required: preselect it (yearly) until it's subscribed — unless the Suite
  // (which includes it) is chosen or already live.
  useEffect(() => {
    if (data && data.configured && !baseLive && !sel["full_suite"] && !liveFeatures["full_suite"] && byFeature["simple_layout"] && !sel["simple_layout"]) {
      setSel((p) => ({ ...p, simple_layout: "annual" }));
    }
  }, [data]);

  const fmt$ = (c) => c == null ? null : "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: c % 100 ? 2 : 0 });
  // What this tenant actually pays. charge_cents is computed server-side from their
  // account discount; falling back to price_cents keeps the page honest against an
  // older portal-billing that doesn't send it yet.
  const chargeOf = (p) => (p && p.charge_cents != null ? p.charge_cents : (p ? p.price_cents : null));
  const isCut = (p) => p && p.charge_cents != null && p.charge_cents < p.price_cents;
  const per = (p) => (p && p.billing_interval === "annual" ? "/yr" : "/mo");
  const priceLabel = (p) => p ? `${fmt$(chargeOf(p))}${per(p)}` : "—";
  const acctDiscount = Number(data?.discount?.percent) || 0;

  // Cart totals (mixed intervals allowed — each feature bills on its own cycle).
  const cart = Object.entries(sel).filter(([f]) => byFeature[f] && !liveFeatures[f]);
  const cartPlans = cart.map(([f, iv]) => byFeature[f].plans[iv]).filter(Boolean);
  const moTotal = cartPlans.filter((p) => p.billing_interval === "monthly").reduce((s, p) => s + (chargeOf(p) || 0), 0);
  const yrTotal = cartPlans.filter((p) => p.billing_interval === "annual").reduce((s, p) => s + (chargeOf(p) || 0), 0);
  // From the SELECTED plan rows, not byFeature.setup — that field is whichever interval's
  // row happened to be seen first, and monthly/annual can carry different setup fees.
  const setupTotal = cartPlans.reduce((s, p) => s + (p.setup_fee_cents || 0), 0);
  // Charged at checkout: first period of every cart item plus setup fees. Registering a
  // recurring never charges anything by itself — the server runs this as an immediate sale
  // and schedules the subscription's own first charge at the renewal. All cents.
  const dueTodayCents = cartPlans.reduce((s, p) => s + (chargeOf(p) || 0), 0) + setupTotal;
  const selectable = features.some((f) => f.availability === "available" && !liveFeatures[f.feature]);

  // Load Collect.js once (from the gateway, with the public tokenization key), then
  // open its hosted card lightbox; the callback hands us a one-time payment token.
  const getPaymentToken = (amountCents) => new Promise((resolve, reject) => {
    const ck = data && data.checkout;
    if (!ck) return reject(new Error("Billing is not configured yet."));
    // Show the exact charge inside Collect.js's hosted card popup — on the lightbox
    // header and its pay button — so the customer sees what they'll be billed BEFORE
    // entering the card, not only after the sale posts. price/currency are display-only
    // to Collect.js (it just tokenizes); the real charge is still the server-side sale,
    // which independently re-checks confirmChargeCents.
    const amt = amountCents != null ? (amountCents / 100).toFixed(2) : null;
    const start = () => {
      try {
        window.CollectJS.configure({
          variant: "lightbox",
          ...(amt ? {
            price: amt,
            currency: "USD",
            country: "US",
            buttonText: `Pay ${fmt$(amountCents)} now`,
            // Keep this to ONE line — Collect.js caps the lightbox height, and a
            // two-line header pushes the pay button past the bottom edge. The renewal
            // note already lives on the page's due-today line and the pay button.
            instructionText: `You'll be charged ${fmt$(amountCents)} today.`,
          } : {}),
          callback: (resp) => resp && resp.token ? resolve(resp.token) : reject(new Error("Card entry was cancelled.")),
        });
        window.CollectJS.startPaymentRequest();
      } catch (e) { reject(e); }
    };
    if (window.CollectJS) return start();
    const s = document.createElement("script");
    s.src = ck.collectJsUrl;
    s.setAttribute("data-tokenization-key", ck.tokenizationKey);
    s.onload = start;
    s.onerror = () => reject(new Error("Could not load the secure card form."));
    document.head.appendChild(s);
  });

  const toggleFeature = (f) => {
    if (f.availability !== "available" || liveFeatures[f.feature] || busy) return;
    if (memberCovered(f.feature)) return;                      // covered by the Suite — not separately selectable
    if (f.required && !baseLive && !sel["full_suite"]) return; // Simple Layout stays unless the Suite covers it
    setSel((p) => {
      const n = { ...p };
      if (n[f.feature]) delete n[f.feature];
      else {
        n[f.feature] = "annual";
        if (f.feature === "full_suite") SUITE_MEMBERS.forEach((m) => delete n[m]); // the Suite replaces the à-la-carte pieces
      }
      return n;
    });
  };
  const setInterval_ = (f, iv) => {
    if (f.availability !== "available" || liveFeatures[f.feature] || busy || memberCovered(f.feature)) return;
    setSel((p) => ({ ...p, [f.feature]: iv }));
  };

  const subscribe = async () => {
    const planIds = cartPlans.map((p) => p.id);
    if (planIds.length === 0) { setMsg({ err: "Select at least one feature." }); return; }
    setMsg(null); setBusy(true);
    try {
      // EVERY caller echoes the exact amount shown, and the server refuses a mismatch —
      // so the card can only ever be charged the number that was on screen. dueTodayCents
      // is already cents (the old operator path sent setupTotal * 100, cents times a
      // hundred; never bit only because every setup fee is $0).
      const body = { action: "subscribe", planIds, confirmChargeCents: dueTodayCents };
      if (viewingLabel) {
        // Real money against THEIR card: confirm with the client named and the amount out loud.
        if (!window.confirm(`Subscribe ${viewingLabel} to ${planIds.length} feature(s) and charge ${fmt$(dueTodayCents)} today?

This bills the card ${viewingLabel} has on file.`)) { setBusy(false); return; }
      } else if (!data.hasCard) {
        body.paymentToken = await getPaymentToken(dueTodayCents);
      }
      const { data: r, error: e } = await sb.functions.invoke("portal-billing", { body });
      if (e) {
        // A non-2xx from the function carries the real story in its BODY — a declined-card
        // message, a "charge may not have been reversed (ref …)" with the transaction id,
        // or the fresh due-today amount on a price mismatch. e.message alone is the generic
        // "non-2xx status code" and would hide all of it.
        let msg = e.message;
        try { const ctx = await e.context.json(); if (ctx && ctx.error) msg = ctx.error; } catch (_x) {}
        throw new Error(msg);
      }
      if (r && r.error) throw new Error(r.error);
      if (r.failed && r.failed.length > 0) {
        // The per-feature error text matters here: it may carry a transaction reference or
        // an explicit "do NOT try again" — a bare plan id would hide exactly the part the
        // customer and support need.
        setMsg({ err: `Some features could not be started - ${r.failed.map((x) => `${x.planId}: ${x.error}`).join(" | ")}` });
      } else {
        setMsg({ ok: "You're subscribed — thank you!" });
      }
      setSel({});
      await load();
    } catch (e) { setMsg({ err: e.message }); }
    setBusy(false);
  };

  const cancel = async (s) => {
    const p = planById[s.plan_id] || {};
    if (!window.confirm(viewingLabel
      ? `Cancel ${p.name || "this feature"} for ${viewingLabel}? It will stop at the end of their billing period.`
      : `Cancel ${p.name || "this feature"}? It will stop at the end of the billing period.`)) return;
    setMsg(null); setBusy(true);
    try {
      const { data: r, error: e } = await sb.functions.invoke("portal-billing", { body: { action: "cancel", subscriptionId: s.id } });
      if (e || (r && r.error)) throw new Error((e && e.message) || r.error);
      setMsg({ ok: `${p.name || "Feature"} cancelled.` });
      await load();
    } catch (e) { setMsg({ err: e.message }); }
    setBusy(false);
  };

  const SUB_BADGE = {
    active:    { bg: "#F0FDF4", fg: "#15803D", label: "Active" },
    paused:    { bg: "#FFFBEB", fg: "#B45309", label: "Paused" },
    past_due:  { bg: "#FEF2F2", fg: "#DC2626", label: "Past due" },
    cancelled: { bg: "#F1F5F9", fg: "#64748B", label: "Cancelled" },
  };

  if (data === null) return <div style={S.card}><p style={{ fontSize: 13, color: "#64748B" }}>Loading billing…</p></div>;

  return (
    <div>
      {error && <div style={S.err}>{error}</div>}
      {msg && msg.err && <div style={S.err}>{msg.err}</div>}
      {msg && msg.ok && <div style={S.okMsg}>{msg.ok}</div>}

      {/* Founding-price banner — scarcity marker above all the pricing. */}
      <div style={{ background: "linear-gradient(90deg, #3D3672 0%, #1B7895 100%)", color: "#FFF", borderRadius: 10, padding: "12px 16px", marginBottom: 14, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span style={{ fontSize: 20, lineHeight: 1 }}>⭐</span>
        <div>
          <div style={{ fontSize: 14.5, fontWeight: 800, letterSpacing: "-0.01em" }}>Founding Price</div>
          <div style={{ fontSize: 12.5, color: "#DCE7F0", marginTop: 1 }}>Only for the first 25 builders — lock in this rate now.</div>
        </div>
      </div>

      {data && data.configured === false && plans.length > 0 && (
        <div style={{ background: "#EEF2FF", border: "1px solid #C7D2FE", borderRadius: 8, padding: "10px 14px", color: "#3D3672", fontSize: 13, fontWeight: 600, marginBottom: 12 }}>
          Online checkout isn't switched on yet — browse your plans below, and contact CSM Synergy to get started.
        </div>
      )}
      {data && data.configured === false && plans.length === 0 && (
        <div style={S.card}>
          <div style={S.h2}>Billing</div>
          <p style={{ fontSize: 13, color: "#64748B" }}>
            Billing isn't set up for your account yet. Reach out to CSM Synergy and we'll get your subscription going.
          </p>
        </div>
      )}

      {/* At-a-glance subscription summary — total spend, status, and next renewal, above the
          per-feature detail. Derived from the same live subscriptions; no extra backend call. */}
      {data && liveSubs.length > 0 && (() => {
        const moSum = liveSubs.filter((s) => (planById[s.plan_id] || {}).billing_interval !== "annual").reduce((a, s) => a + (s.price_cents || 0), 0);
        const yrSum = liveSubs.filter((s) => (planById[s.plan_id] || {}).billing_interval === "annual").reduce((a, s) => a + (s.price_cents || 0), 0);
        const nextRenew = liveSubs.map((s) => s.current_period_end).filter(Boolean).sort()[0] || null;
        const headStatus = liveSubs.some((s) => s.status === "past_due") ? "past_due" : liveSubs.some((s) => s.status === "paused") ? "paused" : "active";
        const hb = SUB_BADGE[headStatus] || SUB_BADGE.active;
        const spend = [moSum ? `${fmt$(moSum)}/mo` : null, yrSum ? `${fmt$(yrSum)}/yr` : null].filter(Boolean).join(" + ") || "—";
        const stat = (label, value) => (
          <div style={{ minWidth: 120 }}>
            <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: 0.5, textTransform: "uppercase", color: "#94A3B8" }}>{label}</div>
            <div style={{ fontSize: 16, fontWeight: 800, color: "#1E293B", marginTop: 3 }}>{value}</div>
          </div>
        );
        return (
          <div style={S.card}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
              <div style={{ ...S.h2, marginBottom: 0 }}>Your subscription</div>
              <span style={{ background: hb.bg, color: hb.fg, borderRadius: 20, padding: "3px 10px", fontSize: 11, fontWeight: 700 }}>{hb.label}</span>
            </div>
            <div style={{ display: "flex", gap: 28, flexWrap: "wrap" }}>
              {stat("What you pay", spend)}
              {stat("Active features", String(liveSubs.length))}
              {stat("Next renewal", nextRenew ? fmtDate(nextRenew) : "—")}
            </div>
            {acctDiscount > 0 && (
              <div style={{ fontSize: 12, color: "#15803D", fontWeight: 600, marginTop: 12 }}>
                Your account discount of {acctDiscount}% is already applied to the prices above.
              </div>
            )}
          </div>
        );
      })()}

      {data && liveSubs.length > 0 && (
        <div style={S.card}>
          <div style={S.h2}>Your features</div>
          {liveSubs.map((s) => {
            const p = planById[s.plan_id] || {};
            const b = SUB_BADGE[s.status] || SUB_BADGE.active;
            return (
              <div key={s.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", padding: "10px 0", borderBottom: "1px solid #F1F5F9" }}>
                <div>
                  <span style={{ fontSize: 14, fontWeight: 800, color: "#1E293B", marginRight: 10 }}>{p.name || s.plan_id}</span>
                  <span style={{ background: b.bg, color: b.fg, borderRadius: 20, padding: "3px 10px", fontSize: 11, fontWeight: 700 }}>{b.label}</span>
                  <div style={{ fontSize: 12, color: "#64748B", marginTop: 3 }}>
                    {s.price_cents != null && <>{fmt$(s.price_cents)}{p.billing_interval === "annual" ? "/yr" : "/mo"} · </>}
                    started {fmtDate(s.current_period_start)}{s.current_period_end ? ` · renews ${fmtDate(s.current_period_end)}` : ""}
                  </div>
                </div>
                <button type="button" onClick={() => cancel(s)} disabled={busy}
                  style={{ ...S.btn("#FFF", "#DC2626"), border: "1px solid #FECACA", padding: "6px 12px", fontSize: 12, opacity: busy ? 0.6 : 1 }}>
                  Cancel
                </button>
              </div>
            );
          })}
        </div>
      )}

      {data && plans.length > 0 && (
        <div style={S.card}>
          <div style={S.h2}>{liveSubs.length > 0 ? "Add features" : "Choose your features"}</div>
          <p style={{ fontSize: 12, color: "#64748B", marginBottom: 12 }}>
            Pick monthly or yearly for each feature — yearly is 10× monthly (2 months free). Cancel any feature anytime.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 12 }}>
            {features.filter((f) => !liveFeatures[f.feature]).map((f) => {
              const soon = f.availability !== "available";
              const covered = memberCovered(f.feature);
              const veiled = soon || covered;   // shows an overlay + dims + blocks interaction
              const iv = sel[f.feature];
              const on = !!iv;
              const shown = f.plans[iv || "annual"];
              const lockedBase = f.required && !baseLive;
              return (
                <div key={f.feature} onClick={covered ? undefined : () => toggleFeature(f)}
                  style={{ position: "relative", border: on ? `2px solid ${ACCENT}` : "1px solid #E2E8F0", borderRadius: 10, padding: on ? 15 : 16, cursor: veiled ? "default" : "pointer", overflow: "hidden" }}>
                  {veiled && (
                    <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2, pointerEvents: "none" }}>
                      <span style={{ transform: "rotate(-12deg)", background: covered ? "#EDE9FE" : "#FEF3C7", color: covered ? "#5B21B6" : "#B45309", border: `1px solid ${covered ? "#C4B5FD" : "#FDE68A"}`, borderRadius: 8, padding: "6px 16px", fontSize: 13, fontWeight: 800, letterSpacing: 1.5, textTransform: "uppercase", whiteSpace: "nowrap" }}>{covered ? "Included in the Suite" : (f.feature === "self_serve_displays" ? "Coming 2027" : "Coming soon")}</span>
                    </div>
                  )}
                  <div style={{ opacity: veiled ? 0.45 : 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
                      <span style={{ fontSize: 14, fontWeight: 800, color: "#1E293B" }}>{f.name}</span>
                      {f.required && <span style={{ background: "#75E6DA", color: "#134E4A", borderRadius: 20, padding: "2px 8px", fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.5 }}>Required</span>}
                      {!veiled && !lockedBase && <span style={{ marginLeft: "auto", fontSize: 18, color: on ? ACCENT : "#CBD5E1", fontWeight: 800 }}>{on ? "✓" : "+"}</span>}
                    </div>
                    {!veiled && (
                      <div onClick={(e) => e.stopPropagation()} style={{ display: "inline-flex", border: "1px solid #E2E8F0", borderRadius: 20, overflow: "hidden", marginBottom: 8 }}>
                        {["monthly", "annual"].map((k) => (
                          <button key={k} type="button" onClick={() => setInterval_(f, k)}
                            style={{ background: (iv || "annual") === k ? ACCENT : "transparent", color: (iv || "annual") === k ? "#FFF" : "#64748B", border: "none", padding: "4px 12px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                            {k === "annual" ? "Yearly" : "Monthly"}
                          </button>
                        ))}
                      </div>
                    )}
                    {/* Features whose price isn't published yet show no number at all —
                        not even the setup fee, which would hint at the tier. Flip
                        billing_plans.price_visible to true to start showing it. */}
                    {f.priceVisible ? (<>
                      <div style={{ fontSize: 19, fontWeight: 800, color: ACCENT }}>
                        {/* Discounted tenants see what they'd have paid struck through, so the
                            price they're agreeing to is unambiguous rather than mysteriously low. */}
                        {isCut(shown) && (
                          <span style={{ fontSize: 14, fontWeight: 600, color: "#94A3B8", textDecoration: "line-through", marginRight: 6 }}>
                            {fmt$(shown.price_cents)}
                          </span>
                        )}
                        {priceLabel(shown)}
                      </div>
                      {isCut(shown) && (
                        <div style={{ display: "inline-block", fontSize: 10.5, fontWeight: 800, letterSpacing: ".04em", textTransform: "uppercase", color: "#166534", background: "#DCFCE7", border: "1px solid #86EFAC", borderRadius: 6, padding: "2px 7px", marginTop: 4 }}>
                          {shown.discount_percent}% off
                        </div>
                      )}
                      <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 3 }}>
                        {f.setup == null ? "Setup fee: TBD" : f.setup === 0 ? "No setup fee" : `Setup: ${fmt$(f.setup)} one-time`}
                      </div>
                    </>) : (
                      <div style={{ fontSize: 14, fontWeight: 700, color: "#64748B" }}>
                        Pricing announced at launch
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {selectable && (
            <div style={{ marginTop: 16, borderTop: "1px solid #E2E8F0", paddingTop: 14 }}>
              <div style={{ fontSize: 13, color: "#475569", lineHeight: 1.8 }}>
                <div>Selected features: <b>{cart.length}</b></div>
                {moTotal > 0 && <div>Monthly total: <b>{fmt$(moTotal)}/mo</b></div>}
                {yrTotal > 0 && <div>Yearly total: <b>{fmt$(yrTotal)}/yr</b></div>}
                <div>One-time setup: <b>{fmt$(setupTotal)}</b></div>
                {/* The first period is charged at checkout — the recurring only takes over
                    at renewal — so the number the card sees today is stated in bold before
                    the button, not discovered on a statement. */}
                <div style={{ marginTop: 4, fontSize: 14.5, color: "#1E293B" }}>
                  Due today: <b style={{ color: "#3D3672" }}>{fmt$(dueTodayCents)}</b>
                  <span style={{ fontSize: 12, color: "#64748B" }}> — first {yrTotal > 0 && moTotal > 0 ? "period" : yrTotal > 0 ? "year" : "month"}{setupTotal > 0 ? " + setup" : ""}. Renews automatically.</span>
                </div>
              </div>
              {/* An operator must never be the one entering a card: a Collect.js token is
                  minted in the CARDHOLDER's browser, so in operator mode it would be ours.
                  The server refuses that outright, so surface it here rather than failing. */}
              {data.configured ? (viewingLabel && !data.hasCard ? (
                <p style={{ fontSize: 12.5, color: "#92400E", background: "#FEF3C7", border: "1px solid #F59E0B", borderRadius: 8, padding: "8px 12px", marginTop: 12, fontWeight: 600 }}>
                  {viewingLabel} has no card on file. Card details must be entered by the owner
                  themselves — ask them to add a card, then you can change their plan from here.
                </p>
              ) : (
                <button type="button" onClick={subscribe} disabled={busy || cart.length === 0}
                  style={{ ...S.btn(ACCENT, "#FFF"), marginTop: 12, opacity: busy || cart.length === 0 ? 0.6 : 1 }}>
                  {busy ? "Working…" : (viewingLabel ? `Subscribe ${viewingLabel} with card on file` : (data.hasCard ? "Subscribe with card on file" : "Continue to secure card entry"))}
                </button>
              )) : (
                <p style={{ fontSize: 12, color: "#64748B", marginTop: 12, fontWeight: 600 }}>
                  Online checkout opens here soon — contact CSM Synergy to activate your features today.
                </p>
              )}
            </div>
          )}

          <p style={{ fontSize: 11, color: "#94A3B8", marginTop: 14 }}>
            StructureStudio integrates with your CRM — CRM setup is available for an additional fee.
            Card details are entered in a secure form served by the payment gateway; they never pass through StructureStudio.
          </p>
        </div>
      )}

      {/* Synergy CRM — a separate offering with tiered per-user pricing. Sign-up is EXTERNAL (its
          own enrollment page), not the in-app Deposyt checkout, so this is an informational card
          with an outbound link rather than a purchasable billing_plans feature. */}
      <div style={S.card}>
        <div style={S.h2}>Synergy CRM</div>
        <p style={{ fontSize: 12.5, color: "#64748B", marginBottom: 14, lineHeight: 1.5 }}>
          The CRM that runs your sales — leads, pipelines, and follow-up. Priced by number of users; enroll on the sign-up page.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12, marginBottom: 16 }}>
          {[
            { tier: "1 User", monthly: 20000, annual: 200000 },
            { tier: "2-3 Users", monthly: 30000, annual: 300000 },
            { tier: "Unlimited Users", monthly: 50000, annual: 500000 },
          ].map((t) => {
            const iv = crmIv[t.tier] || "annual";
            const cents = iv === "annual" ? t.annual : t.monthly;
            return (
              <div key={t.tier} style={{ border: "1px solid #E2E8F0", borderRadius: 10, padding: 16 }}>
                <div style={{ fontSize: 14, fontWeight: 800, color: "#1E293B", marginBottom: 8 }}>{t.tier}</div>
                <div style={{ display: "inline-flex", border: "1px solid #E2E8F0", borderRadius: 20, overflow: "hidden", marginBottom: 8 }}>
                  {["monthly", "annual"].map((k) => (
                    <button key={k} type="button" onClick={() => setCrmIv((p) => ({ ...p, [t.tier]: k }))}
                      style={{ background: iv === k ? ACCENT : "transparent", color: iv === k ? "#FFF" : "#64748B", border: "none", padding: "4px 12px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                      {k === "annual" ? "Yearly" : "Monthly"}
                    </button>
                  ))}
                </div>
                <div style={{ fontSize: 19, fontWeight: 800, color: ACCENT }}>{fmt$(cents)}{iv === "annual" ? "/yr" : "/mo"}</div>
              </div>
            );
          })}
        </div>
        <a href="https://streamlinedconstructionsystem.com/saas-enrollment" target="_blank" rel="noopener noreferrer"
          style={{ ...S.btn(ACCENT, "#FFF"), display: "inline-block", textDecoration: "none" }}>
          Sign up for Synergy CRM →
        </a>
      </div>
    </div>
  );
}

// ─── Pricing & inclusions (CSV self-serve; via portal-settings, JWT-scoped) ───
function PricingCsv({ viewingLabel = null, onGoToOptions = null }) {
  const [cat, setCat] = useState(null);   // { clientId, styles, sizes, items, inclusions }
  const [busy, setBusy] = useState(false);
  const [dlBusy, setDlBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [result, setResult] = useState(null);
  const [fileKey, setFileKey] = useState(0);
  // building-style manager state
  const [styleName, setStyleName] = useState("");
  const [styleImg, setStyleImg] = useState(null);     // { base64, contentType, name }
  const [styleBusy, setStyleBusy] = useState(false);
  const [styleFileKey, setStyleFileKey] = useState(0);
  const [pendingDelete, setPendingDelete] = useState(null);  // style pending permanent delete (confirm modal)
  const [editStyle, setEditStyle] = useState(null);          // style being edited (name/photo modal)
  const [editName, setEditName] = useState("");
  const [editImg, setEditImg] = useState(null);              // { base64, contentType } | null
  const [editFileKey, setEditFileKey] = useState(0);
  const [dragIdx, setDragIdx] = useState(null);              // index of the style row being dragged

  const load = async () => {
    const { data, error } = await sb.functions.invoke("portal-settings", { body: { action: "catalog" } });
    if (error || (data && data.error)) { setMsg({ err: (error && error.message) || data.error }); return; }
    setCat(data);
  };
  useEffect(() => { load(); }, []);

  const items = () => (cat && cat.items) || [];
  const allStyles = () => (cat && cat.styles) || [];
  const activeStyles = () => allStyles().filter((s) => s.active);
  // Every option THIS client offers = built-in layout items + their catalog fixtures (doors/
  // windows/ramps). Each becomes a CSV column so an owner can set how many the base price includes
  // per size. Catalog columns key on the fixture id, so an "included" catalog item rides the same
  // building_size_inclusions pipeline (item_key = fixture id). Label carries the size so multiple
  // sizes of one style stay distinct and never collide with a built-in's label.
  // Option columns grouped into the same sections the Options tab shows top-to-bottom — built-in
  // options, then the Doors, Ramps and Windows catalog sections — each with a header fill colour
  // for the Excel template. Archived options drop out entirely (they can't be added to new builds,
  // so they must not be an inclusion column — get_config + submit-estimate also stop netting them).
  const optionSections = () => {
    // Drop the built-in "ramp" — the ramp is now a self-contained option managed in the Ramp
    // settings section (simple price or custom catalog ramps), not a per-building inclusion column.
    // Mirrors LayoutPricing, which also hides the ramp row.
    const layout = items().filter((it) => !it.archived && it.key !== "ramp").map((it) => ({ key: it.key, label: it.label }));
    const fx = ((cat && cat.fixtures) || []).filter((f) => f && f.active !== false && f.archived !== true);
    // Plain ASCII "x" (not "×") — a CSV opened in Excel misreads non-ASCII as mojibake ("Ã—"), and
    // since the column is matched by its exact label on re-import, a garbled header would silently
    // drop the inclusion. ASCII round-trips safely through any spreadsheet.
    const col = (f) => ({ key: String(f.id), label: `${f.name || "Item"}${f.width_in && f.height_in ? ` (${fmtFtIn(f.width_in)}x${fmtFtIn(f.height_in)})` : ""}` });
    const inCat = (f, c) => (f.category || "door") === c; // a missing category reads as "door" (matches DoorsView)
    const byCat = (c) => fx.filter((f) => inCat(f, c)).map(col);
    const other = fx.filter((f) => !["door", "ramp", "window"].includes(f.category || "door")).map(col);
    return [
      { name: "Built-in options", argb: "FFDBEAFF", cols: layout },
      { name: "Doors",            argb: "FFFEE9C7", cols: byCat("door") },
      { name: "Ramps",            argb: "FFE7E5E4", cols: byCat("ramp") },
      { name: "Windows",          argb: "FFDCF1FB", cols: byCat("window") },
      { name: "Other",            argb: "FFF1F5F9", cols: other },
    ].filter((s) => s.cols.length);
  };
  const optionCols = () => optionSections().flatMap((s) => s.cols);

  const ALLOWED_IMG = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  const onStyleImg = (file) => {
    if (!file) { setStyleImg(null); return; }
    if (!ALLOWED_IMG.includes(file.type)) { setMsg({ err: "Use a JPG, PNG, WEBP or GIF image." }); setStyleFileKey((k) => k + 1); return; }
    if (file.size > 3_000_000) { setMsg({ err: "Image too large (max 3MB)." }); setStyleFileKey((k) => k + 1); return; }
    const r = new FileReader();
    r.onerror = () => setMsg({ err: "Could not read that image." });
    r.onload = () => setStyleImg({ base64: r.result, contentType: file.type || "image/jpeg", name: file.name });
    r.readAsDataURL(file);
  };
  const addStyle = async () => {
    if (!styleName.trim()) return;
    setStyleBusy(true); setMsg(null);
    try {
      const body = { action: "create_style", label: styleName.trim() };
      if (styleImg) { body.imageBase64 = styleImg.base64; body.imageContentType = styleImg.contentType; }
      const { data, error } = await sb.functions.invoke("portal-settings", { body });
      if (error || (data && data.error)) throw new Error((error && error.message) || data.error);
      const added = styleName.trim();
      setStyleName(""); setStyleImg(null); setStyleFileKey((k) => k + 1);
      await load();
      setMsg({ ok: `Building style “${added}” added — now set its sizes & prices via the Excel template below.` });
    } catch (e) { setMsg({ err: e.message }); }
    setStyleBusy(false);
  };
  const toggleStyle = async (s) => {
    setStyleBusy(true); setMsg(null);
    try {
      const { data, error } = await sb.functions.invoke("portal-settings", { body: { action: "set_style_active", styleId: s.id, active: !s.active } });
      if (error || (data && data.error)) throw new Error((error && error.message) || data.error);
      await load();
    } catch (e) { setMsg({ err: e.message }); }
    setStyleBusy(false);
  };
  // Toggle whether this style's photo is attached to the GHL estimate (default on).
  const toggleStyleImage = async (s) => {
    setStyleBusy(true); setMsg(null);
    try {
      const { data, error } = await sb.functions.invoke("portal-settings", { body: { action: "set_style_estimate_image", styleId: s.id, show: s.show_image_on_estimate === false } });
      if (error || (data && data.error)) throw new Error((error && error.message) || data.error);
      await load();
    } catch (e) { setMsg({ err: e.message }); }
    setStyleBusy(false);
  };
  // Drag a style to a new position; persists the new order (sort_order = index), which is what
  // the design page sorts styles by. Optimistic UI, reloads on failure to resync.
  const moveStyle = async (from, to) => {
    const arr = [...allStyles()];
    if (from == null || to == null || from === to || from < 0 || to < 0 || from >= arr.length || to >= arr.length) return;
    const [moved] = arr.splice(from, 1);
    arr.splice(to, 0, moved);
    setCat((c) => ({ ...c, styles: arr }));
    setStyleBusy(true); setMsg(null);
    try {
      const { data, error } = await sb.functions.invoke("portal-settings", { body: { action: "reorder_styles", orderedIds: arr.map((s) => s.id) } });
      if (error || (data && data.error)) throw new Error((error && error.message) || data.error);
      setMsg({ ok: "Display order saved — this is the order customers see on the design page." });
    } catch (e) { setMsg({ err: e.message }); await load(); }
    setStyleBusy(false);
  };
  const openEdit = (s) => { setEditStyle(s); setEditName(s.label || ""); setEditImg(null); setEditFileKey((k) => k + 1); };
  const onEditImg = (file) => {
    if (!file) { setEditImg(null); return; }
    if (!ALLOWED_IMG.includes(file.type)) { setMsg({ err: "Use a JPG, PNG, WEBP or GIF image." }); setEditFileKey((k) => k + 1); return; }
    if (file.size > 3_000_000) { setMsg({ err: "Image too large (max 3MB)." }); setEditFileKey((k) => k + 1); return; }
    const r = new FileReader();
    r.onerror = () => setMsg({ err: "Could not read that image." });
    r.onload = () => setEditImg({ base64: r.result, contentType: file.type || "image/jpeg" });
    r.readAsDataURL(file);
  };
  const saveEdit = async () => {
    const s = editStyle;
    if (!s || !editName.trim()) return;
    setStyleBusy(true); setMsg(null);
    try {
      const body = { action: "update_style", styleId: s.id, label: editName.trim() };
      if (editImg) { body.imageBase64 = editImg.base64; body.imageContentType = editImg.contentType; }
      const { data, error } = await sb.functions.invoke("portal-settings", { body });
      if (error || (data && data.error)) throw new Error((error && error.message) || data.error);
      await load();
      setMsg({ ok: `Building style updated.` });
    } catch (e) { setMsg({ err: e.message }); }
    setStyleBusy(false);
    setEditStyle(null);
  };
  const confirmDelete = async () => {
    const s = pendingDelete;
    if (!s) return;
    if (viewingLabel && !window.confirm(`Delete “${s.label}” — and all its sizes and prices — from ${viewingLabel}'s account?`)) return;
    setStyleBusy(true); setMsg(null);
    try {
      const { data, error } = await sb.functions.invoke("portal-settings", { body: { action: "delete_style", styleId: s.id } });
      if (error || (data && data.error)) throw new Error((error && error.message) || data.error);
      await load();
      setMsg({ ok: `Building style “${s.label}” and its sizes/prices were deleted.` });
    } catch (e) { setMsg({ err: e.message }); }
    setStyleBusy(false);
    setPendingDelete(null);
  };
  const downloadTemplate = async () => {
    if (!cat || dlBusy) return;
    const sections = optionSections();
    const its = sections.flatMap((s) => s.cols);
    const headers = ["style", "width", "length", "price", ...its.map((it) => it.label), "active"];
    // Item cells carry the included QUANTITY (loft = sq ft, doors = count); 0 = not included.
    // Legacy "yes"/"no" sheets still upload fine (yes imports as quantity 1).
    const incBySize = {}; (cat.inclusions || []).forEach((x) => { if (x.included) (incBySize[x.size_id] = incBySize[x.size_id] || {})[x.item_key] = Number(x.qty) || 1; });
    // Numbers stay numbers so Excel treats width/length/price/counts as numeric; blanks/text pass through.
    const numOr = (v) => (v === "" || v == null || isNaN(Number(v)) ? v : Number(v));
    const rows = [];
    activeStyles().forEach((s) => {
      const sizes = (cat.sizes || []).filter((z) => z.style_id === s.id);
      if (sizes.length === 0) {
        // No sizes yet → one starter row: fill width/length/price and copy the line down.
        rows.push([s.label, "", "", "", ...its.map(() => 0), "yes"]);
      } else {
        sizes.forEach((z) => {
          const inc = incBySize[z.id] || {};
          rows.push([s.label, numOr(z.width_ft), numOr(z.length_ft), z.base_price == null ? "" : numOr(z.base_price),
            ...its.map((it) => Number(inc[it.key] || 0)), z.active ? "yes" : "no"]);
        });
      }
    });

    setDlBusy(true); setMsg(null);
    let ExcelJS;
    try { ExcelJS = await loadExcelJS(); }
    catch (e) {
      // Library unreachable → still hand back a usable CSV so the download never fully fails.
      downloadFile(`${cat.clientId || "pricing"}-pricing.csv`, toCSV(headers, rows.map((r) => r.map((v) => (v == null ? "" : String(v))))));
      setMsg({ err: `${e.message} Downloaded a plain CSV instead.` });
      setDlBusy(false);
      return;
    }
    try {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Pricing", { views: [{ state: "frozen", xSplit: 4, ySplit: 1 }] });
      ws.addRow(headers);
      rows.forEach((r) => ws.addRow(r));

      const thin = { style: "thin", color: { argb: "FFCBD5E1" } };
      const FIXED = "FF334155"; // dark slate header for style/width/length/price/active
      // Header row: bold, wrapped, colour-banded by section.
      const hdr = ws.getRow(1); hdr.height = 30;
      const paintHdr = (c, argb, light) => {
        const cell = hdr.getCell(c);
        cell.font = { bold: true, size: 10, color: { argb: light ? "FF1E293B" : "FFFFFFFF" } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb } };
        cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
        cell.border = { top: thin, left: thin, bottom: thin, right: thin };
      };
      [1, 2, 3, 4].forEach((c) => paintHdr(c, FIXED, false));
      paintHdr(headers.length, FIXED, false);
      let c = 5;
      sections.forEach((sec) => sec.cols.forEach(() => paintHdr(c++, sec.argb, true)));

      // Column widths: style wide enough for its longest name; the rest sized to their header.
      const styleW = Math.min(Math.max(8, ...rows.map((r) => String(r[0] || "").length)) + 2, 34);
      ws.columns.forEach((colObj, i) => { colObj.width = i === 0 ? styleW : Math.min(Math.max(String(headers[i]).length + 2, 9), 26); });

      // Body: borders everywhere, bold style name, a heavier rule where a new building style starts,
      // and a currency format on price so the sheet reads cleanly.
      let prevStyle = null;
      for (let r = 2; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        const styleName = String(rows[r - 2][0] || "");
        const newGroup = styleName !== prevStyle; prevStyle = styleName;
        for (let cc = 1; cc <= headers.length; cc++) {
          const cell = row.getCell(cc);
          cell.border = { left: thin, right: thin, bottom: thin, top: newGroup ? { style: "medium", color: { argb: "FF94A3B8" } } : thin };
          cell.alignment = { vertical: "middle", horizontal: cc === 1 ? "left" : "center" };
          if (cc === 1) cell.font = { bold: true };
        }
        row.getCell(4).numFmt = '$#,##0';
      }
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };

      const buf = await wb.xlsx.writeBuffer();
      downloadBlob(`${cat.clientId || "pricing"}-pricing.xlsx`,
        new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    } catch (e) {
      setMsg({ err: `Could not build the Excel file: ${e.message}` });
    }
    setDlBusy(false);
  };
  const onUpload = async (file) => {
    if (!file) return;
    setBusy(true); setMsg(null); setResult(null);
    try {
      if (file.size > 5_000_000) throw new Error("File too large (max 5MB).");
      // Accept both the Excel template and a plain CSV (anything already filled out).
      const isXlsx = /\.xlsx$/i.test(file.name) || file.type.includes("spreadsheetml");
      const matrix = isXlsx ? await readXlsxMatrix(file, await loadExcelJS()) : parseCSV(await file.text());
      if (matrix.length < 2) throw new Error("The sheet has no data rows.");
      const header = matrix[0].map((h) => String(h).trim());
      const lc = header.map((h) => h.toLowerCase());
      const iStyle = lc.indexOf("style"), iWidth = lc.indexOf("width"), iLength = lc.indexOf("length"), iPrice = lc.indexOf("price"), iActive = lc.indexOf("active");
      if (iStyle < 0 || iWidth < 0 || iLength < 0 || iPrice < 0) throw new Error('The sheet needs "style", "width", "length" and "price" columns.');
      const reserved = new Set([iStyle, iWidth, iLength, iPrice, iActive]);
      // Inclusion columns match by LABEL, and the label→key map is last-writer-wins: two
      // catalog items sharing a name and size (nothing server-side enforces unique names)
      // used to resolve BOTH columns to the second item's id, silently dropping the first
      // item's inclusion edits (audit 2026-08-20). Refuse and name the duplicates instead.
      {
        const seenLabel = new Set(); const dupLabels = new Set();
        optionCols().forEach((it) => { const l = it.label.toLowerCase(); if (seenLabel.has(l)) dupLabels.add(it.label); seenLabel.add(l); });
        if (dupLabels.size) throw new Error(`Import stopped — two catalog items share the same name and size, so their columns can't be told apart: ${[...dupLabels].join(", ")}. Rename one of the duplicates on its catalog tab, re-download the template, then import again.`);
      }
      const labelToKey = {}; optionCols().forEach((it) => { labelToKey[it.label.toLowerCase()] = it.key; labelToKey[it.key.toLowerCase()] = it.key; });
      const colKey = header.map((h, idx) => reserved.has(idx) ? null : (labelToKey[h.toLowerCase()] || null));
      // Same collision from the sheet side: a copied/duplicated header column would make the
      // second column silently overwrite the first's quantities row by row.
      {
        const keyCount = {}; colKey.forEach((k) => { if (k) keyCount[k] = (keyCount[k] || 0) + 1; });
        const dupHdrs = [...new Set(header.filter((h, idx) => colKey[idx] && keyCount[colKey[idx]] > 1))];
        if (dupHdrs.length) throw new Error(`Import stopped — the sheet has more than one column for: ${dupHdrs.join(", ")}. Keep one column per option and re-upload.`);
      }
      const rows = matrix.slice(1).map((cols) => {
        const inclusions = {}; colKey.forEach((k, idx) => { if (k) inclusions[k] = cols[idx]; });
        return { style: cols[iStyle], width: cols[iWidth], length: cols[iLength], price: cols[iPrice], active: iActive >= 0 ? cols[iActive] : "", inclusions };
      });
      const { data, error } = await sb.functions.invoke("portal-settings", { body: { action: "import_pricing_csv", rows } });
      if (error || (data && data.error)) throw new Error((error && error.message) || data.error);
      setResult(data); await load();
      const parts = []; if (data.created) parts.push(`${data.created} added`); if (data.updated) parts.push(`${data.updated} updated`);
      setMsg({ ok: `Imported ${data.imported || 0} size(s)` + (parts.length ? ` (${parts.join(", ")})` : "") + (data.skipped && data.skipped.length ? `, ${data.skipped.length} skipped` : "") });
    } catch (e) { setMsg({ err: e.message }); }
    setBusy(false); setFileKey((k) => k + 1);
  };

  const errStyle = { background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 8, padding: "9px 13px", color: "#DC2626", fontSize: 13, fontWeight: 600, marginBottom: 12 };
  const okStyle = { background: "#F0FDF4", border: "1px solid #BBF7D0", borderRadius: 8, padding: "9px 13px", color: "#15803D", fontSize: 13, fontWeight: 600, marginBottom: 12 };
  const thumb = { width: 48, height: 36, borderRadius: 4, background: "#F1F5F9", objectFit: "cover", flexShrink: 0 };
  return (
    <>
      {msg && msg.err && <div style={errStyle}>{msg.err}</div>}
      {msg && msg.ok && <div style={okStyle}>{msg.ok}</div>}

      {editStyle && (
        <div onClick={() => !styleBusy && setEditStyle(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.5)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 1000 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "#FFF", borderRadius: 12, padding: 22, maxWidth: 440, width: "100%", boxShadow: "0 20px 50px rgba(0,0,0,0.25)" }}>
            <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 14 }}>Edit building style</div>
            <span style={S.lbl}>Name</span>
            <input value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="Building style name" style={{ ...S.input, marginBottom: 14 }} />
            <span style={S.lbl}>Photo</span>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}>
              {(editImg || editStyle.image_url)
                ? <img src={editImg ? editImg.base64 : editStyle.image_url} alt="" style={thumb} />
                : <div style={{ ...thumb, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>🏠</div>}
              <label style={{ ...S.btn("#F1F5F9", "#334155"), cursor: "pointer" }}>
                {editImg ? "New image selected ✓" : "Replace image"}
                <input key={editFileKey} type="file" accept="image/png,image/jpeg,image/webp,image/gif" style={{ display: "none" }} onChange={(e) => onEditImg(e.target.files && e.target.files[0])} />
              </label>
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", flexWrap: "wrap" }}>
              <button onClick={() => setEditStyle(null)} disabled={styleBusy} style={S.btn("#F1F5F9", "#334155")}>Cancel</button>
              <button onClick={saveEdit} disabled={styleBusy || !editName.trim()} style={{ ...S.btn(ACCENT, "#FFF"), opacity: (styleBusy || !editName.trim()) ? 0.55 : 1 }}>
                {styleBusy ? "Saving…" : "Save changes"}
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingDelete && (
        <div onClick={() => !styleBusy && setPendingDelete(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.5)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 1000 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "#FFF", borderRadius: 12, padding: 22, maxWidth: 440, width: "100%", boxShadow: "0 20px 50px rgba(0,0,0,0.25)" }}>
            <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 10 }}>Delete “{pendingDelete.label}”?</div>
            <p style={{ fontSize: 13.5, color: "#475569", lineHeight: 1.55, marginBottom: 18 }}>
              This permanently deletes the style and <b>all of its sizes and prices</b>. Past designs that used it keep
              their saved plan, but their estimate can no longer be regenerated. <b>This cannot be undone.</b> To just
              stop offering it, use <b>Hide</b> instead.
            </p>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", flexWrap: "wrap" }}>
              <button onClick={() => setPendingDelete(null)} disabled={styleBusy} style={S.btn("#F1F5F9", "#334155")}>Cancel</button>
              <button onClick={confirmDelete} disabled={styleBusy} style={S.btn(styleBusy ? "#9CA3AF" : "#DC2626", "#FFF")}>
                {styleBusy ? "Deleting…" : "OK – proceed and delete"}
              </button>
            </div>
          </div>
        </div>
      )}

      <div style={S.card}>
        <div style={S.h2}>Building styles</div>
        <p style={{ fontSize: 13, color: "#64748B", marginBottom: 12, lineHeight: 1.5 }}>
          Add each building style you sell — give it a name and a photo. Then set the sizes &amp; prices for each
          style using the Excel template below. <b>Drag the ⠿ handle to reorder</b> — the top style shows first on your
          design page, then the rest in this order. <b>Hide</b> stops offering a style to customers but keeps its
          sizes &amp; prices (reversible). <b>Delete</b> permanently removes the style and all its sizes &amp; prices —
          use it only when you’re sure you won’t need that style again.
        </p>
        {!cat ? <div style={{ fontSize: 13, color: "#94A3B8" }}>Loading…</div> : (
          <div>
            {allStyles().length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
                {allStyles().map((s, i) => (
                  <div key={s.id}
                    draggable={!styleBusy}
                    onDragStart={(e) => { setDragIdx(i); e.dataTransfer.effectAllowed = "move"; }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => { e.preventDefault(); moveStyle(dragIdx, i); setDragIdx(null); }}
                    onDragEnd={() => setDragIdx(null)}
                    style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 10px", border: `1px solid ${dragIdx === i ? ACCENT : "#E2E8F0"}`, borderRadius: 8, opacity: dragIdx === i ? 0.4 : (s.active ? 1 : 0.55), background: "#FFF", cursor: styleBusy ? "default" : "grab" }}>
                    <span title="Drag to reorder" style={{ color: "#CBD5E1", fontSize: 16, userSelect: "none", flexShrink: 0 }}>⠿</span>
                    {s.image_url
                      ? <img src={s.image_url} alt="" style={thumb} />
                      : <div style={{ ...thumb, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>🏠</div>}
                    <div style={{ flex: 1, fontWeight: 600, fontSize: 14 }}>{s.label}{!s.active && <span style={{ color: "#94A3B8", fontWeight: 400 }}> — hidden</span>}</div>
                    {/* Whether this style has a 3D look of its own yet. Read-only here —
                        setting one needs the live 3D preview, so it lives in the Designer
                        tab's 3D Style Calibration panel. */}
                    <span title={s.d3 ? "This style has its own 3D look — tune it in Designer → 3D Style Calibration" : "No 3D look set yet: 3D falls back to a generic shape. Set one in Designer → 3D Style Calibration."}
                      style={{ flexShrink: 0, fontSize: 11, fontWeight: 800, borderRadius: 6, padding: "3px 7px", border: "1px solid " + (s.d3 ? "#A7F3D0" : "#E2E8F0"), background: s.d3 ? "#ECFDF5" : "#F8FAFC", color: s.d3 ? "#047857" : "#94A3B8" }}>
                      {s.d3 ? "3D ✓" : "3D —"}
                    </span>
                    <label title="Attach this style's photo to the CRM estimate" style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: "#475569", fontWeight: 600, cursor: styleBusy ? "default" : "pointer", flexShrink: 0 }}>
                      <input type="checkbox" checked={s.show_image_on_estimate !== false} disabled={styleBusy} onChange={() => toggleStyleImage(s)} style={{ width: 15, height: 15, cursor: "pointer" }} />
                      Image on estimate
                    </label>
                    <button onClick={() => openEdit(s)} disabled={styleBusy} style={S.btn("#F1F5F9", "#334155")}>Edit</button>
                    <button onClick={() => toggleStyle(s)} disabled={styleBusy} style={S.btn("#F1F5F9", "#334155")}>{s.active ? "Hide" : "Show"}</button>
                    <button onClick={() => setPendingDelete(s)} disabled={styleBusy} style={S.btn("#FEF2F2", "#DC2626")}>Delete</button>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <input value={styleName} onChange={(e) => setStyleName(e.target.value)} placeholder="Building style name (e.g. Lofted Barn)" style={{ ...S.input, minWidth: 220 }} />
              <label style={{ ...S.btn("#F1F5F9", "#334155"), cursor: "pointer", display: "inline-block" }}>
                {styleImg ? "Image selected ✓" : "Choose image"}
                <input key={styleFileKey} type="file" accept="image/png,image/jpeg,image/webp,image/gif" style={{ display: "none" }} onChange={(e) => onStyleImg(e.target.files && e.target.files[0])} />
              </label>
              <button onClick={addStyle} disabled={styleBusy || !styleName.trim()} style={{ ...S.btn(ACCENT, "#FFF"), opacity: (styleBusy || !styleName.trim()) ? 0.55 : 1 }}>{styleBusy ? "Adding…" : "Add style"}</button>
            </div>
          </div>
        )}
      </div>

      <div style={S.card}>
        <div style={S.h2}>Pricing &amp; included options (Excel)</div>
        {/* Sequencing banner (Carolyn 2026-08-06): the template's option columns ARE the
            tenant's Options catalog, so pricing a size before the catalog exists means
            re-downloading the sheet later to say what's included. Say so before they start. */}
        <div style={{ background: "#FEF3C7", border: "1px solid #FDE68A", borderRadius: 8, padding: "11px 14px", marginBottom: 12, display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
          <span aria-hidden="true" style={{ fontSize: 15, lineHeight: 1.4 }}>💡</span>
          <div style={{ flex: 1, minWidth: 220, fontSize: 13, color: "#92400E", lineHeight: 1.55 }}>
            <b>Set up your Options first.</b> Every door, window, ramp, and add-on you offer becomes a
            column in this sheet — that's how you say what comes <b>included</b> with each style and size.
            Build that list under <b>Options</b>, then download the template so nothing is missing from it.
          </div>
          {onGoToOptions && (
            <button onClick={onGoToOptions} style={{ ...S.btn("#FFF", "#92400E"), border: "1px solid #FDE68A", padding: "6px 12px", whiteSpace: "nowrap" }}>Go to Options →</button>
          )}
        </div>
        <p style={{ fontSize: 13, color: "#64748B", marginBottom: 12, lineHeight: 1.5 }}>
          Download the template (one row per building style), then add a row for every size you offer: type the
          <b> width</b> and <b>length</b> (in feet) and the <b>price</b>. The option columns hold the <b>quantity
          included in the price</b> — for a loft that's the included <b>square footage</b> (e.g. <b>50</b>), for doors
          and windows a <b>count</b> (e.g. <b>1</b>). Put <b>0</b> to charge for it instead. If a customer declines an
          included item, their estimate credits the quantity × your configured rate. Re-upload anytime to update prices
          (matched by style + size, so no duplicates). A blank price — or <b>active = no</b> — hides that size from your designer.
          The option columns include <b>every door, window, and ramp in your catalog</b> (each shown with its size) alongside the
          built-in items — so you can set how many of a specific catalog item come included with each size.
        </p>
        {!cat ? <div style={{ fontSize: 13, color: "#94A3B8" }}>Loading…</div> : activeStyles().length === 0 ? (
          <div style={{ background: "#DBEAFF", border: "1px solid #75E6DA", borderRadius: 8, padding: "11px 14px", color: "#1B7895", fontSize: 13, lineHeight: 1.5 }}>
            <b>Add a building style above first.</b> The pricing template is built from your styles — add at least one
            (with a name &amp; photo), then come back here to download it and set sizes &amp; prices.
          </div>
        ) : (
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <button onClick={downloadTemplate} disabled={dlBusy} style={{ ...S.btn("#F1F5F9", "#334155"), opacity: dlBusy ? 0.6 : 1, cursor: dlBusy ? "default" : "pointer" }}>{dlBusy ? "Preparing…" : "⬇ Download Excel template"}</button>
            <label style={{ ...S.btn(busy ? "#9CA3AF" : "#1E293B", "#FFF"), cursor: busy ? "default" : "pointer", display: "inline-block" }}>
              {busy ? "Importing…" : "⬆ Upload filled sheet"}
              <input key={fileKey} type="file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" disabled={busy} style={{ display: "none" }}
                onChange={(e) => onUpload(e.target.files && e.target.files[0])} />
            </label>
          </div>
        )}
        {result && result.skipped && result.skipped.length > 0 && (
          <div style={{ marginTop: 12, fontSize: 13 }}>
            <div style={{ color: "#B91C1C", fontWeight: 700 }}>{result.skipped.length} row(s) skipped:</div>
            <ul style={{ margin: "4px 0 0 18px", color: "#B91C1C", maxHeight: 160, overflow: "auto" }}>
              {result.skipped.slice(0, 30).map((s, i) => <li key={i}>{s}</li>)}
            </ul>
          </div>
        )}
      </div>
    </>
  );
}

// ─── Layout-item pricing (per placeable: doors, windows, workbench, loft, ramp) ───
// Edits the DEFAULT (all-styles) price for each enabled layout item. Per-style overrides
// stay DB-managed. These rates feed estimates for tenants that don't price via GHL products.
const LP_METHODS = [
  { value: "each", label: "each" },
  { value: "lineal_ft", label: "lineal ft" },
  { value: "sqft_option", label: "sqft option" },
  { value: "sqft_building", label: "sqft building" },
  { value: "perimeter_building", label: "perimeter building" },
  { value: "pct_building_price", label: "pct building price" },
  { value: "pct_estimate_total", label: "pct estimate total" },
];
function LayoutPricing({ viewingLabel = null, clientId = null }) {
  // Operator "view as": scope catalog read + archive to the client on screen (see DoorsView).
  const scoped = (body) => (viewingLabel && clientId ? { ...body, targetClientId: clientId } : body);
  const [cat, setCat] = useState(null);     // { clientId, items, layoutPricing }
  const [rows, setRows] = useState([]);      // [{ item_key, label, pricing_method, rate, archived }]
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [fileKey, setFileKey] = useState(0);
  const [imgBusyKey, setImgBusyKey] = useState(null);   // item_key currently uploading an image
  const [imgFileKey, setImgFileKey] = useState(0);      // resets the hidden file inputs after a pick

  const buildRows = (data) => {
    const byKey = {}; (data.layoutPricing || []).forEach((r) => { byKey[r.item_key] = r; });
    // The ramp is managed entirely in the Ramp section now (mode/price/offer + archive), so it is
    // no longer shown or archived here.
    return (data.items || []).filter((it) => it.key !== "ramp").map((it) => {
      const p = byKey[it.key] || {};
      return { item_key: it.key, label: it.label, pricing_method: p.pricing_method || "each", rate: p.rate != null ? String(p.rate) : "0", image_url: p.image_url || null, archived: !!it.archived, internalOnly: !!it.internalOnly };
    });
  };

  const load = async () => {
    const { data, error } = await sb.functions.invoke("portal-settings", { body: scoped({ action: "catalog" }) });
    if (error || (data && data.error)) { setMsg({ err: (error && error.message) || data.error }); return; }
    setCat(data); setRows(buildRows(data));
  };
  useEffect(() => { load(); }, []);

  // Archive / restore a built-in option. Archived = retired from new builds but still rendered on
  // every existing design (get_config keeps it, flagged noPalette+archived). Reloads to re-sort.
  const toggleArchive = async (itemKey, archived) => {
    setBusy(true); setMsg(null);
    try {
      const { data, error } = await sb.functions.invoke("portal-settings", { body: scoped({ action: "set_layout_item_archived", itemKey, archived }) });
      if (error || (data && data.error)) throw new Error((error && error.message) || data.error);
      await load();
      setMsg({ ok: archived ? "Option archived — it stays on existing designs but can't be added to new ones." : "Option restored." });
    } catch (e) { setMsg({ err: e.message }); }
    setBusy(false);
  };

  // Internal-only = still placeable in the rep (embedded) designer and still rendered on existing
  // designs, but dropped from the customer-facing designer's palette (get_config emits internalOnly;
  // the designer filters by `embedded`). Independent of archive. Optimistic local update.
  const toggleInternal = async (itemKey, internalOnly) => {
    setBusy(true); setMsg(null);
    setRows((rs) => rs.map((r) => r.item_key === itemKey ? { ...r, internalOnly } : r));
    try {
      const { data, error } = await sb.functions.invoke("portal-settings", { body: scoped({ action: "set_layout_item_internal_only", itemKey, internalOnly }) });
      if (error || (data && data.error)) throw new Error((error && error.message) || data.error);
      setMsg({ ok: internalOnly ? "Item set to Internal Designer only — customers can’t add it, but it still shows on designs that already have it." : "Item available on the customer designer again." });
    } catch (e) { setRows((rs) => rs.map((r) => r.item_key === itemKey ? { ...r, internalOnly: !internalOnly } : r)); setMsg({ err: e.message }); }
    setBusy(false);
  };

  const setRow = (key, field, val) => setRows((rs) => rs.map((r) => r.item_key === key ? { ...r, [field]: val } : r));

  // Optional per-item product image. Uploads immediately to get a public URL (branding
  // bucket, via portal-settings), stores it on the row, and persists on "Save prices" →
  // layout_item_pricing.image_url, which submit-estimate attaches to that item's estimate line.
  const ALLOWED_IMG = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  const onRowImg = async (itemKey, file) => {
    if (!file) return;
    if (!ALLOWED_IMG.includes(file.type)) { setMsg({ err: "Use a JPG, PNG, WEBP or GIF image." }); setImgFileKey((k) => k + 1); return; }
    if (file.size > 3_000_000) { setMsg({ err: "Image too large (max 3MB)." }); setImgFileKey((k) => k + 1); return; }
    setImgBusyKey(itemKey); setMsg(null);
    try {
      const base64 = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onerror = () => rej(new Error("Could not read that image."));
        r.onload = () => res(r.result);
        r.readAsDataURL(file);
      });
      const { data, error } = await sb.functions.invoke("portal-settings", { body: { action: "upload_layout_image", imageBase64: base64, imageContentType: file.type || "image/jpeg" } });
      if (error || (data && data.error)) throw new Error((error && error.message) || data.error);
      setRow(itemKey, "image_url", data.url);
      setMsg({ ok: "Image added — click “Save prices” to apply it to estimates." });
    } catch (e) { setMsg({ err: e.message }); }
    setImgBusyKey(null); setImgFileKey((k) => k + 1);
  };
  const removeRowImg = (itemKey) => { setRow(itemKey, "image_url", null); setMsg({ ok: "Image removed — click “Save prices” to apply." }); };

  const save = async (rowsToSave) => {
    setBusy(true); setMsg(null);
    try {
      const src = rowsToSave || rows;
      // Rates are validated, never coerced: `Number(r.rate) || 0` used to turn an unparseable
      // cell ("TBD", "1.2.3" — easy via the CSV upload) into a silent $0 BEFORE the request,
      // sneaking past the server's own invalid-rate guard, so the option then priced at $0 on
      // every customer estimate (audit 2026-08-20). Refuse and name the rows instead. A blank
      // rate still means 0 — that's how an untouched row round-trips.
      const rateOf = (r) => { const s = String(r.rate ?? "").trim(); return s === "" ? 0 : Number(s); };
      const bad = src.filter((r) => { const n = rateOf(r); return !Number.isFinite(n) || n < 0; });
      if (bad.length) throw new Error(`Nothing was saved — fix these rate(s) first, they aren't usable dollar amounts: ${bad.map((r) => `${r.label} ("${r.rate}")`).join(", ")}.`);
      const payloadRows = src.map((r) => ({ item_key: r.item_key, pricing_method: r.pricing_method, rate: rateOf(r), imageUrl: r.image_url ?? null }));
      const { data, error } = await sb.functions.invoke("portal-settings", { body: { action: "save_layout_pricing", rows: payloadRows } });
      if (error || (data && data.error)) throw new Error((error && error.message) || data.error);
      await load();
      const skipped = data.skipped || [];
      setMsg({ ok: `Saved ${data.saved || 0} item price(s)` + (skipped.length ? `, ${skipped.length} skipped` : "") + ".", skipped });
    } catch (e) { setMsg({ err: e.message }); }
    setBusy(false);
  };

  const downloadCsv = () => {
    const headers = ["item", "method", "rate"];
    downloadFile(`${(cat && cat.clientId) || "layout"}-layout-pricing.csv`, toCSV(headers, rows.map((r) => [r.item_key, r.pricing_method, r.rate])));
  };

  const onUpload = async (file) => {
    if (!file) return;
    setBusy(true); setMsg(null);
    try {
      if (file.size > 2_000_000) throw new Error("CSV too large (max 2MB).");
      const matrix = parseCSV(await file.text());
      if (matrix.length < 2) throw new Error("CSV has no data rows.");
      const header = matrix[0].map((h) => String(h).trim().toLowerCase());
      const iItem = header.indexOf("item"), iMethod = header.indexOf("method"), iRate = header.indexOf("rate");
      if (iItem < 0 || iMethod < 0 || iRate < 0) throw new Error('CSV needs "item", "method" and "rate" columns.');
      // Accept the item by key or label, and the method as its enum value or friendly label.
      const keyByAny = {}; rows.forEach((r) => { keyByAny[r.item_key.toLowerCase()] = r.item_key; keyByAny[r.label.toLowerCase()] = r.item_key; });
      const methodByAny = {}; LP_METHODS.forEach((m) => { methodByAny[m.value.toLowerCase()] = m.value; methodByAny[m.label.toLowerCase()] = m.value; });
      const next = rows.map((r) => ({ ...r }));
      const byKey = {}; next.forEach((r) => { byKey[r.item_key] = r; });
      matrix.slice(1).forEach((cols) => {
        const itemKey = keyByAny[String(cols[iItem] || "").trim().toLowerCase()];
        if (!itemKey || !byKey[itemKey]) return;   // unknown/disabled item — ignore
        const method = methodByAny[String(cols[iMethod] || "").trim().toLowerCase()];
        if (method) byKey[itemKey].pricing_method = method;
        const rate = String(cols[iRate] || "").replace(/[$,\s]/g, "");
        if (rate !== "") byKey[itemKey].rate = rate;
      });
      setRows(next);
      await save(next);
    } catch (e) { setMsg({ err: e.message }); }
    setBusy(false); setFileKey((k) => k + 1);
  };

  const errStyle = { background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 8, padding: "9px 13px", color: "#DC2626", fontSize: 13, fontWeight: 600, marginBottom: 12 };
  const okStyle = { background: "#F0FDF4", border: "1px solid #BBF7D0", borderRadius: 8, padding: "9px 13px", color: "#15803D", fontSize: 13, fontWeight: 600, marginBottom: 12 };
  const thumb = { width: 48, height: 36, borderRadius: 4, background: "#F1F5F9", objectFit: "cover", flexShrink: 0, border: "1px solid #E2E8F0" };
  return (
    <>
      {msg && msg.err && <div style={errStyle}>{msg.err}</div>}
      {msg && msg.ok && <div style={okStyle}>{msg.ok}</div>}
      <div style={S.card}>
        <div style={S.h2}>Options</div>
        <p style={{ fontSize: 13, color: "#64748B", marginBottom: 14, lineHeight: 1.5 }}>
          Set how each item customers can place on the floor plan is priced —
          <b>each</b> = rate × count; <b>lineal ft</b> = rate × total feet; <b>sqft option</b> = rate × option area;
          <b>sqft building</b> = rate × (width × depth); <b>perimeter building</b> = rate × 2 × (width + depth);
          <b>pct building price</b> = (rate ÷ 100) × base building price; <b>pct estimate total</b> = (rate ÷ 100) × subtotal of all other lines, resolved last.
          These rates are used on estimates when you don’t price through your CRM’s products. Building sizes are priced on the <b>Structures</b> tab.
          <br />Add an optional <b>product image</b> per item — it appears on that line of the customer’s estimate.
        </p>
        {!cat ? <div style={{ fontSize: 13, color: "#94A3B8" }}>Loading…</div> : rows.length === 0 ? (
          <div style={{ fontSize: 13, color: "#64748B" }}>No placeable items are enabled for your designer yet.</div>
        ) : (
          <>
            {/* overflowX wrapper: the method select + rate input enforce ~300px of minimum
                cell width, so on narrow viewports (68px icon rail) the table scrolls inside
                its card instead of forcing page-level horizontal scroll. */}
            <div className="tight" style={{ overflowX: "auto", marginBottom: 14 }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>
                <th style={S.th}>Item</th><th style={S.th}>How it’s priced</th><th style={S.th}>Rate (USD)</th><th style={S.th}>Image</th><th style={{ ...S.th, textAlign: "center" }} title="Available in the rep designer only — hidden from customers’ placement buttons on the client-facing page (already-placed items still show).">Internal</th><th style={S.th}></th>
              </tr></thead>
              <tbody>
                {rows.map((r) => r).sort((a, b) => (a.archived ? 1 : 0) - (b.archived ? 1 : 0)).map((r) => (
                  <tr key={r.item_key} style={r.archived ? { opacity: 0.55 } : undefined}>
                    <td style={{ ...S.td, fontWeight: 700 }}>{r.label}{r.archived && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 800, color: "#B45309", background: "#FEF3C7", borderRadius: 4, padding: "1px 6px" }}>Archived</span>}</td>
                    <td style={S.td}>
                      <select value={r.pricing_method} onChange={(e) => setRow(r.item_key, "pricing_method", e.target.value)} style={{ ...S.input, width: "auto", minWidth: 170 }}>
                        {LP_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                      </select>
                    </td>
                    <td style={S.td}>
                      <input type="number" min="0" step="0.01" value={r.rate} onChange={(e) => setRow(r.item_key, "rate", e.target.value)} style={{ ...S.input, width: 120 }} />
                    </td>
                    <td style={S.td}>
                      {r.image_url ? (
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <img src={r.image_url} alt="" style={thumb} />
                          <button onClick={() => removeRowImg(r.item_key)} disabled={busy || imgBusyKey === r.item_key} style={S.btn("#F1F5F9", "#334155")}>Remove</button>
                        </div>
                      ) : (
                        <label style={{ ...S.btn("#F1F5F9", "#334155"), cursor: imgBusyKey === r.item_key ? "default" : "pointer", display: "inline-block" }}>
                          {imgBusyKey === r.item_key ? "Uploading…" : "Add image"}
                          <input key={imgFileKey} type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={imgBusyKey === r.item_key} style={{ display: "none" }} onChange={(e) => onRowImg(r.item_key, e.target.files && e.target.files[0])} />
                        </label>
                      )}
                    </td>
                    <td style={{ ...S.td, textAlign: "center" }}>
                      <label title="Internal only: reps can still place it in the designer and it stays on existing designs, but customers can't add it on the client-facing page" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: busy ? "default" : "pointer" }}>
                        <input type="checkbox" checked={!!r.internalOnly} disabled={busy} onChange={() => toggleInternal(r.item_key, !r.internalOnly)} style={{ width: 16, height: 16, cursor: busy ? "default" : "pointer", accentColor: DOOR_MINT }} />
                      </label>
                    </td>
                    <td style={{ ...S.td, textAlign: "center", whiteSpace: "nowrap" }}>
                      <button onClick={() => toggleArchive(r.item_key, !r.archived)} disabled={busy}
                        title={r.archived ? "Restore this option to new builds" : "Archive: retire from new builds, keep on every existing design"}
                        style={S.btn(r.archived ? "#FEF3C7" : "#F1F5F9", r.archived ? "#B45309" : "#64748B")}>{r.archived ? "Unarchive" : "Archive"}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <button onClick={() => save()} disabled={busy} style={S.btn(busy ? "#9CA3AF" : ACCENT, "#FFF")}>{busy ? "Saving…" : "Save prices"}</button>
              <button onClick={downloadCsv} disabled={busy || !cat} style={S.btn("#F1F5F9", "#334155")}>⬇ Download CSV</button>
              <label style={{ ...S.btn(busy ? "#9CA3AF" : "#1E293B", "#FFF"), cursor: busy ? "default" : "pointer", display: "inline-block" }}>
                {busy ? "Working…" : "⬆ Upload CSV"}
                <input key={fileKey} type="file" accept=".csv,text/csv" disabled={busy} style={{ display: "none" }} onChange={(e) => onUpload(e.target.files && e.target.files[0])} />
              </label>
            </div>
          </>
        )}
        {msg && msg.skipped && msg.skipped.length > 0 && (
          <div style={{ marginTop: 12, fontSize: 13 }}>
            <div style={{ color: "#B91C1C", fontWeight: 700 }}>{msg.skipped.length} item(s) skipped:</div>
            <ul style={{ margin: "4px 0 0 18px", color: "#B91C1C", maxHeight: 160, overflow: "auto" }}>
              {msg.skipped.slice(0, 30).map((s, i) => <li key={i}>{s}</li>)}
            </ul>
          </div>
        )}
      </div>
    </>
  );
}

// ─── Doors / Ramps / Windows (Options tab → the fixtures catalog) ───
// fixture_items, one flat row per item (its own size + price + photo; doors also carry
// swing/operation). Each item renders as ONE read-only summary line and is edited/saved
// INDIVIDUALLY via save_fixture / delete_fixture — the old full-list-replace saves are gone
// from the UI, so a save can never silently delete the rest of the list. Drag ⠿ to reorder
// (reorder_fixtures → the designer's picker order). Export/Import is an Excel round-trip:
// a real .xlsx (CSV fallback) with an ID column; re-import matches by ID and UPSERTS ONLY —
// rows missing from the file are never deleted. A swing/operation ★ default only shows —
// and is only saved — when BOTH opposite options are checked; the customer can flip to the
// other on the plan. Checkboxes use the portal mint.
const DOOR_MINT = "#75E6DA";
// Door sizes are entered as feet/inches ( 8'  ·  6'3"  ·  36" ) but stored as inches. No
// spaces allowed, so the width/height parse cleanly. parseFtIn -> inches (number), NaN if
// unparseable, null if blank. fmtFtIn -> the display string.
function parseFtIn(s) {
  const t = String(s == null ? "" : s).trim();
  if (t === "") return null;
  if (/\s/.test(t)) return NaN;
  let m = t.match(/^(\d+(?:\.\d+)?)'(\d+(?:\.\d+)?)?"?$/);   // feet, optional inches
  if (m) return parseFloat(m[1]) * 12 + (m[2] ? parseFloat(m[2]) : 0);
  m = t.match(/^(\d+(?:\.\d+)?)"?$/);                        // inches (bare or with ")
  if (m) return parseFloat(m[1]);
  return NaN;
}
function fmtFtIn(inches) {
  const n = Number(inches);
  if (!isFinite(n) || n <= 0) return "";
  const ft = Math.floor(n / 12), inch = Math.round((n - ft * 12) * 100) / 100;
  if (ft === 0) return inch + '"';
  if (inch === 0) return ft + "'";
  return ft + "'" + inch + '"';
}
function ftInToInches(s) { const v = parseFtIn(s); return (typeof v === "number" && isFinite(v)) ? v : ""; }

// The shared per-line catalog editor. `sizeWord` flips the second dimension's wording
// ("height" for doors/windows, "length" for ramps — height_in holds the ramp LENGTH).
function FixtureCatalog({ category, noun, addLabel, namePh, labelPh, wPh, hPh, sizeWord = "height", hasSwingOp = false, viewingLabel = null, clientId = null }) {
  // Operator "view as": scope EVERY call to the client on screen explicitly, so an item is
  // always read/written for the tenant shown, never silently the operator's own.
  const scoped = (body) => (viewingLabel && clientId ? { ...body, targetClientId: clientId } : body);
  const [rows, setRows] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [edit, setEdit] = useState(null);            // { idx, draft } — idx -1 = adding a new item
  const [pendingDelete, setPendingDelete] = useState(null);
  const [dragIdx, setDragIdx] = useState(null);
  const [imgBusy, setImgBusy] = useState(false);
  const [imgFileKey, setImgFileKey] = useState(0);
  const [straighten, setStraighten] = useState(null);   // File awaiting the straighten step
  const [dlBusy, setDlBusy] = useState(false);
  const [fileKey, setFileKey] = useState(0);

  const mapRow = (d) => ({
    id: d.id, name: d.name || "", plan_label: d.plan_label || "", show_image_on_estimate: d.show_image_on_estimate !== false,
    width_in: d.width_in != null ? fmtFtIn(d.width_in) : "", height_in: d.height_in != null ? fmtFtIn(d.height_in) : "",
    price: d.price != null ? String(d.price) : "",
    swing_in: !!d.swing_in, swing_out: !!d.swing_out, swing_default: d.swing_default || null,
    op_right: !!d.op_right, op_left: !!d.op_left, op_double: !!d.op_double, op_slideup: !!d.op_slideup, op_default: d.op_default || null,
    image_url: d.image_url || null, active: d.active !== false, archived: d.archived === true, internalOnly: d.internal_only === true,
  });
  const load = async () => {
    const { data, error } = await sb.functions.invoke("portal-settings", { body: scoped({ action: "catalog" }) });
    if (error || (data && data.error)) { setMsg({ err: (error && error.message) || data.error }); return; }
    const list = (data.fixtures || []).filter((f) => (f.category || "door") === category).map(mapRow);
    // Display order = the order drag persists: live items first, archived sink to the bottom.
    setRows([...list.filter((r) => !r.archived), ...list.filter((r) => r.archived)]);
    setLoaded(true);
  };
  useEffect(() => { load(); }, []);

  // One line's payload for save_fixture / import_fixtures. Sizes go over as inches.
  const toPayload = (r) => ({
    id: r.id || undefined, category, name: r.name, planLabel: r.plan_label,
    showImageOnEstimate: r.show_image_on_estimate !== false,
    widthIn: ftInToInches(r.width_in), heightIn: ftInToInches(r.height_in), price: r.price,
    swingIn: !!r.swing_in, swingOut: !!r.swing_out, swingDefault: r.swing_default,
    opRight: !!r.op_right, opLeft: !!r.op_left, opDouble: !!r.op_double, opSlideUp: !!r.op_slideup, opDefault: r.op_default,
    imageUrl: r.image_url || null, active: r.active !== false, archived: r.archived === true, internalOnly: r.internalOnly === true,
  });

  const saveLine = async () => {
    if (!edit) return;
    setBusy(true); setMsg(null);
    try {
      const { data, error } = await sb.functions.invoke("portal-settings", { body: scoped({ action: "save_fixture", ...toPayload(edit.draft) }) });
      if (error || (data && data.error)) throw new Error((error && error.message) || data.error);
      const saved = { ...edit.draft, id: edit.draft.id || (data && data.id) || null };
      setRows((rs) => edit.idx < 0 ? [...rs, saved] : rs.map((r, j) => j === edit.idx ? saved : r));
      setEdit(null);
      setMsg({ ok: `Saved “${saved.name}”.` });
    } catch (e) { setMsg({ err: e.message }); }
    setBusy(false);
  };

  // Immediate toggle on a saved line (Archive / Unarchive): whole-row save with the patch
  // applied — optimistic, rolled back on error.
  const quickSave = async (idx, patch) => {
    const before = rows[idx];
    const after = { ...before, ...patch };
    setBusy(true); setMsg(null);
    setRows((rs) => rs.map((r, j) => j === idx ? after : r));
    try {
      const { data, error } = await sb.functions.invoke("portal-settings", { body: scoped({ action: "save_fixture", ...toPayload(after) }) });
      if (error || (data && data.error)) throw new Error((error && error.message) || data.error);
    } catch (e) { setRows((rs) => rs.map((r, j) => j === idx ? before : r)); setMsg({ err: e.message }); }
    setBusy(false);
  };

  const confirmDelete = async () => {
    const row = pendingDelete; if (!row) return;
    // A line that never reached the server has no id. Drop it locally instead of asking the
    // server to delete nothing — that round trip could only ever come back as an error, and
    // it left the builder unable to clear a row they could see.
    if (!row.id) {
      setRows((rs) => rs.filter((r) => r !== row));
      setPendingDelete(null);
      setMsg({ ok: "Removed the unsaved line." });
      return;
    }
    setBusy(true); setMsg(null);
    try {
      const { data, error } = await sb.functions.invoke("portal-settings", { body: scoped({ action: "delete_fixture", id: row.id }) });
      if (error || (data && data.error)) throw new Error((error && error.message) || data.error);
      setRows((rs) => rs.filter((r) => r !== row));
      setPendingDelete(null);
      setMsg({ ok: `Deleted “${row.name}”.` });
    } catch (e) { setMsg({ err: e.message }); }
    setBusy(false);
  };

  const persistOrder = async (next) => {
    setRows(next);
    const ids = next.map((r) => r.id).filter(Boolean);
    if (!ids.length) return;
    const { data, error } = await sb.functions.invoke("portal-settings", { body: scoped({ action: "reorder_fixtures", category, orderedIds: ids }) });
    if (error || (data && data.error)) setMsg({ err: (error && error.message) || data.error });
  };
  const moveRow = (from, to) => {
    if (from == null || to == null || from === to) return;
    const next = rows.slice(); const [m] = next.splice(from, 1); next.splice(to, 0, m);
    persistOrder(next);
  };

  const ALLOWED_IMG = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  const guardImg = (file) => { if (!ALLOWED_IMG.includes(file.type)) { setMsg({ err: "Use a JPG, PNG, WEBP or GIF image." }); return false; } if (file.size > 20_000_000) { setMsg({ err: "That photo is over 20MB — take it at a lower resolution." }); return false; } return true; };
  const uploadImg = async (file) => {
    file = await ssFitImageForUpload(file);
    const base64 = await new Promise((res, rej) => { const r = new FileReader(); r.onerror = () => rej(new Error("Could not read that image.")); r.onload = () => res(r.result); r.readAsDataURL(file); });
    const { data, error } = await sb.functions.invoke("portal-settings", { body: scoped({ action: "upload_fixture_image", imageBase64: base64, imageContentType: file.type || "image/jpeg" }) });
    if (error || (data && data.error)) throw new Error((error && error.message) || data.error);
    return data.url;
  };
  // A picked photo goes through the straighten step FIRST. This image is what the 3D
  // masks onto the door slab, so a tilted phone shot becomes a tilted door on the
  // customer's building; squaring it up here is cheaper than asking for a reshoot.
  // The aspect comes from the dimensions the builder already typed for pricing.
  const onDraftImg = (file) => {
    if (!file) return; if (!guardImg(file)) { setImgFileKey((k) => k + 1); return; }
    setImgFileKey((k) => k + 1);
    setStraighten(file);
  };
  const onStraightened = async (file) => {
    setStraighten(null);
    if (!file) return;
    setImgBusy(true); setMsg(null);
    try { const url = await uploadImg(file); setDraft({ image_url: url }); } catch (e) { setMsg({ err: e.message }); }
    setImgBusy(false);
  };

  // ── Excel round-trip. ASCII-only headers (a “×” becomes mojibake in Excel and the column
  // silently drops on re-import). The ID column is the row key: keep it to update a row,
  // leave it blank on rows you add. Photos never ride in the sheet (managed here). ──
  const HEADERS = hasSwingOp
    ? ["ID", "Style", "Label on plan", "Width", "Height", "Price", "Swing out", "Swing in", "Default swing", "Opens right", "Opens left", "Double", "Slide up", "Default operation", "Photo on estimate", "Active", "Internal only", "Archived"]
    : ["ID", "Style", "Label on plan", "Width", sizeWord === "length" ? "Length" : "Height", "Price", "Photo on estimate", "Active", "Internal only", "Archived"];
  const yn = (b) => (b ? "yes" : "no");
  const exportRows = () => rows.map((r) => hasSwingOp
    ? [r.id || "", r.name, r.plan_label, r.width_in, r.height_in, r.price === "" ? "" : Number(r.price), yn(r.swing_out), yn(r.swing_in), r.swing_default || "", yn(r.op_right), yn(r.op_left), yn(r.op_double), yn(r.op_slideup), r.op_default || "", yn(r.show_image_on_estimate), yn(r.active), yn(r.internalOnly), yn(r.archived)]
    : [r.id || "", r.name, r.plan_label, r.width_in, r.height_in, r.price === "" ? "" : Number(r.price), yn(r.show_image_on_estimate), yn(r.active), yn(r.internalOnly), yn(r.archived)]);
  const doExport = async () => {
    if (dlBusy || rows.length === 0) return;
    const body = exportRows();
    setDlBusy(true); setMsg(null);
    let ExcelJS;
    try { ExcelJS = await loadExcelJS(); }
    catch (e) {
      // Library unreachable → still hand back a usable CSV so the download never fully fails.
      downloadFile(`${category}s-catalog.csv`, toCSV(HEADERS, body.map((r) => r.map((v) => (v == null ? "" : String(v))))));
      setMsg({ err: `${e.message} Downloaded a plain CSV instead.` });
      setDlBusy(false);
      return;
    }
    try {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Catalog", { views: [{ state: "frozen", xSplit: 2, ySplit: 1 }] });
      ws.addRow(HEADERS);
      body.forEach((r) => ws.addRow(r));
      const thin = { style: "thin", color: { argb: "FFCBD5E1" } };
      const hdr = ws.getRow(1); hdr.height = 28;
      for (let c = 1; c <= HEADERS.length; c++) {
        const cell = hdr.getCell(c);
        cell.font = { bold: true, size: 10, color: { argb: "FFFFFFFF" } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: c === 1 ? "FF94A3B8" : "FF334155" } };
        cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
        cell.border = { top: thin, left: thin, bottom: thin, right: thin };
      }
      const nameW = Math.min(Math.max(10, ...body.map((r) => String(r[1] || "").length)) + 2, 34);
      ws.columns.forEach((colObj, i) => { colObj.width = i === 0 ? 12 : i === 1 ? nameW : Math.min(Math.max(String(HEADERS[i]).length + 2, 9), 20); });
      for (let r = 2; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        for (let cc = 1; cc <= HEADERS.length; cc++) {
          const cell = row.getCell(cc);
          cell.border = { left: thin, right: thin, bottom: thin, top: thin };
          cell.alignment = { vertical: "middle", horizontal: cc === 2 ? "left" : "center" };
          if (cc === 2) cell.font = { bold: true };
          if (cc === 1) cell.font = { size: 9, color: { argb: "FF94A3B8" } };
        }
        row.getCell(6).numFmt = '$#,##0';
      }
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: HEADERS.length } };
      const buf = await wb.xlsx.writeBuffer();
      downloadBlob(`${category}s-catalog.xlsx`, new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
      setMsg({ ok: "Exported. Edit in Excel, then Import — the ID column matches rows back up; leave it blank on rows you add. Rows you remove from the file are NOT deleted here." });
    } catch (e) { setMsg({ err: `Could not build the Excel file: ${e.message}` }); }
    setDlBusy(false);
  };
  const onImport = async (file) => {
    if (!file) return;
    setBusy(true); setMsg(null);
    try {
      if (file.size > 5_000_000) throw new Error("File too large (max 5MB).");
      const isXlsx = /\.xlsx$/i.test(file.name) || file.type.includes("spreadsheetml");
      const matrix = isXlsx ? await readXlsxMatrix(file, await loadExcelJS()) : parseCSV(await file.text());
      if (matrix.length < 2) throw new Error("The sheet has no data rows.");
      const lc = matrix[0].map((h) => String(h).trim().toLowerCase());
      const col = (...names) => { for (const n of names) { const i = lc.indexOf(n); if (i >= 0) return i; } return -1; };
      const iId = col("id"), iName = col("style", "name"), iLabel = col("label on plan", "label"),
        iW = col("width"), iH = col(sizeWord === "length" ? "length" : "height", "height", "length"), iPrice = col("price"),
        iSwOut = col("swing out"), iSwIn = col("swing in"), iSwDef = col("default swing"),
        iOpR = col("opens right", "right"), iOpL = col("opens left", "left"), iOpD = col("double"), iOpS = col("slide up"), iOpDef = col("default operation"),
        iPhoto = col("photo on estimate", "on estimate"), iActive = col("active"), iInternal = col("internal only", "internal"), iArch = col("archived");
      if (iName < 0 || iW < 0 || iH < 0 || iPrice < 0) throw new Error('The sheet needs "Style", "Width", "' + (sizeWord === "length" ? "Length" : "Height") + '" and "Price" columns.');
      const truthy = (v) => /^\s*(y|yes|true|1)\s*$/i.test(String(v == null ? "" : v));
      // Absent column (index < 0) → undefined: the key is dropped from the JSON body, and the
      // server's presence contract leaves that field UNCHANGED on ID-matched rows. A trimmed
      // sheet (say ID/Style/Width/Height/Price, the natural bulk-price edit) used to reset
      // archived/internal-only/swing flags to their defaults on every imported row — silently
      // un-archiving retired doors into the customer designer (audit 2026-08-20). A blank cell
      // in a PRESENT column still means the default, matching the "yes"/"no" the export writes.
      const bool = (cols, i, dflt) => i < 0 ? undefined : (String(cols[i] == null ? "" : cols[i]).trim() === "" ? dflt : truthy(cols[i]));
      const importRows = matrix.slice(1).map((cols) => {
        const row = {
          id: iId >= 0 ? String(cols[iId] == null ? "" : cols[iId]).trim() : "",
          name: cols[iName], planLabel: iLabel >= 0 ? cols[iLabel] : undefined,
          widthIn: ftInToInches(String(cols[iW] == null ? "" : cols[iW]).replace(/\s/g, "")),
          heightIn: ftInToInches(String(cols[iH] == null ? "" : cols[iH]).replace(/\s/g, "")),
          price: cols[iPrice],
          showImageOnEstimate: bool(cols, iPhoto, true), active: bool(cols, iActive, true),
          internalOnly: bool(cols, iInternal, false), archived: bool(cols, iArch, false),
        };
        if (hasSwingOp) {
          row.swingOut = bool(cols, iSwOut, false); row.swingIn = bool(cols, iSwIn, false);
          const sd = String(iSwDef >= 0 ? (cols[iSwDef] == null ? "" : cols[iSwDef]) : "").trim().toLowerCase();
          row.swingDefault = iSwDef < 0 ? undefined : ((sd === "in" || sd === "out") ? sd : null);
          row.opRight = bool(cols, iOpR, false); row.opLeft = bool(cols, iOpL, false);
          row.opDouble = bool(cols, iOpD, false); row.opSlideUp = bool(cols, iOpS, false);
          const od = String(iOpDef >= 0 ? (cols[iOpDef] == null ? "" : cols[iOpDef]) : "").trim().toLowerCase();
          row.opDefault = iOpDef < 0 ? undefined : ((od === "right" || od === "left") ? od : null);
        }
        return row;
      });
      const { data, error } = await sb.functions.invoke("portal-settings", { body: scoped({ action: "import_fixtures", category, rows: importRows }) });
      if (error || (data && data.error)) throw new Error((error && error.message) || data.error);
      await load();
      const skipped = (data && data.skipped) || [];
      setMsg({ ok: `Imported: ${data.saved || 0} updated, ${data.added || 0} added` + (skipped.length ? `, ${skipped.length} skipped` : "") + ". Rows not in the file were left untouched.", skipped });
    } catch (e) { setMsg({ err: e.message }); }
    setBusy(false); setFileKey((k) => k + 1);
  };

  // ── Draft editing (one line at a time) ──
  const blank = () => ({ id: null, name: "", plan_label: "", show_image_on_estimate: true, width_in: "", height_in: "", price: "", swing_in: false, swing_out: hasSwingOp, swing_default: null, op_right: hasSwingOp, op_left: false, op_double: false, op_slideup: false, op_default: null, image_url: null, active: true, archived: false, internalOnly: false });
  const setDraft = (patch) => setEdit((e) => (e ? { ...e, draft: { ...e.draft, ...patch } } : e));
  // Operation coherence: Double and Slide up are EXCLUSIVE — checking either clears the rest,
  // and checking Right/Left clears Double/Slide up (same rules as the designer expects).
  const setOpD = (field, on) => {
    if (!on) { setDraft({ [field]: false }); return; }
    if (field === "op_double") setDraft({ op_double: true, op_right: false, op_left: false, op_slideup: false, op_default: null });
    else if (field === "op_slideup") setDraft({ op_slideup: true, op_right: false, op_left: false, op_double: false, op_default: null });
    else setDraft({ [field]: true, op_double: false, op_slideup: false });
  };

  const errStyle = { background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 8, padding: "9px 13px", color: "#DC2626", fontSize: 13, fontWeight: 600, marginBottom: 12 };
  const okStyle = { background: "#F0FDF4", border: "1px solid #BBF7D0", borderRadius: 8, padding: "9px 13px", color: "#15803D", fontSize: 13, fontWeight: 600, marginBottom: 12 };
  const thumb = { width: 48, height: 36, borderRadius: 4, background: "#F1F5F9", objectFit: "cover", flexShrink: 0, border: "1px solid #E2E8F0" };
  const chip = (label, bg, fg, title) => <span title={title} style={{ fontSize: 10, fontWeight: 800, color: fg, background: bg, borderRadius: 4, padding: "2px 7px", whiteSpace: "nowrap", flexShrink: 0 }}>{label}</span>;
  // A button, not a clickable span: this picks what the customer sees selected first, and a
  // span has no role, no focus stop and no Enter/Space handling — readable but not operable
  // without a mouse. `aria-pressed` because it is a toggle within a small set, and the label
  // is spelled out since "★" alone tells a screen reader nothing.
  const star = (on, onClick) => (
    <button type="button" aria-pressed={!!on} aria-label={on ? "Default the customer sees first (currently the default)" : "Make this the default the customer sees first"}
      onClick={onClick} title="Default the customer sees first"
      style={{ background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit", color: on ? "#F59E0B" : "#CBD5E1", fontSize: 15, lineHeight: 1 }}>★</button>
  );
  const fldLbl = { fontSize: 12, color: "#64748B", fontWeight: 600, marginBottom: 5 };
  const dCbx = (field, label, title) => (
    <label title={title} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "#334155", cursor: "pointer", whiteSpace: "nowrap" }}>
      <input type="checkbox" checked={!!edit.draft[field]} onChange={(e) => setDraft({ [field]: e.target.checked })} style={{ width: 16, height: 16, cursor: "pointer", accentColor: DOOR_MINT }} />
      {label}
    </label>
  );
  const dOpChk = (field, label) => (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 13, color: "#334155", cursor: "pointer" }}>
      <input type="checkbox" checked={!!edit.draft[field]} onChange={(e) => setOpD(field, e.target.checked)} style={{ width: 16, height: 16, cursor: "pointer", accentColor: DOOR_MINT }} />
      {label}
    </label>
  );

  // The read-only one-line summary of a saved item.
  const summary = (r) => {
    const parts = [];
    if (r.plan_label) parts.push(r.plan_label);
    if (r.width_in || r.height_in) parts.push(sizeWord === "length" ? `${r.width_in || "?"} wide x ${r.height_in || "?"} long` : `${r.width_in || "?"} x ${r.height_in || "?"}`);
    parts.push(r.price !== "" ? `$${Number(r.price).toLocaleString()}` : "not priced");
    if (hasSwingOp) {
      if (r.swing_out && r.swing_in) parts.push(`swings out${r.swing_default === "out" ? " ★" : ""} / in${r.swing_default === "in" ? " ★" : ""}`);
      else if (r.swing_out) parts.push("swings out");
      else if (r.swing_in) parts.push("swings in");
      if (r.op_double) parts.push("double");
      else if (r.op_slideup) parts.push("slide up");
      else if (r.op_right && r.op_left) parts.push(`opens right${r.op_default === "right" ? " ★" : ""} / left${r.op_default === "left" ? " ★" : ""}`);
      else if (r.op_right) parts.push("opens right");
      else if (r.op_left) parts.push("opens left");
    }
    if (r.image_url && r.show_image_on_estimate) parts.push("photo on estimate");
    return parts.join("  ·  ");
  };

  const editPanel = () => (
    <div style={{ border: `2px solid ${ACCENT}`, background: "#FAFAFF", borderRadius: 10, padding: "14px 16px", marginBottom: 8 }}>
      <div style={{ fontSize: 12, fontWeight: 800, color: ACCENT, marginBottom: 10, textTransform: "uppercase", letterSpacing: 0.5 }}>{edit.idx < 0 ? `New ${noun}` : `Editing — ${edit.draft.name || noun}`}</div>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 12 }}>
        <div style={{ flex: "2 1 220px", minWidth: 200 }}>
          <div style={fldLbl}>Style name</div>
          <input type="text" value={edit.draft.name} placeholder={namePh} onChange={(e) => setDraft({ name: e.target.value })} style={{ ...S.input, width: "100%", boxSizing: "border-box" }} />
        </div>
        <div>
          <div style={fldLbl}>Label <span style={{ fontWeight: 400 }}>on plan</span></div>
          <input type="text" value={edit.draft.plan_label} placeholder={labelPh} maxLength={12} onChange={(e) => setDraft({ plan_label: e.target.value })} style={{ ...S.input, width: 80, minWidth: 0, textAlign: "center" }} />
        </div>
        <div>
          <div style={fldLbl}>Width</div>
          <input type="text" value={edit.draft.width_in} placeholder={wPh} onChange={(e) => setDraft({ width_in: e.target.value.replace(/\s/g, "") })} style={{ ...S.input, width: 70, minWidth: 0, textAlign: "center" }} />
        </div>
        <div>
          <div style={fldLbl}>{sizeWord === "length" ? "Length" : "Height"}</div>
          <input type="text" value={edit.draft.height_in} placeholder={hPh} onChange={(e) => setDraft({ height_in: e.target.value.replace(/\s/g, "") })} style={{ ...S.input, width: 70, minWidth: 0, textAlign: "center" }} />
        </div>
        <div>
          <div style={fldLbl}>Price (USD)</div>
          <div style={{ display: "flex", alignItems: "center", gap: 3 }}><span style={{ color: "#94A3B8" }}>$</span><input type="number" min="0" step="any" value={edit.draft.price} placeholder="0" onChange={(e) => setDraft({ price: e.target.value })} style={{ ...S.input, width: 100, minWidth: 0 }} /></div>
        </div>
      </div>
      {hasSwingOp && (
        <div style={{ display: "flex", gap: 28, flexWrap: "wrap", marginBottom: 12 }}>
          <div>
            <div style={fldLbl}>Swing</div>
            <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>{dCbx("swing_out", "Out")}{edit.draft.swing_in && edit.draft.swing_out && star(edit.draft.swing_default === "out", () => setDraft({ swing_default: "out" }))}</span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>{dCbx("swing_in", "In")}{edit.draft.swing_in && edit.draft.swing_out && star(edit.draft.swing_default === "in", () => setDraft({ swing_default: "in" }))}</span>
            </div>
          </div>
          <div>
            <div style={fldLbl}>Operation</div>
            <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>{dOpChk("op_right", "Right")}{edit.draft.op_right && edit.draft.op_left && star(edit.draft.op_default === "right", () => setDraft({ op_default: "right" }))}</span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>{dOpChk("op_left", "Left")}{edit.draft.op_right && edit.draft.op_left && star(edit.draft.op_default === "left", () => setDraft({ op_default: "left" }))}</span>
              {dOpChk("op_double", "Double")}
              {dOpChk("op_slideup", "Slide up")}
            </div>
          </div>
        </div>
      )}
      <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
        {edit.draft.image_url
          ? <div style={{ display: "flex", alignItems: "center", gap: 6 }}><img src={edit.draft.image_url} alt="" style={thumb} /><button onClick={() => setDraft({ image_url: null })} disabled={imgBusy} style={S.btn("#F1F5F9", "#334155")}>Remove</button></div>
          : <label style={{ ...S.btn("#F1F5F9", "#334155"), cursor: imgBusy ? "default" : "pointer", display: "inline-block", whiteSpace: "nowrap" }}>{imgBusy ? "Uploading…" : "Add image"}<input key={imgFileKey} type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={imgBusy} style={{ display: "none" }} onChange={(e) => onDraftImg(e.target.files && e.target.files[0])} /></label>}
        {dCbx("show_image_on_estimate", "Photo on estimate", "Attach this item's photo to its line on the customer's estimate")}
        {dCbx("active", "Active", "Unchecked = hidden from the designer entirely")}
        {dCbx("internalOnly", "Internal only", "Reps can still place it in the designer; customers can't add it on the client-facing page (already-placed items still show)")}
        <span style={{ flex: 1 }} />
        <button onClick={() => setEdit(null)} disabled={busy} style={S.btn("#F1F5F9", "#334155")}>Cancel</button>
        <button onClick={saveLine} disabled={busy || !edit.draft.name.trim()} style={{ ...S.btn(ACCENT, "#FFF"), opacity: (busy || !edit.draft.name.trim()) ? 0.55 : 1 }}>{busy ? "Saving…" : `Save ${noun}`}</button>
      </div>
    </div>
  );

  const line = (r, i) => (
    <div key={r.id || `row-${i}`}
      draggable={!busy && !edit}
      onDragStart={(e) => { setDragIdx(i); e.dataTransfer.effectAllowed = "move"; }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); moveRow(dragIdx, i); setDragIdx(null); }}
      onDragEnd={() => setDragIdx(null)}
      style={{ display: "flex", alignItems: "center", gap: 10, border: `1px solid ${dragIdx === i ? ACCENT : "#E2E8F0"}`, borderRadius: 8, padding: "7px 10px", marginBottom: 8, opacity: dragIdx === i ? 0.4 : (r.archived ? 0.55 : 1), background: "#FFF", cursor: (!busy && !edit) ? "grab" : "default" }}>
      <span title="Drag to reorder — this is the order customers see" style={{ color: "#CBD5E1", fontSize: 16, userSelect: "none", flexShrink: 0 }}>⠿</span>
      {r.image_url
        ? <img src={r.image_url} alt="" style={thumb} />
        : <div style={{ ...thumb, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, color: "#CBD5E1" }}>📷</div>}
      <div style={{ flex: 1, minWidth: 200, display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontWeight: 700, fontSize: 14, color: "#1E293B" }}>{r.name || "(unnamed)"}</span>
        <span style={{ fontSize: 12.5, color: "#64748B" }}>{summary(r)}</span>
      </div>
      {!r.active && chip("Hidden", "#F1F5F9", "#64748B", "Active is off — not offered in the designer")}
      {r.internalOnly && chip("Internal", "#E2E8F0", "#475569", "Internal Designer only — customers can't add it")}
      {r.archived && chip("Archived", "#FEF3C7", "#B45309", "Retired from new builds; still shows on existing designs")}
      <button onClick={() => setEdit({ idx: i, draft: { ...r } })} disabled={busy} style={S.btn("#F1F5F9", "#334155")}>Edit</button>
      <button onClick={() => quickSave(i, { archived: !r.archived })} disabled={busy}
        title={r.archived ? "Restore to active" : "Archive: retire from new builds, keep on existing designs"}
        style={S.btn(r.archived ? "#FEF3C7" : "#F1F5F9", r.archived ? "#B45309" : "#64748B")}>{r.archived ? "Unarchive" : "Archive"}</button>
      <button onClick={() => setPendingDelete(r)} disabled={busy} style={S.btn("#FEF2F2", "#DC2626")}>✕</button>
    </div>
  );

  return (
    <>
      {straighten && (
        <SSStraightenPhoto
          file={straighten}
          // For a door or window the width/height typed for pricing IS the real-world shape
          // of the thing in the photo, so it is the right aspect to square the crop to. For
          // a RAMP those two numbers are a plan footprint (width x run) and describe nothing
          // visible in a photo of it, so the crop is left square and the builder frames it.
          aspect={(() => {
            if (category === "ramp") return 1;
            const w = Number(ftInToInches(edit && edit.draft ? edit.draft.width_in : "")), h = Number(ftInToInches(edit && edit.draft ? edit.draft.height_in : ""));
            return (w > 0 && h > 0) ? (w / h) : 1;
          })()}
          onCancel={() => setStraighten(null)}
          onDone={onStraightened}
        />
      )}
      {msg && msg.err && <div style={errStyle}>{msg.err}</div>}
      {msg && msg.ok && <div style={okStyle}>{msg.ok}</div>}
      {!loaded ? <div style={{ fontSize: 13, color: "#94A3B8" }}>Loading…</div> : (
        <>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
            <span style={{ flex: 1 }} />
            <button onClick={doExport} disabled={dlBusy || busy || rows.length === 0} style={S.btn("#F1F5F9", "#334155")}>{dlBusy ? "Building…" : "⬇ Export Excel"}</button>
            <label style={{ ...S.btn(busy ? "#9CA3AF" : "#F1F5F9", "#334155"), cursor: busy ? "default" : "pointer", display: "inline-block" }}>
              ⬆ Import
              <input key={fileKey} type="file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" disabled={busy} style={{ display: "none" }} onChange={(e) => onImport(e.target.files && e.target.files[0])} />
            </label>
          </div>
          {rows.length === 0 && !edit && <div style={{ fontSize: 13, color: "#64748B", marginBottom: 14 }}>Nothing here yet — click <b>+ {addLabel}</b> below to create your first one.</div>}
          {rows.map((r, i) => (edit && edit.idx === i) ? <React.Fragment key={r.id || `edit-${i}`}>{editPanel()}</React.Fragment> : line(r, i))}
          {edit && edit.idx < 0 && editPanel()}
          <button onClick={() => setEdit({ idx: -1, draft: blank() })} disabled={busy || !!edit} style={{ ...S.btn("#1E293B", "#FFF"), opacity: (busy || !!edit) ? 0.55 : 1 }}>+ {addLabel}</button>
        </>
      )}
      {msg && msg.skipped && msg.skipped.length > 0 && (
        <div style={{ marginTop: 12, fontSize: 13 }}>
          <div style={{ color: "#B91C1C", fontWeight: 700 }}>{msg.skipped.length} row(s) skipped:</div>
          <ul style={{ margin: "4px 0 0 18px", color: "#B91C1C", maxHeight: 160, overflow: "auto" }}>{msg.skipped.slice(0, 30).map((s, i) => <li key={i}>{s}</li>)}</ul>
        </div>
      )}
      {pendingDelete && (
        <div onClick={() => !busy && setPendingDelete(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.5)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 1000 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "#FFF", borderRadius: 12, padding: 22, maxWidth: 440, width: "100%", boxShadow: "0 20px 50px rgba(0,0,0,0.25)" }}>
            <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 10 }}>Delete “{pendingDelete.name}”?</div>
            <p style={{ fontSize: 13.5, color: "#475569", lineHeight: 1.55, marginBottom: 18 }}>
              This removes it from your catalog right away. Any one already placed on a saved design keeps
              showing there. To stop offering it without deleting, use <b>Archive</b> instead.
            </p>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", flexWrap: "wrap" }}>
              <button onClick={() => setPendingDelete(null)} disabled={busy} style={S.btn("#F1F5F9", "#334155")}>Cancel</button>
              <button onClick={confirmDelete} disabled={busy} style={S.btn(busy ? "#9CA3AF" : "#DC2626", "#FFF")}>{busy ? "Deleting…" : "Delete"}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function DoorsView({ viewingLabel = null, clientId = null }) {
  return (
    <div style={S.card}>
      <div style={S.h2}>Doors</div>
      <p style={{ fontSize: 13, color: "#64748B", marginBottom: 14, lineHeight: 1.5 }}>
        The doors your customers can drop onto a building. Each door is <b>one line</b> — click <b>Edit</b> to change it;
        every line saves on its own. Drag <b>⠿</b> to set the order customers see. The <b style={{ color: "#F59E0B" }}>★</b> marks
        the swing/operation default the customer sees first (only needed when more than one is allowed; they can switch to any
        other you’ve checked). Sizes are feet/inches — 8', 6'3", 36" (no spaces). <b>Export Excel</b> to edit in bulk and
        re-import — rows are matched by the ID column, and rows missing from the file are never deleted.
      </p>
      <FixtureCatalog category="door" noun="door" addLabel="Add door" namePh="e.g. Steel door" labelPh="SD" wPh={'36"'} hPh={'80"'} hasSwingOp sizeWord="height" viewingLabel={viewingLabel} clientId={clientId} />
    </div>
  );
}

// ─── Colors (paint palette) ───
// Common shed/barn paint colours for the one-click "quick add" library. Hexes are
// APPROXIMATE — for on-screen recognition only; only the NAME is saved as the colour
// label. Owners curate freely and can verify exact codes at hayleypaint.com. Carolyn's
// examples (Mountain Red / Classic Red / Red Delicious) are included.
const COLOR_LIBRARY = [
  { name: "Bright White", hex: "#F6F6F1" }, { name: "White", hex: "#ECEAE0" },
  { name: "Almond", hex: "#E7D9BE" }, { name: "Beige", hex: "#D8C7A0" },
  { name: "Sandstone", hex: "#C9B489" }, { name: "Buckskin", hex: "#B79A6E" },
  { name: "Desert Tan", hex: "#C2A579" }, { name: "Khaki", hex: "#A89468" },
  { name: "Clay", hex: "#B08155" }, { name: "Mocha Tan", hex: "#9A8064" },
  { name: "Coffee Brown", hex: "#5A4535" }, { name: "Chocolate", hex: "#3E2C22" },
  { name: "Barn Red", hex: "#7B1E22" }, { name: "Mountain Red", hex: "#8C2A2A" },
  { name: "Classic Red", hex: "#A32431" }, { name: "Red Delicious", hex: "#9E1B2A" },
  { name: "Burgundy", hex: "#5E1F2B" }, { name: "Sage Green", hex: "#8A9A78" },
  { name: "Hunter Green", hex: "#2F4A38" }, { name: "Forest Green", hex: "#274134" },
  { name: "Ivy Green", hex: "#3B5E3A" }, { name: "Country Blue", hex: "#5E7C99" },
  { name: "Slate Blue", hex: "#41566B" }, { name: "Navy Blue", hex: "#25324B" },
  { name: "Light Gray", hex: "#C7CACC" }, { name: "Pewter Gray", hex: "#8C9194" },
  { name: "Slate Gray", hex: "#5E676C" }, { name: "Charcoal Gray", hex: "#3A3F43" },
  { name: "Quaker Gray", hex: "#9AA0A0" }, { name: "Black", hex: "#1C1C1C" },
];

// Roof-color quick-add sets are supplier-specific, NOT the generic paint palette above.
// Shingle = the 12 STANDARD Owens Corning TruDefinition Duration colors (NOT the Duration
// Designer line) — the exact set Carolyn specified in the 2026-07-08 meeting ("these 12").
// Metal = Central States Panel-Loc Plus (Built Rite Buildings' supplier). Hexes are close
// on-screen approximations of the swatches — owners can set the exact code per row after adding.
const SHINGLE_LIBRARY = [
  { name: "Shasta White", hex: "#D9D9D2" }, { name: "Desert Rose", hex: "#A6836C" },
  { name: "Driftwood", hex: "#8A8073" }, { name: "Teak", hex: "#6B4A30" },
  { name: "Brownwood", hex: "#584434" }, { name: "Chateau Green", hex: "#47564A" },
  { name: "Estate Gray", hex: "#6C7072" }, { name: "Sierra Gray", hex: "#6E6862" },
  { name: "Quarry Gray", hex: "#7A7B7D" }, { name: "Slatestone Gray", hex: "#5C6468" },
  { name: "Williamsburg Gray", hex: "#5E5D5A" }, { name: "Onyx Black", hex: "#262626" },
];
const METAL_LIBRARY = [
  { name: "Brilliant White", hex: "#F5F3EE" }, { name: "Alamo White", hex: "#EBE9DF" },
  { name: "Ivory", hex: "#EEDFB4" }, { name: "Light Stone", hex: "#CDC3AE" },
  { name: "Tan", hex: "#B99167" }, { name: "Taupe", hex: "#9E9880" },
  { name: "Desert Sand", hex: "#9F966E" }, { name: "Hickory Moss", hex: "#A89F90" },
  { name: "Gray", hex: "#D8D4C6" }, { name: "Pewter Gray", hex: "#B2AFA4" },
  { name: "Lunar Gray", hex: "#909696" }, { name: "Charcoal", hex: "#6E6960" },
  { name: "Brown", hex: "#493421" }, { name: "Burnished Slate", hex: "#3C3D2D" },
  { name: "Copper Metallic", hex: "#8B5321" }, { name: "Galvalume", hex: "#BFC1BF" },
  { name: "Black", hex: "#171717" }, { name: "Matte Black", hex: "#1C1C1C" },
  { name: "Rustic Red", hex: "#842424" }, { name: "Crimson", hex: "#A82A21" },
  { name: "Burgundy", hex: "#3A1C22" }, { name: "Colony Green", hex: "#6A7A54" },
  { name: "Hunter Green", hex: "#365637" }, { name: "Forest Green", hex: "#193E20" },
  { name: "Gallery Blue", hex: "#0E3A52" }, { name: "Ocean Blue", hex: "#3D6678" },
];

// ─── Ramps (Options tab → its own section, below Doors) ───
// Two modes on client_settings (save_ramp_settings): SIMPLE = one auto-width ramp with one
// price; CUSTOM = a fixture catalog (category='ramp', height_in holds the ramp LENGTH) that
// edits per line via the shared FixtureCatalog. The Save button here applies only the
// mode/offer/simple-price settings — catalog lines save themselves.
function RampsView({ viewingLabel = null, clientId = null }) {
  const scoped = (body) => (viewingLabel && clientId ? { ...body, targetClientId: clientId } : body);
  const [mode, setMode] = useState("simple");
  const [enabled, setEnabled] = useState(true);   // does this client OFFER a ramp at all
  const [simple, setSimple] = useState({ price: "", method: "each", image_url: null, show_image_on_estimate: true });
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [simpleImgBusy, setSimpleImgBusy] = useState(false);
  const [imgFileKey, setImgFileKey] = useState(0);

  const load = async () => {
    const { data, error } = await sb.functions.invoke("portal-settings", { body: scoped({ action: "catalog" }) });
    if (error || (data && data.error)) { setMsg({ err: (error && error.message) || data.error }); return; }
    const rs = data.rampSettings || {};
    setMode(rs.mode === "custom" ? "custom" : "simple");
    setEnabled(rs.enabled !== false);
    setSimple({ price: rs.price != null ? String(rs.price) : "", method: rs.method || "each", image_url: rs.imageUrl || null, show_image_on_estimate: rs.showImage !== false });
    setLoaded(true);
  };
  useEffect(() => { load(); }, []);

  const ALLOWED_IMG = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  const guardImg = (file) => { if (!ALLOWED_IMG.includes(file.type)) { setMsg({ err: "Use a JPG, PNG, WEBP or GIF image." }); return false; } if (file.size > 20_000_000) { setMsg({ err: "That photo is over 20MB — take it at a lower resolution." }); return false; } return true; };
  const uploadImg = async (file) => {
    file = await ssFitImageForUpload(file);
    const base64 = await new Promise((res, rej) => { const r = new FileReader(); r.onerror = () => rej(new Error("Could not read that image.")); r.onload = () => res(r.result); r.readAsDataURL(file); });
    const { data, error } = await sb.functions.invoke("portal-settings", { body: scoped({ action: "upload_fixture_image", imageBase64: base64, imageContentType: file.type || "image/jpeg" }) });
    if (error || (data && data.error)) throw new Error((error && error.message) || data.error);
    return data.url;
  };
  const onSimpleImg = async (file) => {
    if (!file) return; if (!guardImg(file)) { setImgFileKey((k) => k + 1); return; }
    setSimpleImgBusy(true); setMsg(null);
    try { const url = await uploadImg(file); setSimple((s) => ({ ...s, image_url: url })); setMsg({ ok: "Photo added — click Save ramp settings to apply." }); } catch (e) { setMsg({ err: e.message }); }
    setSimpleImgBusy(false); setImgFileKey((k) => k + 1);
  };

  const saveSettings = async () => {
    setBusy(true); setMsg(null);
    try {
      const r1 = await sb.functions.invoke("portal-settings", { body: scoped({ action: "save_ramp_settings", mode, enabled, price: simple.price, method: simple.method, imageUrl: simple.image_url || null, showImage: simple.show_image_on_estimate !== false }) });
      if (r1.error || (r1.data && r1.data.error)) throw new Error((r1.error && r1.error.message) || r1.data.error);
      setMsg({ ok: "Ramp settings saved." });
    } catch (e) { setMsg({ err: e.message }); }
    setBusy(false);
  };

  const errStyle = { background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 8, padding: "9px 13px", color: "#DC2626", fontSize: 13, fontWeight: 600, marginBottom: 12 };
  const okStyle = { background: "#F0FDF4", border: "1px solid #BBF7D0", borderRadius: 8, padding: "9px 13px", color: "#15803D", fontSize: 13, fontWeight: 600, marginBottom: 12 };
  const thumb = { width: 48, height: 36, borderRadius: 4, background: "#F1F5F9", objectFit: "cover", flexShrink: 0, border: "1px solid #E2E8F0" };
  const cbx = (checked, onChange) => <input type="checkbox" checked={!!checked} onChange={onChange} style={{ width: 16, height: 16, cursor: "pointer", accentColor: DOOR_MINT }} />;
  const imgCell = (url, busyOn, onPick, onRemove) => url
    ? <div style={{ display: "flex", alignItems: "center", gap: 6 }}><img src={url} alt="" style={thumb} /><button onClick={onRemove} disabled={busy || busyOn} style={S.btn("#F1F5F9", "#334155")}>Remove</button></div>
    : <label style={{ ...S.btn("#F1F5F9", "#334155"), cursor: busyOn ? "default" : "pointer", display: "inline-block", whiteSpace: "nowrap" }}>{busyOn ? "Uploading…" : "Add image"}<input key={imgFileKey} type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={busyOn} style={{ display: "none" }} onChange={onPick} /></label>;
  const modeCard = (m, title, text) => (
    <div onClick={() => setMode(m)} style={{ border: `2px solid ${mode === m ? ACCENT : "#E2E8F0"}`, background: mode === m ? "#F5F5FF" : "#FFF", borderRadius: 12, padding: "12px 14px", cursor: "pointer", display: "flex", gap: 10, alignItems: "flex-start" }}>
      <div style={{ width: 16, height: 16, borderRadius: "50%", border: `2px solid ${mode === m ? ACCENT : "#CBD5E1"}`, flex: "0 0 auto", marginTop: 2, position: "relative" }}>{mode === m && <div style={{ position: "absolute", inset: 3, borderRadius: "50%", background: ACCENT }} />}</div>
      <div><div style={{ fontWeight: 700, fontSize: 13.5, color: "#1E293B" }}>{title}</div><div style={{ fontSize: 12, color: "#64748B", marginTop: 2, lineHeight: 1.45 }}>{text}</div></div>
    </div>
  );

  return (
    <>
      {msg && msg.err && <div style={errStyle}>{msg.err}</div>}
      {msg && msg.ok && <div style={okStyle}>{msg.ok}</div>}
      <div style={S.card}>
        <div style={S.h2}>Ramps</div>
        <p style={{ fontSize: 13, color: "#64748B", marginBottom: 14, lineHeight: 1.5 }}>
          Pick how ramps work. <b>Simple</b> is one ramp that's automatically the width of the door it attaches to — you just set
          the price. <b>Custom ramp styles</b> is a catalog with its own sizes and prices, like doors — each style is one line that
          saves on its own. Enter sizes in feet/inches (8', 6'3", 36"). The <b>Save ramp settings</b> button applies the offer/mode
          and simple-ramp price.
        </p>
        {!loaded ? <div style={{ fontSize: 13, color: "#94A3B8" }}>Loading…</div> : (<>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 8, marginBottom: 14, fontSize: 14, fontWeight: 700, color: "#334155", cursor: "pointer" }}>
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} style={{ width: 18, height: 18, cursor: "pointer", accentColor: DOOR_MINT }} />
            Offer a ramp on your buildings
          </label>
          {!enabled && <div style={{ fontSize: 12.5, color: "#B45309", background: "#FEF3C7", border: "1px solid #FDE68A", borderRadius: 8, padding: "8px 12px", marginBottom: 14 }}>Ramps are turned off — customers can't add one to a new build. Any ramp already on a saved design still shows and prices as before. (Click <b>Save ramp settings</b> to apply.)</div>}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 20, opacity: enabled ? 1 : 0.5, pointerEvents: enabled ? "auto" : "none" }}>
            {modeCard("simple", "Simple ramp", "One ramp, automatically the width of the door it attaches to. No sizes to manage.")}
            {modeCard("custom", "Custom ramp styles", "A catalog of ramp styles with their own sizes, prices, and photos.")}
          </div>

          {mode === "simple" ? (
            <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "flex-end" }}>
              <div><div style={{ fontSize: 12, color: "#64748B", fontWeight: 600, marginBottom: 5 }}>How it's priced</div>
                <select value={simple.method} onChange={(e) => setSimple((s) => ({ ...s, method: e.target.value }))} style={{ ...S.input, width: 210 }}>
                  <option value="each">each (per ramp)</option><option value="per_ft">per foot of door width</option>
                </select></div>
              <div><div style={{ fontSize: 12, color: "#64748B", fontWeight: 600, marginBottom: 5 }}>Price</div>
                <div style={{ position: "relative", width: 130 }}><span style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", color: "#94A3B8" }}>$</span><input type="number" min="0" step="any" value={simple.price} onChange={(e) => setSimple((s) => ({ ...s, price: e.target.value }))} style={{ ...S.input, width: 130, paddingLeft: 22 }} /></div></div>
              <div><div style={{ fontSize: 12, color: "#64748B", fontWeight: 600, marginBottom: 5 }}>Photo (optional)</div>{imgCell(simple.image_url, simpleImgBusy, (e) => onSimpleImg(e.target.files && e.target.files[0]), () => setSimple((s) => ({ ...s, image_url: null })))}</div>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "#334155", cursor: "pointer" }}>{cbx(simple.show_image_on_estimate, (e) => setSimple((s) => ({ ...s, show_image_on_estimate: e.target.checked })))} On estimate</label>
            </div>
          ) : (
            <FixtureCatalog category="ramp" noun="ramp style" addLabel="Add ramp style" namePh="e.g. Aluminum ramp" labelPh="RMP" wPh={'48"'} hPh={"3'"} sizeWord="length" viewingLabel={viewingLabel} clientId={clientId} />
          )}

          <div style={{ display: "flex", marginTop: 20 }}>
            <div style={{ flex: 1 }} />
            <button onClick={saveSettings} disabled={busy} style={S.btn(busy ? "#9CA3AF" : ACCENT, "#FFF")}>{busy ? "Saving…" : "Save ramp settings"}</button>
          </div>
        </>)}
      </div>
    </>
  );
}

// ─── Windows (Options tab → its own section, below Ramps) ───
// A straight catalog like doors, minus swing/operation (windows don't swing). category='window'
// in fixture_items; height_in holds the window HEIGHT. Per-line saves via the shared FixtureCatalog.
function WindowsView({ viewingLabel = null, clientId = null }) {
  return (
    <div style={S.card}>
      <div style={S.h2}>Windows</div>
      <p style={{ fontSize: 13, color: "#64748B", marginBottom: 14, lineHeight: 1.5 }}>
        The windows your customers can add to a building. Each window is <b>one line</b> — click <b>Edit</b> to change it;
        every line saves on its own. Drag <b>⠿</b> to set the order customers see. Sizes are feet/inches — 8', 6'3", 36"
        (no spaces). <b>Export Excel</b> to edit in bulk and re-import — rows are matched by the ID column, and rows missing
        from the file are never deleted.
      </p>
      <FixtureCatalog category="window" noun="window" addLabel="Add window" namePh="e.g. Slider window" labelPh="SL" wPh={'36"'} hPh={'36"'} sizeWord="height" viewingLabel={viewingLabel} clientId={clientId} />
    </div>
  );
}

function ColorsView({ viewingLabel = null }) {
  const [cat, setCat] = useState(null);
  // One flat list across all categories; a row's category is set by its flags:
  // paint = siding/trim (and not shingle/metal), shingle = shingle, metal = metal.
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [libOpen, setLibOpen] = useState(null);   // which section's library is open

  const load = async () => {
    const { data, error } = await sb.functions.invoke("portal-settings", { body: { action: "catalog" } });
    if (error || (data && data.error)) { setMsg({ err: (error && error.message) || data.error }); return; }
    setCat(data);
    setRows((data.colors || []).map((c) => ({
      id: c.id, label: c.label, siding: c.siding !== false, trim: c.trim !== false,
      shingle: !!c.shingle, metal: !!c.metal,
      allow_custom: !!c.allow_custom, is_default: !!c.is_default, active: c.active !== false,
      hex: c.hex || null, pricing_method: c.pricing_method || "each", rate: (c.rate != null ? String(c.rate) : "0"),
    })));
  };
  useEffect(() => { load(); }, []);

  const setRow = (gi, field, val) => setRows((rs) => rs.map((r, i) => i === gi ? { ...r, [field]: val } : r));
  // New rows are tagged for the section they're added from.
  const addRow = (preset, category) => setRows((rs) => [...rs, {
    id: null, label: preset ? preset.name : "",
    siding: category === "paint", trim: category === "paint",
    shingle: category === "shingle", metal: category === "metal",
    allow_custom: false, is_default: false, active: true, hex: preset ? preset.hex : null,
    pricing_method: "each", rate: "0",
  }]);
  const removeRow = (gi) => setRows((rs) => rs.filter((_, i) => i !== gi));
  // Swap two rows by their GLOBAL indices (callers pass same-section neighbors to reorder within a section).
  const swap = (gi, gj) => setRows((rs) => { if (gj < 0 || gj >= rs.length) return rs; const next = rs.slice(); [next[gi], next[gj]] = [next[gj], next[gi]]; return next; });

  // One save persists every section at once — the whole list is always sent, so the
  // server's "delete anything not in the payload" stays safe across categories.
  const save = async () => {
    // Full-list replace: the server removes any colour not in this payload. Harmless
    // on your own palette, not harmless on someone else's.
    if (viewingLabel && !window.confirm(`Replace ${viewingLabel}'s ENTIRE colour list with these ${rows.length} colour(s)?

Anything not shown here will be removed from their account.`)) return;
    setBusy(true); setMsg(null);
    try {
      const colors = rows.map((r, i) => ({
        id: r.id || undefined, label: r.label,
        siding: !!r.siding, trim: !!r.trim, shingle: !!r.shingle, metal: !!r.metal,
        allowCustom: !!r.allow_custom, isDefault: !!r.is_default, active: r.active !== false,
        sortOrder: i, hex: r.hex || null, pricingMethod: r.pricing_method || "each", rate: Number(r.rate) || 0,
      }));
      const { data, error } = await sb.functions.invoke("portal-settings", { body: { action: "save_colors", colors } });
      if (error || (data && data.error)) throw new Error((error && error.message) || data.error);
      await load();
      const skipped = data.skipped || [];
      setMsg({ ok: `Saved ${data.saved || 0} colour(s)` + (data.deleted ? `, removed ${data.deleted}` : "") + (skipped.length ? `, ${skipped.length} skipped` : "") + ".", skipped });
    } catch (e) { setMsg({ err: e.message }); }
    setBusy(false);
  };

  const errStyle = { background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 8, padding: "9px 13px", color: "#DC2626", fontSize: 13, fontWeight: 600, marginBottom: 12 };
  const okStyle = { background: "#F0FDF4", border: "1px solid #BBF7D0", borderRadius: 8, padding: "9px 13px", color: "#15803D", fontSize: 13, fontWeight: 600, marginBottom: 12 };
  const ctr = { ...S.td, padding: "8px 5px", textAlign: "center" };
  const tdc = { ...S.td, padding: "8px 5px" };
  const thc = { ...S.th, padding: "8px 5px", whiteSpace: "normal" };
  const chk = (gi, field) => <input type="checkbox" checked={!!rows[gi][field]} onChange={(e) => setRow(gi, field, e.target.checked)} style={{ width: 16, height: 16, cursor: "pointer" }} />;

  // Which palette a row belongs to. Mirrors renderSection's filter exactly — paint is the
  // absence of the other two flags, not a flag of its own.
  const catOf = (r) => (r.shingle ? "shingle" : r.metal ? "metal" : "paint");

  // "Custom" marks the ONE entry in a palette that lets the shopper type their own colour:
  // the designer looks it up with `colors.find((c) => c.allowCustom)` and, when it is picked,
  // swaps the dropdown for a free-text box. Because the designer takes the FIRST match, two
  // custom rows in one palette would silently make the second one dead — so ticking one
  // unticks the others in the same palette rather than leaving a state only the code can
  // resolve. This column exists because `allow_custom` round-tripped through load and save
  // with no control anywhere: a shipped designer feature no builder could switch on.
  const setAllowCustom = (gi, checked) => setRows((rs) => {
    const cat = catOf(rs[gi]);
    return rs.map((r, i) => i === gi ? { ...r, allow_custom: checked }
      : (checked && catOf(r) === cat && r.allow_custom) ? { ...r, allow_custom: false } : r);
  });

  // Render one category card. `ckey` selects which rows show; `showST` adds the paint-only
  // Siding/Trim columns. Defined as a plain function (not a <Component/>) so inputs keep focus.
  const renderSection = (ckey, title, desc, showST) => {
    const entries = rows.map((r, gi) => ({ r, gi })).filter(({ r }) =>
      ckey === "paint" ? (!r.shingle && !r.metal) : ckey === "shingle" ? r.shingle : r.metal);
    // Each section quick-adds from its own supplier palette, not the shared paint set.
    const lib = ckey === "metal" ? METAL_LIBRARY : ckey === "shingle" ? SHINGLE_LIBRARY : COLOR_LIBRARY;
    return (
      <div style={S.card}>
        <div style={S.h2}>{title}</div>
        <p style={{ fontSize: 13, color: "#64748B", marginBottom: 14, lineHeight: 1.5 }}>{desc}</p>
        {entries.length === 0 ? (
          <div style={{ fontSize: 13, color: "#64748B", marginBottom: 12 }}>No colors yet — add one below or pick from the library.</div>
        ) : (
          <table style={{ width: "100%", tableLayout: "fixed", borderCollapse: "collapse", marginBottom: 14 }}>
            <colgroup>
              {/* Widths sum to 100 in each branch. The Custom column added 2026-08-07 came out
                  of the name column, which holds a flexible text input and had the slack —
                  measured in the real ~693px panel, the checkbox headers need ~55px ("DEFAULT"
                  is the longest at 54px) and clip below that, so those three stay at 8%. */}
              {showST ? (
                <>
                  <col style={{ width: "8%" }} /><col style={{ width: "7%" }} /><col style={{ width: "15%" }} />
                  <col style={{ width: "7%" }} /><col style={{ width: "7%" }} /><col style={{ width: "15%" }} /><col style={{ width: "10%" }} />
                  <col style={{ width: "8%" }} /><col style={{ width: "8%" }} /><col style={{ width: "8%" }} /><col style={{ width: "7%" }} />
                </>
              ) : (
                <>
                  <col style={{ width: "9%" }} /><col style={{ width: "8%" }} /><col style={{ width: "21%" }} />
                  <col style={{ width: "17%" }} /><col style={{ width: "12%" }} />
                  <col style={{ width: "9%" }} /><col style={{ width: "9%" }} /><col style={{ width: "9%" }} /><col style={{ width: "6%" }} />
                </>
              )}
            </colgroup>
            <thead><tr>
              <th style={thc}>Order</th><th style={thc}>Swatch</th><th style={thc}>Color name</th>
              {showST && <th style={thc}>Siding</th>}
              {showST && <th style={thc}>Trim</th>}
              <th style={thc}>How it’s priced</th><th style={thc}>Rate (USD)</th>
              <th style={thc} title="Lets the customer type their own color instead of picking one">Custom</th>
              <th style={thc}>Default</th><th style={thc}>Active</th><th style={thc}></th>
            </tr></thead>
            <tbody>
              {entries.map(({ r, gi }, pos) => (
                <tr key={r.id || `new-${gi}`}>
                  <td style={ctr}>
                    <button onClick={() => { if (pos > 0) swap(gi, entries[pos - 1].gi); }} disabled={pos === 0} style={{ ...S.btn("#F1F5F9", "#334155"), padding: "2px 7px" }}>▲</button>{" "}
                    <button onClick={() => { if (pos < entries.length - 1) swap(gi, entries[pos + 1].gi); }} disabled={pos === entries.length - 1} style={{ ...S.btn("#F1F5F9", "#334155"), padding: "2px 7px" }}>▼</button>
                  </td>
                  <td style={ctr}>
                    <input type="color" value={r.hex || "#CCCCCC"} onChange={(e) => setRow(gi, "hex", e.target.value)} title={r.hex || "Pick this color"}
                      style={{ width: 34, height: 26, padding: 0, border: "1px solid #CBD5E1", borderRadius: 4, background: "#FFF", cursor: "pointer" }} />
                  </td>
                  <td style={tdc}>
                    <input type="text" value={r.label} placeholder="e.g. Barn Red" onChange={(e) => setRow(gi, "label", e.target.value)} style={{ ...S.input, width: "100%", minWidth: 0, boxSizing: "border-box" }} />
                  </td>
                  {showST && <td style={ctr}>{chk(gi, "siding")}</td>}
                  {showST && <td style={ctr}>{chk(gi, "trim")}</td>}
                  <td style={tdc}>
                    <select value={r.pricing_method || "each"} onChange={(e) => setRow(gi, "pricing_method", e.target.value)} style={{ ...S.input, width: "100%", minWidth: 0, boxSizing: "border-box" }}>
                      {LP_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                    </select>
                  </td>
                  <td style={ctr}>
                    <input type="number" min="0" step="0.01" value={r.rate ?? "0"} onChange={(e) => setRow(gi, "rate", e.target.value)} style={{ ...S.input, width: "100%", minWidth: 0, boxSizing: "border-box" }} />
                  </td>
                  <td style={ctr}>
                    <input type="checkbox" checked={!!r.allow_custom} onChange={(e) => setAllowCustom(gi, e.target.checked)}
                      title="Picking this entry in the designer shows a free-text box instead of a swatch"
                      style={{ width: 16, height: 16, cursor: "pointer" }} />
                  </td>
                  <td style={ctr}>{chk(gi, "is_default")}</td>
                  <td style={ctr}>{chk(gi, "active")}</td>
                  <td style={ctr}>
                    <button onClick={() => removeRow(gi)} style={S.btn("#FEF2F2", "#DC2626")}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 4 }}>
          <button onClick={() => addRow(undefined, ckey)} style={S.btn("#1E293B", "#FFF")}>+ Add color</button>
          <button onClick={() => setLibOpen((o) => o === ckey ? null : ckey)} style={S.btn("#F1F5F9", "#334155")}>{libOpen === ckey ? "▴ Hide color library" : "▾ Quick-add from library"}</button>
          <div style={{ flex: 1 }} />
          <button onClick={save} disabled={busy} style={S.btn(busy ? "#9CA3AF" : ACCENT, "#FFF")}>{busy ? "Saving…" : "Save colors"}</button>
        </div>
        {libOpen === ckey && (
          <div style={{ marginTop: 12, padding: 12, background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 8 }}>
            <div style={{ fontSize: 12, color: "#64748B", marginBottom: 10 }}>Click a color to add it to this list (swatches are approximate — rename or set exact codes after adding). Then click <b>Save colors</b>.</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {lib.map((c) => (
                <button key={c.name} onClick={() => { addRow(c, ckey); setMsg({ ok: `Added “${c.name}” — click Save colors to apply.` }); }}
                  style={{ display: "flex", alignItems: "center", gap: 7, background: "#FFF", border: "1px solid #CBD5E1", borderRadius: 20, padding: "5px 12px 5px 6px", fontSize: 12, fontWeight: 600, color: "#334155", cursor: "pointer" }}>
                  <span style={{ width: 18, height: 18, borderRadius: "50%", background: c.hex, border: "1px solid rgba(0,0,0,0.15)", flexShrink: 0 }} />
                  {c.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  };

  const paintDesc = (<>
    These are the colors your customers pick from for <b>paint</b> in the designer.
    Toggle <b>Siding</b> / <b>Trim</b> to control which dropdown a color appears in (a color can be in both).
    Set <b>How it’s priced</b> + a <b>Rate</b> to charge for a color — it’s added to the estimate automatically when picked
    (leave the rate at <b>0</b> for colors included in the base price). <b>Default</b> pre-selects a color; <b>Active</b> shows/hides it. Drag order with ▲▼.
    <br />Tick <b>Custom</b> on one entry (name it something like “Other — my own color”) to let customers type a color you don’t stock; picking it in the designer swaps the swatch list for a text box. Only one entry per palette can be the custom one.
    <br />Need color ideas? See <b>hayleypaint.com</b> or use the quick-add library below.
  </>);
  const shingleDesc = (<>
    Shingle roof colors your customers pick from when they choose a <b>Shingle</b> roof in the designer.
    Set <b>How it’s priced</b> + a <b>Rate</b> to charge (leave <b>0</b> if included). <b>Default</b> pre-selects one; <b>Active</b> shows/hides it. Drag order with ▲▼.
  </>);
  const metalDesc = (<>
    Metal roof colors your customers pick from when they choose a <b>Metal</b> roof in the designer.
    Set <b>How it’s priced</b> + a <b>Rate</b> to charge (leave <b>0</b> if included). <b>Default</b> pre-selects one; <b>Active</b> shows/hides it. Drag order with ▲▼.
  </>);

  return (
    <>
      {msg && msg.err && <div style={errStyle}>{msg.err}</div>}
      {msg && msg.ok && <div style={okStyle}>{msg.ok}</div>}
      {!cat ? <div style={S.card}><div style={{ fontSize: 13, color: "#94A3B8" }}>Loading…</div></div> : (
        <>
          {renderSection("paint", "Paint colors", paintDesc, true)}
          {renderSection("shingle", "Shingle colors", shingleDesc, false)}
          {renderSection("metal", "Metal colors", metalDesc, false)}
          {msg && msg.skipped && msg.skipped.length > 0 && (
            <div style={{ ...S.card, marginTop: 0, fontSize: 13 }}>
              <div style={{ color: "#B91C1C", fontWeight: 700 }}>{msg.skipped.length} color(s) skipped:</div>
              <ul style={{ margin: "4px 0 0 18px", color: "#B91C1C", maxHeight: 160, overflow: "auto" }}>
                {msg.skipped.slice(0, 30).map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </div>
          )}
        </>
      )}
    </>
  );
}

