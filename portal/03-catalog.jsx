// ─── Settings (via portal-settings edge function; API key is write-only) ───

// Is a failed `tax_settings` read a "no tax section here" rather than a fault to show?
// These answers qualify, and each renders NOTHING (the sales-tax UI on CRM Connection and
// on Company → Locations reads this):
//   • A portal-settings OLDER than this page. The frontend deploys itself on push and edge
//     functions deploy separately, so for a while the page can be ahead of the function.
//     An old function has no GATES line for the action, and resolveTenant fails closed with
//     403 `Unrecognised action`; one with the gate but not the branch falls to the
//     dispatcher's 400 `Unknown action`. Either way that window must look like "no tax UI
//     yet", not a broken screen — on every tenant, CRM-mode ones included.
//   • Any other 403 — the caller cannot read settings_crm. The browser's access map keeps
//     most of them from asking; this covers the ones it cannot see (view-as, a stale map).
// Keyed on the status the invoke wrapper records (`ssStatus`), plus the dispatcher's own
// sentence for the 400, since that branch carries no `reason` code.
function ssTaxReadUnavailable(err) {
  if (!err) return false;
  if (err.ssStatus === 403) return true;
  return err.ssStatus === 400 && /^Unknown action\b/i.test(String(err.message || ""));
}

// The Settings → Company "Quotes are good for" box: a whole number of days, 1 to 365 — the same
// rule as portal-settings' save and client_settings' CHECK (migration 269).
function ssQuoteDaysOk(v) {
  const s = String(v ?? "").trim();
  if (!/^\d+$/.test(s)) return false;
  const n = Number(s);
  return n >= 1 && n <= 365;
}

function SettingsView({ section, view3d = false }) {
  // Which settings cards to render: "connection" (GHL creds + pipeline mapping)
  // or "branding" (customer-link look & feel + business details + pricing
  // display + testing). No section = all (legacy). Form state always covers
  // every field (prefilled from status), so the global save stays safe no
  // matter which section is on screen.
  // `view3d` is the shell's view3dUnlocked: the four-corner switch (migration 276) shows only where
  // the tenant has 3D, because without it the quote carries no 3D page at all.
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
    // How many days a quote stays good for (migration 269). A STRING like every other field; "30"
    // is the column's default and what every quote printed before the setting existed.
    quoteValidDays: "30",
    // Page 2 of the quote from all four corners (migration 276). Off is the column's default.
    quoteCornerViews: false,
    // Who issues the paperwork (migration 121). Defaults to the CRM — the same default the
    // column has — so a status response that predates the column can't read as "SS issues it".
    // Invoices number separately from quotes (migration 125, Carolyn's decision).
    invoiceInGhl: true, ssQuoteNext: "", ssQuotePrefix: "", ssInvoiceNext: "", ssInvoicePrefix: "",
    ssTaxRate: "", ssTaxLabel: "", ssTaxDelivery: false,
    // Changing a signed order (migrations 209-216). coUnlockRequired defaults FALSE and
    // that is load-bearing: with it off the whole approval-and-fee regime is dormant and
    // every tenant behaves exactly as they did before the feature existed.
    coUnlockRequired: false, coFreeDays: "0", coFee: "0", coFeeTaxable: true,
    coFeeLabel: "Change order fee", coUnlockHours: "72",
    // designer branding (client_configs — drives the public ?client= link)
    brandName: "", brandTagline: "", brandAccent: "#D97706", brandHeaderBg: "#1E293B",
    // Building styles per row on the designer (migration 232). A STRING like every other form
    // field here; "8" is the designer's own default, so a tenant who never chose reads as 8.
    brandStylesPerRow: "8",
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
  // Styles per row AS STORED: "5".."8", or null = never chosen (the card shows that as 8).
  // Review 2026-09-15: Save Branding used to send stylesPerRow on EVERY save, so a tenant who
  // only swapped their logo got styles_per_row = 8 written — erasing "never chosen", changing
  // their get_config payload (232 emits the key only when the column is set) and pinning them
  // at 8 if the default ever moves. Same idea as the logo: the key is sent only when the owner
  // actually picked a different number, and save_branding leaves the column alone otherwise.
  const [brandSprStored, setBrandSprStored] = useState(null);
  const saveBranding = async () => {
    setBrandBusy(true); setBrandMsg(null);
    const body = { action: "save_branding", companyName: form.brandName, tagline: form.brandTagline,
      accentColor: form.brandAccent, headerBg: form.brandHeaderBg };
    if (form.brandStylesPerRow !== (brandSprStored || "8")) body.stylesPerRow = Number(form.brandStylesPerRow);
    if (logoDataUrl) { body.logoBase64 = logoDataUrl; body.logoContentType = logoCt; }
    else if (clearLogo) { body.logoUrl = ""; }
    const { data, error: err } = await sb.functions.invoke("portal-settings", { body });
    setBrandBusy(false);
    if (err || (data && data.error)) { setBrandMsg({ err: (data && data.error) || err.message }); return; }
    if ("stylesPerRow" in body) setBrandSprStored(String(body.stylesPerRow));
    setBrandMsg({ ok: clearLogo && !logoDataUrl ? "Branding saved — your logo was removed, so the designer shows your company initials." : "Branding saved — your designer link now reflects it." });
    if (data.logoUrl) setCurrentLogo(data.logoUrl);
    if (clearLogo && !logoDataUrl) setCurrentLogo(null);
    setLogoDataUrl(""); setLogoCt(""); setClearLogo(false);
  };
  // Branding lives inside the page-wide <form> but saves through its OWN action. Enter in
  // one of its text fields would otherwise fire the form's implicit submit: the page-wide
  // save runs, "Settings saved." appears, and the branding edit just typed is never sent —
  // a success message for work that didn't happen. Route Enter to this card's own save.
  const brandKeyDown = (e) => {
    if (e.key !== "Enter" || brandBusy) return;
    e.preventDefault();
    saveBranding();
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
      setBrandSprStored(b.stylesPerRow ? String(b.stylesPerRow) : null);
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
        quoteValidDays: typeof data.quoteValidDays === "number" ? String(data.quoteValidDays) : "30",
        quoteCornerViews: data.quoteCornerViews === true,
        betaMode: Boolean(data.betaMode), betaEmail: data.betaEmail || "", showPricing: Boolean(data.showPricing),
        invoiceInGhl: data.invoiceInGhl !== false,
        ssQuoteNext: data.ssQuoteNext == null ? "" : String(data.ssQuoteNext),
        ssQuotePrefix: data.ssQuotePrefix || "",
        ssInvoiceNext: data.ssInvoiceNext == null ? "" : String(data.ssInvoiceNext),
        ssInvoicePrefix: data.ssInvoicePrefix || "",
        // Sales tax (migration 158). The status call surfaces the stored fraction as a
        // PERCENT; blank means "never answered", which the server refuses to let SS-issued
        // mode start with — 0 is a legitimate explicit answer, silence is not.
        ssTaxRate: data.ssTaxRate == null ? "" : String(data.ssTaxRate),
        ssTaxLabel: data.ssTaxLabel || "",
        ssTaxDelivery: Boolean(data.ssTaxDelivery),
        coUnlockRequired: Boolean(data.coUnlockRequired),
        coFreeDays: data.coFreeDays == null ? "0" : String(data.coFreeDays),
        coFee: data.coFee == null ? "0" : String(data.coFee),
        coFeeTaxable: data.coFeeTaxable !== false,
        coFeeLabel: data.coFeeLabel || "Change order fee",
        coUnlockHours: data.coUnlockHours == null ? "72" : String(data.coUnlockHours),
        // Customer login code (migration 231). `status` sends 'sms' | 'email'; a function from
        // before 231 sends nothing, which means text — the same thing the server defaults to.
        customerLoginDefault: data.customerLoginDefault === "email" ? "email" : "sms",
        brandName: b.companyName || "", brandTagline: b.tagline || "",
        brandAccent: b.accentColor || "#D97706", brandHeaderBg: b.headerBg || "#1E293B",
        brandStylesPerRow: b.stylesPerRow ? String(b.stylesPerRow) : "8",
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
    // Same bounds as the server and the column (1..365), stopped here so the owner sees it beside
    // the box they just typed in. The server check is the one that counts. A cleared box is not a
    // mistake: it means the 30 its placeholder shows, as the server's parseQuoteValidDays reads it.
    const quoteDaysBlank = String(form.quoteValidDays ?? "").trim() === "";
    if (quoteDaysReady && !quoteDaysBlank && !ssQuoteDaysOk(form.quoteValidDays)) {
      setError("Quotes have to stay good for a whole number of days, from 1 to 365.");
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
      // Only when `status` could read the column: a portal-settings or database without migration
      // 269 never sees the key, so this page can ship ahead of either without breaking the save.
      ...(quoteDaysReady ? { quoteValidDays: quoteDaysBlank ? 30 : Number(form.quoteValidDays) } : {}),
      // Only when `status` could read the column (migration 276), and only when the owner changed
      // it: a save from Branding or CRM Connection, or one from a tab opened before someone else
      // flipped the switch, then never writes back a value nobody on this screen chose.
      ...(cornerReady && form.quoteCornerViews !== status.quoteCornerViews ? { quoteCornerViews: form.quoteCornerViews === true } : {}),
    };
    const { data, error: err } = await sb.functions.invoke("portal-settings", { body });
    setBusy(false);
    if (err || (data && data.error)) { setError((data && data.error) || err.message); return; }
    setSaved(true);
    // The four-corner switch is sent only when it differs from `status`, so `status` has to learn
    // what was just stored even when the re-read below fails. Otherwise ticking it, saving through
    // a failed re-read and unticking it again compares false with a stale false, sends nothing,
    // says "Settings saved." and leaves the page on every quote.
    if ("quoteCornerViews" in body) setStatus((s) => (s ? { ...s, quoteCornerViews: body.quoteCornerViews } : s));
    // refresh masked status
    const { data: st } = await sb.functions.invoke("portal-settings", { body: { action: "status" } });
    if (st && !st.error) setStatus(st);
  };

  // ── MAY THIS TENANT INVOICE THROUGH THE CRM AT ALL? (migration 217) ──────────────────
  // Carolyn 2026-09-07: "The feature for payments to go through GHL should only show in
  // Junior Barns as he is an active user. All other builders will only have the option to
  // invoice through SS. They can still have the customer info pass to GHL if they choose."
  //
  // So this hides ONE checkbox. The CRM Connection card above is untouched — location id,
  // API key, pipeline and stages stay for everyone, and submit-estimate keeps mirroring
  // contacts and opportunities into a connected CRM while we issue the paperwork.
  //
  // Read from `status`, never from `form`: a grandfathered tenant's `invoiceInGhl` is still
  // true, and this must not follow it. The render below is unreachable until status has
  // loaded (the `!status && !error` branch), so there is no flash of the wrong card.
  const mayGhlInvoice = Boolean(status && status.ghlInvoicingAllowed === true);
  // Can this tenant set how long quotes stay good for? `status` answers a number once migration
  // 269 is applied and portal-settings knows the field; before that (or on a read that failed) it
  // answers null or nothing, and the box stays hidden rather than offer a value it cannot save.
  const quoteDaysReady = Boolean(status && typeof status.quoteValidDays === "number");
  // The same for the four-corner switch (migration 276): status answers true or false once the
  // column exists and portal-settings knows it, and null or nothing before, which hides the switch.
  const cornerReady = Boolean(status && typeof status.quoteCornerViews === "boolean");
  // The SS-paperwork fields used to key on `!form.invoiceInGhl` alone. For a tenant that
  // cannot choose, SS mode is the only mode — including while their row still says otherwise,
  // which is exactly when they need the numbering fields in front of them.
  const ssMode = !mayGhlInvoice || !form.invoiceInGhl;
  // What a BLANK starting-number box will actually print (migration 283): the counter already in
  // use when there is one (the save keeps a set counter over a blank), otherwise 1000. `stored` is
  // the saved counter as status reports it, so the preview never promises 1000 to a builder whose
  // numbering has moved on.
  const blankStart = (stored) => (stored == null || stored === "" ? "1000" : String(stored));

  // SALES TAX SUMMARY — read-only, under the company rate (Avalara plan, 2026-09-17). Which rate
  // a quote charges is no longer just the box on this card: a sales location's own rate beats
  // it, and a rate verified for the delivery address beats both. Whether verified lookups are
  // on is an operator switch (`client_settings.tax_lookup_enabled`), so a builder can only see
  // it here, never flip it. No price is shown — the meters are off, and a price read follows
  // the catalog redaction precedent when it is needed.
  //
  // Asked only on the CRM Connection screen, and only when the SAVED row is SS mode —
  // `status.invoiceInGhl === false`, the same test submit-estimate makes
  // (`invoice_in_ghl !== false` is the CRM path). NOT `ssMode` above: that one is true for a
  // grandfathered tenant without the capability whose row still says CRM, so their
  // numbering fields show — but every quote they issue still goes through the CRM. A
  // CRM-mode tenant sees no sales-tax box and makes no tax call at all. Re-asked when
  // `status` is re-read after a save, so the box appears the moment a save flips the row to
  // SS mode and the location count stays current.
  // ⚠️ These hooks sit ABOVE the skeleton's early return below — a hook added under it
  // white-screens the page with React #310 the first time status lands.
  const [taxInfo, setTaxInfo] = useState(null);   // tax_settings answer | { err, unavailable } | null
  const savedSsMode = Boolean(status && status.invoiceInGhl === false);
  const wantTaxInfo = savedSsMode && show("connection");
  useEffect(() => {
    // Cleared when the row leaves SS mode, so switching back never flashes the old answer.
    if (!wantTaxInfo) { setTaxInfo(null); return; }
    let alive = true;
    sb.functions.invoke("portal-settings", { body: { action: "tax_settings" } }).then(({ data, error: err }) => {
      if (!alive) return;
      if (err || !data || data.error) {
        setTaxInfo({
          err: (data && data.error) || (err && err.message) || "Couldn't check your sales tax settings.",
          unavailable: ssTaxReadUnavailable(err),
        });
        return;
      }
      setTaxInfo(data);
    });
    return () => { alive = false; };
  }, [wantTaxInfo, status]);
  // Rendered only on an answer: the server saying SS mode, or a real failure for a tenant
  // whose saved row is SS mode. Nothing while it loads, nothing when the server says CRM
  // mode, and nothing when the function is older than this page (ssTaxReadUnavailable).
  const showTaxBox = ssMode && wantTaxInfo && !!taxInfo
    && (taxInfo.err ? !taxInfo.unavailable : taxInfo.ssMode === true);

  // Who issues quotes and invoices (migration 121). Its own save, not the page-wide one:
  // the three fields are presence-based on the server, so sending only these leaves every
  // other setting untouched — and this card lives in the CRM section while the page Save
  // button lives down in Branding.
  const [invBusy, setInvBusy] = useState(false);
  const [invMsg, setInvMsg] = useState(null);   // { ok } | { err }
  const saveInvoicing = async () => {
    setInvMsg(null); setInvBusy(true);
    const { data, error: err } = await sb.functions.invoke("portal-settings", { body: {
      action: "save",
      // `mayGhlInvoice` and not `form.invoiceInGhl` (migration 217): a tenant without the
      // capability has no checkbox, and its state variable still holds whatever their row
      // last said — which for a grandfathered tenant is `true`. Posting that would ask the
      // server for the very thing the card no longer offers. The server forces false anyway;
      // this keeps the request honest rather than relying on being overruled.
      invoiceInGhl: mayGhlInvoice ? form.invoiceInGhl : false,
      ssQuoteNext: form.ssQuoteNext,
      ssQuotePrefix: form.ssQuotePrefix,
      ssInvoiceNext: form.ssInvoiceNext,
      ssInvoicePrefix: form.ssInvoicePrefix,
      ssTaxRate: form.ssTaxRate,
      ssTaxLabel: form.ssTaxLabel,
      ssTaxDelivery: form.ssTaxDelivery,
    } });
    setInvBusy(false);
    if (err || (data && data.error)) { setInvMsg({ err: (data && data.error) || err.message }); return; }
    setInvMsg({ ok: (mayGhlInvoice && form.invoiceInGhl)
      ? "Saved — your quotes and invoices are created in your CRM, exactly as before."
      : "Saved — StructureStudio now issues your quotes and invoices. Contacts and opportunities still go to your CRM if one is connected." });
    const { data: st } = await sb.functions.invoke("portal-settings", { body: { action: "status" } });
    if (st && !st.error) setStatus(st);
  };

  // Changing a signed order (migrations 209-216). Its own save, like the invoicing card
  // above and for the same reason: the fields are presence-based on the server, so sending
  // only these leaves every other setting untouched.
  // "Customer login code: Text / Email" (migration 231; plan 3.6, Ahsan 2026-09-15). Saves the
  // moment it is picked, through `save` with ONE key: the server writes customer_login_default
  // only when the key is present, so nothing else on the page is touched — the same
  // presence-based pattern as the two cards around it. A refused save puts the old choice back.
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginMsg, setLoginMsg] = useState(null);   // { ok } | { err }
  const saveLoginDefault = async (next) => {
    const prev = form.customerLoginDefault === "email" ? "email" : "sms";
    if (next === prev || loginBusy) return;
    setLoginMsg(null); setLoginBusy(true);
    setForm((p) => ({ ...p, customerLoginDefault: next }));
    const { data, error: err } = await sb.functions.invoke("portal-settings", { body: { action: "save", customerLoginDefault: next } });
    setLoginBusy(false);
    if (err || (data && data.error)) {
      setForm((p) => ({ ...p, customerLoginDefault: prev }));
      setLoginMsg({ err: (data && data.error) || (err ? await fnError(err) : "Couldn't save that.") });
      return;
    }
    setLoginMsg({ ok: next === "email"
      ? "Saved — customers are offered an emailed code first."
      : "Saved — customers are offered a texted code first." });
  };

  const [coBusy, setCoBusy] = useState(false);
  const [coMsg, setCoMsg] = useState(null);   // { ok } | { err }
  const saveChangeOrders = async () => {
    setCoMsg(null); setCoBusy(true);
    const { data, error: err } = await sb.functions.invoke("portal-settings", { body: {
      action: "save",
      coUnlockRequired: form.coUnlockRequired,
      coFreeDays: form.coFreeDays,
      coFee: form.coFee,
      coFeeTaxable: form.coFeeTaxable,
      coFeeLabel: form.coFeeLabel,
      coUnlockHours: form.coUnlockHours,
    } });
    setCoBusy(false);
    if (err || (data && data.error)) { setCoMsg({ err: (data && data.error) || err.message }); return; }
    setCoMsg({ ok: form.coUnlockRequired
      ? `Saved — after ${Number(form.coFreeDays) || 0} day${Number(form.coFreeDays) === 1 ? "" : "s"}, a signed order has to be unlocked before it can be changed.`
      : "Saved — your reps can change a signed order at any time without asking anyone." });
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

  // Grey blocks in the form's own shape instead of the word "Loading" — see SkelBar in
  // 01-core. The `status` read genuinely has to land before the real form paints: every
  // field is prefilled from it, and `status.configured` is what decides between
  // "Connected — location …" and "Not connected yet", so painting the form early would
  // state a connection we can't prove. The shape is the part we CAN show honestly.
  //
  // Section-aware on purpose. Connection and Branding share this one gate but render
  // different cards, and a single shared skeleton would promise the Branding logo tile to
  // someone sitting on the CRM screen — a skeleton that overstates the answer is the exact
  // thing skeletons exist to avoid.
  if (!status && !error) {
    const skFields = (n, seed) => (
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
        {Array.from({ length: n }, (_, i) => (
          <div key={seed + i}><SkelBar w="42%" h={9} style={{ marginBottom: 7 }} /><SkelBar w="100%" h={30} /></div>
        ))}
      </div>
    );
    return (
      <div>
        {show("connection") && (
          <div style={S.card}>
            <SkelBar w={150} h={15} style={{ marginBottom: 14 }} />
            {skFields(2, 0)}
            <SkelBar w={210} h={32} style={{ marginTop: 14 }} />
          </div>
        )}
        {show("branding") && (
          <div style={S.card}>
            <SkelBar w={250} h={15} style={{ marginBottom: 14 }} />
            {skFields(4, 10)}
            {/* The logo tile, at the size the real one renders (96×64). */}
            <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 14 }}>
              <SkelBar w={96} h={64} /><SkelBar w={170} h={12} />
            </div>
          </div>
        )}
        {show("branding") && (
          <div style={S.card}>
            <SkelBar w={210} h={15} style={{ marginBottom: 14 }} />
            {skFields(4, 20)}
            <div style={{ marginTop: 12 }}><SkelBar w="30%" h={9} style={{ marginBottom: 7 }} /><SkelBar w="100%" h={70} /></div>
          </div>
        )}
      </div>
    );
  }

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
            : <>Not connected. Optional — connect one to mirror contacts and quotes into it. With no CRM, contacts stay in Structure Studio and quotes go out through Structure Studio paperwork (switch it on below).</>}
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

      {/* Quotes & Invoices (migration 121). ON is what every tenant has done since day one:
          the quote and the invoice are objects in the CRM. OFF moves BOTH documents into
          StructureStudio — and the copy has to be explicit that contacts and opportunities
          still go to the CRM, because "invoice in StructureStudio" reads like "stop using my
          CRM" otherwise. The starting numbers are optional since migration 283 (Carolyn
          2026-10-06): left blank, quotes and invoices each start at 1000, or carry on one past
          the last number issued under the prefix, so a book never restarts at 1. A box cleared
          over a counter already in use keeps that counter (the server ignores the blank), and
          the preview says so. The tax rate is still required (the server refuses the save
          without one). */}
      <div style={S.card}>
        <div style={S.h2}>Quotes &amp; Invoices</div>
        {mayGhlInvoice && (
          <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13, fontWeight: 600, color: "#1E293B" }}>
            <input type="checkbox" checked={form.invoiceInGhl} onChange={set("invoiceInGhl")} style={{ marginTop: 2 }} />
            Quote and invoice through my CRM
          </label>
        )}
        <p style={{ fontSize: 12, color: "#64748B", marginTop: mayGhlInvoice ? 6 : 0, marginBottom: 0, lineHeight: 1.5 }}>
          {!ssMode
            ? <>On — your estimates and invoices are created in your CRM and emailed from there, exactly as they are today.</>
            : <><b>{mayGhlInvoice ? "Off — StructureStudio issues your quotes and invoices." : "StructureStudio issues your quotes and invoices."}</b> Each quote is one document: the priced
                estimate, the floor plan, and, if you have 3D, a 3D picture of the building. Your customer accepts it from
                their quote page, and you invoice from the Orders tab. If a CRM is connected, contacts and
                opportunities still go there so your pipeline keeps working; if not, everything stays in Structure Studio.</>}
        </p>
        {ssMode && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginTop: 12, maxWidth: 460 }}>
            <div><span style={S.lbl}>Starting quote number</span>
              <input style={S.input} value={form.ssQuoteNext} onChange={set("ssQuoteNext")} placeholder="1000" inputMode="numeric" />
              <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 4 }}>Pick up where your CRM or QuickBooks left off, or leave blank to start at 1000 (or carry on after your last quote). Counts up by one per quote.</div></div>
            <div><span style={S.lbl}>Quote prefix (optional)</span>
              <input style={S.input} value={form.ssQuotePrefix} onChange={set("ssQuotePrefix")} placeholder="e.g. JB-" maxLength={12} />
              <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 4 }}>Letters, numbers and dashes. Shows on the document as {(form.ssQuotePrefix || "") + (form.ssQuoteNext || blankStart(status && status.ssQuoteNext))}.</div></div>
            <div><span style={S.lbl}>Starting invoice number</span>
              <input style={S.input} value={form.ssInvoiceNext} onChange={set("ssInvoiceNext")} placeholder="1000" inputMode="numeric" />
              {/* The QuickBooks line follows the CONNECTION (status.qboConnected), not the
                  subscription: send_invoice refuses a blank start while a connected company would
                  receive the invoice, because QuickBooks may already hold an invoice 1000. */}
              <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 4 }}>Invoices number separately from quotes. Leave blank to start at 1000 (or carry on after your last invoice).{status && status.qboConnected === true && <> Connected to QuickBooks? Enter your next QuickBooks invoice number.</>}</div></div>
            <div><span style={S.lbl}>Invoice prefix (optional)</span>
              <input style={S.input} value={form.ssInvoicePrefix} onChange={set("ssInvoicePrefix")} placeholder="e.g. INV-" maxLength={12} />
              <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 4 }}>Shows on the invoice as {(form.ssInvoicePrefix || "") + (form.ssInvoiceNext || blankStart(status && status.ssInvoiceNext))}.</div></div>
          </div>
        )}
        {/* Sales tax (migration 158). SS mode only: in CRM mode GHL computes tax on its
            own documents. The rate here is the COMPANY rate, and it is the last rung a quote
            can land on: a rate verified for the delivery address wins, then the quote's
            sales location's own rate (migration 244), then this. Nothing looks an address up
            on its own — a verified rate only exists where someone asked for one. That is why
            the server refuses to flip SS mode on while this is blank: with no location rate
            either, a quote would have nothing to charge. 0 is a real answer, "unanswered" is
            not.

            The help text used to say tax was "figured from each quote's delivery address" and
            this rate charged "when that lookup can't resolve". Neither was true once lookups
            stopped running on every submit, and a builder reading it would believe every
            quote was being checked. */}
        {ssMode && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginTop: 12, maxWidth: 460 }}>
            <div><span style={S.lbl}>Sales tax rate (%)</span>
              <input style={S.input} value={form.ssTaxRate} onChange={set("ssTaxRate")} placeholder="e.g. 7.25" inputMode="decimal" />
              <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 4 }}>Used on every quote unless the quote's sales location has its own rate, or someone verifies the rate for its delivery address. Enter 0 if you don't collect sales tax.</div></div>
            <div><span style={S.lbl}>Tax label on documents</span>
              <input style={S.input} value={form.ssTaxLabel} onChange={set("ssTaxLabel")} placeholder="Sales tax" maxLength={40} />
              <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 4 }}>How the tax line reads on quotes and invoices.</div>
              <label style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12, fontWeight: 600, color: "#1E293B", marginTop: 8 }}>
                <input type="checkbox" checked={form.ssTaxDelivery} onChange={set("ssTaxDelivery")} />
                Charge tax on delivery
              </label></div>
          </div>
        )}
        {/* Read-only: where else a quote's rate can come from, and whether verified lookups
            are on for this account. See the note on `taxInfo` above. "Verified against the
            delivery address", never "exact" — the lookup is an approximate rate for general
            goods, and the copy must not promise more than that. */}
        {showTaxBox && (
          <div style={{ marginTop: 12, maxWidth: 620, background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 8, padding: "10px 13px", fontSize: 12.5, color: "#475569", lineHeight: 1.55 }}>
            <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.5, textTransform: "uppercase", color: "#64748B", marginBottom: 4 }}>Sales tax</div>
            {taxInfo.err && <div style={{ color: "#B45309", fontWeight: 600 }}>{taxInfo.err}</div>}
            {!taxInfo.err && (() => {
              const withRate = (taxInfo.locations || []).filter((l) => l.active !== false && l.taxRatePct != null).length;
              return (<>
                <div>
                  <b>Local rates:</b>{" "}
                  {withRate > 0
                    ? <>{withRate} of your sales locations {withRate === 1 ? "has its" : "have their"} own rate, used on quotes for {withRate === 1 ? "that location" : "those locations"}. Set them in Company → Locations.</>
                    : <>none yet. A sales location can carry your local rate — set one in Company → Locations.</>}
                </div>
                <div style={{ marginTop: 4 }}>
                  <b>Verified lookups:</b>{" "}
                  {!taxInfo.lookupEnabled
                    ? <>off for your account. CSM Synergy switches these on; until then your quotes use your company and local rates.</>
                    : taxInfo.configured === false
                      ? <>on for your account, but the lookup service isn't connected right now — quotes use your company and local rates until it is.</>
                      : <>on for your account. A quote's rate can be verified against its delivery address before your customer signs.
                          {/* usage24h is null when the lookup ledger can't be counted: unknown, not zero. */}
                          {taxInfo.dailyCap != null && typeof taxInfo.usage24h === "number" && <> {taxInfo.usage24h} of {taxInfo.dailyCap} used in the last 24 hours.</>}</>}
                </div>
              </>);
            })()}
          </div>
        )}
        {/* Only the tax rate is still required: a blank starting number begins at 1000 (283). */}
        {ssMode && !String(form.ssTaxRate).trim() && (
          <div style={{ marginTop: 10, background: "#FEF3C7", border: "1px solid #FDE68A", color: "#B45309", borderRadius: 8, padding: "9px 13px", fontSize: 12.5, fontWeight: 600, lineHeight: 1.5 }}>
            Before saving, set your sales tax rate (0 counts).
            Without a company tax rate, a quote whose sales location has no rate of its own has nothing to charge.
          </div>
        )}
        {ssMode && status && status.emailReady === false && (
          /* Was "nobody is emailed" (decision 5, 2026-08-23). Since 2026-09-02 a
             paperwork-mode tenant sends from the PLATFORM address until their own domain
             verifies — _shared/emailSend.ts opens its provider guard for exactly this case,
             because nothing else can send their documents. So the notice states what now
             happens (a working send under our name) rather than a failure that no longer
             occurs. Do not restore the old wording without closing that opening too. */
          <div style={{ marginTop: 10, background: "#FEF3C7", border: "1px solid #FDE68A", color: "#B45309", borderRadius: 8, padding: "9px 13px", fontSize: 12.5, fontWeight: 600, lineHeight: 1.5 }}>
            Heads up: your own sending domain isn't verified yet (Settings → Email Settings), so quotes
            and invoices go out from our address on your behalf, with your business name as the
            sender. Verify your domain to send from your own address instead.
          </div>
        )}
        {invMsg && invMsg.err && <div style={{ ...S.err, marginTop: 10 }}>{invMsg.err}</div>}
        {invMsg && invMsg.ok && <div style={{ ...S.okMsg, marginTop: 10 }}>{invMsg.ok}</div>}
        <button type="button" onClick={saveInvoicing} disabled={invBusy}
          style={{ ...S.btn(ACCENT, "#FFF"), marginTop: 12, opacity: invBusy ? 0.6 : 1 }}>
          {invBusy ? "Saving…" : "Save Quote & Invoice Settings"}
        </button>
      </div>

      {/* ── Changing a signed order (migrations 209-216) ─────────────────────────────────
          SS-PAPERWORK MODE ONLY. In CRM mode GoHighLevel owns the documents, so there is
          nothing of ours for a fee to print on and nothing for an unlock to protect — the
          server refuses a fee in that state and the card would be describing a feature the
          tenant cannot use.

          The default (approval OFF) is what every tenant already has, and the copy says so
          plainly rather than presenting the dormant state as an unconfigured one. */}
      {!form.invoiceInGhl && (
        <div style={S.card}>
          <div style={S.h2}>Changing a signed order</div>
          <p style={{ fontSize: 12, color: "#64748B", marginTop: 6, marginBottom: 10, lineHeight: 1.5 }}>
            A change order re-opens the whole order — the drawing, the options, the price — and the
            customer signs it again. Payments already taken are never touched. This is who is allowed
            to start one, and what it costs.
          </p>

          <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13, fontWeight: 600, color: "#1E293B" }}>
            <input type="checkbox" checked={form.coUnlockRequired} onChange={set("coUnlockRequired")} style={{ marginTop: 2 }} />
            An admin or crew leader has to unlock a signed order first
          </label>
          <p style={{ fontSize: 12, color: "#64748B", marginTop: 6, marginBottom: 0, lineHeight: 1.5 }}>
            {form.coUnlockRequired
              ? <>On — once the free window below has passed, a rep asks and someone with <b>Approve Changes</b> decides. A change can still happen at any point in the job, including after delivery and final payment.</>
              : <><b>Off — this is how your account works today.</b> Any rep who holds Change Orders can change a signed order whenever they need to, with nobody's approval.</>}
          </p>

          {form.coUnlockRequired && (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginTop: 12, maxWidth: 460 }}>
                <div><span style={S.lbl}>Free-change window (days)</span>
                  <input style={S.input} value={form.coFreeDays} onChange={set("coFreeDays")} placeholder="e.g. 3" inputMode="numeric" />
                  <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 4 }}>
                    How long after the order is written a rep can change it with no approval and no fee — for the customer who rings back the same afternoon. Enter 0 for no free window.
                  </div></div>
                <div><span style={S.lbl}>How long an unlock lasts (hours)</span>
                  <input style={S.input} value={form.coUnlockHours} onChange={set("coUnlockHours")} placeholder="72" inputMode="numeric" />
                  <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 4 }}>
                    An unlock nobody used expires on its own, so an order is never left standing open. Up to 720 hours (30 days).
                  </div></div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginTop: 12, maxWidth: 460 }}>
                <div><span style={S.lbl}>Change order fee ($)</span>
                  <input style={S.input} value={form.coFee} onChange={set("coFee")} placeholder="e.g. 150" inputMode="decimal" />
                  <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 4 }}>
                    Added automatically to a change made after the free window, as its own line on the invoice. Enter 0 for no fee.
                  </div></div>
                <div><span style={S.lbl}>How the fee reads on the invoice</span>
                  <input style={S.input} value={form.coFeeLabel} onChange={set("coFeeLabel")} placeholder="Change order fee" maxLength={40} />
                  <label style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12, fontWeight: 600, color: "#1E293B", marginTop: 8 }}>
                    <input type="checkbox" checked={form.coFeeTaxable} onChange={set("coFeeTaxable")} />
                    Charge sales tax on the fee
                  </label>
                  <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 4 }}>
                    Taxed at the rate on the customer's own agreement, not today's — check with your accountant if you are unsure.
                  </div></div>
              </div>

              {/* The one combination the server refuses, surfaced at the control rather
                  than after a round trip. A fee with no approval requirement is charged
                  by nothing — see order_amendment_gate: it only quotes a fee on an unlock. */}
              {Number(form.coFee) > 0 && (
                <div style={{ marginTop: 10, background: "#F0F9FF", border: "1px solid #BAE6FD", color: "#075985", borderRadius: 8, padding: "9px 13px", fontSize: 12.5, lineHeight: 1.5 }}>
                  A rep is shown the {"$"}{(Number(form.coFee) || 0).toFixed(2)} fee before they start the change, so nobody meets it for the first time on the customer's invoice.
                  {Number(form.coFreeDays) > 0
                    ? ` Changes made within ${Number(form.coFreeDays)} day${Number(form.coFreeDays) === 1 ? "" : "s"} of the order are free.`
                    : " Every change to a signed order carries it — there is no free window."}
                </div>
              )}
            </>
          )}

          <button type="button" onClick={saveChangeOrders} disabled={coBusy}
            style={{ ...S.btn(ACCENT, "#FFF"), marginTop: 12, opacity: coBusy ? 0.6 : 1 }}>
            {coBusy ? "Saving…" : "Save change order rules"}
          </button>
          {coMsg && (
            <div style={{ marginTop: 10, background: coMsg.err ? "#FEF2F2" : "#ECFDF5", border: `1px solid ${coMsg.err ? "#FECACA" : "#A7F3D0"}`, color: coMsg.err ? "#B91C1C" : "#065F46", borderRadius: 8, padding: "9px 13px", fontSize: 12.5, fontWeight: 600, lineHeight: 1.5 }}>
              {coMsg.err || coMsg.ok}
            </div>
          )}
        </div>
      )}

      {/* CUSTOMER LOGIN CODE (migration 231; plan 3.6, Ahsan 2026-09-15: "Text AND email login
          codes before the expo"). The designer's Log in sheet offers Text | Email; this picks
          which one comes FIRST. customer-auth login_options only ever treats it as a preference
          among the channels the platform can actually deliver, so choosing Email before email
          codes are switched on changes nothing a customer sees — the copy says so rather than
          promising a route. Every tenant, CRM or not: the login is ours either way. */}
      <div style={S.card}>
        <div style={S.h2}>Customer login code</div>
        <p style={{ fontSize: 12, color: "#64748B", marginTop: 6, marginBottom: 10, lineHeight: 1.5 }}>
          How your customers get the 6-digit code that logs them in to see, accept and sign their quotes
          and invoices. This is the option they're offered first — they can still pick the other one.
        </p>
        <div role="group" aria-label="Customer login code" data-ss-login-default={form.customerLoginDefault === "email" ? "email" : "sms"}
          style={{ display: "inline-flex", border: "1px solid #E2E8F0", borderRadius: 8, overflow: "hidden" }}>
          {[["sms", "Text"], ["email", "Email"]].map(([v, label]) => {
            const on = (form.customerLoginDefault === "email" ? "email" : "sms") === v;
            return (
              <button key={v} type="button" aria-pressed={on} disabled={loginBusy} onClick={() => saveLoginDefault(v)}
                style={{ background: on ? ACCENT : "#FFF", color: on ? "#FFF" : "#334155", border: "none", borderLeft: v === "email" ? "1px solid #E2E8F0" : "none", padding: "7px 18px", fontSize: 13, fontWeight: 700, cursor: loginBusy ? "default" : "pointer", fontFamily: "inherit", opacity: loginBusy ? 0.7 : 1 }}>
                {label}
              </button>
            );
          })}
        </div>
        <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 6 }}>
          If emailed codes aren't available on your account yet, customers get a text either way.
        </div>
        {loginMsg && (
          <div style={{ marginTop: 10, background: loginMsg.err ? "#FEF2F2" : "#ECFDF5", border: `1px solid ${loginMsg.err ? "#FECACA" : "#A7F3D0"}`, color: loginMsg.err ? "#B91C1C" : "#065F46", borderRadius: 8, padding: "9px 13px", fontSize: 12.5, fontWeight: 600, lineHeight: 1.5 }}>
            {loginMsg.err || loginMsg.ok}
          </div>
        )}
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
          <div><span style={S.lbl}>Company name</span><input style={S.input} value={form.brandName} onChange={set("brandName")} onKeyDown={brandKeyDown} /></div>
          <div><span style={S.lbl}>Tagline</span><input style={S.input} value={form.brandTagline} onChange={set("brandTagline")} onKeyDown={brandKeyDown} placeholder="Design & Quote" /></div>
          <div><span style={S.lbl}>Accent color</span>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="color" value={form.brandAccent} onChange={set("brandAccent")} style={{ width: 44, height: 34, border: "1px solid #CBD5E1", borderRadius: 6, background: "#FFF", cursor: "pointer" }} />
              <input style={{ ...S.input, flex: 1 }} value={form.brandAccent} onChange={set("brandAccent")} onKeyDown={brandKeyDown} /></div></div>
          <div><span style={S.lbl}>Header background</span>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="color" value={form.brandHeaderBg} onChange={set("brandHeaderBg")} style={{ width: 44, height: 34, border: "1px solid #CBD5E1", borderRadius: 6, background: "#FFF", cursor: "pointer" }} />
              <input style={{ ...S.input, flex: 1 }} value={form.brandHeaderBg} onChange={set("brandHeaderBg")} onKeyDown={brandKeyDown} /></div></div>
          {/* BUILDING STYLES PER ROW (Carolyn 2026-09-14 @7:10, migration 232). A ninth style
              wrapped to a second row of her style bar; the bar now scrolls instead, and this is
              how many photos sit side by side before it does. Four buttons, not a number box:
              only 5-8 are valid, and a picker that cannot hold a wrong value needs no error.
              type="button" is load-bearing — this card lives inside the page-wide <form>, and a
              default-type button would submit it. Staged like the logo: Save Branding sends it. */}
          <div><span id="ss-brand-spr" style={S.lbl}>Building styles per row</span>
            <div role="group" aria-labelledby="ss-brand-spr" data-ss-styles-per-row={form.brandStylesPerRow} style={{ display: "flex", gap: 6 }}>
              {["5", "6", "7", "8"].map((n) => {
                const on = form.brandStylesPerRow === n;
                return (
                  <button key={n} type="button" aria-pressed={on} onClick={() => setForm((p) => ({ ...p, brandStylesPerRow: n }))}
                    style={{ flex: 1, height: 34, cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 700, borderRadius: 6,
                      border: on ? "1px solid " + ACCENT : "1px solid #CBD5E1", background: on ? ACCENT : "#FFF", color: on ? "#FFF" : "#475569" }}>
                    {n}
                  </button>
                );
              })}
            </div>
            <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 4 }}>How many style photos sit side by side on your designer. Extra styles scroll.</div>
          </div>
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

      {/* ─── COMPANY (Carolyn 2026-09-04 @28:55) ───
          Split out of Branding, not newly built. She hit this mid-onboarding of a real
          client: "I'm getting ready to send this email to this client ... what I'm trying to
          work through on the setup part of it ... I feel like we need to go into branding and
          we need to have everything about the company ... the EIN, all that stuff needs to be
          in here. Their terms and conditions, company, branding, company information."

          Her structure, in her words, is three things: Branding, Company, Team. This is the
          Company third. Nothing moved in the DATABASE — these are the same
          `client_settings.business_*` columns saved by the same global save; only the tab
          they live under changed, which is what she was actually missing.

          ⚠️ WHAT IS DELIBERATELY NOT HERE YET: legal business name, business type, and the
          privacy/terms URLs. Those exist today only inside the SMS carrier registration
          (`sms_registrations`), and promoting them is a schema change, not a re-tab. The
          EIN is a harder case and must NOT simply be moved: 165_sms_registration.sql holds
          that the full EIN, the rep's mobile and the registered address live at TWILIO and
          are referenced by SID, with only `ein_last4` kept locally, so that "a support ticket
          must never be answerable by reading our database". Reversing that is a privacy
          decision for Ahsan and Carolyn, not a refactor. See the plan's Lane E.

          Safe by construction: SettingsView's form state always covers every field no matter
          which section renders, and the save is global — the comment at the top of this
          component says so, and it is why this split needs no new save path. */}
      {show("company") && (<>
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
            {/* The quote PDF fetches the logo server-side, and only from where Upload puts it
                (_shared/pdfLogo.ts). A pasted link from another site still shows in emails. */}
            <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 4 }}>A PNG or JPG you upload here also prints at the top of your quote PDFs.</div>
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
        {/* Carolyn 2026-08-06: "estimate good for X amount of days". Prints as the "Valid until"
            date on every quote PDF, and is the expiry date on estimates your CRM sends. */}
        {quoteDaysReady && (
          <div style={{ marginTop: 12 }}>
            <label htmlFor="ss-quote-valid-days" style={S.lbl}>Quotes are good for</label>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input id="ss-quote-valid-days" style={{ ...S.input, width: 90 }} value={form.quoteValidDays}
                onChange={set("quoteValidDays")} inputMode="numeric" placeholder="30" />
              <span style={{ fontSize: 13, color: "#475569" }}>days</span>
            </div>
            <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 4 }}>
              Your quotes show a “Valid until” date this many days after the quote date. Anywhere from 1 to 365 days.
            </div>
          </div>
        )}
        {/* Carolyn 2026-08-20: a 3D page on the estimate, "optional for them", that "gets 4 sides. So
            4 quadrants"; 2026-09-08: "we want to see 4 images... one from each corner". Only where
            3D is unlocked (no 3D, no 3D page), and only once status can read the setting. */}
        {view3d && cornerReady && (
          <div style={{ marginTop: 12 }}>
            <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13, fontWeight: 600, color: "#1E293B" }}>
              <input type="checkbox" checked={form.quoteCornerViews} onChange={set("quoteCornerViews")} style={{ marginTop: 2 }} data-ss-quote-corners />
              Show the building from all four corners on page 2 of my quotes
            </label>
            <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 4 }}>
              Page 2 of your quotes shows four 3D pictures of the building, one from each corner, in place of the single 3D view.
            </div>
          </div>
        )}
      </div>
      </>)}

      {show("branding") && (<>
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

      </>)}

      {/* ⚠️ THE GLOBAL SAVE MUST OUTLIVE THE BRANDING FRAGMENT. It used to sit INSIDE it,
          which was invisible while Branding owned every editable card on this form — and the
          moment Business Details moved to the Company tab (2026-09-04) that tab would have
          rendered a full form of inputs and NO way to save them. A form that silently cannot
          save looks identical to one that saved and lost the data.

          Gated on branding-or-company rather than hoisted unconditionally: `show()` returns
          true for EVERY key when `section` is null, so an unconditional button is correct for
          the legacy all-sections render but would also add a second, whole-form Save to the
          CRM Connection tab, which deliberately has its own three narrow saves. */}
      {(show("branding") || show("company")) && (
        <button type="submit" disabled={busy} style={{ ...S.btn(ACCENT, "#FFF"), opacity: busy ? 0.6 : 1, marginBottom: 24 }}>{busy ? "Saving…" : "Save Settings"}</button>
      )}
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
    // An Excel ERROR (#REF!, #N/A, #DIV/0!) — ExcelJS gives { error } for the value itself and
    // { formula, result: { error } } for a formula that failed. It must come through as its code,
    // never as "": every importer reads a blank as meaningful — the pricing sheet as "not priced"
    // (the NULL-base-price contract hides the size from the designer), a fixture's price the same
    // way, a Real-Time Pricing cost as $0 — while "#REF!" is refused by name and the row is left
    // as it was. ("[object Object]" from the old String(result) was refused too, but unreadably.)
    if (v.error != null) return String(v.error);
    if (v.result != null) return (typeof v.result === "object" && !(v.result instanceof Date)) ? xlsxCellText(v.result) : String(v.result);
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
// EVERY worksheet of an .xlsx File as [{ name, matrix }], same cell tolerance as above.
// Exists for the Real-Time Pricing workbook, whose meaning is spread across sheets
// (Materials + one sheet per style + Overhead) — readXlsxMatrix's first-sheet-only shape
// silently drops all but one of them. Blank rows are KEPT here (as []), because the style
// sheets use blank rows as block separators and dropping them would merge size blocks.
async function readXlsxWorkbook(file, ExcelJS) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await file.arrayBuffer());
  if (!wb.worksheets.length) throw new Error("The spreadsheet has no sheets.");
  return wb.worksheets.map((ws) => {
    const sv = ws.getSheetValues();
    const matrix = [];
    for (let r = 1; r < sv.length; r++) {
      const row = sv[r];
      const arr = [];
      if (row) for (let c = 1; c < row.length; c++) arr[c - 1] = xlsxCellText(row[c]);
      matrix.push(arr);
    }
    return { name: String(ws.name || ""), matrix };
  });
}

// The brand teal, and the ONE card on the Billing tab that wears it: Synergy CRM. Everything
// else here is ACCENT purple, which on this tab means "buy this, now, from us". Synergy CRM is
// a different product bought on a different site, so it gets the other half of the header
// gradient (01-core.jsx: linear-gradient(#3D3672 → #1B7895)) rather than a colour invented for
// it. Don't reuse this for a purchasable feature — the whole job it does is being the exception.
const SYNERGY_TEAL = "#1B7895";

// Wallet top-up presets, in cents. Round numbers a builder recognises rather than multiples
// of the $20 meter price -- "$100" is a decision, "$140 (7 generations)" is arithmetic
// homework. The floor and cap are NOT here: the server sends them (wallet.minTopupCents /
// maxTopupCents) so there is exactly one definition and the UI cannot drift from it.
const TOPUP_PRESETS = [10000, 25000, 50000];

// FOUNDING PRICING IS YEARLY ONLY (Carolyn 2026-09-24): "Everybody that comes in has to pay for
// the full year on whichever selections they make ... leave month so that month is still
// showing but when they click on it, it doesn't do anything." Founding members are backing the
// platform, so they prepay the year.
//
// This is the browser's switch. Set it to false and the Monthly buttons work again, the tile copy
// goes back to "Pick monthly or yearly", and the transition banner (12-shell) quotes /mo again.
// Nothing else was taken apart to do this: the _monthly billing_plans rows and the interval maths
// all still handle monthly.
//
// ⚠️ THE SERVER HAS THE OTHER HALF (2026-09-29, when this went live on production): portal-billing's
// subscribe refuses any monthly plan while FOUNDING_ANNUAL_ONLY in
// supabase/functions/_shared/foundingPricing.ts is on (409 "founding_annual_only"), so a stale tab
// or a hand-made request cannot buy monthly either. Reopening monthly means flipping BOTH
// constants; _shared/foundingPricing.test.ts reads this line and fails the push when they differ.
// Keep it a literal true/false so that test can read it.
const FOUNDING_ANNUAL_ONLY = true;

// ─── Wallet → Transactions (usage billing, migration 259) ───
// Carolyn 2026-10-02: every call minute and every text comes out of the wallet, and "each charge
// is its own line under Transactions, like GoHighLevel". So this is GHL's table: Date,
// Description, Amount, Balance, newest first, with All / Calls / Texts / Funds / Other chips, a
// date range, Load more and Export CSV. It replaces the card's ten-line "Recent activity" list,
// which printed a $0.028 call as "−$0.00".
//
// Everything a line says is decided by portal-billing's `wallet_transactions` action
// (_shared/walletLedger.ts): the description, the chip it counts under, whether it is pending,
// and `precise` — a call or text, or any amount that is not whole cents, shows four decimal
// places ($0.0280); everything else shows two. A balance shows four places on those lines and
// whenever it is not whole cents itself (see balanceOf). This file maps no `kind` to English.
//
// INLINE STYLES ONLY, like every component here (there is no component stylesheet), so the phone
// layout is chosen by measuring the card rather than by a media query: under WALLET_TX_NARROW_PX
// each line becomes two rows, description over date on the left, amount over balance on the right.
const WALLET_TX_FILTERS = [["all", "All"], ["calls", "Calls"], ["texts", "Texts"], ["funds", "Funds"], ["other", "Other"]];
const WALLET_TX_NARROW_PX = 560;
// Narrower still (a 320 px phone with the settings rail beside it leaves a ~230 px card), two date
// fields side by side clip their own dates, so they stack.
const WALLET_TX_TIGHT_PX = 280;

// "$0.0280" / "$1,234.50", unsigned, from integer micros or cents. Never float division into a
// display string: four places is exactly where 0.1 + 0.2 shows up.
function walletTxMoney(micros, cents, precise) {
  if (precise && micros != null) {
    const units = Math.round(Math.abs(micros) / 100);   // ten-thousandths of a dollar
    return { neg: micros < 0 && units !== 0, text: "$" + Math.floor(units / 10000).toLocaleString("en-US") + "." + String(units % 10000).padStart(4, "0") };
  }
  if (cents == null) return null;
  const c = Math.abs(cents);
  return { neg: cents < 0, text: "$" + Math.floor(c / 100).toLocaleString("en-US") + "." + String(c % 100).padStart(2, "0") };
}

async function walletTxCall(body) {
  const { data: d, error: e } = await sb.functions.invoke("portal-billing", { body: { action: "wallet_transactions", ...body } });
  if (e) {
    // The sentence is in the BODY; e.message alone is the generic non-2xx.
    let m = e.message;
    try { const ctx = await e.context.json(); if (ctx && ctx.error) m = ctx.error; } catch (_x) {}
    throw new Error(m);
  }
  if (d && d.error) throw new Error(d.error);
  return d || {};
}

// `recent` is status's ten-line list. It is shown ONLY when the full list cannot load, so a
// portal that ships ahead of portal-billing (an older function answers "Unrecognised action")
// still shows the latest activity instead of losing it.
function WalletTransactions({ reloadKey, recent = [] }) {
  const [filter, setFilter] = useState("all");
  const [fromDay, setFromDay] = useState("");   // yyyy-mm-dd, local
  const [toDay, setToDay] = useState("");
  const [rows, setRows] = useState(null);       // null = first page loading
  const [next, setNext] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null);       // "more" | "export"
  const [note, setNote] = useState(null);       // { ok } | { err } after an export
  const [boxW, setBoxW] = useState(1000);       // the card's measured width
  const narrow = boxW < WALLET_TX_NARROW_PX;
  const tight = boxW < WALLET_TX_TIGHT_PX;
  const boxRef = useRef(null);
  const seq = useRef(0);                        // the newest request wins; older answers are dropped

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setBoxW(Math.round(el.getBoundingClientRect().width));
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The range in the builder's OWN days: from local midnight of the first day to local midnight
  // after the last, sent as instants (portal-billing compares from-inclusive, to-exclusive). A
  // date-only string through bare new Date() is UTC midnight, a day early in every US zone.
  const range = useMemo(() => {
    const startOf = (day, plusDays) => {
      const d = ssLocalDate(day);
      if (!d || !Number.isFinite(d.getTime())) return null;
      d.setDate(d.getDate() + plusDays);
      return d.toISOString();
    };
    const from = fromDay ? startOf(fromDay, 0) : null;
    const to = toDay ? startOf(toDay, 1) : null;
    return { from, to, bad: !!(fromDay && toDay && fromDay > toDay), key: `${from}|${to}` };
  }, [fromDay, toDay]);
  const params = () => ({ filter, ...(range.from ? { from: range.from } : {}), ...(range.to ? { to: range.to } : {}) });

  useEffect(() => {
    if (range.bad) return;
    const my = ++seq.current;
    setRows(null); setNext(null); setErr(null);
    (async () => {
      try {
        const d = await walletTxCall(params());
        if (seq.current !== my) return;
        setRows(d.rows || []); setNext(d.next_cursor || null);
      } catch (e) {
        if (seq.current !== my) return;
        setErr(e.message); setRows([]);
      }
    })();
  }, [filter, range.key, range.bad, reloadKey]);

  const loadMore = async () => {
    if (!next || busy) return;
    const my = seq.current;
    setBusy("more");
    try {
      const d = await walletTxCall({ ...params(), cursor: next });
      if (seq.current === my) { setRows((p) => (p || []).concat(d.rows || [])); setNext(d.next_cursor || null); }
    } catch (e) {
      if (seq.current === my) setNote({ err: e.message });
    }
    setBusy(null);
  };

  const exportCsv = async () => {
    if (busy || range.bad) return;
    setBusy("export"); setNote(null);
    try {
      let tz = "UTC";
      try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch (_x) {}
      const d = await walletTxCall({ ...params(), format: "csv", tz });
      if (typeof d.csv !== "string") throw new Error("The export came back empty. Try again.");
      const span = fromDay || toDay ? `-${fromDay || "start"}-to-${toDay || "today"}` : `-${ssLocalIso(new Date())}`;
      // A byte-order mark so Excel opens it as UTF-8: descriptions carry "·" and "—".
      downloadFile(`wallet-transactions${filter === "all" ? "" : "-" + filter}${span}.csv`, "﻿" + d.csv);
      setNote(d.truncated
        ? { ok: "Downloaded the newest 10,000 lines. Narrow the dates to export older ones." }
        : { ok: `Downloaded ${Number(d.rows || 0).toLocaleString("en-US")} line${d.rows === 1 ? "" : "s"}.` });
    } catch (e) { setNote({ err: e.message }); }
    setBusy(null);
  };

  // Fallback rows from status, in this table's shape (whole cents, no balance).
  const fallback = err && recent.length > 0;
  // A range that ends before it starts shows the warning and no lines, rather than the last
  // range's lines under dates that no longer describe them.
  const shown = range.bad ? []
    : fallback
      ? recent.map((t) => ({ id: t.id, created_at: t.at, description: t.label, amount_cents: t.amountCents, pending: !!t.pending, precise: false, balance_after_cents: null }))
      : (rows || []);
  const filtered = filter !== "all" || !!fromDay || !!toDay;

  const when = (iso) => {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return { day: "", time: "" };
    return {
      day: d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
      time: d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
    };
  };
  const amountOf = (r) => {
    const m = walletTxMoney(r.amount_exact_micros, r.amount_cents, r.precise);
    if (!m) return null;
    return <span style={{ color: m.neg ? "#991B1B" : "#065F46", fontWeight: 700 }}>{m.neg ? "−" : "+"}{m.text}</span>;
  };
  // The balance's places are its OWN, not the amount's. `precise` is decided by the amount, and a
  // top-up after three texts has a whole-cent amount on a balance that still owes a fraction of a
  // cent: printed to two places it read $34.99 under a text line's $9.9876, and the CSV said
  // 34.9876. So four places whenever the exact balance is not whole cents, and on every call or
  // text line as before. (portal-billing nulls an exact balance that does not match the cents,
  // which is what a captured 3D hold leaves behind, so that one falls back to its cents.)
  const balanceOf = (r) => {
    if (r.pending) return <span style={{ color: "#92400E", fontWeight: 700 }}>Pending</span>;
    const exact = r.balance_after_exact_micros;
    const m = walletTxMoney(exact, r.balance_after_cents, r.precise || (exact != null && exact % 10000 !== 0));
    return m ? <span style={{ color: m.neg ? "#991B1B" : "#334155" }}>{m.neg ? "−" : ""}{m.text}</span> : <span style={{ color: "#CBD5E1" }}>—</span>;
  };
  const NUM = { fontVariantNumeric: "tabular-nums", textAlign: "right", whiteSpace: "nowrap" };
  const GRID = { display: "grid", gridTemplateColumns: "150px minmax(0, 1fr) 112px 112px", gap: 12, alignItems: "baseline" };
  const CAP = { fontSize: 11, fontWeight: 800, letterSpacing: 0.5, textTransform: "uppercase", color: "#94A3B8" };

  return (
    <div ref={boxRef} style={S.card} data-wallet-tx="card">
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
        <div style={{ ...S.h2, marginBottom: 0 }}>Transactions</div>
        <button type="button" onClick={exportCsv} disabled={!!busy || range.bad} data-wallet-tx-export=""
          style={{ ...S.btn("#F1F5F9", "#334155"), marginLeft: "auto", border: "1px solid #E2E8F0", padding: "6px 14px", fontSize: 12.5, opacity: busy || range.bad ? 0.6 : 1, cursor: busy || range.bad ? "default" : "pointer" }}>
          {busy === "export" ? "Exporting…" : "Export CSV"}
        </button>
      </div>

      {/* Chips, then the dates. Side by side on a wide card; stacked on a phone, where the two
          date fields share the row and shrink (the portal's DateRange keeps the browser's own
          width for a date field, which pushed a 390 px phone's card 10 px past its edge). */}
      <div style={{ display: "flex", flexDirection: narrow ? "column" : "row", gap: narrow ? 10 : 14, flexWrap: narrow ? "nowrap" : "wrap", alignItems: narrow ? "stretch" : "flex-end", marginBottom: 12 }}>
        <div role="group" aria-label="Show" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {WALLET_TX_FILTERS.map(([k, label]) => {
            const on = filter === k;
            return (
              <button key={k} type="button" aria-pressed={on} onClick={() => setFilter(k)} data-wallet-tx-filter={k}
                style={{
                  cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 700, padding: "5px 12px", borderRadius: 999,
                  border: on ? "1px solid " + ACCENT : "1px solid #E2E8F0", background: on ? ACCENT : "#FFF", color: on ? "#FFF" : "#475569",
                }}>{label}</button>
            );
          })}
        </div>
        <div style={FCTRL}>
          {/* Clear sits on the heading line, not beside the fields, so on a phone the two date
              fields keep the whole row. */}
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
            <span style={FLBL}>Dates</span>
            {(fromDay || toDay) && (
              <button type="button" onClick={() => { setFromDay(""); setToDay(""); }}
                style={{ background: "none", border: "none", color: "#DC2626", fontSize: 11.5, fontWeight: 700, cursor: "pointer", padding: 0, fontFamily: "inherit" }}>
                Clear dates
              </button>
            )}
          </div>
          <div style={{ display: "flex", flexDirection: tight ? "column" : "row", gap: 6, alignItems: tight ? "stretch" : "center", minWidth: 0 }}>
            {[[fromDay, setFromDay, "From"], [toDay, setToDay, "To"]].map(([v, set, name], i) => (<React.Fragment key={name}>
              {i === 1 && !tight && <span style={{ color: "#94A3B8", fontSize: 12 }}>–</span>}
              <input type="date" aria-label={name} value={v} onChange={(e) => set(e.target.value)}
                style={{ ...S.input, padding: "6px 8px", minWidth: 0, ...(tight ? { width: "100%" } : narrow ? { flex: "1 1 0", width: "auto" } : { flex: "0 0 auto", width: 150 }) }} />
            </React.Fragment>))}
          </div>
        </div>
      </div>

      {range.bad && (
        <div style={{ fontSize: 12.5, color: "#B45309", fontWeight: 600, marginBottom: 10 }}>The start date is after the end date.</div>
      )}
      {note && note.err && <div style={S.err}>{note.err}</div>}
      {note && note.ok && <div style={S.okMsg}>{note.ok}</div>}
      {err && (
        <div style={{ ...S.err, ...(fallback ? { background: "#FFFBEB", border: "1px solid #FDE68A", color: "#92400E" } : {}) }}>
          {fallback ? `Showing your latest activity only. The full list couldn't load: ${err}` : err}
        </div>
      )}

      {!narrow && (shown.length > 0 || (rows === null && !range.bad)) && (
        <div style={{ ...GRID, padding: "0 0 7px", borderBottom: "2px solid #E2E8F0" }}>
          <span style={CAP}>Date</span><span style={CAP}>Description</span>
          <span style={{ ...CAP, textAlign: "right" }}>Amount</span><span style={{ ...CAP, textAlign: "right" }}>Balance</span>
        </div>
      )}

      {rows === null && !range.bad ? (
        [0, 1, 2].map((i) => (
          <div key={i} style={{ padding: "11px 0", borderBottom: "1px solid #F1F5F9", display: "flex", gap: 12 }}>
            <SkelBar w={narrow ? "55%" : 130} h={11} /><SkelBar w="35%" h={11} />
          </div>
        ))
      ) : shown.length === 0 && !range.bad ? (
        !err && (
          <p style={{ fontSize: 13, color: "#64748B", margin: "6px 0 0" }}>
            {filtered ? "Nothing matches these filters." : "No transactions yet. Funds you add and everything charged to the wallet will show here."}
          </p>
        )
      ) : shown.map((r) => {
        const w = when(r.created_at);
        const desc = (
          <span style={{ color: "#334155", fontWeight: 600, overflowWrap: "anywhere" }}>
            {r.description}
            {r.pending && <span style={{ color: "#92400E", fontWeight: 700 }}> · pending</span>}
          </span>
        );
        return narrow ? (
          <div key={r.id} data-wallet-tx-row={r.id} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "9px 0", borderBottom: "1px solid #F1F5F9", fontSize: 13 }}>
            <div style={{ minWidth: 0 }}>
              <div>{desc}</div>
              <div style={{ fontSize: 11.5, color: "#94A3B8", marginTop: 2 }}>{w.day} · {w.time}</div>
            </div>
            <div style={{ ...NUM, flexShrink: 0 }}>
              <div>{amountOf(r)}</div>
              <div style={{ fontSize: 11.5, color: "#94A3B8", marginTop: 2 }}>{r.pending || r.balance_after_cents != null ? <>Balance {balanceOf(r)}</> : null}</div>
            </div>
          </div>
        ) : (
          <div key={r.id} data-wallet-tx-row={r.id} style={{ ...GRID, padding: "9px 0", borderBottom: "1px solid #F1F5F9", fontSize: 13 }}>
            <span style={{ color: "#475569", whiteSpace: "nowrap" }}>{w.day}<span style={{ color: "#94A3B8" }}> · {w.time}</span></span>
            {desc}
            <span style={NUM}>{amountOf(r)}</span>
            <span style={NUM}>{balanceOf(r)}</span>
          </div>
        );
      })}

      {!fallback && !range.bad && next && (
        <div style={{ textAlign: "center", marginTop: 12 }}>
          <button type="button" onClick={loadMore} disabled={!!busy} data-wallet-tx-more=""
            style={{ ...S.btn("#FFF", ACCENT), border: "1px solid #E2E8F0", padding: "7px 18px", fontSize: 12.5, opacity: busy ? 0.6 : 1 }}>
            {busy === "more" ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Billing (per-feature subscriptions via portal-billing; Deposyt/NMI gateway) ───
// Each feature (Simple Layout, RealTime Pricing, …) is its own recurring
// subscription, chosen monthly or yearly independently. Simple Layout is the
// required base; features not yet launched render with a COMING SOON overlay and
// can't be selected. Card entry happens in Collect.js's hosted lightbox (loaded
// from the gateway with the PUBLIC tokenization key) — card data never touches the
// portal or Supabase; a returning tenant's card on file (gateway vault) is reused
// so the lightbox only shows the first time.
// SPLIT INTO TWO TABS on 2026-09-11 (Carolyn: "create a new nav called billing then I want to
// move the subscriptions and the wallet in there, as we are prepping for logging every charge
// for the wallet" / "I want the subscriptions on their own tab and wallet on another").
//
// ⚠️ ONE component, one mount, one `data` read — BillingShell passes `section` to a SINGLE
// <BillingView>. portal-billing's `status` is the only backend leg here and it carries the
// plans, the live subscriptions, the discount AND the wallet in one response, so two mounts
// would mean two identical calls and a tab switch that re-fetched for nothing.
//
// The founding-price banner and the "checkout isn't switched on yet" notices ride with
// SUBSCRIPTION: both are about the plan grid directly beneath them.
function BillingView({ viewingLabel = null, section = "all", paywall = false }) {
  const showWallet = section === "all" || section === "wallet";
  const showSub = section === "all" || section === "subscription";
  const [data, setData] = useState(null);   // status response; null = loading
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);   // subscribe/cancel in flight
  const [msg, setMsg] = useState(null);      // { ok } | { err }
  // On the paywall (BillingGate passes `paywall`), a checkout that went through only in part holds
  // back the shell's entitlement re-read until the customer presses Continue: see subscribe().
  const [holdSignal, setHoldSignal] = useState(false);
  const [sel, setSel] = useState({});        // feature -> "monthly" | "annual"
  const [crmIv, setCrmIv] = useState({});    // Synergy CRM tier -> "monthly" | "annual" (display only)
  const [demoNote, setDemoNote] = useState(false); // our own account pressed checkout — see demoView
  // Wallet top-up (migration 164). `topupSel` is a preset in cents; `topupCustom` is the raw
  // DOLLARS string from the Other field. Exactly one is ever set -- picking a preset clears
  // the field and typing clears the preset -- so there is never an ambiguous "which did they
  // mean" state to resolve at charge time.
  const [topupSel, setTopupSel] = useState(null);
  const [topupCustom, setTopupCustom] = useState("");
  const [autoOn, setAutoOn] = useState(false);
  const [autoThreshold, setAutoThreshold] = useState("");
  const [autoAmount, setAutoAmount] = useState("");

  // The shell's own entitlement is refreshed through ssEntitlementChanged (subscribe and cancel
  // below), which respects the paywall's hold; this only re-reads what this view shows.
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
  // NON-BILLABLE ACCOUNT. Since 2026-09-21 the operator's Non-billable flag confers every
  // feature (migration 228), but the tiles below are built from liveFeatures — REAL
  // subscription rows — so without this a comped account sees a full price list with working
  // Subscribe buttons for things it already has, and can put a real charge through for them.
  // Deliberately keyed on entitlement.exempt rather than on `features`: this asks "is this
  // account billable", which is a different question from "may it use X".
  //
  // OUR OWN ACCOUNT IS THE EXCEPTION (Carolyn 2026-09-24): "I am using Structure Studio to do
  // demos and I need that billing tab to ... just show it as it would when they get signed up
  // as a new builder." The comped view took the founding-price pitch off the very screen she
  // sells from. So an INTERNAL account (client_settings.internal_account, migration 169 — "this
  // tenant is us", never a customer) sees what a prospect sees: the banner, the prices, tiles
  // that select. It is still comped in every way that matters; this is only the page it shows.
  // portal-billing reports it as reason "internal" (it outranks "exempt" there), so this needs
  // no new field and no client id in code. Every other comped account keeps the comped view.
  //
  // ⚠️ THE PROSPECT VIEW MUST NOT BE ABLE TO BUY. That account has a real card on file, and an
  // owner with a card is charged by subscribe() with no confirm step — one demo click would
  // put a real yearly charge through. subscribe() stops at its first line for demoView, and
  // portal-billing refuses subscribe for an internal account as well.
  const demoView = !!(data && data.entitlement && data.entitlement.reason === "internal");
  const comped = !!(data && data.entitlement && data.entitlement.exempt) && !demoView;

  // The Structure Studio Suite bundles everything except Self Serve Displays. When it's chosen
  // (in the cart) or already live, its member features are covered — shown "Included" and not
  // separately purchasable — and it satisfies the required base in place of Simple Layout.
  const SUITE_MEMBERS = ["simple_layout", "schedule_builds", "view_3d", "quickbooks_sync", "on_demand_pricing", "crm"];
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
  const grossDueCents = cartPlans.reduce((s, p) => s + (chargeOf(p) || 0), 0) + setupTotal;
  // UPGRADE CREDIT (migration 160). Moving to a bundle throws away prepaid time on the
  // features it replaces; the server credits that unused time against today's charge only —
  // the Suite still RENEWS at full price. `upgradeCredits` is keyed by bundle feature and
  // only contains bundles this tenant can actually claim against, so an empty object (a new
  // signup, or an older portal-billing) simply leaves the arithmetic where it was.
  //
  // This must be applied HERE rather than shown as a footnote: dueTodayCents is what the
  // confirm dialog quotes, what getPaymentToken tokenizes, and what the server re-checks as
  // confirmChargeCents. A credit the browser knew about but did not subtract would fail that
  // handshake on every upgrade.
  const upgradeCredits = (data && data.upgradeCredits) || {};
  const cartCredit = cart.reduce((s, [f]) => s + ((upgradeCredits[f] && upgradeCredits[f].cents) || 0), 0);
  // Capped at the charge: the server caps it the same way and turns the remainder into a
  // later renewal date, so a negative total here would just disagree with the server.
  const creditCents = Math.min(cartCredit, grossDueCents);
  const dueTodayCents = grossDueCents - creditCents;
  const creditSources = cart.flatMap(([f]) => (upgradeCredits[f] && upgradeCredits[f].sources) || []);
  const selectable = !comped && features.some((f) => f.availability === "available" && !liveFeatures[f.feature]);

  // ── Wallet top-up (migration 164) ──────────────────────────────────────────────────
  // Bounds come from the server so the floor and cap live in one place
  // (_shared/walletTopup.ts); the fallbacks only matter against an older portal-billing.
  const wallet = data && data.wallet;
  const minTopup = (wallet && wallet.minTopupCents) || 2000;
  const maxTopup = (wallet && wallet.maxTopupCents) || 500000;
  // Dollars -> cents via Math.round, not parseInt: "12.5" is $12.50, and truncating a
  // half-cent is the kind of rounding that shows up as a penny off in the ledger.
  const customCents = topupCustom.trim() === "" ? null : Math.round(Number(topupCustom) * 100);
  const topupCents = topupSel != null ? topupSel : (Number.isFinite(customCents) ? customCents : null);
  const topupValid = Number.isInteger(topupCents) && topupCents >= minTopup && topupCents <= maxTopup;

  // Mirror the saved auto-recharge config into the form whenever the server's answer
  // changes. Depends on `data` (the whole payload) rather than the nested fields so it
  // re-syncs after every load(), including the one that follows a successful save.
  useEffect(() => {
    const a = (data && data.wallet && data.wallet.autoTopup) || null;
    if (!a) return;
    setAutoOn(!!a.enabled);
    setAutoThreshold(a.thresholdCents != null ? String(a.thresholdCents / 100) : "");
    setAutoAmount(a.amountCents != null ? String(a.amountCents / 100) : "");
  }, [data]);

  const addFunds = async () => {
    if (!topupValid) return;
    setMsg(null); setBusy(true);
    try {
      // Same handshake as subscribe: the amount on screen is the amount tokenized and the
      // amount charged, and the server refuses if they disagree.
      const body = { action: "topup", amountCents: topupCents, confirmChargeCents: topupCents };
      if (viewingLabel) {
        if (!window.confirm(`Add ${fmt$(topupCents)} to ${viewingLabel}'s wallet?

This charges the card they have on file.`)) { setBusy(false); return; }
      } else if (!data.hasCard) {
        body.paymentToken = await getPaymentToken(topupCents);
      }
      const { data: r, error: e } = await sb.functions.invoke("portal-billing", { body });
      if (e) {
        // The real story is in the BODY -- a decline reason, or a "do NOT try again" with a
        // reference. e.message alone is the generic non-2xx and would hide all of it.
        let m = e.message;
        try { const ctx = await e.context.json(); if (ctx && ctx.error) m = ctx.error; } catch (_x) {}
        throw new Error(m);
      }
      if (r && r.error) throw new Error(r.error);
      setMsg({ ok: r && r.alreadyCredited
        ? "That top-up was already applied — your balance is up to date."
        : `Added ${fmt$(topupCents)} to the wallet.` });
      setTopupSel(null); setTopupCustom("");
      await load();
    } catch (e) { setMsg({ err: e.message }); }
    setBusy(false);
  };

  const saveAutoTopup = async () => {
    setMsg(null); setBusy(true);
    try {
      const body = {
        action: "topup_settings",
        enabled: autoOn,
        thresholdCents: autoOn ? Math.round(Number(autoThreshold) * 100) : null,
        amountCents: autoOn ? Math.round(Number(autoAmount) * 100) : null,
      };
      const { data: r, error: e } = await sb.functions.invoke("portal-billing", { body });
      if (e) {
        let m = e.message;
        try { const ctx = await e.context.json(); if (ctx && ctx.error) m = ctx.error; } catch (_x) {}
        throw new Error(m);
      }
      if (r && r.error) throw new Error(r.error);
      setMsg({ ok: autoOn ? "Automatic top-ups are on." : "Automatic top-ups are off." });
      await load();
    } catch (e) { setMsg({ err: e.message }); }
    setBusy(false);
  };

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
      // Collect.js only ever settles us through `callback`, and it fires that ONLY on a
      // tokenization attempt — closing the lightbox (the ✕, Esc, click-away) fires nothing
      // in the config surface we use, which used to leave this promise pending forever:
      // `subscribe` awaited it, `busy` never cleared, and the Billing tab was dead until a
      // reload. There is no close/cancel hook to wire, so watch the DOM instead: the
      // lightbox arrives as injected iframe(s); once one has been visible and none is any
      // more — with no token — the customer closed it. Two consecutive misses (3s apart)
      // before rejecting, so a re-layout blip can't fire a false abandon while the card
      // form is still up; a 5-minute backstop covers a lightbox that hides rather than
      // removes itself, or that never appeared at all.
      let settled = false, poll = null, backstop = null;
      const settle = (fn, v) => { if (settled) return; settled = true; if (poll) clearInterval(poll); if (backstop) clearTimeout(backstop); fn(v); };
      // Snapshot BEFORE Collect.js runs, so whatever iframes it injects read as "added".
      const before = new Set(Array.from(document.querySelectorAll("iframe")));
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
          callback: (resp) => resp && resp.token ? settle(resolve, resp.token) : settle(reject, new Error("Card entry was cancelled.")),
        });
        window.CollectJS.startPaymentRequest();
      } catch (e) { return settle(reject, e); }
      let seen = false, gone = 0;
      poll = setInterval(() => {
        const visible = Array.from(document.querySelectorAll("iframe")).some((el) =>
          !before.has(el) && el.isConnected && (el.offsetWidth > 0 || el.offsetHeight > 0));
        if (visible) { seen = true; gone = 0; return; }
        // Soft wording on purpose: abandoning card entry is a normal choice, not a fault.
        if (seen && ++gone >= 2) settle(reject, new Error("Card entry was closed — nothing was charged. Press the button again whenever you're ready."));
      }, 3000);
      backstop = setTimeout(() => settle(reject, new Error("Card entry timed out — nothing was charged. Press the button again whenever you're ready.")), 5 * 60 * 1000);
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
    if (comped || f.availability !== "available" || liveFeatures[f.feature] || busy) return;
    if (memberCovered(f.feature)) return;                      // covered by the Suite — not separately selectable
    // Only block REMOVING the required base (it's in `sel` and the click would delete it);
    // re-adding must always work. Blocking both directions stranded the cart: selecting the
    // Suite deletes Simple Layout from `sel`, deselecting the Suite then left NEITHER in the
    // cart, and this guard refused the click that would put the base back — checkout dead
    // until a reload re-ran the [data] preselect (the server 400s a cart without the base).
    if (f.required && !baseLive && !sel["full_suite"] && sel[f.feature]) return; // Simple Layout stays unless the Suite covers it
    setSel((p) => {
      const n = { ...p };
      if (n[f.feature]) {
        delete n[f.feature];
        // Deselecting the Suite re-seeds the required base — the [data] preselect effect
        // only re-runs on a reload, so without this the cart strands with neither.
        if (f.feature === "full_suite" && !baseLive && !liveFeatures["full_suite"] && byFeature["simple_layout"]) n.simple_layout = "annual";
      }
      else {
        n[f.feature] = "annual";
        if (f.feature === "full_suite") SUITE_MEMBERS.forEach((m) => delete n[m]); // the Suite replaces the à-la-carte pieces
      }
      return n;
    });
  };
  const setInterval_ = (f, iv) => {
    if (comped || f.availability !== "available" || liveFeatures[f.feature] || busy || memberCovered(f.feature)) return;
    // The only way a tile ever reaches monthly — every default (preselect, toggle-on, the Suite
    // deselect re-seed) already writes "annual" — so refusing it here keeps monthly out of the cart.
    if (FOUNDING_ANNUAL_ONLY && iv === "monthly") return;
    setSel((p) => ({ ...p, [f.feature]: iv }));
  };

  const subscribe = async () => {
    // Our own account shows the prospect view but must never buy (see demoView). First line, so
    // it stops the view-as confirm, the Collect.js lightbox and the request alike.
    if (demoView) { setDemoNote(true); return; }
    const planIds = cartPlans.map((p) => p.id);
    if (planIds.length === 0) { setMsg({ err: "Select at least one feature." }); return; }
    setMsg(null); setHoldSignal(false); setBusy(true);
    try {
      // EVERY caller echoes the exact amount shown, and the server refuses a mismatch —
      // so the card can only ever be charged the number that was on screen. dueTodayCents
      // is already cents (the old operator path sent setupTotal * 100, cents times a
      // hundred; never bit only because every setup fee is $0).
      const body = { action: "subscribe", planIds, confirmChargeCents: dueTodayCents };
      if (viewingLabel) {
        // Real money against THEIR card: confirm with the client named and the amount out loud.
        // A fully-credited upgrade charges nothing, and the dialog has to say THAT rather
        // than "charge $0 today", which reads like a bug about to bill someone.
        const what = dueTodayCents === 0 && creditCents > 0
          ? `charge nothing today (${fmt$(creditCents)} credit covers it)`
          : `charge ${fmt$(dueTodayCents)} today`;
        if (!window.confirm(`Subscribe ${viewingLabel} to ${planIds.length} feature(s) and ${what}?

This bills the card ${viewingLabel} has on file.`)) { setBusy(false); return; }
      } else if (!data.hasCard) {
        // The card is still required when nothing is due — it is what the RENEWAL bills.
        // Passing null rather than 0 keeps Collect.js from putting "$0.00" on its pay
        // button, which invites "then why do you want my card?".
        body.paymentToken = await getPaymentToken(dueTodayCents || null);
      }
      const { data: r, error: e } = await sb.functions.invoke("portal-billing", { body });
      // Whatever the answer, the server may have started something (a partial success comes back
      // as `failed` beside the ones that went through), so the shell re-reads the entitlement now
      // rather than at the next reload: 3D bought here is on in the designer without one.
      // EXCEPT on the paywall: there, a re-read that unlocks the portal unmounts this view and the
      // message with it, and a partial failure's message can say "do NOT try again" or carry a
      // charge reference. So anything short of a clean success waits for the Continue button.
      const clean = !e && r && !r.error && !(r.failed && r.failed.length);
      if (paywall && !clean) setHoldSignal(true); else ssEntitlementChanged();
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
      // Usually nothing visible moves (a cancelled feature runs to the end of the paid period),
      // but the shell's copy of the entitlement must not be the one place that is out of date.
      ssEntitlementChanged();
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

  // The whole tab sat behind this one early return — the founding-price banner, the wallet
  // card and every plan card withheld until portal-billing's `status` landed. That read is
  // the only leg here and all of it is used (plans, subscriptions, wallet, discount), so
  // there is no fast/slow split to exploit and nothing to defer; what there IS to fix is
  // the empty card. Same early return, in the tab's real shape: banner strip, wallet card,
  // then the plan grid at the same `minmax(230px, 1fr)` the real one uses, so nothing jumps
  // when the answer arrives.
  if (data === null) return (
    <div>
      <SkelBar w="100%" h={62} style={{ borderRadius: 10, marginBottom: 14 }} />
      <div style={S.card}>
        <SkelBar w={110} h={15} style={{ marginBottom: 14 }} />
        <div style={{ display: "flex", gap: 26, flexWrap: "wrap", marginBottom: 14 }}>
          {[0, 1].map((i) => <div key={i} style={{ minWidth: 120 }}><SkelBar w="60%" h={9} style={{ marginBottom: 5 }} /><SkelBar w="80%" h={16} /></div>)}
        </div>
        <SkelBar w="70%" h={12} />
      </div>
      <div style={S.card}>
        <SkelBar w={180} h={15} style={{ marginBottom: 14 }} />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 12 }}>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} style={{ border: "1px solid #E2E8F0", borderRadius: 10, padding: 16 }}>
              <SkelBar w="65%" h={13} style={{ marginBottom: 10 }} />
              <SkelBar w={120} h={22} style={{ borderRadius: 20, marginBottom: 10 }} />
              <SkelBar w="45%" h={19} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  return (
    <div>
      {error && <div style={S.err}>{error}</div>}
      {/* While held, the server's sentence keeps a box of its own with Continue under it, so the
          button is never read as part of it; otherwise the box is the bare sentence, as always. */}
      {msg && msg.err && (
        <div style={S.err}>
          {holdSignal ? (<>
            <div>{msg.err}</div>
            <button type="button" onClick={() => { setHoldSignal(false); ssEntitlementChanged(); }}
              style={{ ...S.btn("#1D4ED8", "#FFF"), marginTop: 8, padding: "4px 10px", fontSize: 12 }}>
              Continue
            </button>
          </>) : msg.err}
        </div>
      )}
      {msg && msg.ok && <div style={S.okMsg}>{msg.ok}</div>}

      {showSub && (<>
      {/* COMPED ACCOUNT. Replaces the scarcity pitch rather than sitting beside it — an
          account that pays nothing has no rate to lock in, and "only the first 15 builders"
          over a price list they cannot buy from reads as a bug. */}
      {comped && (
        <div style={{ background: "#F0FDF4", border: "1px solid #BBF7D0", borderRadius: 10, padding: "12px 16px", marginBottom: 14, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span style={{ fontSize: 20, lineHeight: 1 }}>✓</span>
          <div>
            <div style={{ fontSize: 14.5, fontWeight: 800, color: "#166534", letterSpacing: "-0.01em" }}>Your account is comped</div>
            <div style={{ fontSize: 12.5, color: "#15803D", marginTop: 1 }}>
              Every feature is switched on for you by Structure Studio, and there's nothing to pay. The prices below are for reference only.
            </div>
          </div>
        </div>
      )}
      {/* Founding-price banner — scarcity marker above all the pricing. */}
      {!comped && (
      <div style={{ background: "linear-gradient(90deg, #3D3672 0%, #1B7895 100%)", color: "#FFF", borderRadius: 10, padding: "12px 16px", marginBottom: 14, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span style={{ fontSize: 20, lineHeight: 1 }}>⭐</span>
        <div>
          <div style={{ fontSize: 14.5, fontWeight: 800, letterSpacing: "-0.01em" }}>Founding Price</div>
          <div style={{ fontSize: 12.5, color: "#DCE7F0", marginTop: 1 }}>Only for the first 15 builders — lock in this rate on the features you select while founding pricing is open.</div>
        </div>
      </div>
      )}

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

      </>)}
      {showWallet && (<>
      {/* WALLET — prepaid credit for metered usage. Carolyn, 2026-08-24: "like GHL has a
          wallet on there ... put it in the billing, in the billing portion. A wallet for
          usage cases."

          Sits ABOVE "Your subscription" on purpose: once 3D is live this is what a builder
          opens the tab to check weekly, while the subscription summary is a monthly glance.
          It is also the shape she pointed at in Framed-UP — balance, what's left, what it
          costs — translated from a monthly quota to prepaid money.

          Renders even at a zero balance, and even before Deposyt is connected. That is the
          whole point: a real balance really does drop when a generation runs, which is what
          makes the September demo honest without a merchant account attached. */}
      {data && data.wallet && (() => {
        const w = data.wallet;
        const avail = (w.balanceCents || 0) - (w.heldCents || 0);
        // EVERY meter the server sends, in its own sort order. This used to look up
        // video_3d_generation by name and ignore the rest, so the texting meters — live and
        // priced — never appeared, and the card said "nothing is metered" while they were
        // drawing on this balance. The server already sends only ACTIVE meters and authors
        // their labels, so the card renders the list and maps no `kind` to English itself.
        // A meter whose price is redacted (`visible` off) arrives with priceCents null: it is
        // listed by name and no figure is invented for it.
        const meters = (w.meters || []).filter((m) => m && m.kind);
        const priced = meters.filter((m) => typeof m.priceCents === "number" && m.priceCents > 0);
        const cheapest = priced.length ? Math.min(...priced.map((m) => m.priceCents)) : 0;
        // A balance CAN go below zero: some usage posts after the fact rather than holding its
        // price first, because refusing it would block a document a customer is waiting on.
        // This card used to clamp that to $0.00, which told a builder whose next text or 3D
        // generation was about to be refused that they simply had nothing in the wallet.
        const signed$ = (c) => (c < 0 ? "−" + fmt$(-c) : fmt$(c));
        // Green when the cheapest priced use is covered, amber below it, red at nothing, and
        // red with its own word below zero. The same read as SUB_BADGE, so the tab has one
        // visual language. No priced meter at all reads as Ready, as it always did.
        const tone = w.exempt ? { bg: "#ECFDF5", bd: "#A7F3D0", fg: "#065F46", t: "Non-billable" }
          : avail < 0 ? { bg: "#FEF2F2", bd: "#FECACA", fg: "#991B1B", t: "Below zero" }
          : cheapest === 0 || avail >= cheapest ? { bg: "#ECFDF5", bd: "#A7F3D0", fg: "#065F46", t: "Ready" }
          : avail > 0 ? { bg: "#FFFBEB", bd: "#FDE68A", fg: "#92400E", t: "Low balance" }
          : { bg: "#FEF2F2", bd: "#FECACA", fg: "#991B1B", t: "Empty" };
        const stat = (label, value, color = "#1E293B") => (
          <div style={{ minWidth: 120 }}>
            <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: 0.5, textTransform: "uppercase", color: "#94A3B8" }}>{label}</div>
            <div style={{ fontSize: 16, fontWeight: 800, color, marginTop: 3 }}>{value}</div>
          </div>
        );
        return (
          <div style={S.card}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
              <div style={{ ...S.h2, marginBottom: 0 }}>Wallet</div>
              <span style={{ background: tone.bg, border: `1px solid ${tone.bd}`, color: tone.fg, borderRadius: 999, padding: "2px 10px", fontSize: 11, fontWeight: 800 }}>{tone.t}</span>
            </div>
            <div style={{ display: "flex", gap: 26, flexWrap: "wrap", marginBottom: 14 }}>
              {stat("Balance", signed$(avail), avail < 0 ? "#991B1B" : "#1E293B")}
              {(w.heldCents || 0) > 0 && stat("Reserved", fmt$(w.heldCents))}
            </div>
            {!w.exempt && avail < 0 && (
              <div style={{ background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 8, padding: "9px 13px", color: "#991B1B", fontSize: 12.5, fontWeight: 600, marginBottom: 12, lineHeight: 1.5 }}>
                Your wallet is {fmt$(-avail)} below zero. Add funds to bring it back up — anything that takes its
                price from the wallet up front is declined until your balance covers it.
              </div>
            )}
            {meters.length > 0 ? (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.5, textTransform: "uppercase", color: "#94A3B8", marginBottom: 6 }}>What draws on it</div>
                {meters.map((m) => {
                  const hasPrice = typeof m.priceCents === "number";
                  // How many the balance pays for — the "what's left" half of the Framed-UP shape,
                  // for every priced meter rather than only 3D. Not shown on a non-billable
                  // wallet, where nothing is charged and the count would mean nothing.
                  const covers = !w.exempt && hasPrice && m.priceCents > 0 ? Math.floor(Math.max(0, avail) / m.priceCents) : null;
                  return (
                    <div key={m.kind} style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", padding: "5px 0", borderTop: "1px solid #F1F5F9", fontSize: 13 }}>
                      <span style={{ color: "#334155", fontWeight: 600 }}>{m.label || m.kind}</span>
                      {/* Calls and texts (259) cost Twilio's real price times the markup, so
                          there is no fixed figure to print: the server sends the sentence
                          instead ("Billed per call minute") and a null price. */}
                      {m.billedAs ? (
                        <span style={{ color: "#475569", whiteSpace: "nowrap" }}>{m.billedAs}</span>
                      ) : hasPrice && (
                        <span style={{ color: "#475569", whiteSpace: "nowrap" }}>
                          {m.priceCents === 0 ? "No charge" : <><strong>{fmt$(m.priceCents)}</strong>{m.unitLabel ? ` / ${m.unitLabel}` : ""}</>}
                          {covers !== null && <span style={{ color: "#94A3B8" }}> · balance covers {covers}</span>}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p style={{ fontSize: 13, color: "#64748B", marginTop: 0 }}>
                Nothing is metered on your account yet. Anything that switches on later draws from here.
              </p>
            )}
            {/* ADD FUNDS — real since migration 164. The note that used to sit here read
                "not switched on yet ... contact CSM Synergy"; this is the AFTER Carolyn meant
                on 2026-08-24. An unconfigured deployment still gets that sentence, because
                the server would refuse the charge anyway (portal-billing's `configured` 503). */}
            {!data.configured ? (
              <div style={{ background: "#EEF2FF", border: "1px solid #C7D2FE", borderRadius: 8, padding: "10px 14px", color: "#3D3672", fontSize: 13, fontWeight: 600 }}>
                Adding funds online isn't switched on yet — contact CSM Synergy to top up your wallet.
              </div>
            ) : (
              <div>
                <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.5, textTransform: "uppercase", color: "#94A3B8", marginBottom: 8 }}>Add funds</div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  {TOPUP_PRESETS.map((c) => (
                    <button key={c} type="button" onClick={() => { setTopupSel(c); setTopupCustom(""); }}
                      style={{
                        background: topupCents === c ? ACCENT : "#FFF",
                        color: topupCents === c ? "#FFF" : "#334155",
                        border: "1px solid " + (topupCents === c ? ACCENT : "#E2E8F0"),
                        borderRadius: 8, padding: "7px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
                      }}>{fmt$(c)}</button>
                  ))}
                  {/* Custom amount, typed in DOLLARS because that is what a person means by
                      "250". Asking for cents is how someone sends $2.50 meaning $250. */}
                  <div style={{ display: "inline-flex", alignItems: "center", border: "1px solid " + (topupCustom ? ACCENT : "#E2E8F0"), borderRadius: 8, padding: "0 10px" }}>
                    <span style={{ fontSize: 13, color: "#64748B", fontWeight: 700 }}>$</span>
                    <input type="number" inputMode="decimal" min={minTopup / 100} max={maxTopup / 100} placeholder="Other"
                      value={topupCustom} onChange={(e) => { setTopupCustom(e.target.value); setTopupSel(null); }}
                      style={{ border: "none", outline: "none", padding: "7px 4px", fontSize: 13, fontWeight: 700, width: 82, fontFamily: "inherit", color: "#1E293B", background: "transparent" }} />
                  </div>
                  <button type="button" onClick={addFunds} disabled={busy || !topupValid}
                    style={{ ...S.btn(ACCENT, "#FFF"), padding: "8px 16px", opacity: busy || !topupValid ? 0.5 : 1, cursor: busy || !topupValid ? "default" : "pointer" }}>
                    {busy ? "Working…" : (topupCents ? "Add " + fmt$(topupCents) : "Add funds")}
                  </button>
                </div>
                {/* Only complain once something has actually been typed — an empty field is
                    the starting state, not a mistake. */}
                {topupCustom && !topupValid && (
                  <div style={{ fontSize: 12, color: "#B45309", marginTop: 6 }}>
                    Enter an amount between {fmt$(minTopup)} and {fmt$(maxTopup)}.
                  </div>
                )}
                <div style={{ fontSize: 11.5, color: "#94A3B8", marginTop: 6 }}>
                  {data.hasCard
                    ? "Charged to the card on file. Funds are added straight away."
                    : "You'll enter your card in a secure form served by the payment gateway — it never passes through StructureStudio."}
                </div>

                {/* AUTO-RECHARGE. Requires a vaulted card: enabling it without one arms
                    something that can only fail, and its first failure would report a
                    declined card that never existed. */}
                <div style={{ marginTop: 14, borderTop: "1px solid #F1F5F9", paddingTop: 12 }}>
                  {w.autoTopup && w.autoTopup.disabledReason && (
                    <div style={{ background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 8, padding: "8px 12px", color: "#92400E", fontSize: 12.5, fontWeight: 600, marginBottom: 10 }}>
                      Automatic top-ups were switched off — {w.autoTopup.disabledReason} Update the card, then switch them back on.
                    </div>
                  )}
                  {!data.hasCard ? (
                    <div style={{ fontSize: 12, color: "#94A3B8" }}>
                      Add funds once and your card is kept on file — then you can turn on automatic top-ups.
                    </div>
                  ) : (
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", fontSize: 13, color: "#334155" }}>
                      <label style={{ display: "inline-flex", alignItems: "center", gap: 7, fontWeight: 700, cursor: "pointer" }}>
                        <input type="checkbox" checked={autoOn} onChange={(e) => setAutoOn(e.target.checked)} />
                        Top up automatically
                      </label>
                      {autoOn && (<>
                        <span style={{ color: "#64748B" }}>when my balance drops below</span>
                        <span style={{ display: "inline-flex", alignItems: "center", border: "1px solid #E2E8F0", borderRadius: 8, padding: "0 8px" }}>
                          <span style={{ fontSize: 12.5, color: "#64748B", fontWeight: 700 }}>$</span>
                          <input type="number" inputMode="decimal" value={autoThreshold} onChange={(e) => setAutoThreshold(e.target.value)}
                            style={{ border: "none", outline: "none", padding: "6px 4px", fontSize: 13, fontWeight: 700, width: 66, fontFamily: "inherit", color: "#1E293B", background: "transparent" }} />
                        </span>
                        <span style={{ color: "#64748B" }}>add</span>
                        <span style={{ display: "inline-flex", alignItems: "center", border: "1px solid #E2E8F0", borderRadius: 8, padding: "0 8px" }}>
                          <span style={{ fontSize: 12.5, color: "#64748B", fontWeight: 700 }}>$</span>
                          <input type="number" inputMode="decimal" value={autoAmount} onChange={(e) => setAutoAmount(e.target.value)}
                            style={{ border: "none", outline: "none", padding: "6px 4px", fontSize: 13, fontWeight: 700, width: 66, fontFamily: "inherit", color: "#1E293B", background: "transparent" }} />
                        </span>
                      </>)}
                      <button type="button" onClick={saveAutoTopup} disabled={busy}
                        style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0", padding: "6px 14px", fontSize: 12.5, opacity: busy ? 0.6 : 1 }}>
                        Save
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}
            {/* The ten-line "Recent activity" list that sat here moved into Transactions below
                (2026-10-02): it printed whole cents, so a $0.028 call read "−$0.00". status
                still sends it, and Transactions falls back to it if its own list can't load. */}
          </div>
        );
      })()}
      {/* TRANSACTIONS — the whole ledger, GHL-style. Mounted only where the wallet card is, so
          it inherits the same audience (status's `mine` filter: owners, granted admins,
          operators with can_bill). Reloads whenever `status` does, so a top-up shows at once. */}
      {data && data.wallet && <WalletTransactions reloadKey={data} recent={data.wallet.transactions || []} />}

      </>)}
      {showSub && (<>
      {/* At-a-glance subscription summary — total spend, status, and next renewal, above the
          per-feature detail. Derived from the same live subscriptions; no extra backend call. */}
      {data && liveSubs.length > 0 && (() => {
        const moSum = liveSubs.filter((s) => (planById[s.plan_id] || {}).billing_interval !== "annual").reduce((a, s) => a + (s.price_cents || 0), 0);
        const yrSum = liveSubs.filter((s) => (planById[s.plan_id] || {}).billing_interval === "annual").reduce((a, s) => a + (s.price_cents || 0), 0);
        // paid_through (portal-billing, rolled forward past each renewal) before the stored
        // current_period_end, which stays on the FIRST renewal date for good; the fallback is
        // only for an older portal-billing that does not send it.
        const nextRenew = liveSubs.map((s) => s.paid_through || s.current_period_end).filter(Boolean).sort()[0] || null;
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
                    started {fmtDate(s.current_period_start)}{(s.paid_through || s.current_period_end) ? ` · renews ${fmtDate(s.paid_through || s.current_period_end)}` : ""}
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
            {FOUNDING_ANNUAL_ONLY
              ? "Founding members pay yearly — 10× the monthly rate, so 2 months free. Cancel any feature anytime."
              : "Pick monthly or yearly for each feature — yearly is 10× monthly (2 months free). Cancel any feature anytime."}
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 12 }}>
            {features.filter((f) => !liveFeatures[f.feature]).map((f) => {
              const soon = f.availability !== "available";
              const covered = memberCovered(f.feature);
              // A comped account is veiled the same way a Suite member is: every tile carries
              // the overlay, nothing is clickable, and the price stays legible underneath. The
              // existing mechanic already does exactly that, so this is one more reason to
              // veil rather than a second, parallel way of dimming a card.
              const veiled = soon || covered || comped;   // shows an overlay + dims + blocks interaction
              const iv = sel[f.feature];
              const on = !!iv;
              const shown = f.plans[iv || "annual"];
              const lockedBase = f.required && !baseLive;
              return (
                <div key={f.feature} onClick={(covered || comped) ? undefined : () => toggleFeature(f)}
                  style={{ position: "relative", border: on ? `2px solid ${ACCENT}` : "1px solid #E2E8F0", borderRadius: 10, padding: on ? 15 : 16, cursor: veiled ? "default" : "pointer", overflow: "hidden" }}>
                  {veiled && (
                    <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2, pointerEvents: "none" }}>
                      <span style={{ transform: "rotate(-12deg)", background: comped ? "#DCFCE7" : covered ? "#EDE9FE" : "#FEF3C7", color: comped ? "#166534" : covered ? "#5B21B6" : "#B45309", border: `1px solid ${comped ? "#BBF7D0" : covered ? "#C4B5FD" : "#FDE68A"}`, borderRadius: 8, padding: "6px 16px", fontSize: 13, fontWeight: 800, letterSpacing: 1.5, textTransform: "uppercase", whiteSpace: "nowrap" }}>{comped ? "Included" : covered ? "Included in the Suite" : (f.feature === "self_serve_displays" ? "Coming 2027" : "Coming soon")}</span>
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
                        {["monthly", "annual"].map((k) => {
                          // Monthly stays on the tile while founding pricing is yearly-only, but
                          // does nothing (setInterval_ refuses it). aria-disabled, not `disabled`:
                          // a disabled button gets no hover events, so the title would never show.
                          const shut = FOUNDING_ANNUAL_ONLY && k === "monthly";
                          return (
                            <button key={k} type="button" onClick={() => setInterval_(f, k)} data-plan-interval={k}
                              aria-disabled={shut ? "true" : undefined}
                              title={shut ? "Annual billing only during founding pricing" : undefined}
                              style={{ background: (iv || "annual") === k ? ACCENT : "transparent", color: (iv || "annual") === k ? "#FFF" : "#64748B", border: "none", padding: "4px 12px", fontSize: 11, fontWeight: 700, cursor: shut ? "not-allowed" : "pointer", opacity: shut ? 0.45 : 1 }}>
                              {k === "annual" ? "Yearly" : "Monthly"}
                            </button>
                          );
                        })}
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
                {/* The credit for prepaid time on the features this upgrade replaces. Named
                    plan by plan: "a credit" is a number to be argued with, "your 3D View
                    through 27 Aug 2027" is an explanation. */}
                {creditCents > 0 && (
                  <div style={{ marginTop: 6, background: "#F0FDF4", border: "1px solid #BBF7D0", borderRadius: 8, padding: "8px 12px" }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#15803D" }}>
                      Credit for what you've already paid: −{fmt$(creditCents)}
                    </div>
                    <div style={{ fontSize: 11.5, color: "#3F6212", marginTop: 2 }}>
                      The unused part of {creditSources.map((x) => x.name).join(", ") || "your current features"} — they're
                      replaced by this plan and cancelled, so you're not charged twice for the same months.
                    </div>
                  </div>
                )}
                <div style={{ marginTop: 4, fontSize: 14.5, color: "#1E293B" }}>
                  {/* A fully-credited upgrade charges NOTHING today. Saying "$0.00" reads as
                      a broken cart; saying so in words reads as the deliberate outcome it is. */}
                  {dueTodayCents === 0 && creditCents > 0 ? (<>
                    Due today: <b style={{ color: "#3D3672" }}>Nothing</b>
                    <span style={{ fontSize: 12, color: "#64748B" }}> — your credit covers this period in full. Renews automatically after it runs out.</span>
                  </>) : (<>
                    Due today: <b style={{ color: "#3D3672" }}>{fmt$(dueTodayCents)}</b>
                    <span style={{ fontSize: 12, color: "#64748B" }}> — first {yrTotal > 0 && moTotal > 0 ? "period" : yrTotal > 0 ? "year" : "month"}{setupTotal > 0 ? " + setup" : ""}. Renews automatically.</span>
                  </>)}
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
                <>
                <button type="button" onClick={subscribe} disabled={busy || cart.length === 0}
                  style={{ ...S.btn(ACCENT, "#FFF"), marginTop: 12, opacity: busy || cart.length === 0 ? 0.6 : 1 }}>
                  {/* Our own account reads as a brand-new builder: no card on file, nobody viewing-as. */}
                  {busy ? "Working…" : demoView ? "Continue to secure card entry" : (viewingLabel ? `Subscribe ${viewingLabel} with card on file` : (data.hasCard ? "Subscribe with card on file" : "Continue to secure card entry"))}
                </button>
                {demoView && demoNote && (
                  <p style={{ fontSize: 12.5, color: "#1E3A8A", background: "#EFF6FF", border: "1px solid #BFDBFE", borderRadius: 8, padding: "8px 12px", marginTop: 10, fontWeight: 600 }}>
                    Demo account. Checkout is off on Structure Studio's own account, so nothing was charged.
                  </p>
                )}
                </>
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
          with an outbound link rather than a purchasable billing_plans feature.
          
          TEAL, NOT PURPLE, and that is the point (Carolyn 2026-08-29). Since Built-in CRM went
          on sale there are two cards on this tab with "CRM" in the name, and they are not
          alternatives: one is a feature of Structure Studio bought right here, the other is a
          separate per-user product bought somewhere else. Purple is the buy-here colour — it is
          on every plan tile, the Suite, the toggles and the Subscribe button — so wearing it made
          this card look like a fourth plan in the same list. The brand's teal (already half of
          the header gradient) says "related, but not the same thing" without a word of
          explanation, and the left edge carries it so the difference survives a glance. */}
      <div style={{ ...S.card, borderLeft: `4px solid ${SYNERGY_TEAL}` }}>
        <div style={{ ...S.h2, color: SYNERGY_TEAL }}>Synergy CRM</div>
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
                      style={{ background: iv === k ? SYNERGY_TEAL : "transparent", color: iv === k ? "#FFF" : "#64748B", border: "none", padding: "4px 12px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                      {k === "annual" ? "Yearly" : "Monthly"}
                    </button>
                  ))}
                </div>
                <div style={{ fontSize: 19, fontWeight: 800, color: SYNERGY_TEAL }}>{fmt$(cents)}{iv === "annual" ? "/yr" : "/mo"}</div>
              </div>
            );
          })}
        </div>
        <a href="https://streamlinedconstructionsystem.com/saas-enrollment" target="_blank" rel="noopener noreferrer"
          style={{ ...S.btn(SYNERGY_TEAL, "#FFF"), display: "inline-block", textDecoration: "none" }}>
          Sign up for Synergy CRM →
        </a>
      </div>
      </>)}
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
  const [editCode, setEditCode] = useState("");
  const [editImg, setEditImg] = useState(null);              // { base64, contentType } | null
  const [editFileKey, setEditFileKey] = useState(0);
  const [dragIdx, setDragIdx] = useState(null);              // index of the style row being dragged

  const load = async () => {
    // Shares the same-tick catalog flight with RealTimePricing, which Settings → Structures mounts
    // beside this card (window.__ssCatalogFlight below). Key = the tenant the call will hit.
    const body = { action: "catalog" };
    const { data, error } = await window.__ssCatalogFlight(
      () => sb.functions.invoke("portal-settings", { body }),
      String(body.targetClientId == null ? (ssTargetClientId || "") : body.targetClientId));
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
    // Nor a partition wall (migration 278): it is the customer's own layout inside the building, never
    // part of a size's price, so it has no column (submit-estimate ignores such a row too).
    const layout = items().filter((it) => !it.archived && it.key !== "ramp" && it.key !== "partitionWall").map((it) => ({ key: it.key, label: it.label }));
    const fx = ((cat && cat.fixtures) || []).filter((f) => f && f.active !== false && f.archived !== true);
    // Plain ASCII "x" (not "×") — a CSV opened in Excel misreads non-ASCII as mojibake ("Ã—"), and
    // since the column is matched by its exact label on re-import, a garbled header would silently
    // drop the inclusion. ASCII round-trips safely through any spreadsheet.
    const col = (f) => ({ key: String(f.id), label: `${f.name || "Item"}${f.width_in && f.height_in ? ` (${fmtFtIn(f.width_in)}x${fmtFtIn(f.height_in)})` : ""}` });
    const inCat = (f, c) => (f.category || "door") === c; // a missing category reads as "door" (matches DoorsView)
    const byCat = (c) => fx.filter((f) => inCat(f, c)).map(col);
    const KNOWN_CATS = ["door", "ramp", "window", "vent"];
    const other = fx.filter((f) => !KNOWN_CATS.includes(f.category || "door")).map(col);
    // Section order follows the Options tab's own Exterior grouping (Doors · Windows ·
    // Vents · Ramps) so the sheet reads the way the screen does. "Other" still catches any
    // category added later without a section here — a new fixture kind must never fall out
    // of the export silently, which is what a bare `byCat` list per known name would do.
    return [
      { name: "Built-in options", argb: "FFDBEAFF", cols: layout },
      { name: "Doors",            argb: "FFFEE9C7", cols: byCat("door") },
      { name: "Windows",          argb: "FFDCF1FB", cols: byCat("window") },
      { name: "Vents",            argb: "FFEAF3E6", cols: byCat("vent") },
      { name: "Ramps",            argb: "FFE7E5E4", cols: byCat("ramp") },
      { name: "Other",            argb: "FFF1F5F9", cols: other },
    ].filter((s) => s.cols.length);
  };
  const optionCols = () => optionSections().flatMap((s) => s.cols);

  const ALLOWED_IMG = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  const onStyleImg = async (file) => {
    if (!file) { setStyleImg(null); return; }
    if (!ALLOWED_IMG.includes(file.type)) { setMsg({ err: "Use a JPG, PNG, WEBP or GIF image." }); setStyleFileKey((k) => k + 1); return; }
    // A photo straight off a phone is 4-12MB, so "too large" was refusing the normal case and
    // asking a builder to go find image-editing software before they could add a style. Shrink it
    // instead — ssFitImageForUpload (06-3d.jsx) is the same helper the fixture and colour uploads
    // have used since 2026-08: longest edge 1600px, flattened onto white, JPEG quality stepped
    // 0.9/0.8/0.7 until it fits, and the ORIGINAL handed back untouched if it is already small
    // enough. It re-encodes to image/jpeg, so file.type stays correct for the upload below.
    // The check that follows is no longer the common path: it only fires when the file could not
    // be decoded and re-encoded at all, which is a broken image rather than a big one.
    file = await ssFitImageForUpload(file);
    if (file.size > 3_000_000) { setMsg({ err: "That image couldn't be resized small enough — try a JPG or PNG." }); setStyleFileKey((k) => k + 1); return; }
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
  // Whether this style's BUILDING line carries sales tax (migration 148). On the style, not
  // the size — taxability is a property of the product, not of how big it is.
  const toggleStyleTaxable = async (s) => {
    setStyleBusy(true); setMsg(null);
    try {
      const { data, error } = await sb.functions.invoke("portal-settings", { body: { action: "set_style_taxable", styleId: s.id, taxable: s.taxable === false } });
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
  const openEdit = (s) => { setEditStyle(s); setEditName(s.label || ""); setEditCode(s.code || ""); setEditImg(null); setEditFileKey((k) => k + 1); };
  const onEditImg = async (file) => {
    if (!file) { setEditImg(null); return; }
    if (!ALLOWED_IMG.includes(file.type)) { setMsg({ err: "Use a JPG, PNG, WEBP or GIF image." }); setEditFileKey((k) => k + 1); return; }
    // Shrink oversized photos rather than refusing them — see onStyleImg for why.
    file = await ssFitImageForUpload(file);
    if (file.size > 3_000_000) { setMsg({ err: "That image couldn't be resized small enough — try a JPG or PNG." }); setEditFileKey((k) => k + 1); return; }
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
      const body = { action: "update_style", styleId: s.id, label: editName.trim(), code: editCode.trim() };
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
      // The style column is the same story, and it moves PRICES. The server resolves each
      // cell against every style's label OR key — hidden styles included, last writer wins —
      // and nothing makes a label unique: create_style only uniquifies the derived key, and
      // update_style doesn't check at all. So hide "Barn", add a fresh "Barn", and a whole
      // sheet of new prices can be written onto the hidden one while the banner reports them
      // imported; the live style keeps quoting last year's numbers. A name only ONE style
      // answers to resolves to that style deterministically — refuse the rest by name, since
      // the sheet carries nothing else that could say which "Barn" the builder meant.
      {
        const claims = new Map();   // lowercased label/key -> ids of the styles answering to it
        allStyles().forEach((s) => [s.label, s.key].forEach((tok) => {
          const t = String(tok == null ? "" : tok).trim().toLowerCase();
          if (!t) return;
          const ids = claims.get(t) || [];
          if (!ids.includes(s.id)) ids.push(s.id);   // a style's own label and key are one claim
          claims.set(t, ids);
        }));
        const dupStyles = [...new Set(matrix.slice(1)
          .map((cols) => String(cols[iStyle] == null ? "" : cols[iStyle]).trim())
          .filter((n) => n && (claims.get(n.toLowerCase()) || []).length > 1))];
        if (dupStyles.length) throw new Error(`Import stopped — more than one building style answers to: ${dupStyles.join(", ")}. A hidden style counts, and its prices are the ones that would be overwritten. Rename one of them in Building styles above, then upload again.`);
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
            <input value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="Building style name" style={{ ...S.input, marginBottom: 10 }} />
            {/* Serial code (163). Carolyn @57:20: "all of their buildings have codes. They
                come up with them. LBA. Okay. Stands for Lofted Barn." Optional -- a style
                with no code still sells, its serials just read XXX in this position rather
                than shifting every later segment left. */}
            <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "#475569", marginBottom: 4 }}>Serial code</label>
            <input value={editCode} maxLength={4}
              onChange={(e) => setEditCode(e.target.value.toUpperCase().slice(0, 4))}
              placeholder="e.g. LBA"
              style={{ ...S.input, marginBottom: 4, textTransform: "uppercase" }} />
            <p style={{ fontSize: 11, color: "#94A3B8", marginTop: 0, marginBottom: 14, lineHeight: 1.5 }}>
              Your short code for this building style. It becomes the second block of every serial number this style produces &mdash; the <b>LBA</b> in <code>0826<b>LBA</b>1016REBLDWS5000</code>.
            </p>
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
        {/* Grey blocks in the row's own shape rather than the word "Loading" (see SkelBar in
            01-core). This tab is NOT a blank screen — the headings, the sequencing banner and
            all the explanatory copy paint immediately; it is the one data region that sat grey
            for a whole `catalog` round trip. SkelRows is <tr>-based and belongs only where a
            real table exists, and this is a flex list, so the blocks are composed into the same
            row: handle, photo, name, then the controls on the right. */}
        {!cat ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
            {[0, 1, 2].map((i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 10px", border: "1px solid #E2E8F0", borderRadius: 8, opacity: 1 - i * 0.18 }}>
                <SkelBar w={10} h={14} style={{ flexShrink: 0 }} />
                <SkelBar w={48} h={36} style={{ flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 80 }}><SkelBar w="45%" h={12} /></div>
                <SkelBar w={44} h={20} style={{ flexShrink: 0 }} />
                <SkelBar w={106} h={14} style={{ flexShrink: 0 }} />
                <SkelBar w={46} h={26} style={{ flexShrink: 0 }} /><SkelBar w={46} h={26} style={{ flexShrink: 0 }} /><SkelBar w={56} h={26} style={{ flexShrink: 0 }} />
              </div>
            ))}
          </div>
        ) : (
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
                    {/* loading="lazy": one image request per style, every one fired the instant
                        the list paints and competing with whatever the tab is still fetching. */}
                    {s.image_url
                      ? <img src={s.image_url} alt="" loading="lazy" style={thumb} />
                      : <div style={{ ...thumb, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>🏠</div>}
                    <div style={{ flex: 1, fontWeight: 600, fontSize: 14 }}>
                      {s.label}{!s.active && <span style={{ color: "#94A3B8", fontWeight: 400 }}> — hidden</span>}
                      {/* Shown on the row, not just inside Edit: the code is the thing a
                          builder cross-checks against their paper list, and opening six
                          dialogs to read six codes is the friction that stops them being set. */}
                      {s.code && <span title="Serial code for this style" style={{ marginLeft: 8, fontSize: 11, fontWeight: 800, letterSpacing: 0.4, color: "#475569", background: "#F1F5F9", border: "1px solid #E2E8F0", borderRadius: 5, padding: "2px 6px" }}>{s.code}</span>}
                    </div>
                    {/* Whether this style has a 3D look of its own yet. Read-only here —
                        setting one needs the live 3D preview, so it lives in
                        Settings → Designer → 3D. */}
                    <span title={s.d3 ? "This style has its own 3D look — tune it in Settings → Designer → 3D" : "No 3D look set yet: 3D falls back to a generic shape. Set one in Settings → Designer → 3D."}
                      style={{ flexShrink: 0, fontSize: 11, fontWeight: 800, borderRadius: 6, padding: "3px 7px", border: "1px solid " + (s.d3 ? "#A7F3D0" : "#E2E8F0"), background: s.d3 ? "#ECFDF5" : "#F8FAFC", color: s.d3 ? "#047857" : "#94A3B8" }}>
                      {s.d3 ? "3D ✓" : "3D —"}
                    </span>
                    <label title="Attach this style's photo to the CRM estimate" style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: "#475569", fontWeight: 600, cursor: styleBusy ? "default" : "pointer", flexShrink: 0 }}>
                      <input type="checkbox" checked={s.show_image_on_estimate !== false} disabled={styleBusy} onChange={() => toggleStyleImage(s)} style={{ width: 15, height: 15, cursor: "pointer" }} />
                      Image on estimate
                    </label>
                    <label title="Sales tax is charged on this style's building line. Untick and it sits under the non-taxable subtotal on quotes and invoices." style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: "#475569", fontWeight: 600, cursor: styleBusy ? "default" : "pointer", flexShrink: 0 }}>
                      <input type="checkbox" checked={s.taxable !== false} disabled={styleBusy} onChange={() => toggleStyleTaxable(s)} style={{ width: 15, height: 15, cursor: "pointer" }} />
                      Taxable
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
        {/* This gate gives way to a two-button row (download template / upload sheet), so the
            skeleton is two button-sized blocks — nothing more. Claiming any more shape here
            would be inventing controls this card doesn't have. */}
        {!cat ? (
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <SkelBar w={186} h={30} /><SkelBar w={156} h={30} />
          </div>
        ) : activeStyles().length === 0 ? (
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

// ─── One catalog read on mount, not five ───
// Settings → Options mounts four components side by side (08-integrations.jsx:2127:
// LayoutPricing, DoorsView, RampsView, WindowsView) and FIVE of the things inside them —
// LayoutPricing, the door catalog, RampsView, WindowColorsEditor, the window catalog —
// each fire their OWN identical portal-settings {action:"catalog"} in the same mount tick.
// That action is one edge invocation doing sixteen table reads plus the wallet pair, all in one
// Promise.all (portal-settings, `if (action === "catalog")`), and returning the whole payload
// every time; four of the five callers keep a slice of it (one fixture category + colors,
// windowColors alone, rampSettings alone). Five identical copies contend on the same edge
// instance and the tab is only whole when the SLOWEST lands — so the wait was the tail of
// the distribution, not the mean.
//
// This coalesces those flights and does nothing else: same action, same arguments, same
// payload, same tenant scoping. Only how many copies go on the wire changes.
// Settings → Structures shares it too (2026-10-02): PricingCsv and RealTimePricing mount side by
// side and each read the catalog. The accepted trade, the same one the Options cards make: if that
// one invocation fails, both cards show the error instead of usually only one.
//
// ⚠️ IN-FLIGHT ONLY, AND ONLY WITHIN THE TICK THAT STARTED IT — a settled result is NEVER
// reused. Every mutation on this tab ends in `await load()` (LayoutPricing.toggleArchive,
// FixtureCatalog.quickSave, save_window_colors → WindowsView's refreshKey), and handing one
// of those a cached pre-mutation payload would change what the screen MEANS, not when it
// paints. Same-tick is what makes that airtight without hooking every mutation: React
// flushes all of a commit's mount effects in one synchronous pass, so the five share, while
// a post-mutation reload is always a later tick and always gets its own read. The reset is
// a microtask rather than a timer because background tabs throttle timers and would leave
// the flight joinable for up to a second.
//
// Hung off `window` rather than declared here on purpose: portal/01..09 are concatenated
// into ONE lexical scope, so a top-level binding in this file is a top-level binding for
// every other part too.
window.__ssCatalogFlight = window.__ssCatalogFlight || (function () {
  let key = null, flight = null;
  return function (invoke, k) {
    if (flight && key === k) return flight;
    key = k;
    flight = invoke();
    const mine = flight;
    const done = () => { if (flight === mine) { flight = null; key = null; } };
    Promise.resolve().then(done);
    flight.then(done, done);   // belt and braces if a caller ever reaches this off-tick
    return flight;
  };
})();

// ─── Real-Time Pricing (migration 152; Carolyn 2026-08-27, the 2015 Sterling Supply workbook) ───
// The material-cost pricing engine's settings block, rendered UNDER the pricing card in
// Settings → Structures. One material cost list; a bill of materials per style+size,
// grouped floor/walls/roof/interior; ordered overhead lines; the computed price lands in
// building_sizes.base_price when the tenant flips the Go Live toggle. ALL price math lives
// in SQL (rtp_compute_prices) — this component renders the server's numbers verbatim,
// because three hand-synchronized estimate calculators is already the repo's ceiling.
//
// Paid feature (on_demand_pricing, $85/mo, pay-only): `unlocked` gates the editor, the
// server re-checks on every action, and the not-entitled state is a compact teaser with a
// Billing deep link — the block doubles as the feature's shop window.
const RTP_SECTIONS = ["floor", "walls", "roof", "interior", "other"];
const RTP_KINDS = [
  { value: "multiplier", label: "Multiplier (×)" },
  { value: "percent_of_price", label: "% of price (allocation)" },
  { value: "flat", label: "Flat $" },
];
// Carolyn's own 2015 numbers, offered as the starting point when a tenant has no overhead
// lines yet: price = materials × 1.8 × 1.1, with Sales/Delivery/Build shown as carve-outs.
const RTP_CLASSIC_OVERHEAD = [
  { label: "Mark-up", kind: "multiplier", value: 1.8, active: true },
  { label: "Overhead", kind: "multiplier", value: 1.1, active: true },
  { label: "Sales", kind: "percent_of_price", value: 5, active: true },
  { label: "Delivery", kind: "percent_of_price", value: 10, active: true },
  { label: "Build", kind: "percent_of_price", value: 10, active: true },
];
const rtpNum = (v) => { const n = Number(String(v == null ? "" : v).replace(/[$,\s]/g, "")); return Number.isFinite(n) ? n : NaN; };
const rtpMoney = (v) => v == null ? "—" : "$" + Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Excel refuses sheet names over 31 chars or containing []:*?/\ — sanitize rather than throw.
const rtpSheetName = (label) => String(label || "Style").replace(/[[\]:*?/\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 31) || "Style";

function RealTimePricing({ viewingLabel = null, clientId = null, unlocked = false, canAdmin = false, onSeeBilling = null }) {
  const scoped = (body) => (viewingLabel && clientId ? { ...body, targetClientId: clientId } : body);
  const [data, setData] = useState(null);      // rtp_data payload; null = loading
  const [cat, setCat] = useState(null);        // shared catalog payload (styles + sizes)
  const [busy, setBusy] = useState(false);
  const [dlBusy, setDlBusy] = useState(false);
  const [msg, setMsg] = useState(null);        // { ok } | { err }
  const [result, setResult] = useState(null);  // import report
  const [fileKey, setFileKey] = useState(0);
  // Editable copies, re-seeded whenever the server payload lands (every save reloads).
  const [matRows, setMatRows] = useState([]);
  const [ovhRows, setOvhRows] = useState([]);
  const [bomStyleId, setBomStyleId] = useState("");
  const [bomSizeId, setBomSizeId] = useState("");
  const [bomRows, setBomRows] = useState([]);
  const [dlStyles, setDlStyles] = useState(null);   // Set of style ids for the template; null = all
  const [confirmToggle, setConfirmToggle] = useState(null);  // { to: boolean } | null

  const load = async () => {
    // The catalog flight is keyed like every sibling's (the tenant the call will hit), so it is
    // the SAME flight PricingCsv starts in this tick. It used "catalog|<id>", which never matched.
    const catBody = scoped({ action: "catalog" });
    const [rtpRes, catRes] = await Promise.all([
      sb.functions.invoke("portal-settings", { body: scoped({ action: "rtp_data" }) }),
      window.__ssCatalogFlight(
        () => sb.functions.invoke("portal-settings", { body: catBody }),
        String(catBody.targetClientId == null ? (ssTargetClientId || "") : catBody.targetClientId),
      ),
    ]);
    const rtpErr = rtpRes.error || (rtpRes.data && rtpRes.data.error);
    const catErr = catRes.error || (catRes.data && catRes.data.error);
    if (rtpErr || catErr) { setMsg({ err: String((rtpRes.error && rtpRes.error.message) || rtpErr || (catRes.error && catRes.error.message) || catErr) }); return; }
    setData(rtpRes.data); setCat(catRes.data);
    setMatRows(((rtpRes.data && rtpRes.data.materials) || []).map((m) => ({ id: m.id, category: m.category || "", name: m.name, unitCost: String(m.unit_cost), active: m.active !== false, dirty: false })));
    setOvhRows(((rtpRes.data && rtpRes.data.overhead) || []).map((o) => ({ label: o.label, kind: o.kind, value: String(o.value), active: o.active !== false })));
  };
  useEffect(() => { if (unlocked) load(); }, [unlocked]);

  const styles = () => ((cat && cat.styles) || []).filter((s) => s.active);
  const sizesFor = (styleId) => ((cat && cat.sizes) || []).filter((z) => z.style_id === styleId);
  const sizeById = (id) => ((cat && cat.sizes) || []).find((z) => z.id === id) || null;
  const styleById = (id) => ((cat && cat.styles) || []).find((s) => s.id === id) || null;
  const activeMats = () => matRows.filter((m) => m.active && m.id);
  const bomLinesFor = (sizeId) => ((data && data.bomLines) || []).filter((l) => l.size_id === sizeId);
  const previewFor = (sizeId) => ((data && data.preview) || []).find((p) => p.size_id === sizeId) || null;

  // Seed the BOM editor whenever the picked size (or fresh data) changes.
  useEffect(() => {
    if (!bomSizeId) { setBomRows([]); return; }
    const lines = bomLinesFor(bomSizeId).map((l) => ({ materialId: l.material_id, section: l.section, qty: String(l.qty) }));
    setBomRows(lines.length ? lines : [{ materialId: "", section: "floor", qty: "" }]);
  }, [bomSizeId, data]);

  const invoke = async (action, body) => {
    setBusy(true); setMsg(null);
    try {
      const { data: d, error } = await sb.functions.invoke("portal-settings", { body: scoped({ action, ...body }) });
      if (error || (d && d.error)) {
        let m = (error && error.message) || (d && d.error);
        try { const ctx = await error.context.json(); if (ctx && ctx.error) m = ctx.error; } catch (_e) {}
        setMsg({ err: String(m || "That didn't save.") });
        return null;
      }
      return d || {};
    } finally { setBusy(false); }
  };

  const saveMaterials = async () => {
    const dirty = matRows.filter((m) => m.dirty);
    if (!dirty.length) { setMsg({ ok: "Nothing to save." }); return; }
    for (const m of dirty) {
      const name = m.name.trim();
      if (!name) { setMsg({ err: "Every material needs a name." }); return; }
      const cost = rtpNum(m.unitCost);
      if (!Number.isFinite(cost) || cost < 0) { setMsg({ err: `"${name}" has an invalid cost.` }); return; }
      const r = await invoke("save_rtp_material", { id: m.id || undefined, name, category: m.category.trim(), unitCost: cost, active: m.active });
      if (!r) return;   // the failed row's edits survive in the form for a retry
    }
    setMsg({ ok: `Saved ${dirty.length} material${dirty.length === 1 ? "" : "s"}.` });
    await load();
  };
  const archiveMaterial = async (m) => {
    if (!m.id) { setMatRows((rs) => rs.filter((x) => x !== m)); return; }
    const r = await invoke("delete_rtp_material", { id: m.id });
    if (r) { setMsg({ ok: `Archived "${m.name}". Buildings using it re-price without it.` }); await load(); }
  };

  const saveBom = async () => {
    if (!bomSizeId) return;
    // A quantity that doesn't parse ("12 ea", "two") or is negative used to be dropped by the
    // filter below and the save sent anyway — and since save_rtp_bom FULL-REPLACES the size's
    // bill of materials, the line being edited was deleted rather than saved. Refuse the whole
    // save and name the rows, the way saveOverhead does. A qty of 0 is untouched: that stays
    // the documented way to delete a line, and so does dropping the blank starter row.
    const badQty = bomRows
      .map((l, i) => ({ row: i + 1, materialId: l.materialId, raw: l.qty, n: rtpNum(l.qty) }))
      .filter((x) => x.materialId && (!Number.isFinite(x.n) || x.n < 0));
    if (badQty.length) {
      const names = badQty.map((x) => {
        const m = matRows.find((mr) => mr.id === x.materialId);
        return `${m ? m.name : `line ${x.row}`} ("${x.raw}")`;
      });
      setMsg({ err: `Nothing was saved — fix these quantities first: ${names.join("; ")}.` });
      return;
    }
    const lines = bomRows
      .map((l) => ({ materialId: l.materialId, section: l.section, qty: rtpNum(l.qty) }))
      .filter((l) => l.materialId && Number.isFinite(l.qty) && l.qty > 0);
    const r = await invoke("save_rtp_bom", { sizeId: bomSizeId, lines });
    if (r) {
      setMsg({ ok: `Saved ${r.saved} line${r.saved === 1 ? "" : "s"}${(r.skipped || []).length ? ` — skipped: ${r.skipped.join("; ")}` : ""}.` });
      await load();
    }
  };

  const saveOverhead = async () => {
    const lines = ovhRows.map((o) => ({ label: o.label.trim(), kind: o.kind, value: rtpNum(o.value), active: o.active }));
    if (lines.some((l) => !l.label || !Number.isFinite(l.value) || l.value < 0)) { setMsg({ err: "Every overhead line needs a label and a non-negative value." }); return; }
    const r = await invoke("save_rtp_overhead", { lines });
    if (r) { setMsg({ ok: `Saved ${r.saved} overhead line${r.saved === 1 ? "" : "s"}.` }); await load(); }
  };

  const doToggle = async (on) => {
    setConfirmToggle(null);
    const r = await invoke("set_rtp_enabled", { on });
    if (r) { setMsg({ ok: on ? "Real-Time Pricing is LIVE — your building prices now come from your material costs." : "Real-Time Pricing is off — your manual prices are restored." }); await load(); }
  };

  // ── The workbook (download) ── Materials + one sheet per selected style + Overhead +
  // a read-only Current Prices reference. Layout matches Carolyn's 2015 sheet in spirit,
  // with structured markers ("Size:" rows, repeated section values) so a builder can sort,
  // insert and delete rows without breaking the re-import.
  const downloadTemplate = async () => {
    if (!cat || !data || dlBusy) return;
    const chosen = styles().filter((s) => !dlStyles || dlStyles.has(s.id));
    if (!chosen.length) { setMsg({ err: "Pick at least one style for the template." }); return; }
    const names = new Set();
    for (const s of chosen) {
      const n = rtpSheetName(s.label).toLowerCase();
      if (names.has(n)) { setMsg({ err: `Two styles would share the sheet name "${rtpSheetName(s.label)}" — rename one on the pricing card above, then download again.` }); return; }
      names.add(n);
    }
    setDlBusy(true); setMsg(null);
    try {
      const ExcelJS = await loadExcelJS();
      const wb = new ExcelJS.Workbook();
      const thin = { style: "thin", color: { argb: "FFCBD5E1" } };
      const paintHdr = (ws, rowN, count) => {
        const hr = ws.getRow(rowN); hr.height = 22;
        for (let c = 1; c <= count; c++) {
          const cell = hr.getCell(c);
          cell.font = { bold: true, size: 10, color: { argb: "FFFFFFFF" } };
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF334155" } };
          cell.alignment = { vertical: "middle", horizontal: "center" };
          cell.border = { top: thin, left: thin, bottom: thin, right: thin };
        }
      };
      const mats = activeMats();
      const matByIdLocal = {}; mats.forEach((m) => { matByIdLocal[m.id] = m; });

      const wsM = wb.addWorksheet("Materials", { views: [{ state: "frozen", ySplit: 1 }] });
      wsM.addRow(["Category", "Material", "Unit Cost"]);
      paintHdr(wsM, 1, 3);
      mats.forEach((m) => wsM.addRow([m.category, m.name, rtpNum(m.unitCost)]));
      wsM.columns = [{ width: 18 }, { width: 30 }, { width: 12 }];
      for (let r = 2; r <= wsM.rowCount; r++) wsM.getRow(r).getCell(3).numFmt = '$#,##0.00';

      chosen.forEach((s) => {
        const ws = wb.addWorksheet(rtpSheetName(s.label), { views: [{ state: "frozen", ySplit: 0 }] });
        ws.columns = [{ width: 12 }, { width: 30 }, { width: 8 }];
        sizesFor(s.id).forEach((z) => {
          const marker = ws.addRow(["Size:", z.label]);
          marker.getCell(1).font = { bold: true, size: 11 };
          marker.getCell(2).font = { bold: true, size: 11 };
          marker.eachCell((cell) => { cell.border = { top: { style: "medium", color: { argb: "FF94A3B8" } } }; });
          const hdrRow = ws.addRow(["Section", "Material", "Qty"]);
          hdrRow.eachCell((cell) => {
            cell.font = { bold: true, size: 10, color: { argb: "FFFFFFFF" } };
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF64748B" } };
            cell.border = { top: thin, left: thin, bottom: thin, right: thin };
          });
          const lines = bomLinesFor(z.id);
          if (lines.length) {
            lines.forEach((l) => ws.addRow([l.section, (matByIdLocal[l.material_id] || {}).name || "", Number(l.qty)]));
          } else {
            // Writing room, grouped the way Carolyn asked (floor/walls/roof + interior).
            // Blank material names import as nothing, so unused rows are harmless.
            ["floor", "walls", "roof", "interior"].forEach((sec) => { for (let i = 0; i < 3; i++) ws.addRow([sec, "", ""]); });
          }
          ws.addRow([]);
        });
      });

      const wsO = wb.addWorksheet("Overhead", { views: [{ state: "frozen", ySplit: 1 }] });
      wsO.addRow(["Label", "Type", "Value"]);
      paintHdr(wsO, 1, 3);
      const ovh = ovhRows.length ? ovhRows.filter((o) => o.active) : RTP_CLASSIC_OVERHEAD;
      ovh.forEach((o) => wsO.addRow([o.label, o.kind, rtpNum(o.value)]));
      wsO.columns = [{ width: 16 }, { width: 22 }, { width: 10 }];
      wsO.addRow([]);
      wsO.addRow(["Types: multiplier (multiplies the running price), flat (adds dollars), percent_of_price (a reporting allocation OF the final price — does not change it)."]);

      const wsP = wb.addWorksheet("Basic Pricing");
      wsP.addRow(["Reference only — this sheet is not imported."]).getCell(1).font = { italic: true, color: { argb: "FF64748B" } };
      wsP.addRow(["Style", "Size", "Basic Pricing", "Real-Time Pricing"]);
      paintHdr(wsP, 2, 4);
      wsP.columns = [{ width: 22 }, { width: 10 }, { width: 14 }, { width: 15 }];
      styles().forEach((s) => sizesFor(s.id).forEach((z) => {
        const p = previewFor(z.id);
        wsP.addRow([s.label, z.label, z.base_price == null ? "" : Number(z.base_price), p ? Number(p.computed_price) : ""]);
      }));
      for (let r = 3; r <= wsP.rowCount; r++) { wsP.getRow(r).getCell(3).numFmt = '$#,##0.00'; wsP.getRow(r).getCell(4).numFmt = '$#,##0.00'; }

      const buf = await wb.xlsx.writeBuffer();
      downloadBlob(`${(cat.clientId || "structure")}-real-time-pricing.xlsx`,
        new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    } catch (e) {
      setMsg({ err: `Could not build the workbook: ${e.message}` });
    }
    setDlBusy(false);
  };

  // ── The workbook (upload) ── parsed here to structured JSON; the server is the trust
  // boundary and re-validates everything (names, sizes, sections, entitlement).
  const onUpload = async (file) => {
    if (!file) return;
    setBusy(true); setMsg(null); setResult(null);
    try {
      if (file.size > 5_000_000) throw new Error("File too large (max 5MB).");
      if (!/\.xlsx$/i.test(file.name) && !file.type.includes("spreadsheetml")) throw new Error("Upload the .xlsx workbook (the template you downloaded).");
      const sheets = await readXlsxWorkbook(file, await loadExcelJS());
      const lcName = (n) => String(n).trim().toLowerCase();
      const matSheet = sheets.find((s) => lcName(s.name) === "materials");
      const ovhSheet = sheets.find((s) => lcName(s.name) === "overhead");
      // ⚠️ BOTH NAMES, FOREVER. The read-only price reference tab was renamed "Current Prices"
      // -> "Basic Pricing" on 2026-09-01. Dropping the old name would silently reclassify a
      // workbook downloaded before that date as a STYLE sheet and feed its rows to the BOM
      // importer; keeping only the old one breaks every workbook downloaded after. Neither is
      // a sheet we read, so listing both costs nothing and is the only safe shape.
      const styleSheets = sheets.filter((s) => !["materials", "overhead", "current prices", "basic pricing"].includes(lcName(s.name)));
      if (!matSheet && !styleSheets.length) throw new Error("This doesn't look like the Real-Time Pricing workbook — no Materials sheet and no style sheets.");

      const materials = [];
      if (matSheet) {
        const rows = matSheet.matrix;
        const start = rows.findIndex((r) => String(r[1] || "").trim().toLowerCase() === "material") + 1;
        for (let i = start > 0 ? start : 1; i < rows.length; i++) {
          const r = rows[i]; if (!r) continue;
          const name = String(r[1] || "").trim();
          if (!name) continue;
          materials.push({ category: String(r[0] || "").trim(), name, unitCost: rtpNum(r[2]) });
        }
      }

      const bom = [];
      styleSheets.forEach((sh) => {
        let block = null;
        const push = () => { if (block && block.lines.length) bom.push(block); block = null; };
        sh.matrix.forEach((r) => {
          const c0 = String((r && r[0]) || "").trim();
          if (/^size:?$/i.test(c0)) {
            push();
            const dims = String((r && r[1]) || "").toLowerCase().replace(/[×✕]/g, "x").split("x").map((t) => rtpNum(t));
            if (dims.length === 2 && dims.every((n) => Number.isFinite(n) && n > 0)) {
              block = { style: sh.name, width: dims[0], length: dims[1], lines: [] };
            }
            return;
          }
          if (!block) return;
          if (/^section$/i.test(c0)) return;   // the block's own header row
          const material = String((r && r[1]) || "").trim();
          if (!material) return;
          const sec = c0.toLowerCase();
          block.lines.push({ material, section: RTP_SECTIONS.includes(sec) ? sec : "other", qty: rtpNum(r[2]) });
        });
        push();
      });

      let overhead;
      if (ovhSheet) {
        overhead = [];
        const rows = ovhSheet.matrix;
        const start = rows.findIndex((r) => String(r[0] || "").trim().toLowerCase() === "label") + 1;
        for (let i = start > 0 ? start : 1; i < rows.length; i++) {
          const r = rows[i]; if (!r) continue;
          const label = String(r[0] || "").trim();
          const rawKind = String(r[1] || "").trim().toLowerCase();
          if (!label || !rawKind) continue;
          const kind = /mult/.test(rawKind) ? "multiplier" : /flat/.test(rawKind) ? "flat" : /(percent|%)/.test(rawKind) ? "percent_of_price" : null;
          if (!kind) continue;
          overhead.push({ label, kind, value: rtpNum(r[2]) });
        }
      }

      const r = await invoke("import_rtp_workbook", { materials, bom, overhead });
      if (r) {
        setResult(r);
        setMsg({ ok: `Imported ${r.materialsSaved} material${r.materialsSaved === 1 ? "" : "s"} and ${r.sizesReplaced} building${r.sizesReplaced === 1 ? "" : "s"}.` });
        await load();
      }
    } catch (e) {
      setMsg({ err: e.message });
    } finally {
      setBusy(false); setFileKey((k) => k + 1);
    }
  };

  // ── Render ──
  if (!unlocked || (data && data.entitled === false)) {
    return (
      <div style={S.card}>
        <div style={S.h2}>⚡ Real-Time Pricing</div>
        <p style={{ fontSize: 13, color: "#475569", margin: "0 0 10px", lineHeight: 1.6, maxWidth: 640 }}>
          Bring your material costs into Structure Studio and build every style and size from the exact
          materials it needs. Update your costs each quarter and every building's price recalculates on
          its own — your current prices stay untouched while you set it up.
        </p>
        {canAdmin
          ? <button onClick={onSeeBilling} style={S.btn(ACCENT, "#FFF")}>Add Real-Time Pricing — see Billing</button>
          : <div style={{ fontSize: 12.5, color: "#94A3B8", fontWeight: 600 }}>Ask your account owner to add it under Settings → Billing.</div>}
      </div>
    );
  }
  if (!data || !cat) {
    return <div style={S.card}><div style={S.h2}>⚡ Real-Time Pricing</div><div style={{ fontSize: 13, color: "#94A3B8" }}>{msg && msg.err ? msg.err : "Loading…"}</div></div>;
  }

  const enabled = !!data.enabled;
  const preview = data.preview || [];
  const previewRows = preview.map((p) => {
    const z = sizeById(p.size_id); const s = z && styleById(z.style_id);
    return { ...p, styleLabel: s ? s.label : "?", sizeLabel: p.size_label, current: z ? z.base_price : null };
  }).sort((a, b) => a.styleLabel.localeCompare(b.styleLabel) || String(a.sizeLabel).localeCompare(String(b.sizeLabel)));

  return (
    <div style={S.card}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <div style={{ ...S.h2, marginBottom: 0 }}>⚡ Real-Time Pricing</div>
        <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: ".05em", textTransform: "uppercase", color: enabled ? "#166534" : "#92400E", background: enabled ? "#DCFCE7" : "#FEF3C7", borderRadius: 6, padding: "3px 8px" }}>{enabled ? "Live" : "Setting up"}</span>
        <div style={{ marginLeft: "auto" }}>
          <button onClick={() => setConfirmToggle({ to: !enabled })} disabled={busy}
            style={S.btn(enabled ? "#FEF2F2" : "#166534", enabled ? "#DC2626" : "#FFF")}>
            {enabled ? "Turn off — restore manual prices" : "Go live with Real-Time Pricing"}
          </button>
        </div>
      </div>
      <div style={{ fontSize: 12.5, color: enabled ? "#166534" : "#92400E", background: enabled ? "#F0FDF4" : "#FFFBEB", border: `1px solid ${enabled ? "#BBF7D0" : "#FDE68A"}`, borderRadius: 8, padding: "9px 12px", marginBottom: 14, lineHeight: 1.55 }}>
        {enabled
          ? "LIVE: buildings with a bill of materials price themselves from your material costs. Buildings without one keep their manual price."
          : "Set up while your current prices stay active — nothing changes until you press Go Live. Buildings without a bill of materials always keep their manual price."}
      </div>
      {msg && msg.err && <div style={S.err}>{msg.err}</div>}
      {msg && msg.ok && <div style={S.okMsg}>{msg.ok}</div>}
      {result && (result.skipped || []).length > 0 && (
        <div style={{ ...S.err, background: "#FFFBEB", border: "1px solid #FDE68A", color: "#92400E" }}>
          Skipped: {result.skipped.slice(0, 8).join("; ")}{result.skipped.length > 8 ? ` — and ${result.skipped.length - 8} more` : ""}
        </div>
      )}

      {/* ── Spreadsheet round-trip ── */}
      <div style={{ border: "1px solid #E2E8F0", borderRadius: 10, padding: 14, marginBottom: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: "#1E293B", marginBottom: 6 }}>Work in a spreadsheet</div>
        <p style={{ fontSize: 12.5, color: "#64748B", margin: "0 0 10px", lineHeight: 1.55 }}>
          Download the workbook (a Materials sheet, one sheet per style, and your Overhead), fill in
          quantities, and upload it back. Partial uploads are fine — only the buildings in the file change.
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
          {styles().map((s) => {
            const on = !dlStyles || dlStyles.has(s.id);
            return (
              <button key={s.id} type="button" onClick={() => {
                setDlStyles((cur) => {
                  const next = new Set(cur || styles().map((x) => x.id));
                  if (next.has(s.id)) next.delete(s.id); else next.add(s.id);
                  return next;
                });
              }} style={{ ...S.btn(on ? "#DBEAFF" : "#F8FAFC", on ? "#3D3672" : "#94A3B8"), padding: "5px 10px", fontSize: 12, border: `1px solid ${on ? "#C3D9F7" : "#E2E8F0"}` }}>
                {on ? "✓ " : ""}{s.label}
              </button>
            );
          })}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button onClick={downloadTemplate} disabled={dlBusy} style={{ ...S.btn("#F1F5F9", "#334155"), opacity: dlBusy ? 0.6 : 1 }}>{dlBusy ? "Preparing…" : "⬇ Download workbook"}</button>
          <label style={{ ...S.btn(ACCENT, "#FFF"), display: "inline-block", cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1 }}>
            {busy ? "Working…" : "⬆ Upload filled workbook"}
            <input key={fileKey} type="file" accept=".xlsx" disabled={busy} style={{ display: "none" }}
              onChange={(e) => onUpload(e.target.files && e.target.files[0])} />
          </label>
        </div>
      </div>

      {/* ── Materials ── */}
      <div style={{ border: "1px solid #E2E8F0", borderRadius: 10, padding: 14, marginBottom: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: "#1E293B", marginBottom: 6 }}>Material costs</div>
        <p style={{ fontSize: 12.5, color: "#64748B", margin: "0 0 10px", lineHeight: 1.55 }}>
          The one list you keep current. Change a cost here and every building using that material re-prices
          {enabled ? " immediately." : " the moment you go live."}
        </p>
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", maxWidth: 640 }}>
            <thead><tr><th style={S.th}>Category</th><th style={S.th}>Material</th><th style={S.th}>Unit cost</th><th style={S.th}></th></tr></thead>
            <tbody>
              {matRows.filter((m) => m.active).map((m, i) => (
                <tr key={m.id || "new-" + i}>
                  <td style={{ ...S.td, padding: 4 }}><input value={m.category} onChange={(e) => setMatRows((rs) => rs.map((x) => x === m ? { ...x, category: e.target.value, dirty: true } : x))} style={{ ...S.input, width: 130 }} placeholder="Lumber" /></td>
                  <td style={{ ...S.td, padding: 4 }}><input value={m.name} onChange={(e) => setMatRows((rs) => rs.map((x) => x === m ? { ...x, name: e.target.value, dirty: true } : x))} style={{ ...S.input, minWidth: 180 }} placeholder="White 8' 2x4" /></td>
                  <td style={{ ...S.td, padding: 4 }}><input value={m.unitCost} onChange={(e) => setMatRows((rs) => rs.map((x) => x === m ? { ...x, unitCost: e.target.value, dirty: true } : x))} style={{ ...S.input, width: 84, textAlign: "right" }} placeholder="8.50" /></td>
                  <td style={{ ...S.td, padding: 4 }}><button onClick={() => archiveMaterial(m)} disabled={busy} title={m.id ? "Archive — keeps history, removes it from new lists" : "Remove"} style={{ background: "none", border: "none", color: "#DC2626", cursor: "pointer", fontWeight: 700, fontFamily: "inherit" }}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <button onClick={() => setMatRows((rs) => [...rs, { id: null, category: rs.length ? rs[rs.length - 1].category : "", name: "", unitCost: "", active: true, dirty: true }])} style={{ background: "none", border: "1px dashed #CBD5E1", borderRadius: 8, color: ACCENT, fontWeight: 700, fontSize: 12, padding: "6px 11px", cursor: "pointer", fontFamily: "inherit" }}>+ Add material</button>
          <button onClick={saveMaterials} disabled={busy || !matRows.some((m) => m.dirty)} style={{ ...S.btn(ACCENT, "#FFF"), opacity: busy || !matRows.some((m) => m.dirty) ? 0.55 : 1 }}>Save materials</button>
        </div>
      </div>

      {/* ── Bill of materials per building ── */}
      <div style={{ border: "1px solid #E2E8F0", borderRadius: 10, padding: 14, marginBottom: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: "#1E293B", marginBottom: 6 }}>Bill of materials</div>
        <p style={{ fontSize: 12.5, color: "#64748B", margin: "0 0 10px", lineHeight: 1.55 }}>
          Pick a building, list what it takes to build it — floor, walls, roof, interior. Quantity × unit
          cost is its material total.
        </p>
        <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
          <select value={bomStyleId} onChange={(e) => { setBomStyleId(e.target.value); setBomSizeId(""); }} style={{ ...S.input, width: 200 }}>
            <option value="">Choose a style…</option>
            {styles().map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
          <select value={bomSizeId} onChange={(e) => setBomSizeId(e.target.value)} disabled={!bomStyleId} style={{ ...S.input, width: 140 }}>
            <option value="">Choose a size…</option>
            {sizesFor(bomStyleId).map((z) => <option key={z.id} value={z.id}>{z.label}</option>)}
          </select>
        </div>
        {bomSizeId && (<>
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", maxWidth: 640 }}>
              <thead><tr><th style={S.th}>Section</th><th style={S.th}>Material</th><th style={S.th}>Qty</th><th style={S.th}></th></tr></thead>
              <tbody>
                {bomRows.map((l, i) => (
                  <tr key={i}>
                    <td style={{ ...S.td, padding: 4 }}>
                      <select value={l.section} onChange={(e) => setBomRows((rs) => rs.map((x, j) => j === i ? { ...x, section: e.target.value } : x))} style={{ ...S.input, width: 110 }}>
                        {RTP_SECTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </td>
                    <td style={{ ...S.td, padding: 4 }}>
                      <select value={l.materialId} onChange={(e) => setBomRows((rs) => rs.map((x, j) => j === i ? { ...x, materialId: e.target.value } : x))} style={{ ...S.input, minWidth: 200 }}>
                        <option value="">Choose material…</option>
                        {activeMats().map((m) => <option key={m.id} value={m.id}>{m.name} — {rtpMoney(rtpNum(m.unitCost))}</option>)}
                      </select>
                    </td>
                    <td style={{ ...S.td, padding: 4 }}><input value={l.qty} onChange={(e) => setBomRows((rs) => rs.map((x, j) => j === i ? { ...x, qty: e.target.value } : x))} style={{ ...S.input, width: 70, textAlign: "right" }} /></td>
                    <td style={{ ...S.td, padding: 4 }}><button onClick={() => setBomRows((rs) => rs.filter((_, j) => j !== i))} style={{ background: "none", border: "none", color: "#DC2626", cursor: "pointer", fontWeight: 700, fontFamily: "inherit" }}>✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center" }}>
            <button onClick={() => setBomRows((rs) => [...rs, { materialId: "", section: rs.length ? rs[rs.length - 1].section : "floor", qty: "" }])} style={{ background: "none", border: "1px dashed #CBD5E1", borderRadius: 8, color: ACCENT, fontWeight: 700, fontSize: 12, padding: "6px 11px", cursor: "pointer", fontFamily: "inherit" }}>+ Add line</button>
            <button onClick={saveBom} disabled={busy} style={S.btn(ACCENT, "#FFF")}>Save this building</button>
            {(() => { const p = previewFor(bomSizeId); return p ? <span style={{ fontSize: 12.5, color: "#475569" }}>Materials {rtpMoney(p.materials_total)} → price <b>{rtpMoney(p.computed_price)}</b></span> : null; })()}
          </div>
        </>)}
      </div>

      {/* ── Overhead & markup ── */}
      <div style={{ border: "1px solid #E2E8F0", borderRadius: 10, padding: 14, marginBottom: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: "#1E293B", marginBottom: 6 }}>Overhead & markup</div>
        <p style={{ fontSize: 12.5, color: "#64748B", margin: "0 0 10px", lineHeight: 1.55 }}>
          Applied top to bottom, starting from the materials total. Multipliers and flat lines change the
          price. <b>% of price lines don't</b> — they show where the final price goes (sales, delivery,
          build…), and whatever's left after materials and those shares is your profit.
        </p>
        {ovhRows.length === 0 && (
          <button onClick={() => setOvhRows(RTP_CLASSIC_OVERHEAD.map((o) => ({ ...o, value: String(o.value) })))} style={{ ...S.btn("#F1F5F9", "#334155"), marginBottom: 10 }}>
            Start with the classic setup (×1.8, ×1.1, Sales 5% / Delivery 10% / Build 10%)
          </button>
        )}
        {ovhRows.map((o, i) => (
          <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
            <span style={{ display: "inline-flex", flexDirection: "column", gap: 1 }}>
              <button onClick={() => i > 0 && setOvhRows((rs) => { const n = [...rs]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; return n; })} disabled={i === 0} title="Move up" style={{ background: "none", border: "none", cursor: i === 0 ? "default" : "pointer", color: i === 0 ? "#E2E8F0" : "#64748B", fontSize: 10, lineHeight: 1, padding: 1 }}>▲</button>
              <button onClick={() => i < ovhRows.length - 1 && setOvhRows((rs) => { const n = [...rs]; [n[i], n[i + 1]] = [n[i + 1], n[i]]; return n; })} disabled={i === ovhRows.length - 1} title="Move down" style={{ background: "none", border: "none", cursor: i === ovhRows.length - 1 ? "default" : "pointer", color: i === ovhRows.length - 1 ? "#E2E8F0" : "#64748B", fontSize: 10, lineHeight: 1, padding: 1 }}>▼</button>
            </span>
            <input value={o.label} onChange={(e) => setOvhRows((rs) => rs.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} style={{ ...S.input, width: 140 }} placeholder="Mark-up" />
            <select value={o.kind} onChange={(e) => setOvhRows((rs) => rs.map((x, j) => j === i ? { ...x, kind: e.target.value } : x))} style={{ ...S.input, width: 190 }}>
              {RTP_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
            </select>
            <input value={o.value} onChange={(e) => setOvhRows((rs) => rs.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} style={{ ...S.input, width: 80, textAlign: "right" }} />
            <button onClick={() => setOvhRows((rs) => rs.filter((_, j) => j !== i))} style={{ background: "none", border: "none", color: "#DC2626", cursor: "pointer", fontWeight: 700, fontFamily: "inherit" }}>✕</button>
          </div>
        ))}
        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <button onClick={() => setOvhRows((rs) => [...rs, { label: "", kind: "multiplier", value: "", active: true }])} style={{ background: "none", border: "1px dashed #CBD5E1", borderRadius: 8, color: ACCENT, fontWeight: 700, fontSize: 12, padding: "6px 11px", cursor: "pointer", fontFamily: "inherit" }}>+ Add line</button>
          <button onClick={saveOverhead} disabled={busy} style={S.btn(ACCENT, "#FFF")}>Save overhead</button>
        </div>
      </div>

      {/* ── Preview ── */}
      {previewRows.length > 0 && (
        <div style={{ border: "1px solid #E2E8F0", borderRadius: 10, padding: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: "#1E293B", marginBottom: 6 }}>Computed prices</div>
          <p style={{ fontSize: 12.5, color: "#64748B", margin: "0 0 10px" }}>
            Every building with a bill of materials, priced by the engine{enabled ? " (these ARE your live prices)" : " — nothing changes until you go live"}.
          </p>
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead><tr><th style={S.th}>Style</th><th style={S.th}>Size</th><th style={S.th}>Materials</th><th style={S.th}>Real-Time Pricing</th><th style={S.th}>Basic Pricing</th><th style={S.th}>Where it goes</th></tr></thead>
              <tbody>
                {previewRows.map((p) => (
                  <tr key={p.size_id}>
                    <td style={S.td}>{p.styleLabel}</td>
                    <td style={S.td}>{p.sizeLabel}</td>
                    <td style={S.td}>{rtpMoney(p.materials_total)}</td>
                    <td style={{ ...S.td, fontWeight: 700 }}>{rtpMoney(p.computed_price)}</td>
                    <td style={{ ...S.td, color: Number(p.current) === Number(p.computed_price) ? "#166534" : "#92400E" }}>{rtpMoney(p.current)}</td>
                    <td style={{ ...S.td, fontSize: 12, color: "#64748B" }}>
                      {(p.allocations || []).map((a) => `${a.label} ${rtpMoney(a.amount)}`).join(" · ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Go-live / revert confirm ── */}
      {confirmToggle && (
        <div onClick={(ev) => { if (ev.target === ev.currentTarget) setConfirmToggle(null); }}
          style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.5)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, zIndex: 1200 }}>
          <div style={{ background: "#FFF", borderRadius: 14, maxWidth: 560, width: "100%", maxHeight: "84vh", overflowY: "auto", boxShadow: "0 24px 60px rgba(0,0,0,0.3)" }}>
            <div style={{ background: confirmToggle.to ? "#166534" : "#92400E", color: "#FFF", padding: "15px 18px", fontSize: 15.5, fontWeight: 800 }}>
              {confirmToggle.to ? "Go live with Real-Time Pricing?" : "Turn Real-Time Pricing off?"}
            </div>
            <div style={{ padding: "16px 18px" }}>
              {confirmToggle.to ? (<>
                <p style={{ fontSize: 13, color: "#475569", margin: "0 0 10px", lineHeight: 1.6 }}>
                  Your current prices are backed up first, then every building below takes its computed
                  price. Buildings without a bill of materials keep their manual price. You can turn this
                  off any time and the backed-up prices come straight back.
                </p>
                <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: 12 }}>
                  <thead><tr><th style={S.th}>Building</th><th style={S.th}>Now</th><th style={S.th}>Will become</th></tr></thead>
                  <tbody>
                    {previewRows.map((p) => (
                      <tr key={p.size_id}>
                        <td style={S.td}>{p.styleLabel} {p.sizeLabel}</td>
                        <td style={S.td}>{rtpMoney(p.current)}</td>
                        <td style={{ ...S.td, fontWeight: 700 }}>{rtpMoney(p.computed_price)}</td>
                      </tr>
                    ))}
                    {previewRows.length === 0 && <tr><td style={S.td} colSpan={3}>No buildings have a bill of materials yet — going live changes nothing until they do.</td></tr>}
                  </tbody>
                </table>
              </>) : (
                <p style={{ fontSize: 13, color: "#475569", margin: "0 0 12px", lineHeight: 1.6 }}>
                  Every building goes back to the manual price it had before Real-Time Pricing went live.
                  Your materials, bills and overhead stay saved — going live again re-applies them.
                </p>
              )}
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => doToggle(confirmToggle.to)} disabled={busy} style={{ ...S.btn(confirmToggle.to ? "#166534" : "#92400E", "#FFF"), flex: 1 }}>
                  {confirmToggle.to ? "Back up my prices and go live" : "Restore my manual prices"}
                </button>
                <button onClick={() => setConfirmToggle(null)} style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0" }}>Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
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
// A partition wall (migration 278) is priced by the foot of wall, by the square foot of wall (its length
// times its height) or each: the three methods its pricing understands. portal-settings refuses the
// others for it, and submit-estimate would charge them each.
const LP_METHODS_PARTITION = [
  { value: "each", label: "each" },
  { value: "lineal_ft", label: "lineal ft — per foot of wall" },
  { value: "sqft_option", label: "sqft option — per sq ft of wall" },
];
// The build-on-site fee's basis, shown inline on the row (Carolyn 2026-09-14). The same seven
// methods as LP_METHODS, with "each" spelled the way she reads it: "All these but each is
// flat rate." Values must match the style_wall_heights check constraint (228).
const WH_BOS_BASES = [
  ["each", "flat rate"],
  ["lineal_ft", "lineal ft"],
  ["sqft_option", "sqft option"],
  ["sqft_building", "sqft building"],
  ["perimeter_building", "perimeter building"],
  ["pct_building_price", "pct building price"],
  ["pct_estimate_total", "pct estimate total"],
];
// One hauled and one built-on-site row per increase, and the two share no width (migration 272;
// bug report 2026-10-02: +12 hauled on the 8-12 wide, the same +12 built on site on the 14 wide).
// The portal's copy of wallHeightClash in supabase/functions/_shared/wallHeightRows.ts, so a
// builder reads the sentence BEFORE the save instead of as a refused one; wallHeightRows.test.ts
// pins the wording, so keep the two alike. A null widths list is every width the style sells, and
// on a style with no sizes yet, every width at all.
function whClash(rows, styleWidths) {
  const key = (r) => Number(String(r.deltaIn).trim()) + ":" + (r.buildOnSite ? "site" : "haul");
  const seen = {};
  for (const r of rows) {
    const d = Number(String(r.deltaIn).trim());
    if (seen[key(r)]) return "+" + d + " in is listed twice" + (r.buildOnSite ? " as built on site" : "") + ". An increase can be listed once for hauled buildings and once ticked Built on site.";
    seen[key(r)] = r;
  }
  const all = styleWidths || [];
  for (const r of rows) {
    if (r.buildOnSite) continue;
    const d = Number(String(r.deltaIn).trim());
    const site = seen[d + ":site"];
    if (!site) continue;
    let shared;
    if (!Array.isArray(r.widthsFt) && !Array.isArray(site.widthsFt) && !all.length) shared = [];
    else {
      const wa = Array.isArray(r.widthsFt) ? r.widthsFt.map(Number) : (all.length ? all : null);
      const wb = Array.isArray(site.widthsFt) ? site.widthsFt.map(Number) : (all.length ? all : null);
      const both = wa === null ? (wb || []) : wb === null ? wa : wa.filter((w) => wb.indexOf(w) !== -1);
      shared = [...new Set(both)].sort((x, y) => x - y);
      if (!shared.length) continue;
    }
    return "+" + d + " in is offered both hauled and built on site at " + (shared.length ? shared.join(", ") + " ft wide" : "every width") + ". Untick " + (shared.length === 1 ? "that width" : "those widths") + " on one of the two rows.";
  }
  return null;
}
// -- Wall Height Upgrades (172) ----------------------------------------------------------
// One card, one section per building style -- the ColorsView pattern, and for the reason
// Carolyn liked it there: a builder reads down their own styles rather than across a matrix.
// The heights on offer differ per style because HAULING limits do, which is why this is not
// one list for the whole tenant.
//
// renderSection is a plain function and NOT a component, deliberately: as a component React
// remounts it on every keystroke and the input loses focus. Same note as ColorsView.
// -- Insulation (177) -------------------------------------------------------------------
// A fixed 3x3 matrix: batt / spray foam / rigid foam (272) across floor / walls / roof. Blank a
// cell and that combination stops being offered -- the row is deleted, get_config stops emitting
// it, and the customer's toggle disappears. "Entire building" is a shortcut in the DESIGNER, never a
// fourth row here: a stored fourth rate would be a second place for the price to live.
function Electrical({ viewingLabel = null, clientId = null }) {
  const scoped = (body) => (viewingLabel && clientId ? { ...body, targetClientId: clientId } : body);
  const [f, setF] = useState(null);
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = async () => {
    const body = scoped({ action: "catalog" });
    const { data, error } = await window.__ssCatalogFlight(
      () => sb.functions.invoke("portal-settings", { body }),
      String(body.targetClientId == null ? (ssTargetClientId || "") : body.targetClientId));
    if (error || (data && data.error)) { setMsg({ err: (error && error.message) || data.error }); return; }
    const e = data.electrical || {};
    setF({
      enabled: e.enabled === true,
      packagePrice: e.package_price != null ? String(e.package_price) : "",
      packageLabel: e.package_label || "Electrical Package",
      taxable: e.taxable !== false,
      internalOnly: e.internal_only === true,
      outletSpacingFt: String(e.outlet_spacing_ft == null ? 6 : e.outlet_spacing_ft),
      outletHeightIn: String(e.outlet_height_in == null ? 24 : e.outlet_height_in),
      outletAboveBenchIn: String(e.outlet_above_bench_in == null ? 42 : e.outlet_above_bench_in),
      lightSpacingFt: String(e.light_spacing_ft == null ? 10 : e.light_spacing_ft),
      switchHeightIn: String(e.switch_height_in == null ? 48 : e.switch_height_in),
      includePanel: e.include_panel !== false,
      panelHeightIn: String(e.panel_height_in == null ? 60 : e.panel_height_in),
      // The three device pointers (206). These were missing until 2026-09-07: the card read
      // its whole state from `catalog`, which returns the electrical_settings row RAW — so
      // these are snake_case here, unlike get_config's camelCase for the designer. With them
      // absent the pickers always rendered "— none —" no matter what was stored, and `save`
      // (which posts ...f) had nothing to send, so the setting was unreachable from the UI.
      outletItemId: e.outlet_item_id || "",
      switchItemId: e.switch_item_id || "",
      lightItemId: e.light_item_id || "",
    });
    setItems((data.electricalItems || []).map((r) => ({
      id: r.id, name: r.name, icon: r.icon || "\u26a1", mount: r.mount || "wall",
      heightOffFloorIn: r.height_off_floor_in != null ? String(r.height_off_floor_in) : "",
      priceWithPackage: r.price_with_package != null ? String(r.price_with_package) : "",
      priceStandalone: r.price_standalone != null ? String(r.price_standalone) : "",
      taxable: r.taxable !== false, active: r.active !== false,
      internalOnly: r.internal_only === true, sortOrder: r.sort_order || 0,
    })));
  };
  useEffect(() => { load(); }, [clientId]);

  const set = (k, v) => setF((prev) => ({ ...prev, [k]: v }));
  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const { data, error } = await sb.functions.invoke("portal-settings", { body: scoped({ action: "save_electrical", ...f }) });
      if (error || (data && data.error)) throw new Error((error && error.message) || data.error);
      const r2 = await sb.functions.invoke("portal-settings", { body: scoped({ action: "save_electrical_items", rows: items }) });
      if (r2.error || (r2.data && r2.data.error)) throw new Error((r2.error && r2.error.message) || r2.data.error);
      await load();
      setMsg({ ok: "Saved." });
    } catch (e) { setMsg({ err: e.message }); }
    setBusy(false);
  };

  if (!f) return null;
  const num = (k, label, unit, hint) => (
    <label style={{ display: "block", minWidth: 160 }}>
      <span style={{ ...S.lbl, display: "block", marginBottom: 4 }}>{label}</span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <input type="number" min="0" step="0.5" value={f[k]} onChange={(e) => set(k, e.target.value)}
          style={{ ...S.input, width: 90 }} />
        <span style={{ fontSize: 12, color: "#64748B" }}>{unit}</span>
      </span>
      {hint && <span style={{ display: "block", fontSize: 11, color: "#94A3B8", marginTop: 3 }}>{hint}</span>}
    </label>
  );

  return (
    <div style={S.card}>
      <div style={S.h2}>Electrical</div>
      <p style={{ fontSize: 12.5, color: "#64748B", margin: "0 0 14px", maxWidth: 680 }}>
        Set your wiring standards once and the designer lays them out on the customer&rsquo;s
        building &mdash; a plug every so many feet, lights down the middle, a switch by the door.
        The package is <b>one fixed price</b> covering that standard layout.{" "}
        <b>Removing a device never reduces it</b>; only devices added <i>beyond</i> the standard
        are charged, at that item&rsquo;s own price.
      </p>
      <label style={{ display: "inline-flex", alignItems: "center", gap: 8, marginBottom: 14, cursor: "pointer", fontSize: 13, fontWeight: 700, color: "#1E293B" }}>
        <input type="checkbox" checked={f.enabled} onChange={(e) => set("enabled", e.target.checked)}
          style={{ width: 17, height: 17, cursor: "pointer", accentColor: DOOR_MINT }} />
        Offer an electrical package
        <span style={{ fontWeight: 500, color: "#64748B" }}>&mdash; off hides it entirely without clearing your standards</span>
      </label>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 18, alignItems: "flex-start", marginBottom: 16 }}>
        <label style={{ display: "block", minWidth: 200 }}>
          <span style={{ ...S.lbl, display: "block", marginBottom: 4 }}>What the customer sees</span>
          <input value={f.packageLabel} onChange={(e) => set("packageLabel", e.target.value)} maxLength={60}
            style={{ ...S.input, width: 200 }} />
        </label>
        <label style={{ display: "block", minWidth: 160 }}>
          <span style={{ ...S.lbl, display: "block", marginBottom: 4 }}>Package price</span>
          <input type="number" min="0" step="1" value={f.packagePrice} placeholder="not offered"
            onChange={(e) => set("packagePrice", e.target.value)} style={{ ...S.input, width: 120 }} />
          <span style={{ display: "block", fontSize: 11, color: "#94A3B8", marginTop: 3 }}>Blank = not offered yet</span>
        </label>
      </div>

      {/* One list, one rule (Carolyn 2026-09-03). Outlets, switches and lights are ordinary
          items in the table below with two prices like everything else; the standards just say
          WHICH item the package lays out. Leave one unset and the package lays none of those. */}
      <div style={{ ...S.lbl, marginBottom: 8 }}>Your standards</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 18, alignItems: "flex-start", marginBottom: 14 }}>
        {[["outletItemId", "Outlets are"], ["switchItemId", "The switch is"], ["lightItemId", "Lights are"]].map(([k, label]) => (
          <label key={k} style={{ display: "block", minWidth: 180 }}>
            <span style={{ ...S.lbl, display: "block", marginBottom: 4 }}>{label}</span>
            <select value={f[k] || ""} onChange={(e) => set(k, e.target.value || null)} style={{ ...S.input, width: 180 }}>
              <option value="">&mdash; none &mdash;</option>
              {/* `it.id` guard: an item added in this session has no id yet, and an option
                  with value="" reads back as "— none —" the moment it is picked. Save first,
                  then point a standard at it. */}
              {items.filter((it) => it.id && (it.name || "").trim()).map((it) => (
                <option key={it.id} value={it.id}>{it.name}</option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 18, alignItems: "flex-start", marginBottom: 14 }}>
        {num("outletSpacingFt", "Outlet every", "ft", "measured around the walls")}
        {num("outletHeightIn", "Outlet height", "in", "off the floor")}
        {num("outletAboveBenchIn", "Above a workbench", "in", "used where a bench is in the way")}
        {num("lightSpacingFt", "Light every", "ft", "down the length of the building")}
        {num("switchHeightIn", "Switch height", "in", "one switch, by the door")}
        {/* The panel sits with the other measurements because it has one too. The checkbox
            rides alongside its height rather than in the row of unrelated toggles below. */}
        <label style={{ display: "block", minWidth: 170 }}>
          <span style={{ ...S.lbl, display: "block", marginBottom: 4 }}>Panel height</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <input type="number" min="0" step="0.5" value={f.panelHeightIn} disabled={!f.includePanel}
              onChange={(e) => set("panelHeightIn", e.target.value)}
              style={{ ...S.input, width: 90, opacity: f.includePanel ? 1 : 0.5 }} />
            <span style={{ fontSize: 12, color: "#64748B" }}>in</span>
          </span>
          {/* flex, not inline-flex: the height and its "in" above are an inline-flex span, so
              an inline checkbox flowed onto the SAME line and sat on top of the unit. */}
          <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 5, cursor: "pointer", fontSize: 12, color: "#475569" }}>
            <input type="checkbox" checked={f.includePanel} onChange={(e) => set("includePanel", e.target.checked)}
              style={{ width: 15, height: 15, cursor: "pointer", accentColor: DOOR_MINT }} />
            Include a panel
          </label>
        </label>
      </div>


      <div style={{ display: "flex", flexWrap: "wrap", gap: 18, alignItems: "center", marginBottom: 14 }}>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 7, cursor: "pointer", fontSize: 13 }}
          title="Available in the rep designer only - hidden from the customer-facing page. A rep-selected package still prices normally.">
          <input type="checkbox" checked={f.internalOnly} onChange={(e) => set("internalOnly", e.target.checked)}
            style={{ width: 16, height: 16, cursor: "pointer", accentColor: DOOR_MINT }} />
          Internal only
        </label>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 7, cursor: "pointer", fontSize: 13 }}>
          <input type="checkbox" checked={f.taxable} onChange={(e) => set("taxable", e.target.checked)}
            style={{ width: 16, height: 16, cursor: "pointer", accentColor: DOOR_MINT }} />
          Taxable
        </label>
      </div>

      <p style={{ fontSize: 11.5, color: "#94A3B8", margin: "0 0 18px", maxWidth: 680 }}>
        Every electrical thing lives in one list below, and each has <b>two prices</b> because
        adding one while an electrician is already on site is a different job from a trip for it
        alone. The package covers the standard layout of whichever items you named above;
        anything beyond that is charged at the matching price.
      </p>

      <div style={{ ...S.lbl, marginBottom: 6 }}>Your electrical items</div>
      <p style={{ fontSize: 12.5, color: "#64748B", margin: "0 0 12px", maxWidth: 680 }}>
        Anything else you wire &mdash; a ceiling fan, a flood light, a 220V outlet. Each one has{" "}
        <b>two prices</b>, because they really are two different jobs: what you charge to add it{" "}
        <b>to the package</b> while an electrician is already on site, and what you charge to fit
        it <b>on its own</b> when there is no package. <b>Leave a price blank and you don&rsquo;t
        offer it that way</b> &mdash; blank is not free, and it never falls back to the other price.
      </p>
      <div style={{ overflowX: "auto", marginBottom: 12 }}>
        <table style={{ ...S.table, minWidth: 760 }}>
          <thead>
            <tr>
              <th style={S.th}>Item</th>
              <th style={S.th}>Icon</th>
              <th style={S.th}>Mounts</th>
              <th style={S.th} title="Inches off the floor. Blank for ceiling fittings that hang at the default height.">Height (in)</th>
              <th style={S.th} title="Charged when the customer HAS the electrical package. Blank = can't be added to a package.">With package ($)</th>
              <th style={S.th} title="Charged when there is NO package. Blank = only sold as part of a package.">On its own ($)</th>
              <th style={{ ...S.th, textAlign: "center" }} title="Rep designer only - hidden from the customer-facing page.">Internal</th>
              <th style={{ ...S.th, textAlign: "center" }}>Taxable</th>
              <th style={S.th}></th>
            </tr>
          </thead>
          <tbody>
            {items.map((r, i) => {
              const upd = (k, v) => setItems((p) => p.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
              return (
                <tr key={r.id || ("new-" + i)}>
                  <td style={S.td}><input value={r.name} onChange={(e) => upd("name", e.target.value)} maxLength={60} style={{ ...S.input, width: 150 }} /></td>
                  <td style={S.td}><input value={r.icon} onChange={(e) => upd("icon", e.target.value)} maxLength={4} style={{ ...S.input, width: 48, textAlign: "center" }} /></td>
                  <td style={S.td}>
                    <select value={r.mount} onChange={(e) => upd("mount", e.target.value)} style={{ ...S.input, width: 100 }}>
                      <option value="wall">On a wall</option>
                      <option value="ceiling">Ceiling</option>
                    </select>
                  </td>
                  <td style={S.td}><input type="number" min="0" value={r.heightOffFloorIn} onChange={(e) => upd("heightOffFloorIn", e.target.value)} style={{ ...S.input, width: 80 }} /></td>
                  <td style={S.td}><input type="number" min="0" step="0.01" placeholder="not offered" value={r.priceWithPackage} onChange={(e) => upd("priceWithPackage", e.target.value)} style={{ ...S.input, width: 110 }} /></td>
                  <td style={S.td}><input type="number" min="0" step="0.01" placeholder="not offered" value={r.priceStandalone} onChange={(e) => upd("priceStandalone", e.target.value)} style={{ ...S.input, width: 110 }} /></td>
                  <td style={{ ...S.td, textAlign: "center" }}><input type="checkbox" checked={r.internalOnly} onChange={(e) => upd("internalOnly", e.target.checked)} style={{ width: 16, height: 16, cursor: "pointer", accentColor: DOOR_MINT }} /></td>
                  <td style={{ ...S.td, textAlign: "center" }}><input type="checkbox" checked={r.taxable} onChange={(e) => upd("taxable", e.target.checked)} style={{ width: 16, height: 16, cursor: "pointer", accentColor: DOOR_MINT }} /></td>
                  <td style={S.td}>
                    <button onClick={() => setItems((p) => p.filter((_, j) => j !== i))}
                      style={{ background: "transparent", border: "none", cursor: "pointer", color: "#B91C1C", fontWeight: 700, fontSize: 13 }}>Remove</button>
                  </td>
                </tr>
              );
            })}
            {!items.length && (
              <tr><td colSpan={9} style={{ ...S.td, color: "#94A3B8", fontSize: 12.5 }}>No extra items yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <button onClick={() => setItems((p) => p.concat([{ id: "", name: "", icon: "\u26a1", mount: "wall", heightOffFloorIn: "", priceWithPackage: "", priceStandalone: "", taxable: true, active: true, internalOnly: false, sortOrder: (p.length + 1) * 10 }]))}
        style={{ ...S.btn("#F1F5F9", "#334155"), marginBottom: 14 }}>+ Add an item</button>


      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button onClick={save} disabled={busy} style={S.btn(DOOR_MINT, "#0F4C46")}>{busy ? "Saving\u2026" : "Save electrical"}</button>
        {msg && <span style={{ fontSize: 12.5, color: msg.err ? "#B91C1C" : "#047857" }}>{msg.err || msg.ok}</span>}
      </div>
    </div>
  );
}

function Insulation({ viewingLabel = null, clientId = null }) {
  const scoped = (body) => (viewingLabel && clientId ? { ...body, targetClientId: clientId } : body);
  const TYPES = [["batt", "Batt"], ["spray_foam", "Spray Foam"], ["rigid_foam", "Rigid Foam"]];
  const AREAS = [["floor", "Floor"], ["walls", "Walls"], ["roof", "Roof"]];
  const [cat, setCat] = useState(null);
  const [cells, setCells] = useState({});
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = async () => {
    const body = scoped({ action: "catalog" });
    const { data, error } = await window.__ssCatalogFlight(
      () => sb.functions.invoke("portal-settings", { body }),
      String(body.targetClientId == null ? (ssTargetClientId || "") : body.targetClientId));
    if (error || (data && data.error)) { setMsg({ err: (error && error.message) || data.error }); return; }
    setCat(data);
    setEnabled(data.insulationEnabled === true);
    const m = {};
    (data.insulation || []).forEach((r) => {
      m[r.ins_type + "|" + r.area] = {
        ratePerSqft: r.rate_per_sqft != null ? String(r.rate_per_sqft) : "",
        taxable: r.taxable !== false,
        active: r.active !== false,
        internalOnly: r.internal_only === true,
      };
    });
    setCells(m);
  };
  useEffect(() => { load(); }, []);

  const cellOf = (t, a) => cells[t + "|" + a] || { ratePerSqft: "", taxable: true, active: true, internalOnly: false };
  // Offer / Taxable / Internal only are per TYPE, so a tick writes the same value to all three
  // of that type's areas — the matrix stays one row per type, which is how a builder thinks
  // about it ("we do batt, we don't do spray foam").
  const setType = (t, field, val) => AREAS.forEach(([a]) => setCell(t, a, field, val));
  const typeFlag = (t, field, dflt) => AREAS.every(([a]) => (cellOf(t, a)[field] !== undefined ? cellOf(t, a)[field] : dflt));
  const setCell = (t, a, field, val) =>
    setCells((p) => ({ ...p, [t + "|" + a]: { ...cellOf(t, a), [field]: val } }));

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const rows = [];
      TYPES.forEach(([t]) => AREAS.forEach(([a]) => {
        const c = cellOf(t, a);
        rows.push({ type: t, area: a, ratePerSqft: String(c.ratePerSqft ?? "").trim(), taxable: c.taxable, active: c.active, internalOnly: c.internalOnly });
      }));
      // Refuse, never coerce -- a silently-zeroed rate would insulate a whole building free.
      const bad = rows.filter((r) => r.ratePerSqft !== "" && (!Number.isFinite(Number(r.ratePerSqft)) || Number(r.ratePerSqft) < 0));
      if (bad.length) throw new Error("Nothing was saved \u2014 fix these rate(s) first: " + bad.map((r) => r.type + "/" + r.area).join(", ") + ".");
      const { data, error } = await sb.functions.invoke("portal-settings", { body: scoped({ action: "save_insulation", enabled, rows }) });
      if (error || (data && data.error)) throw new Error((error && error.message) || data.error);
      await load();
      const skipped = data.skipped || [];
      setMsg({ ok: "Saved " + (data.saved || 0) + " rate(s)" + (data.cleared ? ", " + data.cleared + " no longer offered" : "") + (skipped.length ? ", " + skipped.length + " skipped" : "") + ".", skipped });
    } catch (e) { setMsg({ err: e.message }); }
    setBusy(false);
  };

  return (
    <div style={S.card}>
      <div style={S.h2}>Insulation</div>
      <p style={{ fontSize: 12.5, color: "#64748B", margin: "0 0 14px", maxWidth: 680 }}>
        Priced <b>per square foot</b>, worked out from the building the customer designed. Floor and
        roof use the footprint; walls use the perimeter &times; the wall height, so a taller-wall
        upgrade is included automatically. <b>Leave a rate blank and that combination isn&rsquo;t
        offered</b> &mdash; the customer simply won&rsquo;t see it. They pick the areas they want and
        each one lands as its own line on the quote. Only insulate under the floor? Fill in just the
        Floor rate for that type and leave Walls and Roof blank.
      </p>
      <label style={{ display: "inline-flex", alignItems: "center", gap: 8, marginBottom: 14, cursor: "pointer", fontSize: 13, fontWeight: 700, color: "#1E293B" }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)}
          style={{ width: 17, height: 17, cursor: "pointer", accentColor: DOOR_MINT }} />
        Offer insulation to customers
        <span style={{ fontWeight: 500, color: "#64748B" }}>&mdash; off hides it entirely without clearing your rates</span>
      </label>
      {msg && msg.err && <div style={S.err}>{msg.err}</div>}
      {msg && msg.ok && <div style={S.okMsg}>{msg.ok}{Array.isArray(msg.skipped) && msg.skipped.length > 0 && <div style={{ marginTop: 6, fontWeight: 500 }}>{msg.skipped.join(" \u00b7 ")}</div>}</div>}
      {!cat ? <SkelBar /> : (
        <>
          <table style={{ borderCollapse: "collapse", width: "100%", maxWidth: 640 }}>
            <thead><tr>
              <th style={S.th}></th>
              <th style={{ ...S.th, textAlign: "center" }} title="Untick a type you don't offer at all. Its rates are kept, but customers never see it.">Offer</th>
              {AREAS.map(([a, lbl]) => <th key={a} style={S.th} title="Dollars per square foot. Blank = not offered.">{lbl} ($/sq ft)</th>)}
              <th style={{ ...S.th, textAlign: "center" }} title="Available in the rep designer only — hidden from the customer-facing page. A rep-selected area still prices normally.">Internal only</th>
              <th style={{ ...S.th, textAlign: "center" }} title="Untick if you don't charge sales tax on insulation.">Taxable</th>
            </tr></thead>
            <tbody>
              {TYPES.map(([t, tLbl]) => (
                <tr key={t}>
                  <td style={{ ...S.td, fontWeight: 700 }}>{tLbl}</td>
                  <td style={{ ...S.td, textAlign: "center" }}>
                    <input type="checkbox" checked={typeFlag(t, "active", true)} onChange={(e) => setType(t, "active", e.target.checked)}
                      style={{ width: 16, height: 16, cursor: "pointer", accentColor: DOOR_MINT }} />
                  </td>
                  {AREAS.map(([a]) => (
                    <td key={a} style={S.td}>
                      <input type="number" min="0" step="0.01" value={cellOf(t, a).ratePerSqft} placeholder="not offered"
                        onChange={(e) => setCell(t, a, "ratePerSqft", e.target.value)} style={{ ...S.input, width: 110 }} />
                    </td>
                  ))}
                  <td style={{ ...S.td, textAlign: "center" }}>
                    <input type="checkbox" checked={typeFlag(t, "internalOnly", false)} onChange={(e) => setType(t, "internalOnly", e.target.checked)}
                      style={{ width: 16, height: 16, cursor: "pointer", accentColor: DOOR_MINT }} />
                  </td>
                  <td style={{ ...S.td, textAlign: "center" }}>
                    <input type="checkbox" checked={typeFlag(t, "taxable", true)} onChange={(e) => setType(t, "taxable", e.target.checked)}
                      style={{ width: 16, height: 16, cursor: "pointer", accentColor: DOOR_MINT }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 14 }}>
            <button onClick={save} disabled={busy} style={S.btn(DOOR_MINT, "#0F4C46")}>{busy ? "Saving\u2026" : "Save insulation"}</button>
          </div>
        </>
      )}
    </div>
  );
}

// ── Foundation (237) ──────────────────────────────────────────────────────────────────────
// Site work done before the building arrives (Carolyn 2026-09-14: "gravel pad, Fence removal,
// piers, and concrete slab. ALL of these should have multiple ways of charging for them").
// A FIXED four rows with a label override — the cladding shape — per TENANT, not per style.
const SS_FOUNDATION_ROWS = [
  { id: "gravel_pad",    label: "Gravel pad",    basis: "sqft_option" },
  { id: "fence_removal", label: "Fence removal", basis: "lineal_ft" },
  { id: "piers",         label: "Piers",         basis: "each" },
  { id: "concrete_slab", label: "Concrete slab", basis: "sqft_option" },
];
// The seven shared methods. `each` is labelled each here, NOT "flat rate" as on the wall-height
// fee: piers are "each" and DO take a count the customer enters (starting at 1).
const SS_FOUNDATION_BASES = [
  ["each", "each"],
  ["lineal_ft", "lineal ft"],
  ["sqft_option", "sqft option"],
  ["sqft_building", "sqft building"],
  ["perimeter_building", "perimeter building"],
  ["pct_building_price", "pct building price"],
  ["pct_estimate_total", "pct estimate total"],
];

function Foundation({ viewingLabel = null, clientId = null }) {
  const scoped = (body) => (viewingLabel && clientId ? { ...body, targetClientId: clientId } : body);
  const [cat, setCat] = useState(null);
  const [rows, setRows] = useState({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = async () => {
    const body = scoped({ action: "catalog" });
    const { data, error } = await window.__ssCatalogFlight(
      () => sb.functions.invoke("portal-settings", { body }),
      String(body.targetClientId == null ? (ssTargetClientId || "") : body.targetClientId));
    if (error || (data && data.error)) { setMsg({ err: (error && error.message) || data.error }); return; }
    setCat(data);
    const saved = {};
    (data.foundation || []).forEach((r) => { saved[r.item_id] = r; });
    const m = {};
    SS_FOUNDATION_ROWS.forEach((d) => {
      const r = saved[d.id];
      m[d.id] = {
        labelOverride: r && r.label_override ? String(r.label_override) : "",
        rate: r && r.rate != null ? String(r.rate) : "",
        basis: (r && r.basis) || d.basis,
        taxable: !r || r.taxable !== false,
        active: !r || r.active !== false,
        internalOnly: !!r && r.internal_only === true,
      };
    });
    setRows(m);
  };
  useEffect(() => { load(); }, []);
  const rowOf = (id) => rows[id] || { labelOverride: "", rate: "", basis: "each", taxable: true, active: true, internalOnly: false };
  const setRow = (id, field, val) => setRows((p) => ({ ...p, [id]: { ...rowOf(id), [field]: val } }));

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const out = SS_FOUNDATION_ROWS.map((d) => {
        const r = rowOf(d.id);
        return { itemId: d.id, labelOverride: r.labelOverride, rate: String(r.rate ?? "").trim(), basis: r.basis, taxable: r.taxable, active: r.active, internalOnly: r.internalOnly };
      });
      // Refuse, never coerce — a silently-zeroed rate would pour a slab for free.
      const bad = out.filter((r) => r.rate !== "" && (!Number.isFinite(Number(r.rate)) || Number(r.rate) < 0));
      if (bad.length) throw new Error("Nothing was saved \u2014 fix these rate(s) first: " + bad.map((r) => r.itemId.replace("_", " ")).join(", ") + ".");
      const { data, error } = await sb.functions.invoke("portal-settings", { body: scoped({ action: "save_foundation", rows: out }) });
      if (error || (data && data.error)) throw new Error((error && error.message) || data.error);
      await load();
      const skipped = data.skipped || [];
      setMsg({ ok: "Saved " + (data.saved || 0) + " item(s)" + (skipped.length ? ", " + skipped.length + " skipped" : "") + ".", skipped });
    } catch (e) { setMsg({ err: e.message }); }
    setBusy(false);
  };

  return (
    <div style={S.card}>
      <div style={S.h2}>Foundation</div>
      <p style={{ fontSize: 12.5, color: "#64748B", margin: "0 0 8px", maxWidth: 680 }}>
        Site work you do before the building arrives. <b>Leave a rate blank and that item isn&rsquo;t
        offered</b>; 0 means it is included; anything else is a charge, worked out by the method you pick.
        Each one the customer chooses lands as its own line on the quote.
      </p>
      <p style={{ fontSize: 12.5, color: "#64748B", margin: "0 0 14px", maxWidth: 680 }}>
        <b>each</b> = rate &times; a count the customer enters (piers, starting at 1); <b>lineal ft</b> = rate &times; the
        feet they enter (fence); <b>sqft option</b> = rate &times; the square feet they enter, pre-filled with the
        building&rsquo;s footprint (pad, slab); <b>sqft building</b> = rate &times; (width &times; depth);
        <b> perimeter building</b> = rate &times; 2 &times; (width + depth); <b>pct building price</b> = (rate &divide; 100)
        &times; base building price; <b>pct estimate total</b> = (rate &divide; 100) &times; subtotal of all other lines, resolved last.
      </p>
      {msg && msg.err && <div style={S.err}>{msg.err}</div>}
      {msg && msg.ok && <div style={S.okMsg}>{msg.ok}{Array.isArray(msg.skipped) && msg.skipped.length > 0 && <div style={{ marginTop: 6, fontWeight: 500 }}>{msg.skipped.join(" \u00b7 ")}</div>}</div>}
      {!cat ? <SkelBar /> : (
        <>
          <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", maxWidth: 900 }}>
            <thead><tr>
              <th style={S.th}>Item</th>
              <th style={S.th} title="How it reads on the designer and the quote. Blank keeps the built-in name.">Shown as</th>
              <th style={S.th} title="Which of the seven methods prices it. Three of them ask the customer for a number.">How it&rsquo;s priced</th>
              <th style={S.th} title="Dollars, or a percent for the two pct methods. Blank = not offered; 0 = included.">Rate</th>
              <th style={{ ...S.th, textAlign: "center" }} title="Untick to park this item without losing its rate. Customers never see it while unticked.">Offer</th>
              <th style={{ ...S.th, textAlign: "center" }} title="Available in the rep designer only — hidden from the customer-facing page. A rep-selected item still prices normally.">Internal only</th>
              <th style={{ ...S.th, textAlign: "center" }} title="Untick if you don't charge sales tax on this service.">Taxable</th>
            </tr></thead>
            <tbody>
              {SS_FOUNDATION_ROWS.map((d) => {
                const r = rowOf(d.id);
                return (
                  <tr key={d.id}>
                    <td style={{ ...S.td, fontWeight: 700, whiteSpace: "nowrap" }}>{d.label}</td>
                    <td style={S.td}><input type="text" value={r.labelOverride} placeholder={d.label} maxLength={60}
                      onChange={(e) => setRow(d.id, "labelOverride", e.target.value)} style={{ ...S.input, width: 170 }} /></td>
                    <td style={S.td}>
                      <select value={r.basis} onChange={(e) => setRow(d.id, "basis", e.target.value)} style={{ ...S.input, width: 190 }}>
                        {SS_FOUNDATION_BASES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </select>
                    </td>
                    <td style={S.td}><input type="number" min="0" step="0.01" value={r.rate} placeholder="not offered"
                      onChange={(e) => setRow(d.id, "rate", e.target.value)} style={{ ...S.input, width: 120 }} /></td>
                    <td style={{ ...S.td, textAlign: "center" }}><input type="checkbox" checked={r.active} onChange={(e) => setRow(d.id, "active", e.target.checked)} style={{ width: 16, height: 16, cursor: "pointer", accentColor: DOOR_MINT }} /></td>
                    <td style={{ ...S.td, textAlign: "center" }}><input type="checkbox" checked={r.internalOnly} onChange={(e) => setRow(d.id, "internalOnly", e.target.checked)} style={{ width: 16, height: 16, cursor: "pointer", accentColor: DOOR_MINT }} /></td>
                    <td style={{ ...S.td, textAlign: "center" }}><input type="checkbox" checked={r.taxable} onChange={(e) => setRow(d.id, "taxable", e.target.checked)} style={{ width: 16, height: 16, cursor: "pointer", accentColor: DOOR_MINT }} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
          <div style={{ marginTop: 14 }}>
            <button onClick={save} disabled={busy} style={S.btn(DOOR_MINT, "#0F4C46")}>{busy ? "Saving\u2026" : "Save foundation"}</button>
          </div>
        </>
      )}
    </div>
  );
}

// ── Delivery (233–236) ────────────────────────────────────────────────────────────────────
// Carolyn 2026-09-14: "the option for them to setup their delivery fees and the option for them
// to set it up for the fees to be charged based on the miles from either the main builder
// address or any location address. They should specify whether they want the delivery fee to
// automatically add based on their rules.. or not automate it." Four rule shapes, three origins,
// one switch. Miles are driving miles from Google, whole and rounded up; the "Test an address"
// box at the bottom prices an address exactly as the customer designer and the estimate will.
const SS_DELIVERY_RULES = [
  ["flat", "One flat fee", "The same delivery fee on every job."],
  ["base_plus", "Base fee + per mile", "A call-out fee plus a rate for every mile from your origin."],
  ["free_radius", "Free within a radius, then per mile", "No charge up to N miles; beyond that, a rate per mile."],
  ["bands", "Mileage bands", "A flat fee for each range of miles — 0–25, 26–50, and so on."],
];
const SS_DELIVERY_ORIGINS = [
  ["business", "Our business address", "From the address under Settings → Company."],
  ["nearest", "The nearest of our locations", "Whichever of your business address and Locations is closest to the customer."],
  ["rep", "The rep's home lot", "The location set for whoever is quoting (Settings → Company → Team). The customer designer, which has no rep, uses the nearest location."],
];

function DeliveryView({ viewingLabel = null, clientId = null }) {
  const scoped = (body) => (viewingLabel && clientId ? { ...body, targetClientId: clientId } : body);
  const [data, setData] = useState(null);
  const [f, setF] = useState({ automate: false, originMode: "business", ruleType: "flat", flatFee: "", baseFee: "", perMile: "", freeMiles: "", perMileCounts: "beyond", bands: [], ssTaxDelivery: false });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [test, setTest] = useState({ street: "", city: "", state: "", zip: "" });
  const [testRes, setTestRes] = useState(null);
  const [testing, setTesting] = useState(false);
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e && e.target ? (e.target.type === "checkbox" ? e.target.checked : e.target.value) : e }));

  const load = async () => {
    const { data: d, error } = await sb.functions.invoke("portal-settings", { body: scoped({ action: "delivery_settings" }) });
    if (error || (d && d.error)) { setMsg({ err: (error && error.message) || d.error }); return; }
    setData(d);
    const s = d.settings || null;
    const num = (v) => (v == null ? "" : String(v));
    setF({
      automate: !!(s && s.automate),
      originMode: (s && s.origin_mode) || "business",
      ruleType: (s && s.rule_type) || "flat",
      flatFee: num(s && s.flat_fee), baseFee: num(s && s.base_fee), perMile: num(s && s.per_mile), freeMiles: num(s && s.free_miles),
      perMileCounts: (s && s.per_mile_counts) || "beyond",
      bands: Array.isArray(s && s.bands) ? s.bands.map((b) => ({ minMiles: num(b.minMiles), maxMiles: num(b.maxMiles), fee: num(b.fee) })) : [],
      ssTaxDelivery: d.ssTaxDelivery === true,
    });
  };
  useEffect(() => { load(); }, []);

  // Bands: min follows the previous band's max + 1, so the builder only ever types the top of
  // each range and a fee — contiguity is by construction here and checked again on the server.
  const bandsFixed = (list) => {
    let next = 0;
    return list.map((b) => { const out = { ...b, minMiles: String(next) }; const mx = Number(b.maxMiles); if (Number.isFinite(mx)) next = Math.floor(mx) + 1; return out; });
  };
  const setBand = (i, k, v) => setF((p) => ({ ...p, bands: bandsFixed(p.bands.map((b, j) => (j === i ? { ...b, [k]: v } : b))) }));
  const addBand = () => setF((p) => ({ ...p, bands: bandsFixed([...p.bands, { minMiles: "", maxMiles: "", fee: "" }]) }));
  const delBand = (i) => setF((p) => ({ ...p, bands: bandsFixed(p.bands.filter((_, j) => j !== i)) }));

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const body = scoped({
        action: "save_delivery_settings",
        automate: f.automate, originMode: f.originMode, ruleType: f.ruleType,
        flatFee: f.flatFee, baseFee: f.baseFee, perMile: f.perMile, freeMiles: f.freeMiles, perMileCounts: f.perMileCounts,
        bands: f.bands.map((b) => ({ minMiles: b.minMiles, maxMiles: b.maxMiles, fee: b.fee })),
        ssTaxDelivery: f.ssTaxDelivery,
      });
      const { data: d, error } = await sb.functions.invoke("portal-settings", { body });
      if (error || (d && d.error)) throw new Error((error && error.message) || d.error);
      await load();
      setMsg({ ok: "Delivery settings saved." });
    } catch (e) { setMsg({ err: e.message }); }
    setBusy(false);
  };

  const runTest = async () => {
    setTesting(true); setTestRes(null);
    try {
      const { data: d, error } = await sb.functions.invoke("portal-settings", { body: scoped({ action: "delivery_test_address", address: test }) });
      if (error || (d && d.error)) throw new Error((error && error.message) || d.error);
      setTestRes(d.quote);
    } catch (e) { setTestRes({ error: e.message }); }
    setTesting(false);
  };

  const addrLine = (a) => a ? [a.street || a.addressLine1, a.city, a.state, a.zip || a.postalCode].filter(Boolean).join(", ") : "";
  const money = (v) => "$" + (Number(v) || 0).toFixed(2);
  const numBox = (k, ph, w = 110) => <input type="number" min="0" step="0.01" value={f[k]} placeholder={ph} onChange={set(k)} style={{ ...S.input, width: w }} />;
  const needsMiles = f.ruleType !== "flat";
  const reasonText = (r) => ({
    beyond_last_band: "beyond your last mileage band — left for the rep",
    no_distance: "no driving distance could be found",
    no_route: "no driving route could be found",
    rule_incomplete: "the rule above is missing a number",
    no_origin: "no origin has a full address",
    distance_not_configured: "distance lookups aren't configured on this server",
    not_configured: "no delivery rules saved yet",
  })[r] || r;

  return (
    <div style={S.card}>
      <div style={S.h2}>Delivery</div>
      <p style={{ fontSize: 12.5, color: "#64748B", margin: "0 0 14px", maxWidth: 680 }}>
        How delivery is charged. Pick where it is measured from and how the fee is worked out, then
        choose whether it is <b>added automatically</b> — the customer sees it in the designer as soon as
        they enter their address, and it lands on the quote — or left for the rep, who sees the figure
        these rules suggest and decides. Miles are <b>driving miles</b>, rounded up to the next whole mile.
      </p>
      {msg && msg.err && <div style={S.err}>{msg.err}</div>}
      {msg && msg.ok && <div style={S.okMsg}>{msg.ok}</div>}
      {!data ? <SkelBar /> : (
        <>
          {!data.distanceConfigured && (
            <div style={{ ...S.err, background: "#FFFBEB", color: "#92400E", border: "1px solid #FDE68A" }}>
              Distance lookups aren&rsquo;t configured on this server yet, so only a flat fee can run automatically.
              Mileage rules can still be saved; ask CSM Synergy to add the Google key.
            </div>
          )}

          <label style={{ display: "inline-flex", alignItems: "center", gap: 8, marginBottom: 16, cursor: "pointer", fontSize: 13, fontWeight: 700, color: "#1E293B" }}>
            <input type="checkbox" checked={f.automate} onChange={set("automate")} style={{ width: 17, height: 17, cursor: "pointer", accentColor: DOOR_MINT }} />
            Add the delivery fee automatically
            <span style={{ fontWeight: 500, color: "#64748B" }}>&mdash; off means the rep types it, with this figure suggested</span>
          </label>

          <div style={{ ...S.lbl, marginBottom: 6 }}>Measured from</div>
          <div style={{ display: "grid", gap: 6, marginBottom: 6, maxWidth: 680 }}>
            {SS_DELIVERY_ORIGINS.map(([v, l, hint]) => (
              <label key={v} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12.5, cursor: "pointer" }}>
                <input type="radio" name="ss-dlv-origin" checked={f.originMode === v} onChange={() => setF((p) => ({ ...p, originMode: v }))} style={{ marginTop: 2, accentColor: DOOR_MINT }} />
                <span><b style={{ color: "#1E293B" }}>{l}</b> <span style={{ color: "#64748B" }}>&mdash; {hint}</span></span>
              </label>
            ))}
          </div>
          <div style={{ fontSize: 11.5, color: "#64748B", marginBottom: 16, maxWidth: 680 }}>
            On file: <b>{addrLine(data.businessAddress) || "no business address yet"}</b>
            {(data.locations || []).length > 0 && <> &middot; locations: {data.locations.map((l) => l.name + (l.city ? " (" + l.city + ")" : "")).join(", ")}</>}
            {" "}&middot; <a href="/portal/settings/company" style={{ color: "#1B7895" }}>Company</a> &middot; <a href="/portal/settings/locations" style={{ color: "#1B7895" }}>Locations</a>
          </div>

          <div style={{ ...S.lbl, marginBottom: 6 }}>How the fee is worked out</div>
          <div style={{ display: "grid", gap: 6, marginBottom: 10, maxWidth: 680 }}>
            {SS_DELIVERY_RULES.map(([v, l, hint]) => (
              <label key={v} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12.5, cursor: "pointer" }}>
                <input type="radio" name="ss-dlv-rule" checked={f.ruleType === v} onChange={() => setF((p) => ({ ...p, ruleType: v }))} style={{ marginTop: 2, accentColor: DOOR_MINT }} />
                <span><b style={{ color: "#1E293B" }}>{l}</b> <span style={{ color: "#64748B" }}>&mdash; {hint}</span></span>
              </label>
            ))}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end", marginBottom: 16, padding: "10px 12px", background: "#F8FAFC", borderRadius: 8, maxWidth: 680 }}>
            {f.ruleType === "flat" && <div><span style={S.lbl}>Delivery fee ($)</span>{numBox("flatFee", "0.00")}</div>}
            {f.ruleType === "base_plus" && (<>
              <div><span style={S.lbl}>Base fee ($)</span>{numBox("baseFee", "0.00")}</div>
              <div><span style={S.lbl}>Per mile ($)</span>{numBox("perMile", "0.00")}</div>
            </>)}
            {f.ruleType === "free_radius" && (<>
              <div><span style={S.lbl}>Free within (miles)</span>{numBox("freeMiles", "25")}</div>
              <div><span style={S.lbl}>Then per mile ($)</span>{numBox("perMile", "0.00")}</div>
              <div><span style={S.lbl}>Per-mile rate counts</span>
                <select value={f.perMileCounts} onChange={set("perMileCounts")} style={{ ...S.input, width: 220 }}>
                  <option value="beyond">only the miles beyond the radius</option>
                  <option value="all">every mile from the origin</option>
                </select></div>
            </>)}
            {f.ruleType === "bands" && (
              <div style={{ width: "100%" }}>
                <table style={{ borderCollapse: "collapse" }}>
                  <thead><tr><th style={S.th}>From (mi)</th><th style={S.th}>To (mi)</th><th style={S.th}>Fee ($)</th><th style={S.th}></th></tr></thead>
                  <tbody>
                    {f.bands.map((b, i) => (
                      <tr key={i}>
                        <td style={S.td}><input type="number" value={b.minMiles} readOnly style={{ ...S.input, width: 80, background: "#F1F5F9" }} /></td>
                        <td style={S.td}><input type="number" min="0" step="1" value={b.maxMiles} onChange={(e) => setBand(i, "maxMiles", e.target.value)} style={{ ...S.input, width: 80 }} /></td>
                        <td style={S.td}><input type="number" min="0" step="0.01" value={b.fee} onChange={(e) => setBand(i, "fee", e.target.value)} style={{ ...S.input, width: 100 }} /></td>
                        <td style={S.td}><button onClick={() => delBand(i)} title="Remove" style={{ background: "transparent", border: "none", cursor: "pointer", color: "#94A3B8", fontWeight: 800 }}>&#x2715;</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <button onClick={addBand} style={{ background: "transparent", border: "none", color: "#1B7895", fontWeight: 700, fontSize: 13, cursor: "pointer", padding: "8px 0 0" }}>+ Add band</button>
                <div style={{ fontSize: 11.5, color: "#64748B", marginTop: 4 }}>Ranges follow on from each other automatically. An address beyond the last band is not priced automatically &mdash; it is left for the rep.</div>
              </div>
            )}
          </div>

          <label style={{ display: "inline-flex", alignItems: "center", gap: 8, marginBottom: 16, cursor: "pointer", fontSize: 13, fontWeight: 700, color: "#1E293B" }}>
            <input type="checkbox" checked={f.ssTaxDelivery} onChange={set("ssTaxDelivery")} style={{ width: 17, height: 17, cursor: "pointer", accentColor: DOOR_MINT }} />
            Taxable
            {/* The twin of "Charge tax on delivery" on CRM Connection → Quotes & Invoices (both write
                ss_tax_delivery). It used to point at Company → Business details, which has no such switch. */}
            <span style={{ fontWeight: 500, color: "#64748B" }}>&mdash; charge sales tax on the delivery line (the same switch as CRM Connection &rarr; Quotes &amp; Invoices)</span>
          </label>

          <div>
            <button onClick={save} disabled={busy} style={S.btn(DOOR_MINT, "#0F4C46")}>{busy ? "Saving\u2026" : "Save delivery"}</button>
          </div>

          <div style={{ marginTop: 22, paddingTop: 14, borderTop: "1px solid #E2E8F0", maxWidth: 680 }}>
            <div style={{ ...S.lbl, marginBottom: 6 }}>Test an address</div>
            <div style={{ fontSize: 11.5, color: "#64748B", marginBottom: 8 }}>Prices an address against the rules <b>as saved</b> &mdash; save first. This is exactly what the customer will see and be charged.</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}>
              <div style={{ flex: "2 1 200px" }}><span style={S.lbl}>Street</span><input value={test.street} onChange={(e) => setTest((p) => ({ ...p, street: e.target.value }))} style={{ ...S.input, width: "100%", boxSizing: "border-box" }} /></div>
              <div style={{ flex: "1 1 120px" }}><span style={S.lbl}>City</span><input value={test.city} onChange={(e) => setTest((p) => ({ ...p, city: e.target.value }))} style={{ ...S.input, width: "100%", boxSizing: "border-box" }} /></div>
              <div style={{ flex: "0 1 90px" }}><span style={S.lbl}>State</span><input value={test.state} onChange={(e) => setTest((p) => ({ ...p, state: e.target.value }))} style={{ ...S.input, width: "100%", boxSizing: "border-box" }} /></div>
              <div style={{ flex: "0 1 90px" }}><span style={S.lbl}>Zip</span><input value={test.zip} onChange={(e) => setTest((p) => ({ ...p, zip: e.target.value.replace(/\D/g, "").slice(0, 5) }))} style={{ ...S.input, width: "100%", boxSizing: "border-box" }} /></div>
              <button onClick={runTest} disabled={testing || !test.city || !test.state || !test.zip} style={S.btn("#F1F5F9", "#334155")}>{testing ? "Checking\u2026" : "Check"}</button>
            </div>
            {testRes && (
              <div style={{ marginTop: 10, fontSize: 12.5, color: "#1E293B" }}>
                {testRes.error ? <span style={{ color: "#DC2626" }}>{testRes.error}</span>
                  : testRes.autoPriced
                    ? <><b>{money(testRes.amount)}</b> &mdash; {testRes.desc}{needsMiles && testRes.miles != null ? "" : ""}</>
                    : <>Not priced automatically &mdash; {reasonText(testRes.reason)}{testRes.miles != null ? " (" + testRes.miles + " mi" + (testRes.originName ? " from " + testRes.originName : "") + ")" : ""}.</>}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function WallHeights({ viewingLabel = null, clientId = null }) {
  // Operator view-as: state the effective tenant explicitly, same as every sibling card here.
  const scoped = (body) => (viewingLabel && clientId ? { ...body, targetClientId: clientId } : body);
  const [cat, setCat] = useState(null);
  const [byStyle, setByStyle] = useState({});
  const [busyId, setBusyId] = useState(null);
  const [msg, setMsg] = useState(null);

  const load = async () => {
    const body = scoped({ action: "catalog" });
    const { data, error } = await window.__ssCatalogFlight(
      () => sb.functions.invoke("portal-settings", { body }),
      String(body.targetClientId == null ? (ssTargetClientId || "") : body.targetClientId));
    if (error || (data && data.error)) { setMsg({ err: (error && error.message) || data.error }); return; }
    setCat(data);
    const m = {};
    (data.styles || []).forEach((st) => { m[st.id] = []; });
    (data.wallHeights || []).forEach((r) => {
      (m[r.style_id] = m[r.style_id] || []).push({
        id: r.id,
        deltaIn: String(r.delta_in),
        ratePerLf: r.rate_per_lf != null ? String(r.rate_per_lf) : "",
        taxable: r.taxable !== false,
        active: r.active !== false,
        internalOnly: r.internal_only === true,
        widthsFt: Array.isArray(r.widths_ft) ? r.widths_ft.map(Number) : null,
        buildOnSite: r.build_on_site === true,
        bosFeeBasis: r.bos_fee_basis || "each",
        bosFeeRate: r.bos_fee_rate != null ? String(r.bos_fee_rate) : "",
      });
    });
    setByStyle(m);
  };
  useEffect(() => { load(); }, []);

  const setRow = (styleId, idx, field, val) =>
    setByStyle((p) => ({ ...p, [styleId]: (p[styleId] || []).map((r, i) => (i === idx ? { ...r, [field]: val } : r)) }));
  const addRow = (styleId) =>
    setByStyle((p) => ({ ...p, [styleId]: [...(p[styleId] || []), { id: "", deltaIn: "", ratePerLf: "", taxable: true, active: true, internalOnly: false, widthsFt: null, buildOnSite: false, bosFeeBasis: "each", bosFeeRate: "" }] }));
  const delRow = (styleId, idx) =>
    setByStyle((p) => ({ ...p, [styleId]: (p[styleId] || []).filter((_, i) => i !== idx) }));

  const save = async (styleId, styleLabel) => {
    setBusyId(styleId); setMsg(null);
    try {
      const rows = byStyle[styleId] || [];
      // Refuse, never coerce -- the same posture as the rate grid. A silently-zeroed increase
      // would quote a structural change at nothing.
      const bad = rows.filter((r) => {
        const d = Number(String(r.deltaIn).trim());
        return !Number.isInteger(d) || d <= 0 || d > 48;
      });
      if (bad.length) throw new Error("Nothing was saved \u2014 every increase must be a whole number of inches between 1 and 48. Check: " + bad.map((r) => '"' + r.deltaIn + '"').join(", ") + ".");
      const noWidths = rows.filter((r) => Array.isArray(r.widthsFt) && r.widthsFt.length === 0);
      if (noWidths.length) throw new Error(`Nothing was saved — an increase with no widths ticked would never be offered to anyone. Tick at least one width, or untick Active to retire it: ${noWidths.map((r) => "+" + r.deltaIn + " in").join(", ")}.`);
      const badRate = rows.filter((r) => {
        const t = String(r.ratePerLf == null ? "" : r.ratePerLf).trim();
        return t !== "" && (!Number.isFinite(Number(t)) || Number(t) < 0);
      });
      if (badRate.length) throw new Error("Nothing was saved \u2014 fix these rate(s) first: " + badRate.map((r) => "+" + r.deltaIn + " in (\"" + r.ratePerLf + "\")").join(", ") + ".");
      // A build-on-site fee is OPTIONAL (a builder may absorb it) but must be usable if typed.
      // Caught here as well as on the server so the message names the row rather than arriving
      // as a "skipped" line after the save has already half-run.
      const badBos = rows.filter((r) => {
        if (!r.buildOnSite) return false;
        const t = String(r.bosFeeRate == null ? "" : r.bosFeeRate).trim();
        return t !== "" && (!Number.isFinite(Number(t)) || Number(t) < 0);
      });
      if (badBos.length) throw new Error("Nothing was saved \u2014 fix these build-on-site fee(s) first: " + badBos.map((r) => "+" + r.deltaIn + " in (\"" + r.bosFeeRate + "\")").join(", ") + ".");
      // The same increase twice is fine once hauled and once Built on site, on different widths.
      const clash = whClash(rows, widthsOf(styleId));
      if (clash) throw new Error("Nothing was saved \u2014 " + clash);
      const { data, error } = await sb.functions.invoke("portal-settings", {
        body: scoped({
          action: "save_wall_heights",
          styleId,
          rows: rows.map((r) => ({
            id: r.id || undefined,
            deltaIn: Number(String(r.deltaIn).trim()),
            ratePerLf: String(r.ratePerLf == null ? "" : r.ratePerLf).trim(),
            taxable: r.taxable,
            active: r.active,
            internalOnly: r.internalOnly,
            widthsFt: r.widthsFt,
            buildOnSite: r.buildOnSite,
            bosFeeBasis: r.bosFeeBasis,
            bosFeeRate: String(r.bosFeeRate == null ? "" : r.bosFeeRate).trim(),
          })),
        }),
      });
      if (error || (data && data.error)) throw new Error((error && error.message) || data.error);
      await load();
      const skipped = data.skipped || [];
      setMsg({ ok: styleLabel + ": saved " + (data.saved || 0) + " height(s)" + (data.deleted ? ", removed " + data.deleted : "") + (skipped.length ? ", " + skipped.length + " skipped" : "") + ".", skipped });
    } catch (e) { setMsg({ err: e.message }); }
    setBusyId(null);
  };

  // The widths this style actually sells, from its own sizes.
  const widthsOf = (styleId) => [...new Set(((cat && cat.sizes) || [])
    .filter((z) => z.style_id === styleId && z.active !== false)
    .map((z) => Number(z.width_ft)).filter((w) => Number.isFinite(w)))].sort((a, b) => a - b);

  // null means "every width" — ticking one off has to materialise the full list first, or the
  // living default would be lost the moment a builder unticks a single box.
  const toggleWidth = (styleId, idx, w, on, all) =>
    setByStyle((p) => ({ ...p, [styleId]: (p[styleId] || []).map((r, i) => {
      if (i !== idx) return r;
      const cur = Array.isArray(r.widthsFt) ? r.widthsFt : all;
      const next = on ? [...new Set([...cur, w])].sort((a, b) => a - b) : cur.filter((x) => x !== w);
      // Back to all ticked = back to the living default.
      return { ...r, widthsFt: (all.length && next.length === all.length) ? null : next };
    }) }));

  const renderSection = (st) => {
    const rows = byStyle[st.id] || [];
    const widths = widthsOf(st.id);
    // Local overrides for this table only (Carolyn 2026-09-12). S.th is nowrap, so the two narrow
    // columns collided ("INTERNAL ONLYBUILT ON SITE") — those two wrap onto two lines and every
    // header sits on the bottom so the baselines agree. S.td is top-aligned, which parked the
    // checkboxes above the taller inputs — the main row is middle-aligned. The number inputs keep
    // S.input's width:100% so they fit their column instead of crossing into the widths.
    const thB = { ...S.th, verticalAlign: "bottom" };
    const thC = { ...thB, textAlign: "center" };
    const thWrap = { ...thC, whiteSpace: "normal", lineHeight: 1.2 };
    const tdMid = { ...S.td, verticalAlign: "middle" };
    return (
      <div key={st.id} style={{ ...S.card, marginBottom: 12 }}>
        {/* The style's STANDARD wall height, right behind its name (Carolyn 2026-09-12). Read
            from the same catalog payload the 3D calibration writes (building_styles.d3), so it
            is always what the designer will actually draw. 8 ft is the designer's own fallback
            for an uncalibrated style (`|| 8` in structure-studio.component.js), so an unset
            style says so instead of showing a number as if someone had chosen it. */}
        <div style={{ ...S.h2, display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <span>{st.label}</span>
          {(() => {
            const h = st.d3 && Number(st.d3.wallHeightFt);
            const calibrated = Number.isFinite(h) && h > 0;
            return (
              <span title={calibrated ? "Standard wall height, from 3D Style Calibration" : "No wall height calibrated yet — the designer assumes 8 ft. Set it under Settings → Designer → 3D Style Calibration."}
                style={{ fontSize: 12, fontWeight: 600, color: calibrated ? "#1B7895" : "#94A3B8" }}>
                standard wall {calibrated ? h : 8} ft{calibrated ? "" : " (not set — using the default)"}
              </span>
            );
          })()}
        </div>
        {rows.length === 0 ? (
          <p style={{ fontSize: 12.5, color: "#64748B", margin: "0 0 10px" }}>
            No taller-wall option offered on this style — customers see no wall-height choice.
          </p>
        ) : (
          <table style={{ borderCollapse: "collapse", width: "100%", maxWidth: 980, tableLayout: "fixed" }}>
            <colgroup><col style={{ width: "10%" }} /><col style={{ width: "10%" }} /><col style={{ width: "19%" }} /><col style={{ width: "8%" }} /><col style={{ width: "8%" }} /><col style={{ width: "8%" }} /><col style={{ width: "7%" }} /><col style={{ width: "26%" }} /><col style={{ width: "4%" }} /></colgroup>
            <thead><tr>
              <th style={thB} title="How much taller than this style's standard wall, in whole inches.">Increase (in)</th>
              <th style={thB} title="Charged per lineal foot of the building's perimeter. Leave blank to keep the row without offering it yet.">$ / lineal ft</th>
              <th style={thB} title="Which building widths this increase is offered on. Taller walls raise the haul height, and a wider building already has a taller roof — so a narrow building can take more. A width added to this style later arrives unticked, never offered by default.">Offered on widths</th>
              <th style={thWrap} title="Available in the rep designer only — hidden from the customer-facing page. A rep-selected increase still prices normally.">Internal only</th>
              <th style={thWrap} title="Walls this tall can't go under a bridge, so a building with this increase is assembled on the customer's site instead of hauled. Tick it to set the upcharge for sending a crew out.">Built on site</th>
              <th style={thC} title="Untick if you don't charge sales tax on this upgrade.">Taxable</th>
              <th style={thC}>Active</th>
              <th style={thB} title="The upcharge for sending a crew out, on rows ticked Built on site. Amount, then how it is charged — flat rate is one fee for the job; the rest use the same methods as layout items. Leave the amount blank if you don't charge extra: the building is still marked built on site.">On-site fee</th>
              <th style={thB}></th>
            </tr></thead>
            <tbody>
              {rows.map((r, i) => [
                <tr key={(r.id || ("new-" + i)) + "-main"}>
                  <td style={tdMid}><input type="number" min="1" max="48" step="1" value={r.deltaIn} onChange={(e) => setRow(st.id, i, "deltaIn", e.target.value)} style={S.input} /></td>
                  <td style={tdMid}><input type="number" min="0" step="0.01" value={r.ratePerLf} placeholder="not offered" onChange={(e) => setRow(st.id, i, "ratePerLf", e.target.value)} style={S.input} /></td>
                  <td style={tdMid}>
                    {widths.length === 0 ? <span style={{ color: "#94A3B8", fontSize: 12 }}>no sizes yet</span> : (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                        {widths.map((w) => {
                          const on = !Array.isArray(r.widthsFt) || r.widthsFt.indexOf(w) !== -1;
                          return (
                            <label key={w} style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                              <input type="checkbox" checked={on} onChange={(e) => toggleWidth(st.id, i, w, e.target.checked, widths)} style={{ width: 14, height: 14, cursor: "pointer", accentColor: DOOR_MINT }} />
                              {w}
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </td>
                  <td style={{ ...tdMid, textAlign: "center" }}><input type="checkbox" checked={!!r.internalOnly} onChange={(e) => setRow(st.id, i, "internalOnly", e.target.checked)} style={{ width: 16, height: 16, cursor: "pointer", accentColor: DOOR_MINT }} /></td>
                  <td style={{ ...tdMid, textAlign: "center" }}><input type="checkbox" checked={!!r.buildOnSite} onChange={(e) => setRow(st.id, i, "buildOnSite", e.target.checked)} style={{ width: 16, height: 16, cursor: "pointer", accentColor: DOOR_MINT }} /></td>
                  <td style={{ ...tdMid, textAlign: "center" }}><input type="checkbox" checked={r.taxable} onChange={(e) => setRow(st.id, i, "taxable", e.target.checked)} style={{ width: 16, height: 16, cursor: "pointer", accentColor: DOOR_MINT }} /></td>
                  <td style={{ ...tdMid, textAlign: "center" }}><input type="checkbox" checked={r.active} onChange={(e) => setRow(st.id, i, "active", e.target.checked)} style={{ width: 16, height: 16, cursor: "pointer", accentColor: DOOR_MINT }} /></td>
                  {/* The build-on-site fee lives ON the row, to the right of Active (Carolyn
                      2026-09-14: "instead of having it drop down, lets have it appear on the
                      right side of the active button"). It used to be a band under the row,
                      which pushed everything below it down the moment the box was ticked. A
                      row that is not built on site shows a dash, so the table never jumps. */}
                  <td style={tdMid}>
                    {r.buildOnSite ? (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 5, whiteSpace: "nowrap" }}>
                        <span style={{ color: "#94A3B8", fontSize: 12.5 }}>$</span>
                        <input type="number" min="0" step="0.01" value={r.bosFeeRate} placeholder="none"
                          title="Leave blank if you don't charge extra — the building is still marked built on site."
                          onChange={(e) => setRow(st.id, i, "bosFeeRate", e.target.value)} style={{ ...S.input, width: 78 }} />
                        <select value={r.bosFeeBasis || "each"} onChange={(e) => setRow(st.id, i, "bosFeeBasis", e.target.value)} style={{ ...S.input, width: 132, fontSize: 12 }}>
                          {WH_BOS_BASES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                        </select>
                      </span>
                    ) : <span style={{ color: "#CBD5E1" }}>—</span>}
                  </td>
                  <td style={{ ...tdMid, textAlign: "right" }}><button onClick={() => delRow(st.id, i)} title="Remove" style={{ background: "transparent", border: "none", cursor: "pointer", color: "#94A3B8", fontWeight: 800 }}>✕</button></td>
                </tr>,
              ])}
            </tbody>
          </table>
        )}
        <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center" }}>
          <button onClick={() => addRow(st.id)} style={{ background: "transparent", border: "none", color: "#1B7895", fontWeight: 700, fontSize: 13, cursor: "pointer", padding: 0 }}>+ Add increase</button>
          <button onClick={() => save(st.id, st.label)} disabled={busyId === st.id} style={S.btn(DOOR_MINT, "#0F4C46")}>{busyId === st.id ? "Saving…" : "Save"}</button>
        </div>
      </div>
    );
  };

  return (
    <div style={S.card}>
      <div style={S.h2}>Wall Height Upgrades</div>
      {/* Full width, no maxWidth (Carolyn 2026-09-12: "the description/instructions should run
          across the entire page"). It opens by saying where the STANDARD height lives, because
          this card only ever sets the INCREASES on top of it — the base is a 3D calibration
          value, and that was not obvious from here. */}
      <p style={{ fontSize: 12.5, color: "#64748B", margin: "0 0 14px", lineHeight: 1.55 }}>
        Each style's <b>standard wall height</b> is set in the 3D designer: go to <b>Settings → Designer → 3D Style Calibration</b>,
        pick the style, and set its wall height there — that number shows beside each style below. This card adds the
        <b> taller-wall increases</b> a customer can choose on top of it.
        Increases are offered per building style — hauling limits differ per building, so each
        style carries its own list. The customer picks <b>one</b> increase for the whole building
        and it is charged <b>per lineal foot of the building's perimeter</b>: a 12&times;24 has 72
        lineal feet, so +6 in at $2.00/ft adds $144.00. Leave a rate blank to keep a row without
        offering it yet. Tick the <b>widths</b> each increase can be hauled at — a wider building
        already has a taller roof, so a narrow one can take more. A width you add to a style
        later arrives <b>unticked</b> here, so nothing is ever offered on a new size until you
        say so. Tick <b>Built on site</b> on an increase too tall to haul under a bridge: the
        customer sees “on site” beside that choice, the building is marked as a site build
        rather than a delivery, and you can add the upcharge for sending a crew out.
        To sell the same increase hauled on narrower buildings and built on site on wider ones, add it
        <b> twice</b>: once with the hauled widths ticked, and once ticked <b>Built on site</b> with the wider widths.
      </p>
      {msg && msg.err && <div style={S.err}>{msg.err}</div>}
      {msg && msg.ok && <div style={S.okMsg}>{msg.ok}{Array.isArray(msg.skipped) && msg.skipped.length > 0 && <div style={{ marginTop: 6, fontWeight: 500 }}>{msg.skipped.join(" · ")}</div>}</div>}
      {!cat ? <SkelBar /> : (cat.styles || []).filter((st) => st.active !== false).map(renderSection)}
    </div>
  );
}

// ── Cladding (207) ──────────────────────────────────────────────────────────
// Carolyn, 2026-09-07: "Move the cladding into options allowing people to select the cladding
// they use... but keep the cladding as dropdown options as we have it worked into the 3D so
// make sure you don't lose that."
//
// FIVE FIXED ROWS PER STYLE, never added or removed: we ship a texture and a relief profile for
// each of the five, and a builder cannot invent a sixth. What is theirs is which ones they sell,
// what each costs, and what the customer sees it called. The id underneath never changes, which
// is what keeps the 3D renderer and every saved design working. The fifth, 4.5" Vinyl Siding,
// joined on 2026-10-06 (migration 285) with lap's profile at its own course, and lap became
// 7" LP Lap Siding the same day with its drawing unchanged (Carolyn, Q20). ASCII quotes in both
// names: the quote PDF's standard fonts are WinAnsi only.
//
// Per STYLE rather than per tenant because a Greenhouse and a Lofted Barn do not sell the same
// siding, and because the wall area — and so the price — differs anyway.
const SS_CLADDING_ROWS = [
  { id: "panel", label: "Panel Siding" },
  { id: "lap", label: "7\" LP Lap Siding" },
  { id: "vinyl", label: "4.5\" Vinyl Siding" },
  { id: "batten", label: "Board & Batten" },
  // The profile name, not "Metal" (Carolyn 09-11: "they can type in here metal").
  { id: "agpanel", label: "AG Panel" },
];
// The product's SHARED pricing vocabulary, all seven of it (Carolyn 2026-09-07: "add all these
// as options for the pricing"). Same names and same meanings as the Options header, which is
// rendered above the table so a builder reads the definitions in place.
//
// Cladding is a whole-BUILDING option rather than something placed on the plan, so two of the
// seven need saying out loud, and the header does:
//   • sqft option — the option's area IS the wall area: perimeter × wall height.
//   • lineal ft — a whole-building option has no length of its own, so its feet are the
//     perimeter, which makes it the same sum as perimeter building. Both names are in the
//     vocabulary and both price; the duplication is the vocabulary's, not ours.
const SS_CLADDING_BASES = [
  ["sqft_option", "sqft option — per sq ft of wall"],
  ["sqft_building", "sqft building"],
  ["lineal_ft", "lineal ft"],
  ["perimeter_building", "perimeter building"],
  ["each", "each"],
  ["pct_building_price", "pct building price"],
  ["pct_estimate_total", "pct estimate total"],
];

function CladdingView({ viewingLabel = null, clientId = null }) {
  // Operator view-as: state the effective tenant explicitly, same as every sibling card here.
  const scoped = (body) => (viewingLabel && clientId ? { ...body, targetClientId: clientId } : body);
  const [cat, setCat] = useState(null);
  const [byStyle, setByStyle] = useState({});
  const [busyId, setBusyId] = useState(null);
  const [msg, setMsg] = useState(null);
  // Can this database hold a lap course size (style_cladding.exposure_in, 275)? portal-settings
  // answers false only before 275, and then the box is hidden rather than offered and lost.
  const [courses, setCourses] = useState(false);

  const load = async () => {
    const body = scoped({ action: "catalog" });
    const { data, error } = await window.__ssCatalogFlight(
      () => sb.functions.invoke("portal-settings", { body }),
      String(body.targetClientId == null ? (ssTargetClientId || "") : body.targetClientId));
    if (error || (data && data.error)) { setMsg({ err: (error && error.message) || data.error }); return; }
    setCat(data);
    setCourses(data.claddingCourses === true);
    const saved = {};
    (data.cladding || []).forEach((r) => { (saved[r.style_id] = saved[r.style_id] || {})[r.cladding_id] = r; });
    const m = {};
    (data.styles || []).forEach((st) => {
      const own = saved[st.id] || {};
      // The five rows always render, whether or not the tenant has a row for each. A style with
      // no rows at all is not broken — it is a style offering builder's standard only — and it
      // must still be fillable, which a data-driven row list would not allow.
      m[st.id] = SS_CLADDING_ROWS.map((c) => {
        const r = own[c.id] || null;
        return {
          claddingId: c.id,
          builtIn: c.label,
          labelOverride: (r && r.label_override) || "",
          rate: r && r.rate != null ? String(r.rate) : "",
          basis: (r && r.basis) || "sqft_option",
          taxable: !r || r.taxable !== false,
          active: !r || r.active !== false,
          internalOnly: !!(r && r.internal_only),
          // Lap only: the board size in inches, the number in the siding's name (D3_LAP_NOMINAL_IN),
          // which the 3D scales the courses by. Blank = the standard lap, 7 in. NOT the reveal: the
          // standard 7 in board shows about 6 in, so asking "how much shows" got the wrong number.
          exposureIn: c.id === "lap" && r && r.exposure_in != null ? String(r.exposure_in) : "",
        };
      });
    });
    setByStyle(m);
  };
  useEffect(() => { load(); }, []);

  const setRow = (styleId, idx, field, val) =>
    setByStyle((p) => ({ ...p, [styleId]: (p[styleId] || []).map((r, i) => (i === idx ? { ...r, [field]: val } : r)) }));

  const save = async (styleId, styleLabel) => {
    setBusyId(styleId); setMsg(null);
    try {
      const rows = byStyle[styleId] || [];
      // Refuse, never coerce — nothing is sent until every rate reads as money, and the message
      // names the rows at fault. The whole point is that a typo cannot become a silent $0.
      const badRate = rows.filter((r) => {
        const t = String(r.rate == null ? "" : r.rate).trim();
        return t !== "" && (!Number.isFinite(Number(t)) || Number(t) < 0);
      });
      if (badRate.length) {
        throw new Error("Nothing was saved — fix these rate(s) first: " + badRate.map((r) => r.builtIn).join(", "));
      }
      // The course size the same way: a typo must not become a silent 7 in.
      const lapRow = rows.find((r) => r.claddingId === "lap");
      const course = lapRow ? String(lapRow.exposureIn == null ? "" : lapRow.exposureIn).trim() : "";
      if (courses && course !== "" && !(Number.isFinite(Number(course)) && Number(course) >= 3 && Number(course) <= 12)) {
        throw new Error("Nothing was saved — the lap course has to be between 3 and 12 inches (leave it blank for 7).");
      }
      const { data, error } = await sb.functions.invoke("portal-settings", {
        body: scoped({
          action: "save_cladding",
          styleId,
          rows: rows.map((r) => ({
            claddingId: r.claddingId,
            labelOverride: String(r.labelOverride || "").trim(),
            rate: String(r.rate == null ? "" : r.rate).trim(),
            basis: r.basis,
            taxable: r.taxable,
            active: r.active,
            internalOnly: r.internalOnly,
            // Sent on the lap row only, and only where the database can hold it: a row that does
            // not name it leaves the stored size alone.
            ...(courses && r.claddingId === "lap" ? { exposureIn: String(r.exposureIn == null ? "" : r.exposureIn).trim() } : {}),
          })),
        }),
      });
      if (error || (data && data.error)) throw new Error((error && error.message) || data.error);
      await load();
      const skipped = data.skipped || [];
      setMsg({ ok: styleLabel + ": saved." + (skipped.length ? " " + skipped.length + " skipped." : ""), skipped });
    } catch (e) { setMsg({ err: e.message }); }
    setBusyId(null);
  };

  const renderSection = (st) => {
    const rows = byStyle[st.id] || [];
    return (
      <div key={st.id} style={{ ...S.card, marginBottom: 12 }}>
        <div style={S.h2}>{st.label}</div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", maxWidth: 860 }}>
            <thead><tr>
              <th style={S.th}>Cladding</th>
              <th style={S.th} title="What the customer sees this called. Leave blank to use our name.">Shown as</th>
              <th style={S.th} title="The same seven methods the rest of Options uses — the definitions are above the table.">How it&rsquo;s priced</th>
              <th style={S.th} title="Blank = you do not offer it on this style. 0 = included at no charge. Anything else is an upcharge.">Rate (USD)</th>
              <th style={{ ...S.th, textAlign: "center" }} title="Available in the rep designer only — hidden from the customer-facing page.">Internal only</th>
              <th style={{ ...S.th, textAlign: "center" }} title="Untick if you don't charge sales tax on this.">Taxable</th>
              {courses && <th style={S.th} title={"7\" LP Lap Siding only: the board size in inches, the number in the siding's name (8 for an 8\" lap). When a customer picks it, the 3D scales the boards to match. Blank is the standard 7. For 4.5\" vinyl, offer the 4.5\" Vinyl Siding row instead."}>Course (in)</th>}
            </tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.claddingId}>
                  <td style={{ ...S.td, fontWeight: 700, whiteSpace: "nowrap" }}>{r.builtIn}</td>
                  <td style={S.td}>
                    <input type="text" value={r.labelOverride} placeholder={r.builtIn} maxLength={60}
                      onChange={(e) => setRow(st.id, i, "labelOverride", e.target.value)}
                      style={{ ...S.input, width: 170 }} />
                  </td>
                  <td style={S.td}>
                    {/* 230, not 160: "sqft option — per sq ft of wall" is the default and the
                        longest, and a clipped method name is the one thing on this row a
                        builder cannot afford to misread. */}
                    <select value={r.basis} onChange={(e) => setRow(st.id, i, "basis", e.target.value)}
                      style={{ ...S.input, width: 230 }}>
                      {SS_CLADDING_BASES.map(([v, lbl]) => <option key={v} value={v}>{lbl}</option>)}
                    </select>
                  </td>
                  <td style={S.td}>
                    <input type="number" min="0" step="0.01" value={r.rate} placeholder="not offered"
                      onChange={(e) => setRow(st.id, i, "rate", e.target.value)}
                      style={{ ...S.input, width: 120 }} />
                  </td>
                  <td style={{ ...S.td, textAlign: "center" }}>
                    <input type="checkbox" checked={r.internalOnly}
                      onChange={(e) => setRow(st.id, i, "internalOnly", e.target.checked)}
                      style={{ width: 16, height: 16, cursor: "pointer", accentColor: DOOR_MINT }} />
                  </td>
                  <td style={{ ...S.td, textAlign: "center" }}>
                    <input type="checkbox" checked={r.taxable}
                      onChange={(e) => setRow(st.id, i, "taxable", e.target.checked)}
                      style={{ width: 16, height: 16, cursor: "pointer", accentColor: DOOR_MINT }} />
                  </td>
                  {courses && (
                    <td style={S.td}>
                      {r.claddingId === "lap" && (
                        <input type="number" min="3" max="12" step="0.25" value={r.exposureIn} placeholder="7"
                          aria-label={`${st.label} lap siding course, inches`}
                          onChange={(e) => setRow(st.id, i, "exposureIn", e.target.value)}
                          style={{ ...S.input, width: 80 }} />
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: 10 }}>
          <button onClick={() => save(st.id, st.label)} disabled={busyId === st.id} style={S.btn(DOOR_MINT, "#0F4C46")}>
            {busyId === st.id ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    );
  };

  return (
    <div style={S.card}>
      <div style={S.h2}>Cladding</div>
      <p style={{ fontSize: 12.5, color: "#64748B", margin: "0 0 14px", maxWidth: 680 }}>
        The siding a customer can choose, per building style — not every style takes every
        cladding, and metal in particular is far from universal. Leave a rate <b>blank</b> and you
        do not offer it on that style; enter <b>0</b> and it is included at no charge; anything
        else is an upcharge. Rename any of them under <b>Shown
        as</b> to whatever your customers know it as &mdash; the drawing and the 3D view are
        unaffected, because the siding itself is still the same one of our five.
        {courses && (
          <>
            {" "}On <b>7&quot; LP Lap Siding</b> you can also set the <b>course</b>: the board
            size in inches, the number in the siding&rsquo;s name, so blank is the standard 7 and 8
            is an 8&quot; lap. When a customer picks it, the 3D scales the boards to match; it does
            not change the price.
            For 4.5&quot; vinyl, offer the <b>4.5&quot; Vinyl Siding</b> row instead: it draws the
            same boards at 4.5 in, and you price it on its own.
          </>
        )}
      </p>
      {/* The SAME wording as the Options header, because it is the same vocabulary. Two
          sentences are appended for cladding specifically: a whole-building option has no area
          or length of its own, so `sqft option` and `lineal ft` need their meaning stated here
          or a builder has to guess which one charges what. */}
      <p style={{ fontSize: 12.5, color: "#64748B", margin: "0 0 14px", maxWidth: 680 }}>
        Set how cladding is priced &mdash;<b>each</b> = rate &times; count; <b>lineal ft</b> = rate
        &times; total feet; <b>sqft option</b> = rate &times; option area;<b>sqft building</b> =
        rate &times; (width &times; depth); <b>perimeter building</b> = rate &times; 2 &times;
        (width + depth); <b>pct building price</b> = (rate &divide; 100) &times; base building
        price; <b>pct estimate total</b> = (rate &divide; 100) &times; subtotal of all other lines,
        resolved last.
        <br />
        For cladding the <b>option area</b> is the <b>wall</b> area &mdash; the perimeter &times;
        the wall height &mdash; so a taller-walls upgrade is charged for automatically. And since a
        whole building has no length of its own, <b>lineal ft</b> uses the perimeter, which makes
        it the same sum as <b>perimeter building</b>.
      </p>
      {msg && msg.err && <div style={S.err}>{msg.err}</div>}
      {msg && msg.ok && <div style={S.okMsg}>{msg.ok}{Array.isArray(msg.skipped) && msg.skipped.length > 0 && <div style={{ marginTop: 6, fontWeight: 500 }}>{msg.skipped.join(" · ")}</div>}</div>}
      {!cat ? <SkelBar /> : (cat.styles || []).filter((st) => st.active !== false).map(renderSection)}
    </div>
  );
}

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
    // no longer shown or archived here. The three electrical devices are not layout items at
    // all any more — 206 made them ordinary electrical_items, so they cannot appear here.
    return (data.items || []).filter((it) => it.key !== "ramp").map((it) => {
      const p = byKey[it.key] || {};
      // An item that stays out of the customer's palette until it is PRICED (171's shelves, 278's partition
      // wall) starts BLANK rather than 0, and Save leaves a blank one alone: a 0 would be a price, and the
      // item would appear free on every customer's designer the first time this card was saved for
      // something else. Any other item keeps showing 0, which is what it costs today.
      const unpriced = !!it.hiddenUntilPriced && p.rate == null;
      return { item_key: it.key, label: it.label, pricing_method: p.pricing_method || "each", rate: p.rate != null ? String(p.rate) : unpriced ? "" : "0", unpriced, image_url: p.image_url || null, archived: !!it.archived, internalOnly: !!it.internalOnly, taxable: it.taxable !== false,
        wallSnap: !!it.wallSnap, depthIn: it.depthIn != null ? String(it.depthIn) : "", heightOffFloorIn: it.heightOffFloorIn != null ? String(it.heightOffFloorIn) : "" };
    });
  };

  const load = async () => {
    // Joins the other catalog reads fired in this same mount tick instead of being a fifth
    // contending copy of the same ten-table fan-out — see window.__ssCatalogFlight above.
    // The key is the effective tenant: `scoped` states it explicitly in operator view-as,
    // and 01-core.jsx:157-165 injects the same value when it doesn't.
    const body = scoped({ action: "catalog" });
    const { data, error } = await window.__ssCatalogFlight(
      () => sb.functions.invoke("portal-settings", { body }),
      String(body.targetClientId == null ? (ssTargetClientId || "") : body.targetClientId));
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
  // Sales tax (migration 148). Same optimistic shape as toggleInternal below: flip the row,
  // call, and put it back if the call fails — a tax flag that silently did not save is how a
  // builder discovers the exemption never applied, on an invoice.
  const toggleTaxable = async (itemKey, taxable) => {
    setBusy(true); setMsg(null);
    setRows((rs) => rs.map((r) => r.item_key === itemKey ? { ...r, taxable } : r));
    try {
      const { data, error } = await sb.functions.invoke("portal-settings", { body: scoped({ action: "set_layout_item_taxable", itemKey, taxable }) });
      if (error || (data && data.error)) throw new Error((error && error.message) || data.error);
      setMsg({ ok: taxable ? "Sales tax will be charged on this option." : "This option is no longer taxed — it appears under the non-taxable subtotal on quotes and invoices." });
    } catch (e) { setRows((rs) => rs.map((r) => r.item_key === itemKey ? { ...r, taxable: !taxable } : r)); setMsg({ err: e.message }); }
    finally { setBusy(false); }
  };
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
    // Shrink oversized photos rather than refusing them — see onStyleImg for why.
    file = await ssFitImageForUpload(file);
    if (file.size > 3_000_000) { setMsg({ err: "That image couldn't be resized small enough — try a JPG or PNG." }); setImgFileKey((k) => k + 1); return; }
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
      // Dimensions ride the same Save prices click. Only wall-mounted items carry them, and a
      // blank clears the override back to the master default — so they are sent as typed, not
      // coerced, and an unusable one is named rather than silently becoming 0.
      const dimBad = src.filter((r) => r.wallSnap && [r.depthIn, r.heightOffFloorIn].some((v) => {
        const t = String(v ?? "").trim(); return t !== "" && (!Number.isFinite(Number(t)) || Number(t) < 0);
      }));
      if (dimBad.length) throw new Error(`Nothing was saved — fix these measurement(s) first, they aren't usable inch values: ${dimBad.map((r) => r.label).join(", ")}.`);
      const payloadRows = src.filter((r) => !(r.unpriced && String(r.rate ?? "").trim() === "")).map((r) => ({ item_key: r.item_key, pricing_method: r.pricing_method, rate: rateOf(r), imageUrl: r.image_url ?? null,
        ...(r.wallSnap ? { depthIn: String(r.depthIn ?? "").trim(), heightOffFloorIn: String(r.heightOffFloorIn ?? "").trim() } : {}) }));
      // partitionAware: this card knows the partition wall (278), so portal-settings lets it price one.
      // The card from before it, which cannot, never sends the flag.
      const { data, error } = await sb.functions.invoke("portal-settings", { body: { action: "save_layout_pricing", rows: payloadRows, partitionAware: true } });
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
        if (method && (itemKey !== "partitionWall" || LP_METHODS_PARTITION.some((m) => m.value === method))) byKey[itemKey].pricing_method = method;
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
        {/* "Interior items", not "Options" (Carolyn 2026-09-07). A card called Options, inside
            a tab called Options, inside the Interior group, said nothing about what it holds.
            HEADING ONLY — the component, the save_layout_pricing action and every item_key are
            untouched, so nothing joins on this string. */}
        <div style={S.h2}>Interior items</div>
        <p style={{ fontSize: 13, color: "#64748B", marginBottom: 14, lineHeight: 1.5 }}>
          Set how each item customers can place on the floor plan is priced —
          <b>each</b> = rate × count; <b>lineal ft</b> = rate × total feet; <b>sqft option</b> = rate × option area;
          <b>sqft building</b> = rate × (width × depth); <b>perimeter building</b> = rate × 2 × (width + depth);
          <b>pct building price</b> = (rate ÷ 100) × base building price; <b>pct estimate total</b> = (rate ÷ 100) × subtotal of all other lines, resolved last.
          These rates are used on estimates when you don’t price through your CRM’s products. Building sizes are priced on the <b>Structures</b> tab.
          <br />Add an optional <b>product image</b> per item — it appears on that line of the customer’s estimate.
        </p>
        {/* A real table, so the skeleton keeps the real <thead> and puts SkelRows in the body
            at the same six columns — Item / How it's priced / Rate / Image / Internal /
            archive — so the header and the first paint line up and nothing jumps when the
            rows land. Grey blocks, not the word "Loading" (see SkelRows in 01-core). */}
        {!cat ? (
          <div className="tight" style={{ overflowX: "auto", marginBottom: 14 }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>
                <th style={S.th}>Item</th><th style={S.th}>How it’s priced</th><th style={S.th}>Rate (USD)</th><th style={S.th}>Depth (in)</th><th style={S.th}>Height off floor (in)</th><th style={S.th}>Image</th><th style={{ ...S.th, textAlign: "center" }}>Internal only</th><th style={S.th}></th>
              </tr></thead>
              <tbody><SkelRows cols={8} rows={6} widths={["58%", "80%", "60%", "40%", "40%", "50%", "24%", "44%"]} /></tbody>
            </table>
          </div>
        ) : rows.length === 0 ? (
          <div style={{ fontSize: 13, color: "#64748B" }}>No placeable items are enabled for your designer yet.</div>
        ) : (
          <>
            {/* overflowX wrapper: the method select + rate input enforce ~300px of minimum
                cell width, so on narrow viewports (68px icon rail) the table scrolls inside
                its card instead of forcing page-level horizontal scroll. */}
            <div className="tight" style={{ overflowX: "auto", marginBottom: 14 }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>
                <th style={S.th}>Item</th><th style={S.th}>How it’s priced</th><th style={S.th}>Rate (USD)</th><th style={S.th} title="Wall-mounted items only — how far it stands out from the wall, in inches. This is the depth drawn on the customer's plan.">Depth (in)</th><th style={S.th} title="Wall-mounted items only — how high off the floor it hangs, in inches. It is what lets a shelf sit above a workbench instead of colliding with it.">Height off floor (in)</th><th style={S.th}>Image</th><th style={{ ...S.th, textAlign: "center" }} title="Available in the rep designer only — hidden from customers’ placement buttons on the client-facing page (already-placed items still show).">Internal only</th><th style={{ ...S.th, textAlign: "center" }} title="Untick if you don’t charge sales tax on this option. It then sits under the non-taxable subtotal on quotes and invoices.">Taxable</th><th style={S.th}></th>
              </tr></thead>
              <tbody>
                {rows.map((r) => r).sort((a, b) => (a.archived ? 1 : 0) - (b.archived ? 1 : 0)).map((r) => (
                  <tr key={r.item_key} style={r.archived ? { opacity: 0.55 } : undefined}>
                    <td style={{ ...S.td, fontWeight: 700 }} data-ss-lp-item={r.item_key}>{r.label}{r.archived && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 800, color: "#B45309", background: "#FEF3C7", borderRadius: 4, padding: "1px 6px" }}>Archived</span>}
                      {r.unpriced && <div style={{ fontSize: 11.5, fontWeight: 500, color: "#64748B", marginTop: 2, maxWidth: 240 }}>Not offered yet. Customers see it once you set a rate and save.</div>}
                    </td>
                    <td style={S.td}>
                      <select value={r.pricing_method} onChange={(e) => setRow(r.item_key, "pricing_method", e.target.value)} style={{ ...S.input, width: "auto", minWidth: 170 }}>
                        {(r.item_key === "partitionWall" ? LP_METHODS_PARTITION : LP_METHODS).map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                      </select>
                    </td>
                    <td style={S.td}>
                      <input type="number" min="0" step="0.01" value={r.rate} placeholder={r.unpriced ? "not offered" : undefined} onChange={(e) => setRow(r.item_key, "rate", e.target.value)} style={{ ...S.input, width: 120 }} />
                    </td>
                    {/* Dimensions apply to wall-mounted items only; a dash reads as "not applicable
                        here", which an empty box would not. Blank = fall back to our default. */}
                    <td style={S.td}>
                      {r.wallSnap
                        ? <input type="number" min="0" step="0.5" value={r.depthIn} placeholder="default" onChange={(e) => setRow(r.item_key, "depthIn", e.target.value)} style={{ ...S.input, width: 96 }} />
                        : <span style={{ color: "#CBD5E1" }}>—</span>}
                    </td>
                    <td style={S.td}>
                      {r.wallSnap
                        ? <input type="number" min="0" step="0.5" value={r.heightOffFloorIn} placeholder="default" onChange={(e) => setRow(r.item_key, "heightOffFloorIn", e.target.value)} style={{ ...S.input, width: 96 }} />
                        : <span style={{ color: "#CBD5E1" }}>—</span>}
                    </td>
                    <td style={S.td}>
                      {r.image_url ? (
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <img src={r.image_url} alt="" loading="lazy" style={thumb} />
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
                    <td style={{ ...S.td, textAlign: "center" }}>
                      <label title="Taxable: sales tax is charged on this option. Untick and it sits under the non-taxable subtotal on quotes and invoices." style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: busy ? "default" : "pointer" }}>
                        <input type="checkbox" checked={r.taxable !== false} disabled={busy} onChange={() => toggleTaxable(r.item_key, r.taxable === false)} style={{ width: 16, height: 16, cursor: busy ? "default" : "pointer", accentColor: DOOR_MINT }} />
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

// How a catalog door is DRAWN in 3D (migration 186, widened by 187). Kept as one list in one
// place because it is normalised at THREE sites in this file — the row→draft read, the
// draft→save payload, and the <select>'s own value — and three hand-written ternaries pinned
// to "plank" is exactly how the first three styles would have shipped unreachable.
//
// ⚠️ ANYTHING UNRECOGNISED MUST FALL BACK TO 'auto'. 186's header calls that out as
// deliberate and `fixtureDoorStyle` in the designer relies on it: a typo, an older portal, or
// a value written by a NEWER portal than this one can then only ever mean "draw it the way you
// always did" — never a blank door. Keep this list in step with the CHECK constraint in 187
// and with FIXTURE_CATEGORIES' door branch in portal-settings.
//
// Migration 289 adds the generator's four looks (american, basic, classic, dutch): the four hinged
// doors builders sell, drawn in 3D with the frame in the door's trim colour and the panels in its
// door colour, each able to take a window ticked "Can be used inside a door". A double is the row's
// own Double operation, so "American double" is an american row with Double ticked.
const D3_DOOR_STYLES = ["plank", "zbrace", "xbrace", "rollup", "american", "basic", "classic", "dutch"];
const D3_DOOR_STYLE_HINT = {
  auto: "The door's photo is laid onto the door in 3D. Photos taken at an angle look stretched on the building — switch to one of the built looks if this door looks skewed.",
  plank: "Drawn as a real door: a framed panel of vertical boards with black strap hinges and a barn latch, in the door colour the customer picks. The door's photo is still used on the estimate, but not in 3D.",
  zbrace: "The same board-and-batten door with a single diagonal brace, rising from the hinge side.",
  xbrace: "The same board-and-batten door with a crossed X brace across the lower panel.",
  rollup: "Drawn as a roll-up: horizontal slats in side tracks with a lift handle. No hinges or latch. The door's photo is still used on the estimate, but not in 3D.",
  american: "A trim frame with a mid rail and vertical pickets across the lower panel (as many as the door's width spaces like the real door), panels in the door colour (or the building's), with a window in the upper panel if the customer picks one.",
  basic: "A trim frame with a mid rail and plain panels in the door colour (or the building's), with a window in the upper panel if the customer picks one.",
  classic: "A trim frame with an octagon and a diamond in the upper panel and an X in the lower one; a window, if the customer picks one, takes the octagon's place.",
  dutch: "A trim frame with a mid rail and a small dark louvred vent in the lower panel, with a window in the upper panel if the customer picks one.",
};

// The shared per-line catalog editor. `sizeWord` flips the second dimension's wording
// ("height" for doors/windows, "length" for ramps — height_in holds the ramp LENGTH).
function FixtureCatalog({ category, noun, addLabel, namePh, labelPh, wPh, hPh, sizeWord = "height", hasSwingOp = false, viewingLabel = null, clientId = null, refreshKey = 0 }) {
  // Operator "view as": scope EVERY call to the client on screen explicitly, so an item is
  // always read/written for the tenant shown, never silently the operator's own.
  const scoped = (body) => (viewingLabel && clientId ? { ...body, targetClientId: clientId } : body);
  const [rows, setRows] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [edit, setEdit] = useState(null);            // { id, draft } — id null = adding a new item
  const [pendingDelete, setPendingDelete] = useState(null);
  const [dragIdx, setDragIdx] = useState(null);
  const [imgBusy, setImgBusy] = useState(false);
  const [imgFileKey, setImgFileKey] = useState(0);
  const [straighten, setStraighten] = useState(null);   // File awaiting the straighten step
  const [dlBusy, setDlBusy] = useState(false);
  const [fileKey, setFileKey] = useState(0);
  // Paging. This is the one list on the Options tab that plausibly passes 30 rows — a builder
  // with forty window sizes — and every row renders its own <img>, so forty rows meant forty
  // image requests competing with the page. Per category, because doors, ramps and windows
  // are different-length lists and a builder who picks 100 windows didn't ask for 100 ramps.
  const [pageSize, setPageSize] = usePageSize("fixtures." + category);
  const [page, setPage] = useState(1);
  // Door-flagged palette rows (Colors tab → Doors tick), for the color-mode UI. Doors only.
  const [doorColors, setDoorColors] = useState([]);
  const isDoorCat = category === "door";
  // The client's window colors (Windows section list), for per-window availability
  // checkboxes. Windows only.
  const [winColors, setWinColors] = useState([]);
  const isWindowCat = category === "window";
  // The builder's building styles, for the "Offered on" ticks (272). Every category. Hidden
  // styles are left out of the ticks, as every other per-style card here leaves them out.
  const [offerStyles, setOfferStyles] = useState([]);
  // EVERY style id, hidden ones included. "Every style" is judged against these, never against the
  // ticks shown: a line restricted to the Greenhouse while the only other style is hidden must not
  // save as "every style" on a price edit, or the restriction is gone when that style comes back.
  const [allStyleIds, setAllStyleIds] = useState([]);

  const mapRow = (d) => ({
    id: d.id, name: d.name || "", plan_label: d.plan_label || "", show_image_on_estimate: d.show_image_on_estimate !== false,
    width_in: d.width_in != null ? fmtFtIn(d.width_in) : "", height_in: d.height_in != null ? fmtFtIn(d.height_in) : "",
    price: d.price != null ? String(d.price) : "",
    swing_in: !!d.swing_in, swing_out: !!d.swing_out, swing_default: d.swing_default || null,
    op_right: !!d.op_right, op_left: !!d.op_left, op_double: !!d.op_double, op_slideup: !!d.op_slideup, op_default: d.op_default || null,
    color_mode: d.color_mode || "fixed", has_trim_color: d.has_trim_color === true, fixed_color_id: d.fixed_color_id || null,
    // null = comes in ALL window colors (the living default); an array = exactly those.
    window_color_ids: Array.isArray(d.window_color_ids) ? d.window_color_ids.map(String) : null,
    // Can go inside a door (289): windows only; absent reads as no, the column's default.
    in_door: d.in_door === true,
    // null = offered on EVERY building style (the living default); an array = only those (272).
    style_ids: Array.isArray(d.style_ids) ? d.style_ids.map(String) : null,
    // Blank = "use the standard 3'6"", which is NOT the same as 0 (a window starting at
    // the floor), so an empty string has to survive the round trip rather than becoming 0.
    // fmtFtIn renders 0 as "" (right for a width, wrong here — it would turn a deliberate
    // floor-level window back into "use the default" on the next save), so 0 is spelled out.
    sill_in: d.sill_in != null ? (Number(d.sill_in) === 0 ? '0"' : fmtFtIn(d.sill_in)) : "", sill_mode: d.sill_mode === "variable" ? "variable" : "fixed",
    // How the door is DRAWN in 3D (186). Anything unrecognised reads as "auto" — the look
    // the app has always had — so an older row and a newer one cannot render differently.
    door_style: D3_DOOR_STYLES.includes(d.door_style) ? d.door_style : "auto",
    image_url: d.image_url || null, active: d.active !== false, archived: d.archived === true, internalOnly: d.internal_only === true,
    // Sales tax (migration 148). Absent reads as TAXABLE — the column defaults true, so the
    // only way to be untaxed is for the builder to have said so.
    taxable: d.taxable !== false,
  });
  const load = async () => {
    // Joins the sibling catalog reads fired in this same mount tick — see
    // window.__ssCatalogFlight above. The door and window catalogs each used to be one more
    // contending copy of the whole ten-table payload for the sake of one filtered slice.
    const body = scoped({ action: "catalog" });
    const { data, error } = await window.__ssCatalogFlight(
      () => sb.functions.invoke("portal-settings", { body }),
      String(body.targetClientId == null ? (ssTargetClientId || "") : body.targetClientId));
    if (error || (data && data.error)) { setMsg({ err: (error && error.message) || data.error }); return; }
    const list = (data.fixtures || []).filter((f) => (f.category || "door") === category).map(mapRow);
    // Display order = the order drag persists: live items first, archived sink to the bottom.
    setRows([...list.filter((r) => !r.archived), ...list.filter((r) => r.archived)]);
    if (isDoorCat) setDoorColors((data.colors || []).filter((c) => c.door === true && c.active !== false));
    if (isWindowCat) setWinColors((data.windowColors || []).filter((c) => c.active !== false));
    setOfferStyles((data.styles || []).filter((s) => s.active !== false));
    setAllStyleIds((data.styles || []).map((s) => String(s.id)));
    setLoaded(true);
  };
  // refreshKey lets a sibling editor force a reload in place — WindowsView bumps it after
  // the window-color list saves, so a just-added color shows up in the per-window
  // checkboxes without a page refresh.
  useEffect(() => { load(); }, [refreshKey]);

  // What a line's "Offered on" ticks send (272): null when every style the builder has, hidden
  // ones included, is ticked, else the ticked ids. It rides on every save of the line (a price
  // edit, Archive), so judging "every" by the visible ticks alone would widen a restriction.
  const styleIdsOut = (ids) => (ids == null || (allStyleIds.length > 0 && allStyleIds.every((id) => ids.includes(id)))) ? null : ids;
  // Every "Offered on" box unticked. portal-settings refuses that save, so the Save button waits.
  // Judged on the boxes shown: a line left on hidden styles only reaches no customer today either.
  const offeredNowhere = (d) => !!d && Array.isArray(d.style_ids) && offerStyles.length > 1 && !offerStyles.some((s) => d.style_ids.includes(String(s.id)));
  // One line's payload for save_fixture / import_fixtures. Sizes go over as inches.
  // Color keys ride ONLY for doors so the server's presence contract leaves other
  // categories' (forced) values alone.
  const toPayload = (r) => ({
    id: r.id || undefined, category, name: r.name, planLabel: r.plan_label,
    showImageOnEstimate: r.show_image_on_estimate !== false,
    widthIn: ftInToInches(r.width_in), heightIn: ftInToInches(r.height_in), price: r.price,
    swingIn: !!r.swing_in, swingOut: !!r.swing_out, swingDefault: r.swing_default,
    opRight: !!r.op_right, opLeft: !!r.op_left, opDouble: !!r.op_double, opSlideUp: !!r.op_slideup, opDefault: r.op_default,
    ...(isDoorCat ? { colorMode: r.color_mode || "fixed", hasTrimColor: r.has_trim_color === true, fixedColorId: (r.color_mode || "fixed") === "fixed" ? (r.fixed_color_id || null) : null } : {}),
    ...(isDoorCat ? { doorStyle: D3_DOOR_STYLES.includes(r.door_style) ? r.door_style : "auto" } : {}),
    // Every box ticked goes over as null ("all colors") so a window-color added later
    // automatically appears on unrestricted windows.
    ...(isWindowCat ? { windowColorIds: (r.window_color_ids === null || (winColors.length > 0 && winColors.every((c) => r.window_color_ids.includes(String(c.id))))) ? null : r.window_color_ids } : {}),
    // Can be used inside a door (289). WINDOW-ONLY on the wire, like the colour list: portal-settings
    // forces it off for every other category, so sending it for a door would be a value it throws away.
    ...(isWindowCat ? { inDoor: r.in_door === true } : {}),
    // Offered on (272), every category, the same collapse: every style ticked, hidden ones
    // included, goes over as null ("every style"), so a style added later offers this item
    // without a visit here.
    styleIds: styleIdsOut(r.style_ids),
    ...(isWindowCat ? { sillIn: ftInToInches(r.sill_in), sillMode: r.sill_mode === "variable" ? "variable" : "fixed" } : {}),
    // Height off the floor rides for DOORS as well since 2026-09-04 — a loft door is an
    // ordinary door row whose sill is not zero (Carolyn @27:16: "that loft door goes with the
    // doors"). sillMode stays a WINDOW-only key on purpose: portal-settings pins every door to
    // 'fixed', so sending one would be a value the save throws away, and a payload field the
    // server ignores is a field the next reader believes.
    ...(isDoorCat ? { sillIn: ftInToInches(r.sill_in) } : {}),
    imageUrl: r.image_url || null, active: r.active !== false, archived: r.archived === true, internalOnly: r.internalOnly === true,
    taxable: r.taxable !== false,
  });

  const saveLine = async () => {
    if (!edit) return;
    setBusy(true); setMsg(null);
    try {
      const { data, error } = await sb.functions.invoke("portal-settings", { body: scoped({ action: "save_fixture", ...toPayload(edit.draft) }) });
      if (error || (data && data.error)) throw new Error((error && error.message) || data.error);
      const saved = { ...edit.draft, id: edit.draft.id || (data && data.id) || null };
      const adding = edit.id == null;
      // The row is found by id INSIDE the updater, against the array as it stands right now —
      // a reload can have replaced and re-sorted it since the panel opened (see dropFromEdit).
      // Not there at all means the list moved on under a save the server accepted, so the
      // saved line is put back rather than dropped on the floor.
      setRows((rs) => {
        if (adding) return [...rs, saved];
        const at = rs.findIndex((r) => r.id === edit.id);
        return at < 0 ? [...rs, saved] : rs.map((r, j) => j === at ? saved : r);
      });
      // A new line is APPENDED, so with paging on it lands on the last page. Follow it there,
      // or a builder on page 1 of a long catalog saves a door and watches it vanish.
      if (adding) setPage(Math.max(1, Math.ceil((rows.length + 1) / pageSize)));
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

  // The open panel holds the row's ID, never its position, because nothing can keep a
  // positional index in step with this array: a delete shifts every row under it, and a
  // wholesale reload replaces the lot re-sorted live-before-archived — load() runs on the
  // refreshKey a sibling editor bumps (WindowsView, after saving window colors) and after an
  // import, both reachable with the panel open. One position of drift and saveLine writes the
  // draft over a DIFFERENT line: the edited row appears twice, its neighbour vanishes from the
  // list while still existing, and nothing errors, because the SERVER write is keyed on
  // draft.id and succeeds. Past the end of the array the same map matches nothing at all and
  // Save reports success over a list it never changed. Both are silent. An id survives every
  // one of those, so the only thing left to follow is the edited row being deleted outright.
  const dropFromEdit = (row) => {
    if (!row) return;
    setEdit((e) => (e && e.id != null && e.id === row.id ? null : e));
  };
  const confirmDelete = async () => {
    const row = pendingDelete; if (!row) return;
    // A line that never reached the server has no id. Drop it locally instead of asking the
    // server to delete nothing — that round trip could only ever come back as an error, and
    // it left the builder unable to clear a row they could see.
    if (!row.id) {
      dropFromEdit(row);
      setRows((rs) => rs.filter((r) => r !== row));
      setPendingDelete(null);
      setMsg({ ok: "Removed the unsaved line." });
      return;
    }
    setBusy(true); setMsg(null);
    try {
      const { data, error } = await sb.functions.invoke("portal-settings", { body: scoped({ action: "delete_fixture", id: row.id }) });
      if (error || (data && data.error)) throw new Error((error && error.message) || data.error);
      dropFromEdit(row);
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
  // "Height off floor" appears in BOTH lists since 2026-09-04 — the door sheet needs it so a
  // builder can set loft-door heights in bulk (see the edit panel). Adding a column is safe
  // for anyone holding an older sheet: import matches columns BY NAME and an absent one is
  // left untouched, so an old export re-imports exactly as it always did.
  const HEADERS = hasSwingOp
    ? ["ID", "Style", "Label on plan", "Width", "Height", "Price", "Swing out", "Swing in", "Default swing", "Opens right", "Opens left", "Double", "Slide up", "Default operation", "Color mode", "Trim color", "Fixed color", "Height off floor", "Photo on estimate", "Active", "Internal only", "Taxable", "Archived"]
    : ["ID", "Style", "Label on plan", "Width", sizeWord === "length" ? "Length" : "Height", "Price", ...(isWindowCat ? ["Colors", "Height off floor", "Placement"] : []), "Photo on estimate", "Active", "Internal only", "Taxable", "Archived"];
  const yn = (b) => (b ? "yes" : "no");
  // The Fixed color column carries the color's LABEL (ids mean nothing in Excel); import
  // resolves it back against the door-flagged palette.
  const fixedColorLabel = (r) => { const fc = doorColors.find((c) => c.id === r.fixed_color_id); return fc ? fc.label : ""; };
  // The window Colors column carries LABELS too: "all" = every color (a color added later
  // appears automatically), "none" = no color choice, else a comma-separated subset.
  const winColorsCell = (r) => {
    if (r.window_color_ids === null) return "all";
    const names = winColors.filter((c) => r.window_color_ids.includes(String(c.id))).map((c) => c.label);
    return names.length ? names.join(", ") : "none";
  };
  const exportRows = () => rows.map((r) => hasSwingOp
    ? [r.id || "", r.name, r.plan_label, r.width_in, r.height_in, r.price === "" ? "" : Number(r.price), yn(r.swing_out), yn(r.swing_in), r.swing_default || "", yn(r.op_right), yn(r.op_left), yn(r.op_double), yn(r.op_slideup), r.op_default || "", r.color_mode || "fixed", yn(r.has_trim_color), fixedColorLabel(r), r.sill_in || "", yn(r.show_image_on_estimate), yn(r.active), yn(r.internalOnly), yn(r.taxable), yn(r.archived)]
    : [r.id || "", r.name, r.plan_label, r.width_in, r.height_in, r.price === "" ? "" : Number(r.price), ...(isWindowCat ? [winColorsCell(r), r.sill_in || "", (r.sill_mode === "variable" ? "variable" : "fixed")] : []), yn(r.show_image_on_estimate), yn(r.active), yn(r.internalOnly), yn(r.taxable), yn(r.archived)]);
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
        iCMode = col("color mode"), iTrimC = col("trim color"), iFixedC = col("fixed color"), iWinColors = col("colors"),
        iSill = col("height off floor"), iSillMode = col("placement"),
        iPhoto = col("photo on estimate", "on estimate"), iActive = col("active"), iInternal = col("internal only", "internal"), iTaxable = col("taxable", "tax"), iArch = col("archived");
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
          internalOnly: bool(cols, iInternal, false), taxable: bool(cols, iTaxable, true), archived: bool(cols, iArch, false),
        };
        if (hasSwingOp) {
          row.swingOut = bool(cols, iSwOut, false); row.swingIn = bool(cols, iSwIn, false);
          const sd = String(iSwDef >= 0 ? (cols[iSwDef] == null ? "" : cols[iSwDef]) : "").trim().toLowerCase();
          row.swingDefault = iSwDef < 0 ? undefined : ((sd === "in" || sd === "out") ? sd : null);
          row.opRight = bool(cols, iOpR, false); row.opLeft = bool(cols, iOpL, false);
          row.opDouble = bool(cols, iOpD, false); row.opSlideUp = bool(cols, iOpS, false);
          const od = String(iOpDef >= 0 ? (cols[iOpDef] == null ? "" : cols[iOpDef]) : "").trim().toLowerCase();
          row.opDefault = iOpDef < 0 ? undefined : ((od === "right" || od === "left") ? od : null);
          // Color columns follow the same absent-column-leaves-untouched contract. "Fixed
          // color" carries the color's LABEL; an unknown label goes over as "" so the server
          // clears it with a note rather than silently keeping a stale color.
          if (iCMode >= 0) {
            const cm = String(cols[iCMode] == null ? "" : cols[iCMode]).trim().toLowerCase();
            row.colorMode = (cm === "paint" || cm === "match") ? cm : "fixed";
          }
          row.hasTrimColor = bool(cols, iTrimC, false);
          if (iFixedC >= 0) {
            const lbl = String(cols[iFixedC] == null ? "" : cols[iFixedC]).trim();
            const fc = lbl ? doorColors.find((c) => String(c.label).trim().toLowerCase() === lbl.toLowerCase()) : null;
            row.fixedColorId = fc ? fc.id : (lbl ? "unknown:" + lbl : null);
          }
        }
        if (isWindowCat && iWinColors >= 0) {
          // "all"/blank = every color (null), "none" = empty list, else labels → ids
          // (unknown labels are dropped; the server filters again by tenant).
          const raw = String(cols[iWinColors] == null ? "" : cols[iWinColors]).trim();
          if (raw === "" || raw.toLowerCase() === "all") row.windowColorIds = null;
          else if (raw.toLowerCase() === "none") row.windowColorIds = [];
          else {
            const names = raw.split(/[,;]/).map((s) => s.trim().toLowerCase()).filter(Boolean);
            row.windowColorIds = winColors.filter((c) => names.includes(String(c.label).trim().toLowerCase())).map((c) => String(c.id));
          }
        }
        // Height off floor / Placement (139), same absent-column-leaves-it-alone contract.
        // A BLANK cell is meaningful here and is not the same as an absent column: blank
        // means "the standard 3'6"" for a window and "on the floor" for a door, and either
        // way it goes over as null rather than being skipped.
        //
        // Doors read the same column since 2026-09-04 (Carolyn's loft door) — the Placement
        // column below stays window-only, because portal-settings pins every door to 'fixed'
        // and importing a 'variable' onto one would be a value the save silently discards.
        if ((isWindowCat || isDoorCat) && iSill >= 0) row.sillIn = ftInToInches(String(cols[iSill] == null ? "" : cols[iSill]).replace(/\s/g, ""));
        if (isWindowCat && iSillMode >= 0) {
          row.sillMode = /^\s*(variable|slide|adjustable)\b/i.test(String(cols[iSillMode] == null ? "" : cols[iSillMode])) ? "variable" : "fixed";
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
  const blank = () => ({ id: null, name: "", plan_label: "", show_image_on_estimate: true, width_in: "", height_in: "", price: "", swing_in: false, swing_out: hasSwingOp, swing_default: null, op_right: hasSwingOp, op_left: false, op_double: false, op_slideup: false, op_default: null, color_mode: "fixed", has_trim_color: false, fixed_color_id: null, window_color_ids: null, in_door: false, style_ids: null, sill_in: "", sill_mode: "fixed", door_style: "auto", image_url: null, active: true, archived: false, internalOnly: false, taxable: true });
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
    if (isDoorCat) {
      const trimTag = r.has_trim_color ? " + trim color" : "";
      if (r.color_mode === "paint") parts.push(`customer picks color${trimTag}`);
      else if (r.color_mode === "match") parts.push(`matches building${trimTag}`);
      else if (r.fixed_color_id) {
        const fc = doorColors.find((c) => c.id === r.fixed_color_id);
        parts.push(fc ? `color: ${fc.label}` : "fixed color");
      }
    }
    if (isWindowCat && winColors.length > 0 && r.window_color_ids !== null) {
      const names = winColors.filter((c) => r.window_color_ids.includes(String(c.id))).map((c) => c.label);
      parts.push(names.length === 0 ? "no colors" : `colors: ${names.join(", ")}`);
    }
    // Can go inside a door (289): said on the row, only when ticked.
    if (isWindowCat && r.in_door) parts.push("can go in a door");
    // A raised DOOR says so on its row. It is the one field that separates a loft door from a
    // walk door in a list where both read "3' x 4'", and a builder scanning the list for the
    // one they got wrong should not have to open each row to find it. Only when set, so an
    // ordinary door's summary line is unchanged.
    if (isDoorCat && String(r.sill_in || "").trim()) parts.push(`${String(r.sill_in).trim()} off the floor`);
    // Offered on some styles only (272): said on the row, so a builder looking for why an item
    // is missing from a style's designer finds the answer without opening each line.
    if (styleIdsOut(r.style_ids) !== null) {
      const names = offerStyles.filter((s) => r.style_ids.includes(String(s.id))).map((s) => s.label);
      // None shown: hidden styles, or (no foreign key on the list) styles deleted since.
      parts.push(names.length ? `only on ${names.join(", ")}`
        : r.style_ids.some((id) => allStyleIds.includes(id)) ? "only on hidden styles" : "on no style: its styles were deleted");
    }
    if (r.image_url && r.show_image_on_estimate) parts.push("photo on estimate");
    return parts.join("  ·  ");
  };

  const editPanel = () => (
    <div style={{ border: `2px solid ${ACCENT}`, background: "#FAFAFF", borderRadius: 10, padding: "14px 16px", marginBottom: 8 }}>
      <div style={{ fontSize: 12, fontWeight: 800, color: ACCENT, marginBottom: 10, textTransform: "uppercase", letterSpacing: 0.5 }}>{edit.id == null ? `New ${noun}` : `Editing — ${edit.draft.name || noun}`}</div>
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
      {isDoorCat && (
        <div style={{ display: "flex", gap: 14, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 12 }}>
          <div>
            <div style={fldLbl}>Door color</div>
            <select value={edit.draft.color_mode || "fixed"}
              onChange={(e) => setDraft({ color_mode: e.target.value, ...(e.target.value === "fixed" ? { has_trim_color: false } : {}) })}
              style={{ ...S.input, minWidth: 0 }}>
              <option value="fixed">One fixed color</option>
              <option value="paint">Customer picks a color</option>
              <option value="match">Match building colors</option>
            </select>
          </div>
          {(edit.draft.color_mode || "fixed") === "fixed" && (
            <div>
              <div style={fldLbl}>Color</div>
              <select value={edit.draft.fixed_color_id || ""} onChange={(e) => setDraft({ fixed_color_id: e.target.value || null })} style={{ ...S.input, minWidth: 0 }}>
                <option value="">(none)</option>
                {doorColors.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
            </div>
          )}
          {(edit.draft.color_mode === "paint" || edit.draft.color_mode === "match") && (
            <div style={{ paddingBottom: 6 }}>
              {dCbx("has_trim_color", "Customer also picks a trim color", "Two-tone door: the customer picks a main color AND a trim color (both from colors ticked for Doors)")}
            </div>
          )}
          <div style={{ fontSize: 12, color: "#94A3B8", paddingBottom: 8, flexBasis: "100%" }}>
            {(edit.draft.color_mode || "fixed") === "fixed"
              ? "One fixed color — the customer sees no color choice on this door."
              : doorColors.length === 0
                ? "⚠ No colors are ticked for Doors yet — tick the Doors box on colors in the Colors tab, or this door will offer no colors."
                : edit.draft.color_mode === "match"
                  ? "Starts on the building's body/trim colors; the customer can change either."
                  : "The customer picks from the colors ticked for Doors in the Colors tab."}
          </div>
        </div>
      )}
      {isWindowCat && winColors.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={fldLbl}>Colors <span style={{ fontWeight: 400 }}>this window comes in</span></div>
          <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
            {winColors.map((c) => {
              const ids = edit.draft.window_color_ids;
              const checked = ids === null || ids.includes(String(c.id));
              const toggle = (on) => {
                const all = winColors.map((x) => String(x.id));
                const cur = ids === null ? all : ids.filter((x) => all.includes(x));
                const next = on ? [...new Set([...cur, String(c.id)])] : cur.filter((x) => x !== String(c.id));
                // Every box ticked collapses back to null ("all") so colors added later
                // appear on this window automatically.
                setDraft({ window_color_ids: next.length === all.length ? null : next });
              };
              return (
                <label key={c.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "#334155", cursor: "pointer", whiteSpace: "nowrap" }}>
                  <input type="checkbox" checked={checked} onChange={(e) => toggle(e.target.checked)} style={{ width: 16, height: 16, cursor: "pointer", accentColor: DOOR_MINT }} />
                  <span style={{ width: 13, height: 13, borderRadius: 3, background: c.hex || "#CCC", border: "1px solid rgba(0,0,0,0.15)", flexShrink: 0 }} />
                  {c.label}
                </label>
              );
            })}
          </div>
          {edit.draft.window_color_ids !== null && winColors.every((c) => !edit.draft.window_color_ids.includes(String(c.id))) && (
            <div style={{ fontSize: 12, color: "#94A3B8", marginTop: 6 }}>No colors ticked — this window is placed with no color choice.</div>
          )}
        </div>
      )}
      {/* Can be used inside a door (migration 289; asked for on 2026-10-06: the window settings get
          "a can be used inside a door option"). The customer then sees it in the door picker for the four
          built door looks, but only where it fits the upper panel of one door leaf, and it is priced
          as its own window line, once per leaf. Windows only. */}
      {isWindowCat && (
        <div style={{ marginBottom: 12 }}>
          {dCbx("in_door", "Can be used inside a door", "Offer this window in the upper panel of the American, Basic, Classic and Dutch doors")}
          <div style={{ fontSize: 12, color: "#94A3B8", marginTop: 6 }}>
            {edit.draft.in_door
              ? "Offered in the door picker for the American, Basic, Classic and Dutch doors it fits. Each one is charged as a window, one per door (two on a double door)."
              : "Only on the walls. Tick to offer it inside the American, Basic, Classic and Dutch doors as well."}
          </div>
        </div>
      )}
      {/* Offered on (272), for every category: the styles a customer can add this item to. A
          builder asked for louvered vents on greenhouses only (2026-10-02); the same ticks keep a
          garage door off a style sold without one. Only with two or more styles, since one style
          leaves nothing to choose. Same collapse as the window colours: every style ticked, hidden
          ones included, is "every style", including ones added later. A hidden style has no box, so
          a tick change carries its place in the list through untouched. None ticked cannot be saved
          (an item offered nowhere is Active unticked), and the Save button says so. */}
      {offerStyles.length > 1 && (
        <div style={{ marginBottom: 12 }}>
          <div style={fldLbl}>Offered on <span style={{ fontWeight: 400 }}>these building styles</span></div>
          <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
            {offerStyles.map((s) => {
              const ids = edit.draft.style_ids;
              const checked = ids == null || ids.includes(String(s.id));
              const toggle = (on) => {
                const all = allStyleIds;
                const cur = ids == null ? all : ids.filter((x) => all.includes(x));
                const next = on ? [...new Set([...cur, String(s.id)])] : cur.filter((x) => x !== String(s.id));
                setDraft({ style_ids: all.every((x) => next.includes(x)) ? null : next });
              };
              return (
                <label key={s.id} data-ss-offered-on={s.key} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "#334155", cursor: "pointer", whiteSpace: "nowrap" }}>
                  <input type="checkbox" checked={checked} onChange={(e) => toggle(e.target.checked)} style={{ width: 16, height: 16, cursor: "pointer", accentColor: DOOR_MINT }} />
                  {s.label}
                </label>
              );
            })}
          </div>
          <div style={{ fontSize: 12, color: offeredNowhere(edit.draft) ? "#DC2626" : "#94A3B8", marginTop: 6 }}>
            {offeredNowhere(edit.draft)
              ? `Tick at least one style. To stop offering this ${noun} everywhere, untick Active instead.`
              : styleIdsOut(edit.draft.style_ids) == null
                ? `Offered on every style, and on any style you add later.`
                : `Customers designing any other style won't see this ${noun}.`}
          </div>
        </div>
      )}
      {/* Height off the floor (139). Carolyn, 2026-08-25: "how far off the floor, not off
          the ground, off the floor, which is off the inside of the building, not the
          exterior." Every window used to render at the same 3'6" in 3D no matter what the
          builder sells, so a transom and a picture window sat at the same height.
          Independent of the width/height fields above because it is not a size — it is
          where the window is INSTALLED. */}
      {isDoorCat && (
        <div style={{ marginBottom: 12 }}>
          <div style={fldLbl}>How it looks in 3D</div>
          <select value={D3_DOOR_STYLES.includes(edit.draft.door_style) ? edit.draft.door_style : "auto"}
            onChange={(e) => setDraft({ door_style: e.target.value })}
            style={{ ...S.input, minWidth: 0, maxWidth: 380 }}>
            <option value="auto">Use the door's photo</option>
            <option value="plank">Board-and-batten (built in 3D)</option>
            <option value="zbrace">Board-and-batten with a Z brace</option>
            <option value="xbrace">Board-and-batten with an X brace</option>
            <option value="rollup">Roll-up / garage door</option>
            <option value="american">American (built in 3D)</option>
            <option value="basic">Basic (built in 3D)</option>
            <option value="classic">Classic (built in 3D)</option>
            <option value="dutch">Dutch (built in 3D)</option>
          </select>
          <div style={{ fontSize: 12, color: "#94A3B8", marginTop: 6 }}>
            {D3_DOOR_STYLE_HINT[edit.draft.door_style] || D3_DOOR_STYLE_HINT.auto}
          </div>
        </div>
      )}
      {/* Height off the floor — ONE control for windows and doors since 2026-09-04, not two.
          Carolyn's LOFT DOOR is a category='door' fixture that hangs high on a gable end
          (@24:43 "it's called a loft door"; @27:16 "that loft door goes with the doors"), and
          how far up IS the whole difference between it and a walk door. It is the same
          question a window's sill answers, stored in the same column, so it is asked with the
          same field rather than a parallel one that could drift in wording or units.

          The PLACEMENT select stays window-only. 'variable' lets a shopper slide the opening
          up and down the wall in 3D — Carolyn's transom — and a loft door's height is set by
          where the builder's loft floor is, not by the customer. portal-settings pins every
          door to 'fixed' on save, so offering the select here would be a control whose value
          the server discards. */}
      {(isWindowCat || isDoorCat) && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
            <div>
              <div style={fldLbl}>Height off floor</div>
              {/* Spaces stripped as they are typed, exactly like Width and Height above:
                  parseFtIn returns NaN on any internal whitespace and ftInToInches turns that
                  into "", which is the wire form of BLANK — so `6' 6"` saved as "use the
                  standard 3'6"", green banner and all, and the window sat at 3'6" in 3D on
                  every customer's building. A null sill is legal, so nothing downstream could
                  catch it; width and height only survive the same typo because the server
                  rejects a null width. */}
              <input value={edit.draft.sill_in || ""} onChange={(e) => setDraft({ sill_in: e.target.value.replace(/\s/g, "") })}
                placeholder={isDoorCat ? `on the floor` : `standard (3'6")`} style={{ ...S.input, minWidth: 0, width: 140 }} />
            </div>
            {isWindowCat && (
              <div>
                <div style={fldLbl}>Placement</div>
                <select value={edit.draft.sill_mode === "variable" ? "variable" : "fixed"}
                  onChange={(e) => setDraft({ sill_mode: e.target.value })}
                  style={{ ...S.input, minWidth: 0 }}>
                  <option value="fixed">Fixed at this height</option>
                  <option value="variable">Customer can slide it up and down</option>
                </select>
              </div>
            )}
          </div>
          <div style={{ fontSize: 12, color: "#94A3B8", marginTop: 6 }}>
            {/* The door hint names the loft door outright. A builder reading "height off
                floor" on a DOOR would reasonably assume it was a mistake, or a threshold
                allowance, unless the field says what it is for. */}
            {isDoorCat
              ? `Leave blank for a normal door on the floor. Fill it in for a loft door — e.g. 7'6" puts it up on the gable end, above the walk door, with no ramp and no swing arc on the plan.`
              : edit.draft.sill_mode === "variable"
                ? `Starts at ${(edit.draft.sill_in || "").trim() || `3'6"`} and the customer can move it up or down the wall in 3D — for transoms and high windows beside a garage door.`
                : `Always sits this far above the floor inside the building. Leave blank for the standard 3'6".`}
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
        {dCbx("taxable", "Taxable", "Untick if you don't charge sales tax on this item. It then shows on the quote and invoice under a separate non-taxable subtotal.")}
        <span style={{ flex: 1 }} />
        <button onClick={() => setEdit(null)} disabled={busy} style={S.btn("#F1F5F9", "#334155")}>Cancel</button>
        <button onClick={saveLine} disabled={busy || !edit.draft.name.trim() || offeredNowhere(edit.draft)} title={offeredNowhere(edit.draft) ? "Tick at least one building style under Offered on" : undefined} style={{ ...S.btn(ACCENT, "#FFF"), opacity: (busy || !edit.draft.name.trim() || offeredNowhere(edit.draft)) ? 0.55 : 1 }}>{busy ? "Saving…" : `Save ${noun}`}</button>
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
      {/* loading="lazy": one image request per line, all fired at once the moment the list
          paints. Paging caps how many exist at all; lazy caps how many of those race. */}
      {r.image_url
        ? <img src={r.image_url} alt="" loading="lazy" style={thumb} />
        : <div style={{ ...thumb, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, color: "#CBD5E1" }}>📷</div>}
      <div style={{ flex: 1, minWidth: 200, display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontWeight: 700, fontSize: 14, color: "#1E293B" }}>{r.name || "(unnamed)"}</span>
        <span style={{ fontSize: 12.5, color: "#64748B" }}>{summary(r)}</span>
      </div>
      {!r.active && chip("Hidden", "#F1F5F9", "#64748B", "Active is off — not offered in the designer")}
      {r.internalOnly && chip("Internal", "#E2E8F0", "#475569", "Internal Designer only — customers can't add it")}
      {r.taxable === false && chip("No tax", "#FEF3C7", "#B45309", "Not subject to sales tax — appears under the non-taxable subtotal on quotes and invoices")}
      {r.archived && chip("Archived", "#FEF3C7", "#B45309", "Retired from new builds; still shows on existing designs")}
      <button onClick={() => setEdit({ id: r.id, draft: { ...r } })} disabled={busy} style={S.btn("#F1F5F9", "#334155")}>Edit</button>
      <button onClick={() => quickSave(i, { archived: !r.archived })} disabled={busy}
        title={r.archived ? "Restore to active" : "Archive: retire from new builds, keep on existing designs"}
        style={S.btn(r.archived ? "#FEF3C7" : "#F1F5F9", r.archived ? "#B45309" : "#64748B")}>{r.archived ? "Unarchive" : "Archive"}</button>
      <button onClick={() => setPendingDelete(r)} disabled={busy} style={S.btn("#FEF2F2", "#DC2626")}>✕</button>
    </div>
  );

  // Clamped rather than reset: deleting the last row on the last page should fall back a
  // page, not leave the builder staring at an empty list with no way to tell why.
  const curPage = Math.min(page, Math.max(1, Math.ceil(rows.length / pageSize)));
  // Where the open panel's row sits RIGHT NOW — derived every render from the id, never
  // stored, so a delete or a reload that re-sorts the list can't leave it aimed at a
  // neighbour (see dropFromEdit). -1 = the add-new panel, or a row the list no longer holds.
  const editIdx = (edit && edit.id != null) ? rows.findIndex((r) => r.id === edit.id) : -1;

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
      {/* Grey blocks in the line's own shape rather than the word "Loading" (see SkelBar in
          01-core). These are flex lines, not a table, so SkelRows — which is <tr>-based —
          would be the wrong component here; the blocks are composed into the same row
          instead: handle, photo, name + summary, then the three per-line buttons. */}
      {!loaded ? (
        <div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
            <span style={{ flex: 1 }} /><SkelBar w={116} h={30} /><SkelBar w={78} h={30} />
          </div>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, border: "1px solid #E2E8F0", borderRadius: 8, padding: "7px 10px", marginBottom: 8, opacity: 1 - i * 0.16 }}>
              <SkelBar w={10} h={14} style={{ flexShrink: 0 }} />
              <SkelBar w={48} h={36} style={{ flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 200, display: "flex", alignItems: "baseline", gap: 10 }}>
                <SkelBar w={110} h={12} /><SkelBar w={150} h={10} />
              </div>
              <SkelBar w={44} h={26} style={{ flexShrink: 0 }} /><SkelBar w={62} h={26} style={{ flexShrink: 0 }} /><SkelBar w={28} h={26} style={{ flexShrink: 0 }} />
            </div>
          ))}
          <SkelBar w={104} h={30} />
        </div>
      ) : (
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
          {/* ⚠️ `editIdx`, `dragIdx` and `moveRow(from,to)` are FULL-ARRAY indices, and
              persistOrder posts the whole ordered id list to reorder_fixtures — so every
              handler is still handed the GLOBAL index `i`, never the page-local `j`. Passing
              the page-local one would reorder the wrong rows and silently persist that.
              Dragging across a page boundary is impossible either way (there is no unrendered
              row to drop onto) — a real limit of paging this list, not something to paper over. */}
          {rows.slice((curPage - 1) * pageSize, curPage * pageSize).map((r, j) => {
            const i = (curPage - 1) * pageSize + j;
            return (editIdx === i) ? <React.Fragment key={r.id || `edit-${i}`}>{editPanel()}</React.Fragment> : line(r, i);
          })}
          {/* Shown once the list is longer than the SMALLEST offered size, not longer than the
              current one: gated on `> pageSize`, a builder who picked 100 for their 40 windows
              would watch the control that did it disappear, with no way back to 30. Below 10
              rows no offered size can page the list, so the bar would be furniture. */}
          {rows.length > PAGE_SIZES[0] && <PageBar size={pageSize} onSize={setPageSize} page={curPage} onPage={setPage} total={rows.length} noun={noun} />}
          {/* The panel also renders HERE when the row being edited is not on this page, which is
              reachable the moment paging exists: open Edit on window #12, click "Next →", and the
              panel — whose only Cancel button lives inside it — disappears with the row, while
              `edit` stays set. That leaves "+ Add" greyed and every row undraggable with nothing
              on screen explaining why, and the only escapes are paging back or clicking Edit on
              another row, which silently discards the typed draft. Changing the page size does it
              too (onSize resets to page 1). Keeping the panel visible lets the edit be finished or
              cancelled from wherever the builder ended up.

              The upper bound is min(page end, rows.length) and NOT the page end, because the slice
              above is truncated by rows.length: on a partly-filled last page the band between them
              is rendered by neither branch. `curPage * pageSize` alone put the panel back in the
              exact lockout this comment describes, with no paging involved at all — a two-row
              catalog, Edit the second row, delete the first. */}
          {edit && (editIdx < 0
            || editIdx < (curPage - 1) * pageSize
            || editIdx >= Math.min(curPage * pageSize, rows.length)) && editPanel()}
          <button onClick={() => setEdit({ id: null, draft: blank() })} disabled={busy || !!edit} style={{ ...S.btn("#1E293B", "#FFF"), opacity: (busy || !!edit) ? 0.55 : 1 }}>+ {addLabel}</button>
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

// ─── Vents (Carolyn 2026-09-04 @25:19–27:14) ───
// Ahsan asked whether a vent should be its own category or live with windows; she answered
// the PRICING question instead, and that answer is what settles the shape: "most of the
// time it comes with the building. But there are times when they have ... an upcharge for a
// different vent ... I do think we need to put it in as an item for them to put in and say
// no charge or it is a charge."
//
// So a vent is a fixture, not a boolean on the style. `price` already carries all three
// states this needs and needs no new column: NULL = not offered, 0 = included in the
// building, > 0 = an upcharge. That is the same convention doors and windows already use.
//
// ⚠️ NOT the same thing as `styleD3.gableVent`. That is a per-STYLE appearance field the
// video AI infers ("omit the whole gableVent object if the gable ends carry no vent") — it
// describes how this builder's buildings already look. This is a CATALOG item a customer
// chooses and may be billed for. Both can be true of one building and they answer different
// questions, so neither replaces the other.
//
// No swing, no operation, no trim colour, no sill: the shared validator forces that whole
// group off for any non-door / non-window category, so a vent row is width, height, price.
function VentsView({ viewingLabel = null, clientId = null }) {
  return (
    <div style={S.card}>
      <div style={S.h2}>Vents</div>
      <p style={{ fontSize: 13, color: "#64748B", marginBottom: 14, lineHeight: 1.5 }}>
        Gable and wall vents a customer can add to a building. Leave the <b>price blank</b> if you do not offer
        one, set it to <b>0</b> if every building includes it at no charge, or enter an amount to charge for it —
        the same three states the doors and windows lists use. Each vent is <b>one line</b>; click <b>Edit</b> to
        change it and every line saves on its own. Drag <b>⠿</b> to set the order customers see. Sizes are
        feet/inches — 12", 1'6" (no spaces). To sell a vent on some building styles only, click <b>Edit</b> and
        untick the others under <b>Offered on</b>.
      </p>
      <FixtureCatalog category="vent" noun="vent" addLabel="Add vent" namePh="e.g. Gable vent" labelPh="VNT" wPh={'12"'} hPh={'12"'} sizeWord="height" viewingLabel={viewingLabel} clientId={clientId} />
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
    // Joins the sibling catalog reads fired in this same mount tick — see
    // window.__ssCatalogFlight above. This component keeps `rampSettings` alone out of the
    // whole ten-table payload, so its own copy of the round trip bought nothing.
    const body = scoped({ action: "catalog" });
    const { data, error } = await window.__ssCatalogFlight(
      () => sb.functions.invoke("portal-settings", { body }),
      String(body.targetClientId == null ? (ssTargetClientId || "") : body.targetClientId));
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
        {/* Grey blocks in this card's own shape rather than the word "Loading" (see SkelBar in
            01-core): the offer checkbox, the two mode cards at the same 1fr 1fr grid the real
            ones use, then the simple-ramp fields. Nothing about which MODE the tenant is on is
            claimed here — that answer is exactly what the read is still fetching. */}
        {!loaded ? (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
              <SkelBar w={18} h={18} /><SkelBar w={210} h={13} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 20 }}>
              {[0, 1].map((i) => (
                <div key={i} style={{ border: "2px solid #E2E8F0", borderRadius: 12, padding: "12px 14px", display: "flex", gap: 10 }}>
                  <SkelBar w={16} h={16} style={{ borderRadius: "50%", flex: "0 0 auto" }} />
                  <div style={{ flex: 1 }}><SkelBar w="50%" h={12} style={{ marginBottom: 7 }} /><SkelBar w="92%" h={10} /></div>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "flex-end" }}>
              <div><SkelBar w={92} h={10} style={{ marginBottom: 6 }} /><SkelBar w={210} h={30} /></div>
              <div><SkelBar w={40} h={10} style={{ marginBottom: 6 }} /><SkelBar w={130} h={30} /></div>
              <div><SkelBar w={108} h={10} style={{ marginBottom: 6 }} /><SkelBar w={104} h={30} /></div>
            </div>
            <div style={{ display: "flex", marginTop: 20 }}>
              <div style={{ flex: 1 }} /><SkelBar w={150} h={30} />
            </div>
          </div>
        ) : (<>
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
// ─── Window colors (Options tab → Windows section, 116) ───
// ONE small per-client list — every active window offers every active color here, so a
// builder never enters the same window twice for a second color. rate is a flat $ added
// per window (0 = included). Full-list replace via save_window_colors (same delete-sweep
// semantics as the Colors tab, hence the same operator view-as confirm).
function WindowColorsEditor({ viewingLabel = null, clientId = null, onSaved = null }) {
  const scoped = (body) => (viewingLabel && clientId ? { ...body, targetClientId: clientId } : body);
  const [rows, setRows] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = async () => {
    // Joins the sibling catalog reads fired in this same mount tick — see
    // window.__ssCatalogFlight above. This editor keeps `windowColors` alone out of the whole
    // ten-table payload. NOTE the post-save `load()` below is a LATER tick and therefore
    // always gets its own read — which is the point: it must never see pre-save colors.
    const body = scoped({ action: "catalog" });
    const { data, error } = await window.__ssCatalogFlight(
      () => sb.functions.invoke("portal-settings", { body }),
      String(body.targetClientId == null ? (ssTargetClientId || "") : body.targetClientId));
    if (error || (data && data.error)) { setMsg({ err: (error && error.message) || data.error }); return; }
    setRows((data.windowColors || []).map((c) => ({
      id: c.id, label: c.label || "", hex: c.hex || null,
      rate: (c.rate != null ? String(c.rate) : "0"),
      is_default: c.is_default === true, active: c.active !== false,
    })));
    setLoaded(true);
  };
  useEffect(() => { load(); }, []);

  const setRow = (i, field, val) => setRows((rs) => rs.map((r, j) => j === i ? { ...r, [field]: val } : r));
  // Only one default makes sense — the picker preselects the FIRST default it finds, so
  // ticking one unticks the rest rather than leaving a state only the code can resolve.
  const setDefault = (i, on) => setRows((rs) => rs.map((r, j) => ({ ...r, is_default: j === i ? on : (on ? false : r.is_default) })));
  const swap = (i, j) => setRows((rs) => { if (j < 0 || j >= rs.length) return rs; const next = rs.slice(); [next[i], next[j]] = [next[j], next[i]]; return next; });
  const addRow = () => setRows((rs) => [...rs, { id: null, label: "", hex: "#F5F2EA", rate: "0", is_default: rs.length === 0, active: true }]);
  const removeRow = (i) => setRows((rs) => rs.filter((_, j) => j !== i));

  const save = async () => {
    if (viewingLabel && !window.confirm(`Replace ${viewingLabel}'s ENTIRE window color list with these ${rows.length} color(s)?\n\nAnything not shown here will be removed from their account.`)) return;
    setBusy(true); setMsg(null);
    try {
      // Rates are validated, never coerced: `Number(r.rate) || 0` used to turn an unparseable
      // rate into a silent $0 BEFORE the request, sneaking past the server's own invalid-rate
      // guard, so the color then priced at $0 on every customer estimate — the same hole the
      // 2026-08-20 audit closed in LayoutPricing.save. Refuse and name the rows instead. A
      // blank rate still means 0 — that's how an untouched row round-trips.
      const rateOf = (r) => { const s = String(r.rate ?? "").trim(); return s === "" ? 0 : Number(s); };
      const bad = rows.filter((r) => { const n = rateOf(r); return !Number.isFinite(n) || n < 0; });
      if (bad.length) throw new Error(`Nothing was saved — fix these rate(s) first, they aren't usable dollar amounts: ${bad.map((r) => `${r.label || "unnamed color"} ("${r.rate}")`).join(", ")}.`);
      const colors = rows.map((r, i) => ({
        id: r.id || undefined, label: r.label, hex: r.hex || null,
        rate: rateOf(r), isDefault: r.is_default === true, active: r.active !== false, sortOrder: i,
      }));
      const { data, error } = await sb.functions.invoke("portal-settings", { body: scoped({ action: "save_window_colors", colors }) });
      if (error || (data && data.error)) throw new Error((error && error.message) || data.error);
      await load();
      // Tell the host a save landed so the window catalog below re-reads — a just-added
      // color must appear in the per-window checkboxes without a page refresh.
      if (onSaved) onSaved();
      const skipped = (data && data.skipped) || [];
      setMsg({ ok: `Saved ${data.saved || 0} color(s)` + (data.deleted ? `, removed ${data.deleted}` : "") + (skipped.length ? `, ${skipped.length} skipped: ${skipped.join("; ")}` : "") + "." });
    } catch (e) { setMsg({ err: e.message }); }
    setBusy(false);
  };

  const errStyle = { background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 8, padding: "9px 13px", color: "#DC2626", fontSize: 13, fontWeight: 600, marginBottom: 12 };
  const okStyle = { background: "#F0FDF4", border: "1px solid #BBF7D0", borderRadius: 8, padding: "9px 13px", color: "#15803D", fontSize: 13, fontWeight: 600, marginBottom: 12 };
  const ctr = { ...S.td, padding: "8px 5px", textAlign: "center" };
  const tdc = { ...S.td, padding: "8px 5px" };
  const thc = { ...S.th, padding: "8px 5px", whiteSpace: "normal" };

  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: "#1E293B", marginBottom: 4 }}>Window colors</div>
      <p style={{ fontSize: 13, color: "#64748B", marginBottom: 12, lineHeight: 1.5 }}>
        One list for <b>all</b> windows — every window below offers every active color here, so you never enter the same
        window twice for another color. <b>Price</b> is a flat dollar amount added <b>per window</b> in that color
        (leave <b>0</b> for included colors). <b>Default</b> pre-selects one. The color shows on the 3D and on the estimate.
      </p>
      {msg && msg.err && <div style={errStyle}>{msg.err}</div>}
      {msg && msg.ok && <div style={okStyle}>{msg.ok}</div>}
      {/* A real table, so the skeleton keeps the real colgroup + header and drops SkelRows into
          the body at the same seven columns — the header and the first paint line up and
          nothing shifts when the colors land. Grey blocks, not the word "Loading" (see
          SkelRows in 01-core). */}
      {!loaded ? (
        <table style={{ width: "100%", tableLayout: "fixed", borderCollapse: "collapse", marginBottom: 12 }}>
          <colgroup>
            <col style={{ width: "11%" }} /><col style={{ width: "10%" }} /><col style={{ width: "34%" }} />
            <col style={{ width: "17%" }} /><col style={{ width: "10%" }} /><col style={{ width: "10%" }} /><col style={{ width: "8%" }} />
          </colgroup>
          <thead><tr>
            <th style={thc}>Order</th><th style={thc}>Swatch</th><th style={thc}>Color name</th>
            <th style={thc}>Price per window (USD)</th>
            <th style={thc}>Default</th><th style={thc}>Active</th><th style={thc}></th>
          </tr></thead>
          <tbody><SkelRows cols={7} rows={4} widths={["55%", "40%", "80%", "60%", "35%", "35%", "30%"]} /></tbody>
        </table>
      ) : (
        <>
          {rows.length > 0 && (
            <table style={{ width: "100%", tableLayout: "fixed", borderCollapse: "collapse", marginBottom: 12 }}>
              <colgroup>
                <col style={{ width: "11%" }} /><col style={{ width: "10%" }} /><col style={{ width: "34%" }} />
                <col style={{ width: "17%" }} /><col style={{ width: "10%" }} /><col style={{ width: "10%" }} /><col style={{ width: "8%" }} />
              </colgroup>
              <thead><tr>
                <th style={thc}>Order</th><th style={thc}>Swatch</th><th style={thc}>Color name</th>
                <th style={thc} title="Flat $ added per window in this color">Price per window (USD)</th>
                <th style={thc}>Default</th><th style={thc}>Active</th><th style={thc}></th>
              </tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.id || `new-${i}`}>
                    <td style={ctr}>
                      <button onClick={() => swap(i, i - 1)} disabled={i === 0} style={{ ...S.btn("#F1F5F9", "#334155"), padding: "2px 7px" }}>▲</button>{" "}
                      <button onClick={() => swap(i, i + 1)} disabled={i === rows.length - 1} style={{ ...S.btn("#F1F5F9", "#334155"), padding: "2px 7px" }}>▼</button>
                    </td>
                    <td style={ctr}>
                      <input type="color" value={r.hex || "#CCCCCC"} onChange={(e) => setRow(i, "hex", e.target.value)} title={r.hex || "Pick this color"}
                        style={{ width: 34, height: 26, padding: 0, border: "1px solid #CBD5E1", borderRadius: 4, background: "#FFF", cursor: "pointer" }} />
                    </td>
                    <td style={tdc}>
                      <input type="text" value={r.label} placeholder="e.g. White" onChange={(e) => setRow(i, "label", e.target.value)} style={{ ...S.input, width: "100%", minWidth: 0, boxSizing: "border-box" }} />
                    </td>
                    <td style={ctr}>
                      <input type="number" min="0" step="0.01" value={r.rate ?? "0"} onChange={(e) => setRow(i, "rate", e.target.value)} style={{ ...S.input, width: "100%", minWidth: 0, boxSizing: "border-box" }} />
                    </td>
                    <td style={ctr}><input type="checkbox" checked={!!r.is_default} onChange={(e) => setDefault(i, e.target.checked)} style={{ width: 16, height: 16, cursor: "pointer" }} /></td>
                    <td style={ctr}><input type="checkbox" checked={r.active !== false} onChange={(e) => setRow(i, "active", e.target.checked)} style={{ width: 16, height: 16, cursor: "pointer" }} /></td>
                    <td style={ctr}><button onClick={() => removeRow(i)} style={S.btn("#FEF2F2", "#DC2626")}>✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {rows.length === 0 && <div style={{ fontSize: 13, color: "#64748B", marginBottom: 12 }}>No window colors yet — without any, windows are placed with no color choice (exactly as before).</div>}
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <button onClick={addRow} style={S.btn("#1E293B", "#FFF")}>+ Add color</button>
            <div style={{ flex: 1 }} />
            <button onClick={save} disabled={busy} style={S.btn(busy ? "#9CA3AF" : ACCENT, "#FFF")}>{busy ? "Saving…" : "Save window colors"}</button>
          </div>
        </>
      )}
    </div>
  );
}

function WindowsView({ viewingLabel = null, clientId = null }) {
  // Bumped when the window-color list saves → remounts the catalog's data (refreshKey), so
  // a just-added color appears in each window's availability checkboxes immediately.
  const [colorsSavedAt, setColorsSavedAt] = useState(0);
  return (
    <div style={S.card}>
      <div style={S.h2}>Windows</div>
      <WindowColorsEditor viewingLabel={viewingLabel} clientId={clientId} onSaved={() => setColorsSavedAt((n) => n + 1)} />
      <div style={{ fontSize: 14, fontWeight: 700, color: "#1E293B", marginBottom: 4 }}>Window catalog</div>
      <p style={{ fontSize: 13, color: "#64748B", marginBottom: 14, lineHeight: 1.5 }}>
        The windows your customers can add to a building. Each window is <b>one line</b> — click <b>Edit</b> to change it;
        every line saves on its own. Drag <b>⠿</b> to set the order customers see. Sizes are feet/inches — 8', 6'3", 36"
        (no spaces). <b>Export Excel</b> to edit in bulk and re-import — rows are matched by the ID column, and rows missing
        from the file are never deleted.
      </p>
      <FixtureCatalog category="window" noun="window" addLabel="Add window" namePh="e.g. Slider window" labelPh="SL" wPh={'36"'} hPh={'36"'} sizeWord="height" viewingLabel={viewingLabel} clientId={clientId} refreshKey={colorsSavedAt} />
    </div>
  );
}

// SPLIT INTO THREE TABS on 2026-09-11 (Carolyn: "in colors I want to split out the paint,
// shingles and metal colors to their own tab/nav"). `section` chooses which card renders.
//
// ⚠️ ONE component, one mount, one `rows` buffer — ColorsShell passes `section` to a SINGLE
// <ColorsView> rather than rendering three of them behind {sub === ...} branches, and that is
// load-bearing. `rows` is ONE flat list across all three categories and `save` submits the
// whole list, so three mounts would remount on every tab switch: edits made in Paint would be
// silently thrown away by a click on Shingles, and the Save button in each card — which
// already saves all three categories — would submit a list that had just been re-fetched.
// Keep the element in one stable position so React preserves this state.
function ColorsView({ viewingLabel = null, section = "all" }) {
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
      shingle: !!c.shingle, metal: !!c.metal, door: !!c.door,
      allow_custom: !!c.allow_custom, is_default: !!c.is_default, active: c.active !== false,
      hex: c.hex || null, pricing_method: c.pricing_method || "each", rate: (c.rate != null ? String(c.rate) : "0"),
      door_rate: (c.door_rate != null ? String(c.door_rate) : "0"),
      // Sales tax (migration 148): absent reads as taxable, matching the column default.
      taxable: c.taxable !== false,
      // ⚠️ THIS MAP IS A WHITELIST AND FORGETTING A FIELD LOOKS LIKE A BROKEN SAVE.
      // Caught in the browser, not by reading: the code saved to the database correctly and
      // the server returned it correctly, and it still came back blank on screen, because
      // every column added to `colors` has to be added in FOUR places -- the migration, the
      // server's SELECT, the server's write, and here. Three of the four were done.
      code: c.code || "",
    })));
  };
  useEffect(() => { load(); }, []);

  const setRow = (gi, field, val) => setRows((rs) => rs.map((r, i) => i === gi ? { ...r, [field]: val } : r));
  // New rows are tagged for the section they're added from.
  const addRow = (preset, category) => setRows((rs) => [...rs, {
    id: null, label: preset ? preset.name : "",
    siding: category === "paint", trim: category === "paint",
    shingle: category === "shingle", metal: category === "metal", door: false,
    allow_custom: false, is_default: false, active: true, hex: preset ? preset.hex : null,
    pricing_method: "each", rate: "0", door_rate: "0", taxable: true, code: "",
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
      // Rates are validated, never coerced: `Number(r.rate) || 0` used to turn an unparseable
      // rate into a silent $0 BEFORE the request, sneaking past the server's own invalid-rate
      // guard, so the colour then priced at $0 on every customer estimate — the same hole the
      // 2026-08-20 audit closed in LayoutPricing.save. Refuse and name the rows (and which of
      // the two rates is broken) instead. A blank rate still means 0 — that's how an
      // untouched row round-trips.
      const numOf = (v) => { const s = String(v ?? "").trim(); return s === "" ? 0 : Number(s); };
      const badRate = (v) => { const n = numOf(v); return !Number.isFinite(n) || n < 0; };
      const bad = [];
      rows.forEach((r) => {
        const name = r.label || "unnamed colour";
        if (badRate(r.rate)) bad.push(`${name} ("${r.rate}")`);
        if (badRate(r.door_rate)) bad.push(`${name} door price ("${r.door_rate}")`);
      });
      if (bad.length) throw new Error(`Nothing was saved — fix these rate(s) first, they aren't usable dollar amounts: ${bad.join(", ")}.`);
      const colors = rows.map((r, i) => ({
        id: r.id || undefined, label: r.label,
        siding: !!r.siding, trim: !!r.trim, shingle: !!r.shingle, metal: !!r.metal, door: !!r.door,
        allowCustom: !!r.allow_custom, isDefault: !!r.is_default, active: r.active !== false,
        sortOrder: i, hex: r.hex || null, pricingMethod: r.pricing_method || "each", rate: numOf(r.rate),
        doorRate: numOf(r.door_rate), taxable: r.taxable !== false, code: r.code || "",
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
                  is the longest at 54px) and clip below that. The Doors + Door price columns
                  (2026-08-24) squeezed name/method further; short checkbox headers (Siding/
                  Trim/Doors) tolerate 5-6% because thc wraps, Custom/Default keep 8%. */}
              {/* Code (163) came out of swatch/name/method/rate rather than being appended,
                  so each branch still sums to 100 — 15 columns here, 11 below. */}
              {showST ? (
                <>
                  <col style={{ width: "7%" }} /><col style={{ width: "5%" }} /><col style={{ width: "10%" }} /><col style={{ width: "6%" }} />
                  <col style={{ width: "5%" }} /><col style={{ width: "5%" }} /><col style={{ width: "5%" }} /><col style={{ width: "10%" }} /><col style={{ width: "8%" }} />
                  <col style={{ width: "8%" }} /><col style={{ width: "8%" }} /><col style={{ width: "8%" }} /><col style={{ width: "6%" }} /><col style={{ width: "4%" }} /><col style={{ width: "5%" }} />
                </>
              ) : (
                <>
                  <col style={{ width: "9%" }} /><col style={{ width: "7%" }} /><col style={{ width: "16%" }} /><col style={{ width: "8%" }} />
                  <col style={{ width: "14%" }} /><col style={{ width: "11%" }} />
                  <col style={{ width: "9%" }} /><col style={{ width: "9%" }} /><col style={{ width: "9%" }} /><col style={{ width: "4%" }} /><col style={{ width: "4%" }} />
                </>
              )}
            </colgroup>
            <thead><tr>
              <th style={thc}>Order</th><th style={thc}>Swatch</th><th style={thc}>Color name</th>
              <th style={thc} title="Your short code for this colour. It becomes a segment of every building serial number, e.g. the RE, BL and DW in 0826LBA1016REBLDWS5000.">Code</th>
              {showST && <th style={thc}>Siding</th>}
              {showST && <th style={thc}>Trim</th>}
              {showST && <th style={thc} title="Customers can pick this color for doors set to use paint colors">Doors</th>}
              <th style={thc}>How it’s priced</th><th style={thc}>Rate (USD)</th>
              {showST && <th style={thc} title="Flat $ added per door painted this color — separate from the siding/trim rate">Door price (USD)</th>}
              <th style={thc} title="Lets the customer type their own color instead of picking one">Custom</th>
              <th style={thc}>Default</th><th style={thc}>Active</th>
              <th style={thc} title="Untick if you don’t charge sales tax on this colour’s upcharge. It then sits under the non-taxable subtotal on quotes and invoices.">Taxable</th>
              <th style={thc}></th>
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
                  {/* Placeholder SUGGESTS, it never fills. Carolyn: "they might have other
                      color codes that they want to change it to" — a builder's paper system
                      already has codes and the app has to match it, not the reverse. Upper-
                      casing on the way in matches what the server stores, so the field does
                      not appear to change under you after a save. */}
                  <td style={tdc}>
                    <input type="text" value={r.code || ""} maxLength={4}
                      placeholder={(r.label || "").replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase() || "??"}
                      onChange={(e) => setRow(gi, "code", e.target.value.toUpperCase().slice(0, 4))}
                      style={{ ...S.input, width: "100%", minWidth: 0, boxSizing: "border-box", textTransform: "uppercase" }} />
                  </td>
                  {showST && <td style={ctr}>{chk(gi, "siding")}</td>}
                  {showST && <td style={ctr}>{chk(gi, "trim")}</td>}
                  {showST && <td style={ctr}>{chk(gi, "door")}</td>}
                  <td style={tdc}>
                    <select value={r.pricing_method || "each"} onChange={(e) => setRow(gi, "pricing_method", e.target.value)} style={{ ...S.input, width: "100%", minWidth: 0, boxSizing: "border-box" }}>
                      {LP_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                    </select>
                  </td>
                  <td style={ctr}>
                    <input type="number" min="0" step="0.01" value={r.rate ?? "0"} onChange={(e) => setRow(gi, "rate", e.target.value)} style={{ ...S.input, width: "100%", minWidth: 0, boxSizing: "border-box" }} />
                  </td>
                  {showST && <td style={ctr}>
                    <input type="number" min="0" step="0.01" value={r.door_rate ?? "0"} disabled={!r.door}
                      title={r.door ? "Flat $ added per door painted this color" : "Tick Doors to price this color on doors"}
                      onChange={(e) => setRow(gi, "door_rate", e.target.value)}
                      style={{ ...S.input, width: "100%", minWidth: 0, boxSizing: "border-box", opacity: r.door ? 1 : 0.45 }} />
                  </td>}
                  <td style={ctr}>
                    <input type="checkbox" checked={!!r.allow_custom} onChange={(e) => setAllowCustom(gi, e.target.checked)}
                      title="Picking this entry in the designer shows a free-text box instead of a swatch"
                      style={{ width: 16, height: 16, cursor: "pointer" }} />
                  </td>
                  <td style={ctr}>{chk(gi, "is_default")}</td>
                  <td style={ctr}>{chk(gi, "active")}</td>
                  <td style={ctr}>{chk(gi, "taxable")}</td>
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
    Toggle <b>Siding</b> / <b>Trim</b> / <b>Doors</b> to control where a color can be used (a color can be in all three).
    Set <b>How it’s priced</b> + a <b>Rate</b> to charge for a color — it’s added to the estimate automatically when picked
    (leave the rate at <b>0</b> for colors included in the base price). <b>Door price</b> is separate: a flat dollar amount
    added <b>per door</b> painted this color (0 = included) — it only applies to doors set to use paint colors in the Options tab.
    <b>Default</b> pre-selects a color; <b>Active</b> shows/hides it. Drag order with ▲▼.
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
      {/* This gate wraps ALL THREE sections, so the whole tab used to be one grey "Loading…"
          line inside one card until the `catalog` read landed. Grey blocks in the real table's
          shape instead (see SkelRows in 01-core): the paint section's own 13-column colgroup
          and header, so the header and the first paint line up.
          ONE section, not three. Three stacked skeletons would claim shingle and metal lists
          this tenant may not have — and a skeleton that overstates the answer is the thing
          skeletons exist to avoid. */}
      {!cat ? (
        <div style={S.card}>
          <SkelBar w={140} h={15} style={{ marginBottom: 14 }} />
          <table style={{ width: "100%", tableLayout: "fixed", borderCollapse: "collapse", marginBottom: 14 }}>
            <colgroup>
              <col style={{ width: "7%" }} /><col style={{ width: "6%" }} /><col style={{ width: "12%" }} />
              <col style={{ width: "6%" }} /><col style={{ width: "5%" }} /><col style={{ width: "6%" }} /><col style={{ width: "12%" }} /><col style={{ width: "8%" }} />
              <col style={{ width: "9%" }} /><col style={{ width: "8%" }} /><col style={{ width: "8%" }} /><col style={{ width: "7%" }} /><col style={{ width: "6%" }} />
            </colgroup>
            <thead><tr>
              <th style={thc}>Order</th><th style={thc}>Swatch</th><th style={thc}>Color name</th>
              <th style={thc}>Siding</th><th style={thc}>Trim</th><th style={thc}>Doors</th>
              <th style={thc}>How it’s priced</th><th style={thc}>Rate (USD)</th><th style={thc}>Door price (USD)</th>
              <th style={thc}>Custom</th><th style={thc}>Default</th><th style={thc}>Active</th><th style={thc}></th>
            </tr></thead>
            <tbody><SkelRows cols={13} rows={5} /></tbody>
          </table>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <SkelBar w={98} h={30} /><SkelBar w={168} h={30} />
            <div style={{ flex: 1 }} /><SkelBar w={100} h={30} />
          </div>
        </div>
      ) : (
        <>
          {(section === "all" || section === "paint") && renderSection("paint", "Paint colors", paintDesc, true)}
          {(section === "all" || section === "shingle") && renderSection("shingle", "Shingle colors", shingleDesc, false)}
          {(section === "all" || section === "metal") && renderSection("metal", "Metal colors", metalDesc, false)}
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

