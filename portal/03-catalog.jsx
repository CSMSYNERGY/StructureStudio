// ─── Settings (via portal-settings edge function; API key is write-only) ───

// Is a failed `tax_settings` read a "no tax section here" rather than a fault to show?
// These answers qualify, and each renders NOTHING (the sales-tax UI on GHL Connection and
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

function SettingsView({ section, view3d = false, onOpenTax = null }) {
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
    // Page 2 of the quote from all four corners (migration 276). On is the column's default since
    // migration 322; the box shows only once status has said what is stored.
    quoteCornerViews: true,
    // Who issues the paperwork (migration 121). Defaults to the CRM — the same default the
    // column has — so a status response that predates the column can't read as "SS issues it".
    // Invoices number separately from quotes (migration 125, Carolyn's decision).
    invoiceInGhl: true, ssQuoteNext: "", ssQuotePrefix: "", ssInvoiceNext: "", ssInvoicePrefix: "",
    // (The company sales tax rate, its label and tax on delivery left this form on 2026-10-09: they
    // are set on Company → Tax, and the Estimates & Invoices card reads them from `status`.)
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
  // The brand palette (336): its own state, not a key on `form`, because it is a LIST and the
  // `set()` helper on this page edits strings. Staged like the logo — Save Branding sends it.
  const [brandColors, setBrandColors] = useState([]);
  const saveBranding = async () => {
    setBrandBusy(true); setBrandMsg(null);
    const body = { action: "save_branding", companyName: form.brandName, tagline: form.brandTagline,
      accentColor: form.brandAccent, headerBg: form.brandHeaderBg,
      // Rows with no usable color are dropped here as well as on the server, so what the card
      // shows after a save is what was actually stored.
      brandColors: brandColors.filter((c) => ssHexColor(c.hex)).map((c) => ({ name: String(c.name || "").trim(), hex: ssHexColor(c.hex) })) };
    if (form.brandStylesPerRow !== (brandSprStored || "8")) body.stylesPerRow = Number(form.brandStylesPerRow);
    if (logoDataUrl) { body.logoBase64 = logoDataUrl; body.logoContentType = logoCt; }
    else if (clearLogo) { body.logoUrl = ""; }
    const { data, error: err } = await sb.functions.invoke("portal-settings", { body });
    setBrandBusy(false);
    if (err || (data && data.error)) { setBrandMsg({ err: (data && data.error) || err.message }); return; }
    if ("stylesPerRow" in body) setBrandSprStored(String(body.stylesPerRow));
    setBrandColors(Array.isArray(data.brandColors) ? data.brandColors : body.brandColors);
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
      setBrandColors(Array.isArray(b.brandColors) ? b.brandColors.map((c) => ({ name: String(c.name || ""), hex: String(c.hex || "") })) : []);
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
      setError("Estimates have to stay good for a whole number of days, from 1 to 365.");
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
      // it: a save from Branding or GHL Connection, or one from a tab opened before someone else
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
  // So this hides ONE checkbox. The GHL Connection card above is untouched — location id,
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
  // The company rate's home since 2026-10-09: Company → Tax. A same-document switch where the shell
  // gave us one (SettingsShell's setSub), a plain link otherwise; ssPagePath keeps ?view=.
  const taxLink = (text, color = ACCENT) => (
    <a href={ssPagePath("settings", "tax")} onClick={onOpenTax ? ssNavClick(onOpenTax) : undefined}
      style={{ color, fontWeight: 700, textDecoration: "underline" }}>{text}</a>
  );

  // SALES TAX SUMMARY — read-only, under the company rate (Avalara plan, 2026-09-17). Which rate
  // a quote charges is no longer just the box on this card: a sales location's own rate beats
  // it, and a rate verified for the delivery address beats both. Whether verified lookups are
  // on is an operator switch (`client_settings.tax_lookup_enabled`), so a builder can only see
  // it here, never flip it. No price is shown — the meters are off, and a price read follows
  // the catalog redaction precedent when it is needed.
  //
  // Asked only on the GHL Connection screen, and only when the SAVED row is SS mode —
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
      // NO ssTaxRate / ssTaxLabel / ssTaxDelivery (2026-10-09). The company rate is set on Company →
      // Tax (save_company_tax). Posting this card's copy of it on every save would write back a
      // value read when the tab opened over a rate changed there since. `save`'s paperwork guard
      // reads the STORED rate when the key is absent, so moving to paperwork with no rate on file
      // is still refused with the server's sentence.
    } });
    setInvBusy(false);
    if (err || (data && data.error)) { setInvMsg({ err: (data && data.error) || err.message }); return; }
    setInvMsg({ ok: (mayGhlInvoice && form.invoiceInGhl)
      ? "Saved — your estimates and invoices are created in your CRM, exactly as before."
      : "Saved — StructureStudio now issues your estimates and invoices. Contacts and opportunities still go to your CRM if one is connected." });
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

  // Disconnect (Carolyn 2026-10-14). The confirm spells out the three things the server
  // does — drop the credential, drop the pipeline/stage mapping, move quotes to Structure
  // Studio paperwork — because the last one changes what customers receive.
  const disconnectGhl = async () => {
    if (!window.confirm("Disconnect your CRM?\n\n• The saved Location ID and API key are removed — reconnecting means pasting a key again.\n• Your pipeline & stage mapping is cleared.\n• Estimates and invoices go out through Structure Studio paperwork from now on.\n\nContacts already in your CRM are not touched.")) return;
    setGhlMsg(null); setGhlBusy(true);
    const { data, error: err } = await sb.functions.invoke("portal-settings", { body: { action: "disconnect_ghl" } });
    setGhlBusy(false);
    if (err || (data && data.error)) { setGhlMsg({ err: (data && data.error) || (err && err.message) || "Couldn't disconnect." }); return; }
    setGhlMsg({ ok: data.movedToSs ? "CRM disconnected. Estimates and invoices now go out through Structure Studio paperwork." : "CRM disconnected." });
    setGhlApiKey(""); setGhlLocationId(""); setPipelines([]);
    const { data: st } = await sb.functions.invoke("portal-settings", { body: { action: "status" } });
    if (st && !st.error) setStatus(st);
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
        <div style={S.h2}>GHL Connection</div>
        <p style={{ fontSize: 12, color: "#64748B", marginBottom: 12 }}>
          {status && status.configured
            ? <>Connected — location <b>{status.ghlLocationIdMasked}</b>. Leave the fields blank to keep current credentials.</>
            : <>Not connected. Optional — connect GHL to mirror contacts and estimates into it. With no connection, contacts stay in Structure Studio and estimates go out through Structure Studio paperwork (switch it on below).</>}
        </p>
        {ghlMsg && ghlMsg.err && <div style={S.err}>{ghlMsg.err}</div>}
        {ghlMsg && ghlMsg.ok && <div style={ghlMsg.warn ? { ...S.okMsg, background: "#DBEAFF", color: "#1B7895", border: "1px solid #75E6DA" } : S.okMsg}>{ghlMsg.ok}</div>}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
          <div><span style={S.lbl}>GHL Location ID</span>
            <input style={S.input} name="ss-ghl-location-id" autoComplete="off" data-lpignore="true" data-1p-ignore data-form-type="other" spellCheck={false} value={ghlLocationId} onChange={(e) => setGhlLocationId(e.target.value)} placeholder={status && status.ghlLocationIdMasked ? `saved: ${status.ghlLocationIdMasked}` : "e.g. sp58arigVfqozsJSPe1z"} /></div>
          <div><span style={S.lbl}>GHL API Key</span>
            <PasswordInput style={S.input} name="ss-ghl-api-key" autoComplete="new-password" data-lpignore="true" data-1p-ignore data-form-type="other" value={ghlApiKey} onChange={(e) => setGhlApiKey(e.target.value)} placeholder={status && status.hasApiKey ? "•••• saved — type to replace" : "pit-…"} /></div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 12 }}>
          <button type="button" onClick={saveGhl} disabled={ghlBusy} style={{ ...S.btn(ACCENT, "#FFF"), opacity: ghlBusy ? 0.6 : 1 }}>{ghlBusy ? "Verifying…" : "Verify & Save Connection"}</button>
          {status && status.configured && (
            <button type="button" onClick={disconnectGhl} disabled={ghlBusy} style={{ ...S.btn("#FFF", "#DC2626"), border: "1px solid #FECACA", opacity: ghlBusy ? 0.6 : 1 }}>Disconnect GHL</button>
          )}
        </div>
        <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 6 }}>Checks the Location ID + API key against GHL and saves only if they work. Once connected, choose your pipeline &amp; stages below. (On Synergy or another GoHighLevel-based CRM, both values come from your sub-account settings.)</div>
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
          without one), and it is set on Company → Tax: this card summarises it and links there. */}
      <div style={S.card}>
        <div style={S.h2}>Estimates &amp; Invoices</div>
        {mayGhlInvoice && (
          <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13, fontWeight: 600, color: "#1E293B" }}>
            <input type="checkbox" checked={form.invoiceInGhl} onChange={set("invoiceInGhl")} style={{ marginTop: 2 }} />
            Estimates and invoices through my CRM
          </label>
        )}
        <p style={{ fontSize: 12, color: "#64748B", marginTop: mayGhlInvoice ? 6 : 0, marginBottom: 0, lineHeight: 1.5 }}>
          {!ssMode
            ? <>On — your estimates and invoices are created in your CRM and emailed from there, exactly as they are today.</>
            : <><b>{mayGhlInvoice ? "Off — StructureStudio issues your estimates and invoices." : "StructureStudio issues your estimates and invoices."}</b> Each estimate is one document: the price
                breakdown, the floor plan, and, if you have 3D, a 3D picture of the building. Your customer accepts it from
                their estimate page, and you invoice from the Orders tab. If a CRM is connected, contacts and
                opportunities still go there so your pipeline keeps working; if not, everything stays in Structure Studio.</>}
        </p>
        {ssMode && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginTop: 12, maxWidth: 460 }}>
            <div><span style={S.lbl}>Starting estimate number</span>
              <input style={S.input} value={form.ssQuoteNext} onChange={set("ssQuoteNext")} placeholder="1000" inputMode="numeric" />
              <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 4 }}>Pick up where your CRM or QuickBooks left off, or leave blank to start at 1000 (or carry on after your last estimate). Counts up by one per estimate.</div></div>
            <div><span style={S.lbl}>Estimate prefix (optional)</span>
              <input style={S.input} value={form.ssQuotePrefix} onChange={set("ssQuotePrefix")} placeholder="e.g. JB-" maxLength={12} />
              <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 4 }}>Letters, numbers and dashes. Shows on the document as {(form.ssQuotePrefix || "") + (form.ssQuoteNext || blankStart(status && status.ssQuoteNext))}.</div></div>
            <div><span style={S.lbl}>Starting invoice number</span>
              <input style={S.input} value={form.ssInvoiceNext} onChange={set("ssInvoiceNext")} placeholder="1000" inputMode="numeric" />
              {/* The QuickBooks line follows the CONNECTION (status.qboConnected), not the
                  subscription: send_invoice refuses a blank start while a connected company would
                  receive the invoice, because QuickBooks may already hold an invoice 1000. */}
              <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 4 }}>Invoices number separately from estimates. Leave blank to start at 1000 (or carry on after your last invoice).{status && status.qboConnected === true && <> Connected to QuickBooks? Enter your next QuickBooks invoice number.</>}</div></div>
            <div><span style={S.lbl}>Invoice prefix (optional)</span>
              <input style={S.input} value={form.ssInvoicePrefix} onChange={set("ssInvoicePrefix")} placeholder="e.g. INV-" maxLength={12} />
              <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 4 }}>Shows on the invoice as {(form.ssInvoicePrefix || "") + (form.ssInvoiceNext || blankStart(status && status.ssInvoiceNext))}.</div></div>
          </div>
        )}
        {/* Sales tax (migration 158). SS mode only: in CRM mode the CRM computes tax on its
            own documents. The rate is the COMPANY rate, and it is the last rung an estimate can
            land on: a rate verified for the delivery address wins, then the estimate's sales
            location's own rate (migration 244), then this. Since 2026-10-09 it is SET on Company →
            Tax (save_company_tax) and only SUMMARISED here, from `status` (the stored values, not
            a form): two editors of one rate would let a stale tab write an old value back. The
            server still refuses to flip SS mode on while it is blank; 0 is a real answer,
            "unanswered" is not. */}
        {ssMode && (
          <div data-company-tax-summary="" style={{ marginTop: 12, maxWidth: 620, background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 8, padding: "10px 13px", fontSize: 12.5, color: "#475569", lineHeight: 1.55 }}>
            <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.5, textTransform: "uppercase", color: "#64748B", marginBottom: 4 }}>Company sales tax rate</div>
            {status && status.ssTaxRate != null
              ? <><b>{status.ssTaxRate}%</b>, shown on documents as “{status.ssTaxLabel || "Sales tax"}”, {status.ssTaxDelivery === true ? "also charged on delivery" : "not charged on delivery"}.</>
              : <>Not set yet.</>}
            {" "}{taxLink("Change it in Company → Tax")}
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
                    ? <>{withRate} of your sales locations {withRate === 1 ? "has its" : "have their"} own rate, used on estimates for {withRate === 1 ? "that location" : "those locations"}. Set them in Company → Locations.</>
                    : <>none yet. A sales location can carry your local rate — set one in Company → Locations.</>}
                </div>
                <div style={{ marginTop: 4 }}>
                  <b>Verified lookups:</b>{" "}
                  {!taxInfo.lookupEnabled
                    ? <>off for your account. CSM Synergy switches these on; until then your estimates use your company and local rates.</>
                    : taxInfo.configured === false
                      ? <>on for your account, but the lookup service isn't connected right now — estimates use your company and local rates until it is.</>
                      : <>on for your account. An estimate's rate can be verified against its delivery address before your customer signs.
                          {/* usage24h is null when the lookup ledger can't be counted: unknown, not zero. */}
                          {taxInfo.dailyCap != null && typeof taxInfo.usage24h === "number" && <> {taxInfo.usage24h} of {taxInfo.dailyCap} used in the last 24 hours.</>}
                          {/* This UTC month (migration 319). Each figure is null when it can't be read: then it isn't shown. */}
                          {typeof taxInfo.usageMonth === "number" && <> This month: {taxInfo.usageMonth} lookup{taxInfo.usageMonth === 1 ? "" : "s"}
                            {typeof taxInfo.spendMonthCents === "number" && (taxInfo.spendMonthCents > 0
                              ? <>, ${(taxInfo.spendMonthCents / 100).toFixed(2)} from your wallet (Billing → Transactions → Tax)</>
                              : <>, nothing charged</>)}.</>}</>}
                </div>
              </>);
            })()}
          </div>
        )}
        {/* Only the tax rate is still required: a blank starting number begins at 1000 (283). It is
            the STORED rate that counts (this card no longer posts one), so the banner reads status. */}
        {ssMode && status && status.ssTaxRate == null && (
          <div data-company-tax-needed="" style={{ marginTop: 10, background: "#FEF3C7", border: "1px solid #FDE68A", color: "#B45309", borderRadius: 8, padding: "9px 13px", fontSize: 12.5, fontWeight: 600, lineHeight: 1.5 }}>
            Before saving, set your sales tax rate in {taxLink("Company → Tax", "#B45309")} (0 counts).
            Without a company tax rate, an estimate whose sales location has no rate of its own has nothing to charge.
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
            Heads up: your own sending domain isn't verified yet (Settings → Email Settings), so estimates
            and invoices go out from our address on your behalf, with your business name as the
            sender. Verify your domain to send from your own address instead.
          </div>
        )}
        {invMsg && invMsg.err && <div style={{ ...S.err, marginTop: 10 }}>{invMsg.err}</div>}
        {invMsg && invMsg.ok && <div style={{ ...S.okMsg, marginTop: 10 }}>{invMsg.ok}</div>}
        <button type="button" onClick={saveInvoicing} disabled={invBusy}
          style={{ ...S.btn(ACCENT, "#FFF"), marginTop: 12, opacity: invBusy ? 0.6 : 1 }}>
          {invBusy ? "Saving…" : "Save Estimate & Invoice Settings"}
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

      </>)}

      {/* CUSTOMER LOGIN CODE (migration 231; plan 3.6, Ahsan 2026-09-15: "Text AND email login
          codes before the expo"). The designer's Log in sheet offers Text | Email; this picks
          which one comes FIRST. customer-auth login_options only ever treats it as a preference
          among the channels the platform can actually deliver, so choosing Email before email
          codes are switched on changes nothing a customer sees — the copy says so rather than
          promising a route. Every tenant, CRM or not: the login is ours either way.

          ITS OWN SECTION since 2026-10-22 — Settings → Customer Hub → Customer login. It sat on
          the connection page under the GHL credentials, which read as though it were part of
          them; the sentence above is the reason it never was. The card is unchanged and so is
          its save (saveLoginDefault, posting only customerLoginDefault), so moving it writes
          nothing differently. */}
      {show("customer-login") && (
      <div style={S.card}>
        <div style={S.h2}>Customer login code</div>
        <p style={{ fontSize: 12, color: "#64748B", marginTop: 6, marginBottom: 10, lineHeight: 1.5 }}>
          How your customers get the 6-digit code that logs them in to see and accept their estimates,
          and to sign and pay their invoices. This is the option they're offered first — they can still pick the other one.
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
      )}

      {show("connection") && (<>
      {status && status.configured && (
        <div style={S.card}>
          <div style={S.h2}>Pipeline &amp; Stages</div>
          <p style={{ fontSize: 12, color: "#64748B", marginBottom: 12 }}>
            Map each fulfillment stage to a pipeline stage in your CRM. StructureStudio places a new deal at your
            <b> "Send Estimate"</b> stage; then the badge in your Contacts list advances <b>Estimate Accepted → Invoiced →
            Delivered</b> as you move that opportunity into the matching stage in your CRM. Each stage can live
            in a <b>different pipeline</b> (e.g. Send Estimate in "Building", Invoiced/Delivered in "Invoiced"). All
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
            <div style={{ ...S.lbl, marginBottom: 8 }}>Send Estimate — where new estimates land</div>
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
          {derivedRow("Estimate Accepted — customer accepted the estimate", "ghlPipelineAcceptedId", "ghlStageAcceptedId")}
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
          <div><span style={S.lbl}>Tagline</span><input style={S.input} value={form.brandTagline} onChange={set("brandTagline")} onKeyDown={brandKeyDown} placeholder="Design & Estimate" /></div>
          {/* Hex box first, well second (Carolyn 2026-10-25: "I want the HEX codes to show the
              first"). The well can only hold a hex, so it falls back to black for the gradient
              header_bg legitimately carries — the box is the control, the well is the picker. */}
          <div><span style={S.lbl}>Accent color</span>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input style={{ ...S.input, flex: 1, fontFamily: "ui-monospace,Menlo,Consolas,monospace" }} value={form.brandAccent} onChange={set("brandAccent")} onKeyDown={brandKeyDown} aria-label="Accent color hex code" spellCheck={false} />
              <input type="color" value={ssHexColor(form.brandAccent) || "#000000"} onChange={set("brandAccent")} aria-label="Accent color picker" style={{ width: 44, height: 34, border: "1px solid #CBD5E1", borderRadius: 6, background: "#FFF", cursor: "pointer", flexShrink: 0 }} /></div></div>
          <div><span style={S.lbl}>Header background</span>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input style={{ ...S.input, flex: 1, fontFamily: "ui-monospace,Menlo,Consolas,monospace" }} value={form.brandHeaderBg} onChange={set("brandHeaderBg")} onKeyDown={brandKeyDown} aria-label="Header background hex code or gradient" spellCheck={false} />
              <input type="color" value={ssHexColor(form.brandHeaderBg) || "#000000"} onChange={set("brandHeaderBg")} aria-label="Header background picker" style={{ width: 44, height: 34, border: "1px solid #CBD5E1", borderRadius: 6, background: "#FFF", cursor: "pointer", flexShrink: 0 }} /></div></div>
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
        {/* BRAND COLORS (migration 336, Carolyn 2026-10-25) —
            "In the company settings I want to be able to add additional brand colors and then
            those colors to show in the forms as easy selections and also to show in the email
            as easy selection."

            Accent and Header background above are the DESIGNER's two colors and keep their own
            columns. These are the rest of the brand — the barn red, the cream, the one off the
            truck wrap — and they exist to be PICKED somewhere else: every color control in the
            form designer and the email editor draws this list as one-click swatches. So this
            card is the one place a palette is typed, and nowhere else asks for it again.

            Staged like the logo and styles-per-row: editing here changes nothing until
            Save Branding. The hex box is the control and the well is the picker, in that order,
            because a hex is what a brand kit gives you and a well has nothing to paste into. */}
        <div style={{ marginBottom: 12 }}>
          <span style={S.lbl}>Brand colors</span>
          <div style={{ fontSize: 11.5, color: "#64748B", marginBottom: 8, lineHeight: 1.45 }}>
            Your other brand colors. They appear as one-click swatches on every color in the
            form designer and the email editor. Up to {SS_BRAND_COLOR_MAX}.
          </div>
          {brandColors.length === 0 && (
            <div style={{ fontSize: 12, color: "#94A3B8", marginBottom: 8 }}>No brand colors yet.</div>
          )}
          {brandColors.map((c, i) => {
            const hex = ssHexColor(c.hex);
            const upd = (patch) => setBrandColors((p) => p.map((x, j) => (j === i ? { ...x, ...patch } : x)));
            return (
              <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6, maxWidth: 520 }}>
                <input style={{ ...S.input, flex: "0 0 130px", fontFamily: "ui-monospace,Menlo,Consolas,monospace", textTransform: "uppercase" }}
                  value={c.hex} placeholder="#RRGGBB" spellCheck={false} aria-label={"Brand color " + (i + 1) + " hex code"}
                  onChange={(e) => upd({ hex: e.target.value })} onKeyDown={brandKeyDown}
                  onBlur={() => upd({ hex: hex || "" })} />
                <input type="color" value={hex || "#000000"} aria-label={"Brand color " + (i + 1) + " picker"}
                  onChange={(e) => upd({ hex: e.target.value.toUpperCase() })}
                  style={{ width: 44, height: 34, border: "1px solid #CBD5E1", borderRadius: 6, background: "#FFF", cursor: "pointer", flexShrink: 0 }} />
                <input style={{ ...S.input, flex: 1 }} value={c.name} maxLength={40} placeholder="Name it (optional)"
                  aria-label={"Brand color " + (i + 1) + " name"} onChange={(e) => upd({ name: e.target.value })} onKeyDown={brandKeyDown} />
                <button type="button" aria-label={"Remove brand color " + (i + 1)} onClick={() => setBrandColors((p) => p.filter((_, j) => j !== i))}
                  style={{ ...S.btn("#FEF2F2", "#DC2626"), flexShrink: 0 }}>✕</button>
              </div>
            );
          })}
          {/* A row with no usable hex is dropped on save (the server rebuilds the list), so the
              hint says so rather than letting a blank row look saved. */}
          {brandColors.some((c) => !ssHexColor(c.hex)) && (
            <div style={{ fontSize: 11.5, color: "#B45309", marginTop: 2, marginBottom: 6 }}>
              A row without a color like #D97706 is left out when you save.
            </div>
          )}
          {brandColors.length < SS_BRAND_COLOR_MAX && (
            <button type="button" onClick={() => setBrandColors((p) => [...p, { name: "", hex: "" }])}
              style={{ ...S.btn("#F1F5F9", "#334155"), marginTop: 2 }}>+ Add a brand color</button>
          )}
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
            <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 4 }}>A PNG or JPG you upload here also prints at the top of your estimate PDFs.</div>
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
          <div><span style={S.lbl}>Street address</span><input style={S.input} value={form.addr1} onChange={set("addr1")} /></div>
          <div><span style={S.lbl}>City</span><input style={S.input} value={form.addrCity} onChange={set("addrCity")} /></div>
          <div><span style={S.lbl}>State</span><input style={S.input} value={form.addrState} onChange={set("addrState")} /></div>
          <div><span style={S.lbl}>Zip</span><input style={S.input} value={form.addrZip} onChange={set("addrZip")} /></div>
        </div>
        <div><span style={S.lbl}>Estimate terms</span>
          <textarea style={{ ...S.input, minHeight: 70, resize: "vertical", fontFamily: "inherit" }} value={form.quoteTerms} onChange={set("quoteTerms")} /></div>
        {/* Carolyn 2026-08-06: "estimate good for X amount of days". Prints as the "Valid until"
            date on every quote PDF, and is the expiry date on estimates your CRM sends. */}
        {quoteDaysReady && (
          <div style={{ marginTop: 12 }}>
            <label htmlFor="ss-quote-valid-days" style={S.lbl}>Estimates are good for</label>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input id="ss-quote-valid-days" style={{ ...S.input, width: 90 }} value={form.quoteValidDays}
                onChange={set("quoteValidDays")} inputMode="numeric" placeholder="30" />
              <span style={{ fontSize: 13, color: "#475569" }}>days</span>
            </div>
            <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 4 }}>
              Your estimates show a “Valid until” date this many days after the estimate date. Anywhere from 1 to 365 days.
            </div>
          </div>
        )}
        {/* Carolyn 2026-08-20: a 3D page on the estimate, "optional for them", that "gets 4 sides. So
            4 quadrants"; 2026-09-08: "we want to see 4 images... one from each corner". Only where
            3D is unlocked (no 3D, no 3D page), and only once status can read the setting. On by
            default since migration 322 (Ahsan 2026-10-21); a builder can still untick it. */}
        {view3d && cornerReady && (
          <div style={{ marginTop: 12 }}>
            <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13, fontWeight: 600, color: "#1E293B" }}>
              <input type="checkbox" checked={form.quoteCornerViews} onChange={set("quoteCornerViews")} style={{ marginTop: 2 }} data-ss-quote-corners />
              Show the building from all four corners on page 2 of my estimates
            </label>
            <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 4 }}>
              Page 2 of your estimates shows four 3D pictures of the building, one from each corner, in place of the single 3D view.
              {" "}It's on by default for every builder with 3D. Untick it to turn it off and go back to the single view.
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
          GHL Connection tab, which deliberately has its own three narrow saves. */}
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

// ── COF CONSENT (mirrors _shared/cofConsent.ts) ─────────────────────────────────────────────
// What a builder agrees to when we keep their card (migration 317, the Visa/Mastercard stored-
// credential rules). The SENTENCES are not here: portal-billing sends them in status.cof.templates
// from the one copy in _shared/cofConsent.ts, and records the same sentence, filled with ITS OWN
// numbers, when the box is ticked. These fill the {placeholders} the same way, so what is shown
// beside the box is what is stored. _shared/cofConsent.test.ts lifts this block out of the shipped
// file and checks it against the server's functions; plain JS on purpose (no JSX) so it can.
function cofMoney(cents) {
  const c = Math.round(Number(cents) || 0);
  return "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: c % 100 ? 2 : 0 });
}
function cofCardPhrase(isNewCard, last4) {
  if (isNewCard) return "this card";
  return /^\d{4}$/.test(String(last4 == null ? "" : last4)) ? "my card ending " + last4 : "my card on file";
}
function cofTodayPhrase(cents) {
  return cents > 0 ? cofMoney(cents) + " today" : "nothing today";
}
function cofRecurringPhrase(yearlyCents, monthlyCents) {
  const parts = [];
  if (yearlyCents > 0) parts.push(cofMoney(yearlyCents) + " a year");
  if (monthlyCents > 0) parts.push(cofMoney(monthlyCents) + " a month");
  return parts.join(" plus ") || "the renewal price shown";
}
function renderCofConsent(template, vars) {
  return String(template || "").replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : m));
}
// ── /COF CONSENT ────────────────────────────────────────────────────────────────────────────

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
const WALLET_TX_FILTERS = [["all", "All"], ["calls", "Calls"], ["texts", "Texts"], ["tax", "Tax"], ["funds", "Funds"], ["other", "Other"]];
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
  // STORED-CARD AGREEMENTS (migration 317). Each box is the builder's agreement to how their card
  // is charged, and portal-billing refuses the request without it. For an operator, the
  // subscription box is "I read this to the owner and they agreed", and a top-up asks instead
  // whether the owner asked on the phone (topupPhone; null = not said, and nothing is charged until
  // it is), which the card networks need to know. Every answer is for ONE charge: they are all
  // cleared after each attempt, however it ended, and whenever the tab or the viewed tenant changes.
  const [subAgree, setSubAgree] = useState(false);
  const [topupAgree, setTopupAgree] = useState(false);
  const [autoAgree, setAutoAgree] = useState(false);
  const [topupPhone, setTopupPhone] = useState(null);
  const [replacing, setReplacing] = useState(false);
  const [replaceAgree, setReplaceAgree] = useState(false);
  useEffect(() => {
    setSubAgree(false); setTopupAgree(false); setAutoAgree(false); setTopupPhone(null); setReplaceAgree(false);
  }, [section, viewingLabel]);

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

  // ── The agreement sentences (317) ──────────────────────────────────────────────────
  // Filled from the same numbers the server will use: dueTodayCents (proven equal by the
  // confirmChargeCents handshake), the cart's yearly/monthly totals, the amounts typed here.
  // An older portal-billing sends no `cof`; then there is no box and nothing to send.
  const cof = (data && data.cof && data.cof.templates && data.cof.version) ? data.cof : null;
  const consentBody = cof ? { consent: { version: cof.version, accepted: true } } : {};
  // On EVERY card request from this tab, box or no box: it is how portal-billing tells this tab
  // from the pre-317 one it still serves during the transition (see fromOlderTab there).
  const tabMark = cof ? { cofTab: cof.version } : {};
  const cardLast4 = (data && data.card && data.card.last4) || null;
  const cardBrand = (data && data.card && data.card.brand) || null;
  const subConsentText = cof ? renderCofConsent(cof.templates.subscription, {
    // Our own account shows the prospect view (see demoView): "this card", as a new builder sees it.
    card: cofCardPhrase(!(data && data.hasCard) || demoView, cardLast4),
    today: cofTodayPhrase(dueTodayCents),
    recurring: cofRecurringPhrase(yrTotal, moTotal),
  }) : null;
  // A top-up needs the box until the builder's own first top-up has gone through: that one is
  // the charge the bank links every automatic top-up to.
  const topupNeedsAgree = !!cof && !viewingLabel && (!(data && data.hasCard) || !!cof.topupNeedsAgreement);
  const topupConsentText = cof ? renderCofConsent(cof.templates.topup, {
    card: cofCardPhrase(!(data && data.hasCard), cardLast4),
    amount: topupValid ? cofMoney(topupCents) : "the amount I choose",
  }) : null;
  const autoCents = (s) => Math.round(Number(s) * 100);
  const autoConsentText = cof ? renderCofConsent(cof.templates.autoTopup, {
    card: cofCardPhrase(false, cardLast4),
    amount: cofMoney(autoCents(autoAmount)),
    threshold: cofMoney(autoCents(autoThreshold)),
    dailyMax: String(cof.autoTopupDailyMax),
  }) : null;
  // A tick agrees to the sentence as it read WHEN it was ticked. Change the cart or an amount and
  // the sentence changes, so the tick goes and has to be given again: otherwise the stored
  // wording (and, for an operator, "I read them this") would be terms nobody agreed to.
  useEffect(() => { setSubAgree(false); }, [subConsentText]);
  useEffect(() => { setTopupAgree(false); }, [topupConsentText]);
  useEffect(() => { setAutoAgree(false); }, [autoConsentText]);
  // The box beside each sentence. One look, so the four of them read as the same kind of thing.
  const agreeBox = (checked, set, text, testId) => (
    <label data-cof-consent={testId} style={{ display: "flex", alignItems: "flex-start", gap: 8, marginTop: 10, fontSize: 12, color: "#334155", lineHeight: 1.5, cursor: "pointer", maxWidth: 640 }}>
      <input type="checkbox" checked={checked} onChange={(e) => set(e.target.checked)} style={{ marginTop: 2, flexShrink: 0 }} />
      <span>{text}</span>
    </label>
  );
  // Operators: "did the owner ask for this on the phone?", answered every time.
  const phoneChoice = (allowNo, noLabel) => (
    <div data-cof-phone="1" style={{ marginTop: 10, fontSize: 12.5, color: "#334155", display: "flex", flexDirection: "column", gap: 4 }}>
      <label style={{ display: "inline-flex", gap: 7, alignItems: "center", cursor: "pointer" }}>
        <input type="radio" name="cof-phone" checked={topupPhone === true} onChange={() => setTopupPhone(true)} />
        The owner is on the phone and asked for this
      </label>
      <label style={{ display: "inline-flex", gap: 7, alignItems: "center", cursor: allowNo ? "pointer" : "not-allowed", opacity: allowNo ? 1 : 0.5 }}>
        <input type="radio" name="cof-phone" disabled={!allowNo} checked={topupPhone === false} onChange={() => setTopupPhone(false)} />
        {noLabel}
      </label>
    </div>
  );

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
      const body = { action: "topup", amountCents: topupCents, confirmChargeCents: topupCents, ...tabMark };
      if (viewingLabel) {
        if (topupPhone === null) { setMsg({ err: "Say whether the owner asked for this on the phone." }); setBusy(false); return; }
        const asked = topupPhone;
        // The answer is for this one charge: cleared now, whatever the dialog and the server say.
        setTopupPhone(null);
        if (!window.confirm(`Add ${fmt$(topupCents)} to ${viewingLabel}'s wallet?

This charges the card they have on file${asked ? "" : ", without them asking: they will be emailed a receipt"}.`)) { setBusy(false); return; }
        body.cardholderPresent = asked;
      } else {
        if (topupNeedsAgree) {
          if (!topupAgree) { setMsg({ err: "Tick the box to agree to how your card will be charged." }); setBusy(false); return; }
          Object.assign(body, consentBody);
        }
        if (!data.hasCard) {
          const t = await getPaymentToken(topupCents);
          body.paymentToken = t.token;
          body.card = t.card;
        }
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
      setTopupSel(null); setTopupCustom(""); setTopupAgree(false);
      await load();
    } catch (e) { setMsg({ err: e.message }); }
    setBusy(false);
  };

  const saveAutoTopup = async () => {
    // Switching on (or changing the amounts) is the builder's agreement to unattended charges, so
    // an operator may only switch them off (the server refuses the rest with the same sentence).
    if (viewingLabel && autoOn && cof) { setMsg({ err: "Only the owner can switch on or change automatic top-ups: it records their agreement to be charged. You can switch them off." }); return; }
    if (autoOn && cof && !autoAgree) { setMsg({ err: "Tick the box to agree to automatic top-ups." }); return; }
    setMsg(null); setBusy(true);
    try {
      const body = {
        action: "topup_settings",
        enabled: autoOn,
        thresholdCents: autoOn ? Math.round(Number(autoThreshold) * 100) : null,
        amountCents: autoOn ? Math.round(Number(autoAmount) * 100) : null,
        ...tabMark,
        ...(autoOn ? consentBody : {}),
      };
      const { data: r, error: e } = await sb.functions.invoke("portal-billing", { body });
      if (e) {
        let m = e.message;
        try { const ctx = await e.context.json(); if (ctx && ctx.error) m = ctx.error; } catch (_x) {}
        throw new Error(m);
      }
      if (r && r.error) throw new Error(r.error);
      setMsg({ ok: autoOn ? "Automatic top-ups are on." : "Automatic top-ups are off." });
      setAutoAgree(false);
      await load();
    } catch (e) { setMsg({ err: e.message }); }
    setBusy(false);
  };

  // REPLACE THE CARD (317). A $0 check on the new card, which then takes the old one's place for
  // renewals, top-ups and automatic top-ups. The builder's own card only, like every card entry.
  const replaceCard = async () => {
    if (!replaceAgree) { setMsg({ err: "Tick the box to agree to how the new card will be used." }); return; }
    setMsg(null); setBusy(true);
    try {
      const t = await getPaymentToken(null);
      const { data: r, error: e } = await sb.functions.invoke("portal-billing", {
        body: { action: "update_card", paymentToken: t.token, card: t.card, ...tabMark, ...consentBody },
      });
      if (e) {
        let m = e.message;
        try { const ctx = await e.context.json(); if (ctx && ctx.error) m = ctx.error; } catch (_x) {}
        throw new Error(m);
      }
      if (r && r.error) throw new Error(r.error);
      setMsg({ ok: "Card replaced. Renewals and top-ups now use the new card. Nothing was charged." });
      setReplacing(false); setReplaceAgree(false);
      await load();
    } catch (e) {
      setMsg({ err: e.message });
      // A failed replacement can still change what the server holds (an unverifiable one clears
      // the card's top-up agreement), so re-read rather than keep showing the state from before.
      await load();
    }
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
          // The token, and the card's last 4 and type off Collect.js's masked number (317): shown
          // later as "your card ending 1234" and recorded with the agreement. Nothing else of it.
          callback: (resp) => {
            if (!(resp && resp.token)) return settle(reject, new Error("Card entry was cancelled."));
            const masked = String((resp.card && resp.card.number) || "");
            const last4 = /\d{4}$/.test(masked) ? masked.slice(-4) : null;
            const brand = resp.card && typeof resp.card.type === "string" ? resp.card.type : null;
            settle(resolve, { token: resp.token, card: { last4, brand } });
          },
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
      const body = { action: "subscribe", planIds, confirmChargeCents: dueTodayCents, ...tabMark };
      if (viewingLabel) {
        // Real money against THEIR card: confirm with the client named and the amount out loud.
        // A fully-credited upgrade charges nothing, and the dialog has to say THAT rather
        // than "charge $0 today", which reads like a bug about to bill someone.
        const what = dueTodayCents === 0 && creditCents > 0
          ? `charge nothing today (${fmt$(creditCents)} credit covers it)`
          : `charge ${fmt$(dueTodayCents)} today`;
        // A new subscription is a new recurring agreement: the owner has to be on the phone
        // making it, and the operator reads them the sentence and ticks that they agreed (317).
        // The server refuses it otherwise; this says so before the dialog. One charge per tick.
        if (cof && !subAgree) { setMsg({ err: "Read the agreement to the owner and tick the box once they agree." }); setBusy(false); return; }
        setSubAgree(false);
        if (!window.confirm(`Subscribe ${viewingLabel} to ${planIds.length} feature(s) and ${what}?

This bills the card ${viewingLabel} has on file.`)) { setBusy(false); return; }
        body.cardholderPresent = true;
        Object.assign(body, consentBody);
      } else {
        if (cof) {
          if (!subAgree) { setMsg({ err: "Tick the box to agree to how your card will be charged." }); setBusy(false); return; }
          Object.assign(body, consentBody);
        }
        if (!data.hasCard) {
          // The card is still required when nothing is due — it is what the RENEWAL bills.
          // Passing null rather than 0 keeps Collect.js from putting "$0.00" on its pay
          // button, which invites "then why do you want my card?".
          const t = await getPaymentToken(dueTodayCents || null);
          body.paymentToken = t.token;
          body.card = t.card;
        }
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
      setSel({}); setSubAgree(false);
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
                  {(() => {
                    // Also held until the agreement box is ticked (the first top-up) or, for an
                    // operator, until they have said whether the owner asked on the phone; and for
                    // an operator viewing a tenant with no card at all (the note below says why).
                    const held = busy || !topupValid || (topupNeedsAgree && !topupAgree)
                      || (!!viewingLabel && (!data.hasCard || topupPhone === null));
                    return (
                      <button type="button" onClick={addFunds} disabled={held}
                        style={{ ...S.btn(ACCENT, "#FFF"), padding: "8px 16px", opacity: held ? 0.5 : 1, cursor: held ? "default" : "pointer" }}>
                        {busy ? "Working…" : (topupCents ? "Add " + fmt$(topupCents) : "Add funds")}
                      </button>
                    );
                  })()}
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
                {topupNeedsAgree && agreeBox(topupAgree, setTopupAgree, topupConsentText, "topup")}
                {/* "Not asked" is a merchant-initiated charge, allowed only when the owner's own
                    agreement covers top-ups CSM Synergy adds (portal-billing says so in
                    cof.operatorTopupAllowed, and refuses it otherwise). */}
                {viewingLabel && data.hasCard && phoneChoice(
                  !!(cof && cof.operatorTopupAllowed),
                  cof && cof.operatorTopupAllowed
                    ? "The owner did not ask (they will be emailed a receipt)"
                    : "Not asked: not possible until the owner adds funds or replaces their card themselves (that records their agreement)",
                )}
                {viewingLabel && !data.hasCard && (
                  <div style={{ fontSize: 12, color: "#92400E", marginTop: 6 }}>
                    {viewingLabel} has no card on file. The owner has to add funds once themselves.
                  </div>
                )}

                {/* THE CARD ON FILE, and replacing it (317). The decline banner below used to say
                    "Update the card" with no way to do it. A builder only: an operator never
                    enters a card. */}
                {data.hasCard && (
                  <div style={{ marginTop: 12, fontSize: 12.5, color: "#475569", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <span>Card on file: <b>{cardLast4 ? `${cardBrand ? cardBrand.charAt(0).toUpperCase() + cardBrand.slice(1) + " " : ""}ending ${cardLast4}` : "saved"}</b></span>
                    {/* cof: only a portal-billing that sends the sentences can take update_card. */}
                    {cof && !viewingLabel && !demoView && !replacing && (
                      <button type="button" onClick={() => { setReplacing(true); setReplaceAgree(false); }} disabled={busy}
                        style={{ background: "none", border: "none", color: ACCENT, fontWeight: 700, fontSize: 12.5, cursor: "pointer", padding: 0, fontFamily: "inherit" }}>
                        Replace card
                      </button>
                    )}
                  </div>
                )}
                {replacing && cof && (
                  <div style={{ marginTop: 8, background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 8, padding: "10px 12px" }}>
                    {agreeBox(replaceAgree, setReplaceAgree, cof.templates.cardUpdate, "card-update")}
                    <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                      <button type="button" onClick={replaceCard} disabled={busy || !replaceAgree}
                        style={{ ...S.btn(ACCENT, "#FFF"), padding: "6px 14px", fontSize: 12.5, opacity: busy || !replaceAgree ? 0.5 : 1 }}>
                        {busy ? "Working…" : "Enter the new card"}
                      </button>
                      <button type="button" onClick={() => setReplacing(false)} disabled={busy}
                        style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0", padding: "6px 14px", fontSize: 12.5 }}>
                        Cancel
                      </button>
                    </div>
                    <div style={{ fontSize: 11.5, color: "#94A3B8", marginTop: 6 }}>The new card is checked with your bank, not charged.</div>
                  </div>
                )}

                {/* AUTO-RECHARGE. Requires a vaulted card: enabling it without one arms
                    something that can only fail, and its first failure would report a
                    declined card that never existed. */}
                <div style={{ marginTop: 14, borderTop: "1px solid #F1F5F9", paddingTop: 12 }}>
                  {/* The reason is a whole sentence since 317 (a decline says to replace the card;
                      one switched on before agreements were recorded says to add funds once). */}
                  {w.autoTopup && w.autoTopup.disabledReason && (
                    <div style={{ background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 8, padding: "8px 12px", color: "#92400E", fontSize: 12.5, fontWeight: 600, marginBottom: 10 }}>
                      Automatic top-ups are off. {w.autoTopup.disabledReason}
                    </div>
                  )}
                  {/* The daily cap the agreement names (317): on, but not charging until the oldest
                      of today's automatic top-ups is more than 24 hours old. */}
                  {w.autoTopup && w.autoTopup.enabled && w.autoTopup.dailyMax && w.autoTopup.chargesLast24h >= w.autoTopup.dailyMax && (
                    <div style={{ background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 8, padding: "8px 12px", color: "#92400E", fontSize: 12.5, fontWeight: 600, marginBottom: 10 }}>
                      Daily limit reached: {w.autoTopup.dailyMax} automatic top-ups in the last 24 hours. They start again as the oldest one passes 24 hours. Add funds by hand if you need more now.
                    </div>
                  )}
                  {!data.hasCard ? (
                    <div style={{ fontSize: 12, color: "#94A3B8" }}>
                      Add funds once and your card is kept on file — then you can turn on automatic top-ups.
                    </div>
                  ) : (cof && w.autoTopup && w.autoTopup.ready === false && !w.autoTopup.enabled) ? (
                    // 317: automatic top-ups link to the builder's own first top-up. A card saved by
                    // a subscription has none yet, and the server refuses to switch them on.
                    <div style={{ fontSize: 12, color: "#94A3B8" }}>
                      {viewingLabel
                        ? "Automatic top-ups can be switched on by the owner after they add funds once themselves."
                        : "Add funds once yourself, then you can turn on automatic top-ups. That first top-up is the charge your bank links them to."}
                    </div>
                  ) : (viewingLabel && !(w.autoTopup && w.autoTopup.enabled)) ? (
                    <div style={{ fontSize: 12, color: "#94A3B8" }}>
                      Only the owner can switch automatic top-ups on: it records their agreement to be charged.
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
                      <button type="button" onClick={saveAutoTopup} disabled={busy || (autoOn && !!cof && !viewingLabel && !autoAgree)}
                        style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0", padding: "6px 14px", fontSize: 12.5, opacity: busy || (autoOn && !!cof && !viewingLabel && !autoAgree) ? 0.6 : 1 }}>
                        Save
                      </button>
                    </div>
                  )}
                  {/* Switching on, or changing the amounts, is a new agreement to unattended
                      charges: the sentence names the card, the amounts and the daily limit. */}
                  {data.hasCard && autoOn && cof && !viewingLabel && !(w.autoTopup && w.autoTopup.ready === false && !w.autoTopup.enabled) &&
                    agreeBox(autoAgree, setAutoAgree, autoConsentText, "auto-topup")}
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
                {/* THE AGREEMENT (317): every new subscription is a new recurring agreement, card on
                    file or not. The sentence says what is charged today and what renews. An
                    operator is shown the same sentence to READ to the owner on the phone, and
                    ticks that they did and the owner agreed; that is what the server records. */}
                {!viewingLabel && cof && cart.length > 0 && agreeBox(subAgree, setSubAgree, subConsentText, "subscription")}
                {viewingLabel && cof && cart.length > 0 && agreeBox(subAgree, setSubAgree,
                  `The owner is on the phone, I read them this and they agreed: "${subConsentText}"`, "subscription-operator")}
                <div />
                {(() => {
                  const held = busy || cart.length === 0 || (!!cof && !subAgree);
                  return (
                <button type="button" onClick={subscribe} disabled={held}
                  style={{ ...S.btn(ACCENT, "#FFF"), marginTop: 12, opacity: held ? 0.6 : 1 }}>
                  {/* Our own account reads as a brand-new builder: no card on file, nobody viewing-as. */}
                  {busy ? "Working…" : demoView ? "Continue to secure card entry" : (viewingLabel ? `Subscribe ${viewingLabel} with card on file` : (data.hasCard ? "Subscribe with card on file" : "Continue to secure card entry"))}
                </button>
                  );
                })()}
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
// Every option THIS client offers = built-in layout items + their catalog fixtures (doors/
// windows/ramps). Each becomes a pricing column so an owner can set how many the base price
// includes per size. Catalog columns key on the fixture id, so an "included" catalog item rides
// the same building_size_inclusions pipeline (item_key = fixture id). Label carries the size so
// multiple sizes of one style stay distinct and never collide with a built-in's label.
// Columns are grouped into the same sections the Options tab shows top-to-bottom — built-in
// options, then the Doors, Ramps and Windows catalog sections — each with a header fill colour
// for the Excel template. Archived options drop out entirely (they can't be added to new builds,
// so they must not be an inclusion column — get_config + submit-estimate also stop netting them).
// Shared by the Excel template (PricingCsv) and the Pricing Table, so both show the same columns
// in the same order. `cat` is portal-settings' catalog payload ({ items, fixtures, ... }).
function ssPricingColumns(cat) {
  // Drop the built-in "ramp" — the ramp is now a self-contained option managed in the Ramp
  // settings section (simple price or custom catalog ramps), not a per-building inclusion column.
  // Mirrors LayoutPricing, which also hides the ramp row.
  // Nor a partition wall (migration 278): it is the customer's own layout inside the building, never
  // part of a size's price, so it has no column (submit-estimate ignores such a row too).
  const layout = ((cat && cat.items) || []).filter((it) => !it.archived && it.key !== "ramp" && it.key !== "partitionWall").map((it) => ({ key: it.key, label: it.label }));
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
}

// ─── Sizes & prices table: the pure half (2026-10-30) ───
// Everything below up to PricingCsv is a top-level `function x(…) {` with no free variables beyond
// the other functions here, so _test_stubs/pricingTableHelpers_test.ts lifts the SHIPPED text and
// runs it. The components that draw the table are at the end of this file (PricingTableGate).
//
// The reads they model are portal-settings' `catalog` (only `items` and `fixtures`, through
// ssPricingColumns) and `size_table` (styles, sizes, inclusions, counts, rtpOn, clientId; each list
// read in 1000-row pages by client_id). See the build plan's section 4.1.

// A stored price as the table shows it: "$4,800", "$4,800.50", "$0". More than two decimals shows as
// stored ("$4,800.555"): the importer keeps whatever it was given, and rounding it on screen would
// show a number that is not the one on file. null (not priced) is an empty box.
function ssPgFmtPrice(v) {
  if (v == null || v === "") return "";
  const n = Number(v);
  if (!isFinite(n)) return String(v);
  const parts = String(Math.abs(n)).split(".");
  const int = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  let dec = parts[1] || "";
  if (dec.length === 1) dec += "0";
  return (n < 0 ? "-$" : "$") + int + (dec ? "." + dec : "");
}

// The table's model: option columns, shown and hidden styles with their sizes in order, every cell's
// text, and the truncation guard. `cat` is the catalog answer, `table` the size_table answer.
//
// THE GUARD (plan 4.2) says why the page must not trust this read, or null. First match wins:
//   "count"             a list is shorter or longer than its exact count (counts missing counts too).
//   "cap"               catalog's items or fixtures reached 1000 rows: those reads are NOT paged, and
//                       PostgREST stops at 1000 without an error, so columns may be missing.
//   "orphan_inclusion"  an inclusion names a size that is not in `sizes`.
//   "orphan_size"       a size names a style that is not in `styles`.
// All but "cap" can be a save landing between the reads, so the page reads once more before it
// believes them. A tripped guard opens the table view-only. The Excel template refuses on "count"
// alone (plan 4.8), which is why it is checked first: a row cut off a list goes out in the sheet as
// 0, and the importer deletes it. The others are safe for the sheet: the importer writes only the
// columns and sizes it is given, so a missing column or an orphan row is left as it is.
//
// Cells: an option box shows the quantity when the row says included (Number(qty) || 1, the
// template's own rule) and is empty otherwise (Carolyn Q2: empty, not 0). A size is HIDDEN from the
// designer when it is not active or has no price (trigger 029 forces the first when the second).
// Versions (updated_at) are kept verbatim for the save path and never compared here.
function ssPgModel(cat, table) {
  const sections = ssPricingColumns(cat);
  const cols = [];
  sections.forEach((s, si) => s.cols.forEach((c) => cols.push({ key: c.key, label: c.label, section: si })));
  const t = table || {};
  const styles = Array.isArray(t.styles) ? t.styles.filter(Boolean) : [];
  const sizes = Array.isArray(t.sizes) ? t.sizes.filter(Boolean) : [];
  const incs = Array.isArray(t.inclusions) ? t.inclusions.filter(Boolean) : [];
  const counts = t.counts || {};
  const items = (cat && Array.isArray(cat.items)) ? cat.items : [];
  const fixtures = (cat && Array.isArray(cat.fixtures)) ? cat.fixtures : [];
  const styleIds = new Set(styles.map((s) => s.id));
  const sizeIds = new Set(sizes.map((z) => z.id));
  let guard = null;
  if (Number(counts.sizes) !== sizes.length || Number(counts.inclusions) !== incs.length) guard = "count";
  else if (items.length >= 1000 || fixtures.length >= 1000) guard = "cap";
  else if (incs.some((x) => !sizeIds.has(x.size_id))) guard = "orphan_inclusion";
  else if (sizes.some((z) => !styleIds.has(z.style_id))) guard = "orphan_size";

  const inc = {};
  const onFile = {};   // inclusion rows per size, included or not: the server's Remove needs none (ssPgCanRemove)
  incs.forEach((x) => {
    onFile[x.size_id] = (onFile[x.size_id] || 0) + 1;
    if (x.included) (inc[x.size_id] = inc[x.size_id] || {})[x.item_key] = Number(x.qty) || 1;
  });
  // sort_order, then id: the server's own order (nulls last, as Postgres sorts them ascending).
  const ord = (a, b) => {
    const sa = a.sort_order == null ? Infinity : Number(a.sort_order);
    const sb = b.sort_order == null ? Infinity : Number(b.sort_order);
    if (sa !== sb) return sa < sb ? -1 : 1;
    const ia = String(a.id), ib = String(b.id);
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  };
  const sizesBy = {};
  [...sizes].sort(ord).forEach((z) => {
    const price = z.base_price == null || z.base_price === "" ? null : Number(z.base_price);
    const offered = !!z.active && price != null;
    const mine = inc[z.id] || {};
    const w = z.width_ft, l = z.length_ft;
    (sizesBy[z.style_id] = sizesBy[z.style_id] || []).push({
      id: z.id, styleId: z.style_id, label: z.label == null ? "" : String(z.label),
      title: w != null && l != null ? `${w} ft × ${l} ft` : "",
      width: w, length: l, price, priceText: ssPgFmtPrice(price), active: !!z.active, offered, hidden: !offered,
      values: cols.map((c) => (mine[c.key] != null ? String(mine[c.key]) : "")),
      version: z.updated_at == null ? null : z.updated_at, created: z.created_at == null ? null : z.created_at,
      onFile: onFile[z.id] || 0,
    });
  });
  const band = (s) => ({ id: s.id, key: s.key, label: String(s.label || s.key || "Style"), code: s.code || null, active: !!s.active, sizes: sizesBy[s.id] || [] });
  const ordered = [...styles].sort(ord);
  return {
    sections, cols, guard, rtpOn: t.rtpOn === true, clientId: t.clientId == null ? null : String(t.clientId),
    styles: ordered.filter((s) => s.active).map(band),
    hiddenStyles: ordered.filter((s) => !s.active).map(band),
    sizeCount: sizes.length, inclusionCount: incs.length,
  };
}

// The rows the grid draws, top to bottom: each shown style's band, then its sizes; a placeholder
// under a style with nothing to show; then the folded "Hidden styles" section, and the hidden styles
// themselves when it is open. `showHidden: false` folds away sizes the designer does not offer.
// Only "size" rows are cells; bands and placeholders are never a place the cursor or a paste lands.
//
// Phase 4 ("＋ Add sizes", plan 3.7): `adding` ({ [styleId]: true }) opens a style's add strip, an
// "add" row right under its band; `addEmpty` (the page can edit) turns a style's "No sizes yet." into
// that strip with its list box open (empty: true); `keep` ({ [sizeId]: true }, the sizes this page
// added) are never folded away, so a new size, unpriced and so hidden, stays in view to be priced.
// An "add" row is not a cell either.
function ssPgRows(model, opts) {
  const o = opts || {};
  const showHidden = o.showHidden !== false;
  const keep = o.keep || {};
  const out = [];
  if (!model) return out;
  const add = (s) => {
    const hidden = s.sizes.filter((z) => z.hidden).length;
    const shown = showHidden ? s.sizes : s.sizes.filter((z) => !z.hidden || keep[z.id]);
    const folded = s.sizes.length - shown.length;
    out.push({ kind: "band", id: "b-" + s.id, style: s, total: s.sizes.length, hidden, folded });
    if (!s.sizes.length) {
      out.push(o.addEmpty ? { kind: "add", id: "a-" + s.id, style: s, empty: true } : { kind: "empty", id: "e-" + s.id, style: s, text: "No sizes yet." });
      return;
    }
    if (o.adding && o.adding[s.id]) out.push({ kind: "add", id: "a-" + s.id, style: s, empty: false });
    if (!shown.length) out.push({ kind: "empty", id: "e-" + s.id, style: s, text: folded === 1 ? "1 hidden size, folded away." : `${folded} hidden sizes, folded away.` });
    shown.forEach((z) => out.push({ kind: "size", id: z.id, size: z, style: s }));
  };
  model.styles.forEach(add);
  if (model.hiddenStyles.length) {
    out.push({ kind: "hiddenStyles", id: "hidden-styles", count: model.hiddenStyles.length, open: !!o.hiddenStylesOpen });
    if (o.hiddenStylesOpen) model.hiddenStyles.forEach(add);
  }
  return out;
}

// Where a key moves the active cell: { sizeId, col }, or null when the key is not a move (so the
// browser keeps it). `order` is the size ids in the order drawn, `ncols` counts Size, Price and
// Offered too. Tab runs along the row and wraps to the next one; at either end of the grid it is
// left to the browser, so the keyboard can always leave the table.
function ssPgMove(order, ncols, at, key, shift) {
  if (!order || !order.length || !(ncols > 0)) return null;
  const found = at ? order.indexOf(at.sizeId) : -1;
  const i = found < 0 ? 0 : found;
  const c = found < 0 ? 0 : Math.max(0, Math.min(ncols - 1, Number(at.col) || 0));
  const last = order.length - 1;
  switch (key) {
    case "ArrowUp": return { sizeId: order[Math.max(0, i - 1)], col: c };
    case "ArrowDown": return { sizeId: order[Math.min(last, i + 1)], col: c };
    case "ArrowLeft": return { sizeId: order[i], col: Math.max(0, c - 1) };
    case "ArrowRight": return { sizeId: order[i], col: Math.min(ncols - 1, c + 1) };
    case "Home": return { sizeId: order[i], col: 0 };
    case "End": return { sizeId: order[i], col: ncols - 1 };
    case "Tab":
      if (found < 0) return { sizeId: order[0], col: 0 };
      if (shift) return c > 0 ? { sizeId: order[i], col: c - 1 } : (i > 0 ? { sizeId: order[i - 1], col: ncols - 1 } : null);
      return c < ncols - 1 ? { sizeId: order[i], col: c + 1 } : (i < last ? { sizeId: order[i + 1], col: 0 } : null);
    default: return null;
  }
}

// Where the active cell goes when the rows under it change: "Show hidden sizes" folded its size
// away, or a Reload came back without it. The same cell while its size is still drawn (the column
// clamped if columns went away); otherwise the nearest size that is, looking down `prev` (the order
// before the change) first, then up, in the same column; null when none is. So the next arrow key
// carries on from where the builder was, not from the top-left of the grid.
function ssPgReanchor(prev, order, at, ncols) {
  if (!at || !order || !order.length) return null;
  const col = Math.max(0, Math.min((ncols > 0 ? ncols : 1) - 1, Number(at.col) || 0));
  if (order.indexOf(at.sizeId) >= 0) return col === at.col ? at : { sizeId: at.sizeId, col };
  const drawn = new Set(order);
  const was = (prev || []).indexOf(at.sizeId);
  if (was < 0) return null;
  for (let i = was + 1; i < prev.length; i++) if (drawn.has(prev[i])) return { sizeId: prev[i], col };
  for (let i = was - 1; i >= 0; i--) if (drawn.has(prev[i])) return { sizeId: prev[i], col };
  return null;
}

// How tall the option headers must be so that NO name is cut (plan 3.4). Each name stands on end
// (writing-mode: vertical-rl) and may wrap onto a second line inside its 44 px column, so a name
// needs the length of its longer half at the best place to split it between two words; the header
// is the longest of those plus `pad`. `measure(text)` is the text's length in px in the header font.
// A browser filling line one as far as it fits never needs a third line at that length: its first
// line takes at least the words the best split puts there, and what is left is part of the best
// split's second line. One word longer than the rest is its own floor.
function ssPgHeaderHeight(labels, measure, pad) {
  let need = 0;
  (labels || []).forEach((label) => {
    const words = String(label == null ? "" : label).split(/\s+/).filter(Boolean);
    if (!words.length) return;
    let best = measure(words.join(" "));
    for (let i = 1; i < words.length; i++) {
      best = Math.min(best, Math.max(measure(words.slice(0, i).join(" ")), measure(words.slice(i).join(" "))));
    }
    need = Math.max(need, best);
  });
  return Math.ceil(need) + (Number(pad) || 0);
}

// The Excel template's header and rows, built from a FRESH catalog (columns) and size_table (styles,
// sizes, inclusions), never from what Sheds loaded when it mounted: a table edit since then would
// otherwise go back out in the sheet and be put back by the next upload. Same layout as before:
// style, width, length, price, one column per option, active; a style with no sizes gets one starter
// row. Option cells carry the included quantity (0 = not included).
function ssPgTemplate(cat, table) {
  const sections = ssPricingColumns(cat);
  const its = sections.flatMap((s) => s.cols);
  const headers = ["style", "width", "length", "price", ...its.map((it) => it.label), "active"];
  const t = table || {};
  const incBySize = {};
  (Array.isArray(t.inclusions) ? t.inclusions : []).forEach((x) => { if (x && x.included) (incBySize[x.size_id] = incBySize[x.size_id] || {})[x.item_key] = Number(x.qty) || 1; });
  // Numbers stay numbers so Excel treats width/length/price/counts as numeric; blanks/text pass through.
  const numOr = (v) => (v === "" || v == null || isNaN(Number(v)) ? v : Number(v));
  const ord = (a, b) => {
    const sa = a.sort_order == null ? Infinity : Number(a.sort_order);
    const sb = b.sort_order == null ? Infinity : Number(b.sort_order);
    if (sa !== sb) return sa < sb ? -1 : 1;
    const ia = String(a.id), ib = String(b.id);
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  };
  const sizes = (Array.isArray(t.sizes) ? t.sizes : []).filter(Boolean).sort(ord);
  const rows = [];
  (Array.isArray(t.styles) ? t.styles : []).filter((s) => s && s.active).sort(ord).forEach((s) => {
    const mine = sizes.filter((z) => z.style_id === s.id);
    if (mine.length === 0) {
      // No sizes yet → one starter row: fill width/length/price and copy the line down.
      rows.push([s.label, "", "", "", ...its.map(() => 0), "yes"]);
    } else {
      mine.forEach((z) => {
        const inc = incBySize[z.id] || {};
        rows.push([s.label, numOr(z.width_ft), numOr(z.length_ft), z.base_price == null ? "" : numOr(z.base_price),
          ...its.map((it) => Number(inc[it.key] || 0)), z.active ? "yes" : "no"]);
      });
    }
  });
  return { sections, headers, rows };
}

// ─── Sizes & prices table: the save path's pure half (Phase 3, 2026-10-31) ───
// Lifted and run by pricingTableHelpers_test.ts the same way as the helpers above. The page
// (PricingTablePage) owns the clock, the timers and the network; these decide what a box shows,
// what goes out in the next call, and what an answer means. The plan's sections 4.6, 4.7 and 4.10.
//
// A FIELD is one box of one size: "price", "active" (Offered), or "c:" + an option key ("c:loft",
// "c:101"). The prefix keeps an option keyed "price" from ever being read as the price. A price is
// a number or null (not priced), Offered a boolean, an option box its included quantity (0: nothing
// included, which is no row on file).

// The number rules (plan 4.10), the browser's twins of _shared/pricingCells.ts parsePrice, parseQty
// and parseDim. pricingTableHelpers_test.ts runs the one shared table (pricingParseCases.ts) through
// both: a box the browser lets through and the server refuses is a 400 for the whole call, and the
// other way round it is a box the builder cannot type. `stored` is what is on file: a value equal to
// it is always accepted, so copying back what the importer stored never bounces.
function ssPgParsePrice(text, stored) {
  const s = String(text == null ? "" : text).replace(/[$,\s]/g, "");
  if (s === "") return { ok: true, value: null };
  const n = Number(s);
  if (!isFinite(n)) return { ok: false, error: "A price is a number, 0 or more" };
  if (n >= 0 || (stored != null && n === Number(stored))) return { ok: true, value: n };
  return { ok: false, error: "A price is a number, 0 or more" };
}

// An option box: a whole number from 0 to 999,999, blank meaning 0. Stricter than the importer on
// purpose (no yes-words, no rounding, no garbage read as 0, which deletes). Digits only once `$`,
// commas and spaces are gone, so "1e3", "0x1F" and "+5" are refused too.
function ssPgParseQty(text, stored) {
  const s = String(text == null ? "" : text).replace(/[$,\s]/g, "");
  if (s === "") return { ok: true, value: 0 };
  if (!/^\d+$/.test(s)) return { ok: false, error: "Whole numbers only, 0 or more" };
  const n = Number(s);
  if (n <= 999999 || (stored != null && n === Number(stored))) return { ok: true, value: n };
  return { ok: false, error: "Whole numbers from 0 to 999,999" };
}

// A new size's width or length in feet: above 0, at most 500, at most 2 decimals, plain decimals.
function ssPgParseDim(text) {
  const s = String(text == null ? "" : text).replace(/\s/g, "");
  const n = /^\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
  if (isFinite(n) && n > 0 && n <= 500 && Number(n.toFixed(2)) === n) return { ok: true, value: n };
  return { ok: false, error: "A width or length is a number above 0, at most 500, with at most 2 decimals" };
}

// What the server holds for one field of a size. `s` is { version, price, active, cells }; an
// option with no row on file is 0.
function ssPgVal(s, f) {
  if (!s) return undefined;
  if (f === "price") return s.price == null ? null : Number(s.price);
  if (f === "active") return !!s.active;
  const v = s.cells ? s.cells[String(f).slice(2)] : null;
  return v == null ? 0 : Number(v);
}

// Two field values alike. A blank price matches only a blank one ($0 is a real price).
function ssPgSame(a, b) {
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === "boolean" || typeof b === "boolean") return a === b;
  return Number(a) === Number(b);
}

// What the server held when the table was read, per size, in the queue's shape: the version
// (updated_at, verbatim) and every value the grid draws. Hidden styles' sizes too. `created`
// (created_at, verbatim) is for Remove: a size whose version is still its created_at was never
// edited since it was added (ssPgCanRemove). Sizes this page added (ssPgLocalModel) are not here:
// they are read only once the server has them.
function ssPgServerSizes(model) {
  const out = {};
  if (!model) return out;
  [...(model.styles || []), ...(model.hiddenStyles || [])].forEach((st) => (st.sizes || []).forEach((z) => {
    if (z.local) return;
    const cells = {};
    (model.cols || []).forEach((c, i) => { const v = z.values ? z.values[i] : ""; if (v !== "" && v != null) cells[c.key] = Number(v); });
    out[z.id] = { version: z.version == null ? null : z.version, price: z.price == null ? null : Number(z.price), active: !!z.active, cells,
      created: z.created == null ? null : z.created };
  }));
  return out;
}

// One size row as drawn: the server's values with this page's unsent and in-flight edits on top
// (the newest wins), and `marks`, one character per column: "-" nothing, "p" waiting to save (the
// blue corner), "r" refused or not a valid entry (red, "!"), "c" changed elsewhere (amber, "↺"). A
// red box shows what the SERVER holds; what was typed is in the status line (plan 3.14). `marks` is
// "" when the size has nothing local, so PgRow compares one short string. No server entry: the
// model's own values (before the queue exists).
function ssPgRowView(z, s, fs, cols) {
  if (!s) return { priceText: z.priceText, offered: z.offered, noPrice: z.price == null, hidden: z.hidden, values: z.values, marks: "" };
  const shown = (f) => {
    const x = fs && fs[f];
    return x && x.pending ? x.pending.to : x && x.inflight ? x.inflight.to : ssPgVal(s, f);
  };
  const price = shown("price");
  const offered = !!shown("active") && price != null;
  const values = (cols || []).map((c) => { const n = Number(shown("c:" + c.key)) || 0; return n > 0 ? String(n) : ""; });
  let marks = "";
  if (fs) {
    const mark = (f) => {
      const x = fs[f];
      if (!x) return "-";
      if (x.error) return x.error.kind === "conflict" ? "c" : "r";
      return x.pending || x.inflight ? "p" : "-";
    };
    marks = "-" + mark("price") + mark("active") + (cols || []).map((c) => mark("c:" + c.key)).join("");
    if (!/[^-]/.test(marks)) marks = "";
  }
  // Offered cannot be ticked before the size HAS a price on file (the server ticks it with the
  // first price), so the box stays disabled while that first price is still on its way.
  return { priceText: ssPgFmtPrice(price), offered, noPrice: price == null || s.price == null, hidden: !offered, values, marks };
}

// How many boxes are waiting, saving and red, and sizes being added or removed. The badge and the
// leave prompt read this.
function ssPgCount(q) {
  const out = { pending: 0, inflight: 0, red: 0, creating: 0, removing: 0 };
  if (!q) return out;
  Object.keys(q.fields || {}).forEach((id) => {
    const fs = q.fields[id];
    Object.keys(fs).forEach((f) => {
      if (fs[f].pending) out.pending++;
      if (fs[f].inflight) out.inflight++;
      if (fs[f].error) out.red++;
    });
  });
  Object.keys(q.sizes || {}).forEach((id) => { if (q.sizes[id].creating) out.creating++; });
  Object.keys(q.removes || {}).forEach(() => { out.removing++; });
  return out;
}

// The next call (plan 4.3, 4.6), or null when nothing can go. Creates first, then removes, then
// each size with unsent edits, the longest-waiting first. A size whose create is unanswered has no
// version yet, so its edits wait for the answer (they go in the next call, on the create's version).
// `to` and `from` carry only what changed. At most 50 entries and 2,500 option boxes (caps.entries,
// caps.cells): the rest waits for the next call. Returns { body: { creates, removes, sizes }, sent:
// { [sizeId]: { base, fields: { [field]: { to, from, seq } } } }, creates: [ids], removes: [ids],
// changes, cells }.
function ssPgBuildBatch(q, caps) {
  if (!q) return null;
  const maxEntries = (caps && caps.entries) || 50;
  const maxCells = (caps && caps.cells) || 2500;
  const creates = [], removes = [], sizes = [], createIds = [], removeIds = [];
  const sent = {};
  let entries = 0, cells = 0, changes = 0;
  Object.keys(q.sizes || {}).forEach((id) => {
    const s = q.sizes[id];
    if (s.creating !== "pending" || !s.create || entries >= maxEntries) return;
    creates.push({ id, styleId: s.create.styleId, width: s.create.width, length: s.create.length });
    createIds.push(id);
    entries++; changes++;
  });
  Object.keys(q.removes || {}).forEach((id) => {
    if (q.removes[id] !== "pending" || entries >= maxEntries) return;
    removes.push(id);
    removeIds.push(id);
    entries++; changes++;
  });
  const ready = Object.keys(q.fields || {}).map((id) => {
    const s = q.sizes[id], mine = q.fields[id];
    if (!s || s.creating || s.version == null || (q.removes && q.removes[id])) return null;
    const fs = Object.keys(mine).filter((f) => mine[f].pending && !mine[f].inflight);
    if (!fs.length) return null;
    return { id, s, fs, first: Math.min(...fs.map((f) => mine[f].pending.seq)) };
  }).filter(Boolean).sort((a, b) => a.first - b.first);
  for (const r of ready) {
    if (entries >= maxEntries) break;
    const from = {}, to = {}, fl = {};
    r.fs.forEach((f) => {
      const p = q.fields[r.id][f].pending;
      if (f === "price" || f === "active") { from[f] = p.from; to[f] = p.to; }
      else {
        if (cells >= maxCells) return;
        const k = f.slice(2);
        (from.cells = from.cells || {})[k] = p.from;
        (to.cells = to.cells || {})[k] = p.to;
        cells++;
      }
      fl[f] = { to: p.to, from: p.from, seq: p.seq };
    });
    if (!Object.keys(fl).length) continue;
    // A first price the builder pasted with Offered "no" (`off`, ssPgPlanCells): the server ticks
    // Offered with a first price unless `active` is sent, so it goes along, false from false (plan
    // 4.11: Excel's own rule keeps a "no" row unoffered). Only the price is judged on the answer.
    const pp = fl.price ? q.fields[r.id].price.pending : null;
    if (pp && pp.off && pp.from == null && pp.to != null && !("active" in to)) { from.active = false; to.active = false; }
    sizes.push({ id: r.id, base: r.s.version, from, to });
    sent[r.id] = { base: r.s.version, fields: fl };
    entries++;
    changes += Object.keys(fl).length;
  }
  if (!entries) return null;
  return { body: { creates, removes, sizes }, sent, creates: createIds, removes: removeIds, changes, cells };
}

// What a `conflict` means for each field a call sent (plan 4.6): the server holds its `to` → it
// landed (an earlier copy of this very call, or someone typed the same); it still holds its `from`
// → nobody else touched it, so it goes again on the new version; anything else → a real conflict,
// red, never sent. Only fields that were SENT are judged, so an Offered tick never conflicts with a
// colleague's price. `again`: this size was already resent once after a conflict, and a second
// resend turns red instead, so two tabs can never bounce one size back and forth.
function ssPgRebase(sent, server, again) {
  const out = {};
  Object.keys(sent || {}).forEach((f) => {
    const now = ssPgVal(server, f);
    out[f] = ssPgSame(now, sent[f].to) ? "landed" : (!again && ssPgSame(now, sent[f].from)) ? "resend" : "red";
  });
  return out;
}

// THE SAVE QUEUE (plan 4.6): ssPgQueue(state, event) → the next state, never touching its input.
//
// STATE. sizes: { [id]: { version, price, active, cells, creating?, create? } }, what the server last
// confirmed (creating: "pending" | "inflight" while a new size's create is unanswered). fields:
// { [id]: { [field]: { pending?, inflight?, error? } } } for boxes with something local only, where
// pending and inflight are { to, from, seq } and error is { kind: "invalid" | "refused" | "conflict",
// typed, reason, server? }. removes: { [id]: "pending" | "inflight" }. flight: the one call out, with
// what it sent. Plus the clock marks for the send timing, the failure count, why saving stopped or
// the page went view-only, the count of answers (oks, for the refresh rule), a note for the status
// line, and `unsure`: { [id]: true } for sizes a discarded call may have changed all the same,
// until a fresh read says what is on file.
//
// EVENTS: init, commit, commits (a paste, fill or clear), invalid, dismiss, create, remove, flush,
// send, ok, fail, resume, discard, refresh, columns, restore, note-off. Times come in on the event
// (`at`), never from a clock in here.
//
// THE COMMIT RULE. A field's baseline is its in-flight `to` when it has one, otherwise what the
// server confirmed. A value equal to the baseline drops any unsent edit (nothing to send);
// anything else is pending { to, from: baseline }. So typing 480 and then 400 again while 480 is
// out queues { to: 400, from: 480 }, which goes after the answer: it is never thrown away. The
// editor's commit also carries `seen`, what the box showed when typing began: if an answer moved
// the box under the open editor, the text was typed against a value that is gone, and the box goes
// red instead (see commitBox).
function ssPgQueue(q, ev) {
  const e = ev || {};
  const at = e.at == null ? 0 : Number(e.at);
  if (e.type === "init") {
    let cols = null;
    if (Array.isArray(e.cols)) { cols = {}; e.cols.forEach((k) => { cols[k] = true; }); }
    return { sizes: { ...(e.sizes || {}) }, fields: {}, removes: {}, cols, seq: 0, n: 0, flight: null, failures: 0,
      stopped: null, viewOnly: null, oks: 0, firstAt: null, lastAt: null, flush: false, retried: {}, note: null,
      flash: null, reread: false, renamed: {}, unsure: null };
  }
  if (!q) return q;
  // One size's field map with one field set (or gone when nothing is left on it), copied.
  const put = (fields, id, f, x) => {
    const mine = { ...(fields[id] || {}) };
    if (x && (x.pending || x.inflight || x.error)) mine[f] = x; else delete mine[f];
    const out = { ...fields };
    if (Object.keys(mine).length) out[id] = mine; else delete out[id];
    return out;
  };
  const setSize = (fields, id, mine) => {
    const out = { ...fields };
    if (Object.keys(mine).length) out[id] = mine; else delete out[id];
    return out;
  };
  const anyPending = (fields) => Object.keys(fields).some((id) => Object.keys(fields[id]).some((f) => fields[id][f].pending));
  const waiting = (st) => anyPending(st.fields) || Object.keys(st.sizes).some((id) => st.sizes[id].creating === "pending")
    || Object.keys(st.removes).some((id) => st.removes[id] === "pending");
  // What the builder wants a box to be now: the newest unsent edit, else the one in flight.
  const wish = (x) => (x.pending ? x.pending.to : x.inflight ? x.inflight.to : x.error ? x.error.typed : undefined);
  // A first price pasted with Offered "no" keeps that `off` (ssPgBuildBatch) wherever it is re-made
  // from what is there now, as long as it is still a first price.
  const offOf = (x, from, to) => (from == null && to != null && ((x.pending && x.pending.off) || (x.inflight && x.inflight.off)) ? { off: true } : {});
  // One size's in-flight edits, back to unsent. A follow-up typed during the flight folds into it:
  // the newest value, from where the flight started. A box marked not valid keeps only that mark.
  const unsendSize = (mine) => {
    const out = {};
    Object.keys(mine).forEach((f) => {
      const x = mine[f];
      if (!x.inflight) { out[f] = x; return; }
      const y = { ...x };
      const to = x.pending ? x.pending.to : x.inflight.to;
      delete y.inflight;
      delete y.pending;
      if (!y.error && !ssPgSame(to, x.inflight.from)) y.pending = { to, from: x.inflight.from, seq: x.pending ? x.pending.seq : x.inflight.seq, ...offOf(x, x.inflight.from, to) };
      if (y.pending || y.error) out[f] = y;
    });
    return out;
  };
  // Plan 4.6's refresh rule, for one size's unsent boxes against what the server holds now (`t`):
  // one that already says what the box wants has nothing left to send; one whose starting value is
  // gone turns red at once (changed elsewhere, both values) and is never sent, so the grid shows
  // the colleague's number and typing over it is the builder's own choice. In-flight boxes are left
  // to their answer. A fresh read runs it, and so does every answer that brings a size's row back:
  // a conflict or duplicate on one box of a size carries a colleague's price and Offered too.
  const settle = (mine, t) => {
    const next = { ...mine };
    Object.keys(mine).forEach((f) => {
      const x = mine[f];
      if (!x.pending || x.inflight) return;
      const now = ssPgVal(t, f);
      if (ssPgSame(x.pending.to, now)) { const y = { ...x }; delete y.pending; if (y.error) next[f] = y; else delete next[f]; }
      else if (!ssPgSame(x.pending.from, now)) next[f] = { error: { kind: "conflict", typed: x.pending.to, server: now, reason: null } };
    });
    return next;
  };
  // The clock marks after a change: kept while anything waits, cleared when nothing does.
  const timed = (st, touched) => {
    if (!waiting(st)) return { ...st, firstAt: null, lastAt: null, flush: false };
    if (!touched) return st;
    return { ...st, firstAt: st.firstAt == null ? at : st.firstAt, lastAt: at };
  };

  // THE COMMIT RULE for one box ({ sizeId, f, value, seen? }), into `mine`: that size's own copy of
  // its field map, written in place. Returns the next seq (moved when the box now waits to be sent).
  //
  // `seen` (the editor's, and every box of a paste, fill or clear): what the box showed when the
  // typing began, or when the paste was checked. An answer that landed meanwhile moved this box: a
  // colleague's value adopted from a conflict on another box of the size, or the box's own flight
  // in conflict. Committed as usual, its `from` would be that new value, and the server's from-check
  // would let it overwrite the colleague's. So it goes red as changed elsewhere, with both values,
  // and nothing is sent (plan 1: never quietly replaces theirs). A box the server refused keeps its
  // reason. Typing exactly what is there now is no change at all.
  //
  // `off` (a price, from a paste or fill whose Offered said "no"): with a first price, Offered is
  // sent as unticked (ssPgBuildBatch). A price typed later over that unsent one keeps it; a paste
  // says it again either way.
  const commitBox = (mine, d, seq) => {
    const x = mine[d.f] || {};
    const base = x.inflight ? x.inflight.to : ssPgVal(q.sizes[d.sizeId], d.f);
    const y = { ...x };
    delete y.error;
    delete y.pending;
    let next = seq;
    if ("seen" in d) {
      const shown = x.pending ? x.pending.to : base;
      if (!ssPgSame(shown, d.seen) && !ssPgSame(d.value, shown)) {
        y.error = x.error && x.error.kind === "refused" ? { ...x.error, typed: d.value }
          : { kind: "conflict", typed: d.value, server: ssPgVal(q.sizes[d.sizeId], d.f), reason: null };
      }
    }
    if (!y.error && !ssPgSame(d.value, base)) {
      y.pending = { to: d.value, from: base, seq: ++next };
      const off = "off" in d ? !!d.off : !!(x.pending && x.pending.off);
      if (d.f === "price" && off && base == null && d.value != null) y.pending.off = true;
    }
    if (y.pending || y.inflight || y.error) mine[d.f] = y; else delete mine[d.f];
    return next;
  };

  switch (e.type) {
    case "commit": {
      // A size being removed takes no edit (the page says so first): its boxes would go with it.
      if (!q.sizes[e.sizeId] || q.removes[e.sizeId]) return q;
      const mine = { ...(q.fields[e.sizeId] || {}) };
      const seq = commitBox(mine, e, q.seq);
      return timed({ ...q, seq, fields: setSize(q.fields, e.sizeId, mine) }, seq !== q.seq);
    }
    case "commits": {
      // A paste, a fill or a clear (plan 3.11): many boxes at once, each by the commit rule and its
      // `seen` check, in ONE copy of the state (20,000 boxes must not copy it 20,000 times), then sent
      // at once (plan 4.6: a paste flushes). The batches respect the call caps (ssPgBuildBatch).
      const fields = { ...q.fields };
      const touched = {};
      let seq = q.seq;
      (Array.isArray(e.edits) ? e.edits : []).forEach((d) => {
        if (!d || !q.sizes[d.sizeId] || q.removes[d.sizeId]) return;
        seq = commitBox(touched[d.sizeId] || (touched[d.sizeId] = { ...(fields[d.sizeId] || {}) }), d, seq);
      });
      Object.keys(touched).forEach((id) => { if (Object.keys(touched[id]).length) fields[id] = touched[id]; else delete fields[id]; });
      const any = seq !== q.seq;
      return timed({ ...q, seq, fields, flush: any || q.flush }, any);
    }
    case "invalid": {
      // Typed, refused, not sent (plan 3.9): the box goes red with the reason, and any earlier unsent
      // edit of it goes too, because the newest thing typed there is this.
      if (!q.sizes[e.sizeId] || q.removes[e.sizeId]) return q;
      const y = { ...((q.fields[e.sizeId] || {})[e.f] || {}), error: { kind: "invalid", typed: String(e.typed == null ? "" : e.typed), reason: e.reason || "" } };
      delete y.pending;
      return timed({ ...q, fields: put(q.fields, e.sizeId, e.f, y) }, false);
    }
    case "dismiss": {
      const x = (q.fields[e.sizeId] || {})[e.f];
      if (!x || !x.error) return q;
      const y = { ...x };
      delete y.error;
      return { ...q, fields: put(q.fields, e.sizeId, e.f, y) };
    }
    case "create": {
      if (!e.id || q.sizes[e.id]) return q;
      const s = { version: null, price: null, active: false, cells: {}, creating: "pending", create: { styleId: e.styleId, width: e.width, length: e.length } };
      return timed({ ...q, sizes: { ...q.sizes, [e.id]: s }, flush: true }, true);
    }
    case "remove": {
      if (!q.sizes[e.id] || q.removes[e.id]) return q;
      // A size whose create has not gone yet is simply never added: nothing goes for it. Queued, the
      // next call would name the id in both creates and removes, and the server refuses such a call
      // whole (validatePayload), turning every other box in it red. A create already out is answered
      // before the remove can go: one call at a time.
      if (q.sizes[e.id].creating === "pending") {
        const sizes = { ...q.sizes };
        delete sizes[e.id];
        return timed({ ...q, sizes, fields: setSize(q.fields, e.id, {}) }, false);
      }
      return timed({ ...q, removes: { ...q.removes, [e.id]: "pending" }, flush: true }, true);
    }
    case "flush":
      return q.flush ? q : { ...q, flush: true };
    case "note-off":
      return q.note ? { ...q, note: null } : q;
    case "send": {
      // ONE CALL OUT PER PAGE. Nothing goes while a call is out, while saving is stopped, or once the
      // page is view-only.
      if (q.flight || q.stopped || q.viewOnly) return q;
      const b = ssPgBuildBatch(q, e.caps);
      if (!b) return q.flush ? { ...q, flush: false } : q;
      let fields = q.fields;
      Object.keys(b.sent).forEach((id) => {
        const mine = { ...fields[id] };
        Object.keys(b.sent[id].fields).forEach((f) => {
          const y = { ...mine[f], inflight: mine[f].pending };
          delete y.pending;
          mine[f] = y;
        });
        fields = setSize(fields, id, mine);
      });
      const sizes = { ...q.sizes };
      b.creates.forEach((id) => { sizes[id] = { ...sizes[id], creating: "inflight" }; });
      const removes = { ...q.removes };
      b.removes.forEach((id) => { removes[id] = "inflight"; });
      const n = q.n + 1;
      const next = { ...q, fields, sizes, removes, n,
        flight: { n, body: b.body, sent: b.sent, creates: b.creates, removes: b.removes, changes: b.changes, tries: 0 } };
      // What is left (past the caps, or waiting on a create) keeps its clock and goes next.
      return waiting(next) ? next : { ...next, firstAt: null, lastAt: null, flush: false };
    }
    case "ok": {
      if (!q.flight || e.n !== q.flight.n) return q;   // an answer nobody is waiting for any more
      const fl = q.flight;
      const a = e.answer || {};
      const sizes = { ...q.sizes };
      const removes = { ...q.removes };
      const retried = { ...q.retried };
      const renamed = { ...q.renamed };
      const saved = {};
      const notes = [];
      let fields = q.fields;
      let flush = q.flush;
      const cellsOf = (c) => { const o = {}; Object.keys(c || {}).forEach((k) => { o[k] = Number(c[k]) || 0; }); return o; };
      // created_at rides along where the answer has it (Remove reads it: ssPgCanRemove).
      const bornOf = (r, prev) => (r.row && r.row.created_at != null ? { created: r.row.created_at } : prev && prev.created != null ? { created: prev.created } : {});
      const rowOf = (r, prev) => ({ version: r.version == null ? null : r.version, price: r.row.price == null ? null : Number(r.row.price),
        active: !!r.row.active, cells: { ...((prev && prev.cells) || {}), ...cellsOf(r.cells) }, ...bornOf(r, prev) });
      const gone = (f) => f.slice(0, 2) === "c:" && !!q.cols && !q.cols[f.slice(2)];
      const dot = (s) => { const t = String(s || "").trim(); return !t || /[.!?]$/.test(t) ? t : t + "."; };

      // Creates. A created (or duplicate: a resend that already landed) size gets its version, and
      // its waiting edits go in the very next call. `exists`: someone else added these dimensions
      // first; the existing size replaces the minted one, and what was typed on the minted row
      // turns red on it. Refused: the size was never added.
      (Array.isArray(a.created) ? a.created : []).forEach((r) => {
        if (!r || fl.creates.indexOf(r.id) < 0) return;
        const minted = q.sizes[r.id];
        if ((r.status === "created" || r.status === "duplicate") && r.row) {
          sizes[r.id] = { version: r.version == null ? null : r.version, price: r.row.price == null ? null : Number(r.row.price), active: !!r.row.active, cells: cellsOf(r.cells), ...bornOf(r, null) };
          if (fields[r.id]) flush = true;
        } else if (r.status === "exists" && r.existingId && r.row) {
          const into = String(r.existingId);
          const theirs = { version: r.version == null ? null : r.version, price: r.row.price == null ? null : Number(r.row.price), active: !!r.row.active, cells: cellsOf(r.cells), ...bornOf(r, null) };
          const mine = fields[r.id] || {};
          const moved = { ...(fields[into] || {}) };
          Object.keys(mine).forEach((f) => {
            const typed = wish(mine[f]);
            if (typed === undefined || moved[f]) return;
            moved[f] = { error: { kind: "conflict", typed, server: ssPgVal(theirs, f), reason: "Someone else just added this size. Check its numbers and type yours again." } };
          });
          delete sizes[r.id];
          fields = setSize(setSize(fields, r.id, {}), into, moved);
          if (!q.fields[into] || !sizes[into]) sizes[into] = theirs;
          renamed[r.id] = into;
        } else {
          delete sizes[r.id];
          fields = setSize(fields, r.id, {});
          const what = minted && minted.create ? `${minted.create.width}x${minted.create.length}` : "a size";
          notes.push(`Couldn't add ${what}: ${dot(r.reason || "the server refused it")}`);
        }
      });
      // Removes. `removed` (gone: true too: a resend of one that already landed) takes the row away.
      (Array.isArray(a.removed) ? a.removed : []).forEach((r) => {
        if (!r || fl.removes.indexOf(r.id) < 0) return;
        delete removes[r.id];
        if (r.status === "removed") { delete sizes[r.id]; fields = setSize(fields, r.id, {}); }
        else notes.push(dot(r.reason || "That size couldn't be removed"));
      });
      // Sizes.
      const answered = {};
      (Array.isArray(a.results) ? a.results : []).forEach((r) => {
        const sent = r && fl.sent[r.id];
        if (!sent) return;
        answered[r.id] = true;
        const server = r.row ? rowOf(r, sizes[r.id]) : sizes[r.id];
        if (r.row) sizes[r.id] = server;
        const mine = { ...(fields[r.id] || {}) };
        const ours = (f) => !!mine[f] && !!mine[f].inflight && mine[f].inflight.seq === sent.fields[f].seq;
        const fs = Object.keys(sent.fields);
        if (r.status === "saved" || r.status === "duplicate") {
          // Landed. In-flight boxes clear; one typed again during the flight stays unsent (its
          // `from` is already this flight's `to`). A box the server would not take (cellErrors:
          // an option that is no column any more, Real-Time Pricing, Offered with no price) goes
          // red with the reason and the server's value, and a follow-up on it goes red with it,
          // because the value it started from never landed.
          delete retried[r.id];
          const errs = r.cellErrors || {};
          fs.forEach((f) => {
            if (!ours(f)) return;
            const x = mine[f];
            const why = errs[f === "price" || f === "active" ? f : f.slice(2)];
            if (r.status === "saved" && why != null) {
              if (gone(f)) delete mine[f];
              else mine[f] = { error: { kind: "refused", typed: wish(x), reason: String(why) } };
              return;
            }
            const y = { ...x };
            delete y.inflight;
            if (y.pending || y.error) mine[f] = y; else delete mine[f];
            (saved[r.id] = saved[r.id] || []).push(f);
          });
        } else if (r.status === "conflict" && r.row) {
          // REBASE (ssPgRebase): landed boxes clear, untouched ones go again once on the new
          // version from what is there now, and real conflicts turn red with both values.
          //
          // A follow-up typed on a box during its flight folds into that box's resend: the newest
          // value, from what is there now. Plan 4.6 turns such a follow-up red when ITS box is in
          // conflict, because the value it started from never landed; that is the red verdict here.
          // On a resend nobody else touched the box, the value the flight started from still holds,
          // and the server checks `from` again, so going red would only ask the builder to retype
          // what they just typed, under "changed elsewhere" when nothing was. A box marked not valid
          // during the flight keeps that mark (as when the flight is saved): the in-flight value
          // still goes, and the red "wasn't saved" stays until the builder types over it.
          const verdict = ssPgRebase(sent.fields, server, !!retried[r.id]);
          let again = false;
          fs.forEach((f) => {
            if (!ours(f)) return;
            const x = mine[f];
            const now = ssPgVal(server, f);
            const want = wish(x);
            if (verdict[f] === "landed") {
              const y = { ...x };
              delete y.inflight;
              if (y.pending || y.error) mine[f] = y; else delete mine[f];
            } else if (verdict[f] === "resend") {
              const red = x.error ? { error: x.error } : {};
              if (ssPgSame(want, now)) { if (x.error) mine[f] = red; else delete mine[f]; }
              else { mine[f] = { pending: { to: want, from: now, seq: x.pending ? x.pending.seq : x.inflight.seq, ...offOf(x, now, want) }, ...red }; again = true; }
            } else {
              mine[f] = { error: { kind: "conflict", typed: want, server: now, reason: null } };
            }
          });
          if (again) { retried[r.id] = true; flush = true; } else delete retried[r.id];
        } else {
          // Refused, or missing (the size is not on the account any more): red with the reason, the
          // server's value shown, nothing retried. A missing size's other unsent boxes go red too.
          delete retried[r.id];
          const why = dot(r.reason || (r.status === "missing" ? "That size isn't on this account any more" : "This change couldn't be saved"));
          fs.forEach((f) => { if (ours(f)) mine[f] = { error: { kind: "refused", typed: wish(mine[f]), reason: why } }; });
          if (r.status === "missing") {
            Object.keys(mine).forEach((f) => { if (mine[f].pending && !mine[f].error) mine[f] = { error: { kind: "refused", typed: mine[f].pending.to, reason: why } }; });
          }
        }
        // The row this answer brought back is what the server holds now, for the boxes this call did
        // not send as well: a price typed after the call went, waiting behind it, was typed against a
        // value a colleague may have just replaced. Judged like a fresh read (settle), it turns red
        // here with their number on screen. Left unsent, a re-type before it went would take the
        // colleague's value as its `from` and overwrite it (plan 1, 4.6). The server sends back only
        // the option boxes a call named, so only price and Offered can move this way.
        fields = setSize(fields, r.id, r.row ? settle(mine, server) : mine);
      });
      // Anything the answer left out (it never should): red, with what was typed, rather than unsent
      // again, which would resend it every 800 ms for as long as the server kept leaving it out.
      Object.keys(fl.sent).forEach((id) => {
        if (answered[id] || !fields[id]) return;
        const mine = { ...fields[id] };
        Object.keys(fl.sent[id].fields).forEach((f) => {
          if (mine[f] && mine[f].inflight && mine[f].inflight.seq === fl.sent[id].fields[f].seq) {
            mine[f] = { error: { kind: "refused", typed: wish(mine[f]), reason: "The server didn't answer for this change. Type it again" } };
          }
        });
        fields = setSize(fields, id, mine);
      });
      fl.creates.forEach((id) => {
        if (!sizes[id] || sizes[id].creating !== "inflight") return;
        const c = sizes[id].create;
        delete sizes[id];
        fields = setSize(fields, id, {});
        notes.push(`Couldn't add ${c ? `${c.width}x${c.length}` : "a size"}: the server didn't answer. Add it again.`);
      });
      fl.removes.forEach((id) => { if (removes[id] === "inflight") { delete removes[id]; notes.push("A size couldn't be removed: the server didn't answer. Remove it again."); } });
      const next = { ...q, sizes, fields, removes, retried, renamed, flight: null, failures: 0, oks: q.oks + 1, flush,
        note: notes.length ? { text: notes.join(" ") } : q.note, flash: { n: q.oks + 1, saved } };
      return timed(next, false);
    }
    case "fail": {
      if (!q.flight || e.n !== q.flight.n) return q;
      const reason = e.reason ? String(e.reason) : "";
      if (e.kind === "transport") {
        // A timeout, a dropped connection, a 5xx: the SAME call goes again after a backoff (the
        // page's timer). The function answers a resend that already landed `duplicate`, so it is
        // safe. The fifth failure in a row stops saving until the builder says Retry.
        //
        // The first copy may have landed all the same (its answer lost), and a colleague may have set
        // a box back since (A→B→A): the rebase's value check can't tell that from "nobody touched
        // it". So a conflict on the retry is final for each size in it (retried): landed or red,
        // never resent.
        const failures = q.failures + 1;
        const flight = { ...q.flight, tries: q.flight.tries + 1 };
        const retried = { ...q.retried };
        Object.keys(q.flight.sent).forEach((id) => { retried[id] = true; });
        return { ...q, flight, failures, retried, stopped: failures >= (e.max || 5) ? { kind: "transport", reason: reason || "couldn't reach the server" } : null };
      }
      if (e.kind === "refused") {
        // The server refused the whole call (a 400): the browser let through something it should not
        // have. Every box in it goes red; nothing is resent; new sizes in it were never added, and
        // the status line says so, as it does for one the server refuses alone (with no red box to
        // show it, the badge could otherwise read "All changes saved" over a size that vanished, and
        // over what was typed on it while it was being added).
        let fields = q.fields;
        Object.keys(q.flight.sent).forEach((id) => {
          const mine = { ...(fields[id] || {}) };
          Object.keys(q.flight.sent[id].fields).forEach((f) => {
            if (mine[f] && mine[f].inflight) mine[f] = { error: { kind: "refused", typed: wish(mine[f]), reason } };
          });
          fields = setSize(fields, id, mine);
        });
        const sizes = { ...q.sizes };
        const lost = [];
        let typed = 0;
        q.flight.creates.forEach((id) => {
          const c = sizes[id] && sizes[id].create;
          lost.push(c ? `${c.width}x${c.length}` : "a size");
          typed += Object.keys(fields[id] || {}).length;
          delete sizes[id];
          fields = setSize(fields, id, {});
        });
        const removes = { ...q.removes };
        q.flight.removes.forEach((id) => { delete removes[id]; });
        let note = q.note;
        if (lost.length) {
          const why = String(reason || "the server refused it").trim();
          const names = lost.length > 3 ? `${lost.slice(0, 3).join(", ")} and ${lost.length - 3} more` : lost.join(", ");
          note = { text: `Couldn't add ${names}: ${/[.!?]$/.test(why) ? why : why + "."}${typed ? ` What was typed on ${lost.length === 1 ? "it" : "them"} wasn't saved either.` : ""}` };
        }
        return timed({ ...q, fields, sizes, removes, flight: null, failures: 0, note }, false);
      }
      // 403 (forbidden), 401 (auth) or an answer for another account (tenant): nothing more goes
      // from this page. What was in flight is unsent again, so the badge and the leave prompt still
      // count it.
      const fields = {};
      Object.keys(q.fields).forEach((id) => { const m = unsendSize(q.fields[id]); if (Object.keys(m).length) fields[id] = m; });
      const sizes = { ...q.sizes };
      q.flight.creates.forEach((id) => { if (sizes[id]) sizes[id] = { ...sizes[id], creating: "pending" }; });
      const removes = { ...q.removes };
      q.flight.removes.forEach((id) => { removes[id] = "pending"; });
      const back = { ...q, fields, sizes, removes, flight: null, failures: 0 };
      if (e.kind === "forbidden") return { ...back, viewOnly: { reason: reason || "You can't change Sheds on this account" } };
      return { ...back, stopped: { kind: e.kind === "auth" ? "auth" : "tenant", reason } };
    }
    case "resume": {
      // Retry after saving stopped. An answer for another account is not retried from this page.
      if (!q.stopped || q.stopped.kind === "tenant") return q;
      return { ...q, stopped: null, failures: 0, flush: true };
    }
    case "discard": {
      // "Discard these changes": every unsent and in-flight edit goes, and the boxes show what the
      // server last confirmed. Red boxes stay: they say what did not save. A late answer for the
      // call that was out is ignored (no flight is waiting for it). That call may have landed all
      // the same: a timeout gives up on a request already on its way, and a 5xx can follow a commit.
      // So its sizes are `unsure` until a fresh read (refresh) says what is on file; the page reads
      // at once, and the badge does not say "saved" meanwhile.
      const fields = {};
      Object.keys(q.fields).forEach((id) => {
        const mine = {};
        Object.keys(q.fields[id]).forEach((f) => { if (q.fields[id][f].error) mine[f] = { error: q.fields[id][f].error }; });
        if (Object.keys(mine).length) fields[id] = mine;
      });
      const sizes = {};
      Object.keys(q.sizes).forEach((id) => { if (!q.sizes[id].creating) sizes[id] = q.sizes[id]; });
      let unsure = q.unsure;
      if (q.flight) {
        unsure = { ...(q.unsure || {}) };
        [...Object.keys(q.flight.sent), ...q.flight.creates, ...q.flight.removes].forEach((id) => { unsure[id] = true; });
      }
      return { ...q, fields, sizes, removes: {}, flight: null, failures: 0, retried: {}, unsure,
        stopped: q.stopped && q.stopped.kind === "tenant" ? q.stopped : null, flush: false, firstAt: null, lastAt: null };
    }
    case "refresh": {
      // A fresh read (plan 4.6, 4.8). One asked for before the latest answer landed may predate
      // that save: dropped, and another read is wanted (reread). A size with nothing local takes
      // the new version and values (`flash.changed` names the boxes that moved). A size with
      // anything pending, in flight or red KEEPS ITS VERSION, so the server's checks still judge
      // its edits; its boxes show the new values except those in flight, and an unsent edit that
      // started from a value that is no longer there turns red at once and is never sent.
      // A discarded call's sizes (`unsure`) are settled by this read; if one of them moved, part of
      // what was discarded had landed, and the status line says so.
      if (e.okAt !== q.oks) return q.reread ? q : { ...q, reread: true };
      const fresh = e.sizes || {};
      const sizes = {};
      const changed = {};
      let fields = q.fields;
      const moved = (was, t) => ["price", "active", ...Object.keys({ ...(was.cells || {}), ...(t.cells || {}) }).map((k) => "c:" + k)]
        .filter((f) => !ssPgSame(ssPgVal(was, f), ssPgVal(t, f)));
      const landed = !!q.unsure && Object.keys(q.unsure).some((id) => q.sizes[id] && fresh[id] && moved(q.sizes[id], fresh[id]).length > 0);
      Object.keys(fresh).forEach((id) => {
        const was = q.sizes[id], t = fresh[id];
        const mine = q.fields[id];
        if (!mine && !(was && was.creating) && !q.removes[id]) {
          sizes[id] = t;
          if (was) {
            const diff = moved(was, t);
            if (diff.length) changed[id] = diff;
          }
          return;
        }
        if (!was) { sizes[id] = t; return; }
        const flying = (f) => !!(mine && mine[f] && mine[f].inflight);
        const cells = { ...(t.cells || {}) };
        Object.keys(was.cells || {}).forEach((k) => { if (flying("c:" + k)) cells[k] = was.cells[k]; });
        Object.keys(cells).forEach((k) => { if (flying("c:" + k) && !(k in (was.cells || {}))) delete cells[k]; });
        sizes[id] = { ...was, price: flying("price") ? was.price : t.price, active: flying("active") ? was.active : t.active, cells };
        if (!mine) return;
        const left = settle(mine, t);
        fields = setSize(fields, id, left);
        // Every unsent box already said what is on file (an Excel upload or a colleague typed the
        // same): nothing local is left, so the size takes the read's version too, like any other.
        if (!Object.keys(left).length && !was.creating && !q.removes[id]) sizes[id] = t;
      });
      // A size the read no longer has keeps its place only while something local hangs on it.
      Object.keys(q.sizes).forEach((id) => { if (!(id in sizes) && (q.fields[id] || q.sizes[id].creating || q.removes[id])) sizes[id] = q.sizes[id]; });
      const note = landed ? { text: "Part of what you discarded had already saved. The table shows what's on file now." } : q.note;
      return timed({ ...q, sizes, fields, reread: false, unsure: null, note, flash: { n: q.oks, changed } }, false);
    }
    case "columns": {
      // Columns that went away (archived in Options, in another tab): an unsent or red box in one is
      // dropped, with a note saying how many. One in flight is left to the server's answer.
      // `drafts`: the option keys of an open editor's changed text, which the page closes when its
      // column goes (the text is in no queue, so it is counted here, in the same note).
      const keep = {};
      (e.keys || []).forEach((k) => { keep[k] = true; });
      const names = e.names || {};
      const dropped = {};
      (Array.isArray(e.drafts) ? e.drafts : []).forEach((k) => { if (!keep[k]) dropped[k] = (dropped[k] || 0) + 1; });
      let fields = q.fields;
      Object.keys(q.fields).forEach((id) => {
        const mine = { ...q.fields[id] };
        let touched = false;
        Object.keys(mine).forEach((f) => {
          const k = f.slice(2);
          if (f.slice(0, 2) !== "c:" || keep[k]) return;
          const x = mine[f];
          if (!x.pending && !x.error) return;
          dropped[k] = (dropped[k] || 0) + 1;
          const y = { ...x };
          delete y.pending;
          delete y.error;
          if (y.inflight) mine[f] = y; else delete mine[f];
          touched = true;
        });
        if (touched) fields = setSize(fields, id, mine);
      });
      const text = Object.keys(dropped).map((k) => `${names[k] || "An option"} was archived in Options; ${dropped[k] === 1 ? "1 unsaved box in that column was dropped" : `${dropped[k]} unsaved boxes in that column were dropped`}.`).join(" ");
      return timed({ ...q, fields, cols: keep, note: text ? { text } : q.note }, false);
    }
    case "restore": {
      // "Save them" on the backup's banner (plan 4.9): each stored edit goes back in unsent, ON THE
      // VERSION (base) AND FROM THE VALUE (from) IT WAS MADE AGAINST, never on what was read just now.
      // So the server's two checks judge it against what is on file: anything saved to the size since
      // comes back conflict. The size takes the stored version (the refresh rule keeps a size with
      // local edits on the version they were made against), and a conflict on it is final (retried):
      // a box already on file is done, every other turns red, and nothing is resent. Something written
      // since may be this very edit landing (the closed tab's call) and then being set back elsewhere
      // (A→B→A), which the rebase's value check can't tell from "nobody touched it", so a restored box
      // is never resent. Left out, and counted in the status line: a box with an unsent, in-flight or
      // red edit here, one on a size being added or removed here, one in a column that went away, and
      // one on a size no longer on the account. Red entries never come here: they are listed, never
      // sent (the page). Never while a call is out (the page greys Save them): then no box here is in
      // flight, and every restored one goes on its own stored version.
      if (q.flight) return q;
      let fields = q.fields, seq = q.seq, n = 0, gone = 0, skipped = 0;
      const sizes = { ...q.sizes };
      const retried = { ...q.retried };
      const colGone = (f) => f.slice(0, 2) === "c:" && !!q.cols && !q.cols[f.slice(2)];
      Object.keys(e.sizes || {}).forEach((id) => {
        const b = e.sizes[id], s = sizes[id];
        const fs = Object.keys((b && b.fields) || {});
        if (!s) { gone += fs.length; return; }
        if (!b || b.base == null) return;
        if (s.creating || q.removes[id]) { skipped += fs.length; return; }
        const mine = { ...(fields[id] || {}) };
        let any = false;
        fs.forEach((f) => {
          const x = b.fields[f];
          if (!x) return;
          if (mine[f] || colGone(f)) { skipped++; return; }
          const from = x.from;
          if (ssPgSame(x.to, from)) return;
          mine[f] = { pending: { to: x.to, from, seq: ++seq, ...(f === "price" && x.off && from == null && x.to != null ? { off: true } : {}) } };
          any = true;
          n++;
        });
        if (!any) return;
        sizes[id] = { ...s, version: b.base };
        retried[id] = true;
        fields = setSize(fields, id, mine);
      });
      // `creates` (ssPgBackup): boxes typed on a size whose create was never answered. One on file now
      // (its create landed after all) takes them on the version this page read, from the values a
      // new size starts with: the server's from-check judges them as for any other. One that isn't is
      // added again first, as it was typed (the page draws it), and its boxes wait for that answer.
      Object.keys(e.creates || {}).forEach((id) => {
        const c = e.creates[id];
        const fs = Object.keys((c && c.fields) || {});
        if (!fs.length) return;
        if (q.removes[id] || (sizes[id] && sizes[id].creating)) { skipped += fs.length; return; }
        const isNew = !sizes[id];
        const mine = { ...(fields[id] || {}) };
        let any = false;
        fs.forEach((f) => {
          const x = c.fields[f];
          if (!x || ssPgSame(x.to, x.from)) return;
          if (mine[f] || colGone(f)) { skipped++; return; }
          mine[f] = { pending: { to: x.to, from: x.from, seq: ++seq, ...(f === "price" && x.off && x.from == null && x.to != null ? { off: true } : {}) } };
          any = true;
          n++;
        });
        if (!any) return;
        if (isNew) sizes[id] = { version: null, price: null, active: false, cells: {}, creating: "pending", create: { styleId: c.styleId, width: c.width, length: c.length } };
        fields = setSize(fields, id, mine);
      });
      const said = [];
      if (gone) said.push(`${gone === 1 ? "1 change" : `${gone} changes`} from earlier ${gone === 1 ? "was" : "were"} for a size that isn't on this account any more.`);
      if (skipped) {
        said.push(`${skipped === 1 ? "1 change" : `${skipped} changes`} from earlier ${skipped === 1 ? "wasn't" : "weren't"} sent: the option was archived, `
          + "the size is being added or removed here, or the box has a newer change here.");
      }
      const note = said.length ? { text: said.join(" ") } : q.note;
      if (!n) return said.length ? { ...q, note } : q;
      return timed({ ...q, sizes, fields, seq, retried, note, flush: true }, true);
    }
    default:
      return q;
  }
}

// How long until the next call should go (plan 4.6), or null when nothing can: 800 ms after the
// last edit, and at most 3 s after the first one still unsent; at once after a flush (paste, fill,
// add, remove, leaving the tab, Back to Sheds, Retry now) or a rebase.
function ssPgDueIn(q, now) {
  if (!q || q.flight || q.stopped || q.viewOnly) return null;
  if (!ssPgBuildBatch(q)) return null;
  if (q.flush) return 0;
  const last = q.lastAt == null ? now : q.lastAt, first = q.firstAt == null ? now : q.firstAt;
  return Math.max(0, Math.min(last + 800, first + 3000) - now);
}

// The wait before the same call goes again after its `failures`-th transport failure in a row:
// 2, 5, 15, then 30 s (plan 4.7). `schedule` replaces those (the harness shortens them).
function ssPgBackoff(failures, schedule) {
  const s = Array.isArray(schedule) && schedule.length ? schedule : [2000, 5000, 15000, 30000];
  return s[Math.min(s.length - 1, Math.max(0, (Number(failures) || 1) - 1))];
}

// What one save_pricing_cells answer is (plan 4.7), from ssStyleSaveCall's { data, error }. The
// status is read the way ssRunStyleSave reads it (error.ssStatus, set by 01-core's wrapper on the
// main host and by the side door itself).
//   ok         the function answered, for `expect`'s account;
//   transport  a timeout, a dropped connection, a 5xx, or a session still reconnecting: resend;
//   refused    any other 4xx (a 400 is a rule the browser let through: a parity bug), or an error
//              in a 200's body: the boxes go red;
//   forbidden  403: view-only;   auth  401: signed out;
//   tenant     the answer is for another account. The side door skips the wrapper's own tripwire,
//              so this check is the page's, and a mismatch stops every save.
function ssPgAnswerKind(r, expect) {
  const err = r && r.error;
  const data = r && r.data;
  const status = err && Number(err.ssStatus) > 0 ? Number(err.ssStatus) : null;
  if (err) {
    const why = String(err.message || "");
    if (status === 401) return { kind: "auth", status, reason: why };
    if (status === 403) return { kind: "forbidden", status, reason: why };
    if (status != null && status >= 400 && status < 500 && status !== 408 && status !== 425 && status !== 429) return { kind: "refused", status, reason: why };
    return { kind: "transport", status, reason: why };
  }
  if (!data || typeof data !== "object") return { kind: "transport", status: null, reason: "No answer from the server." };
  if (data.error) return { kind: "refused", status: null, reason: String(data.error) };
  if (data.ok !== true) return { kind: "transport", status: null, reason: "No answer from the server." };
  if (expect && String(data.clientId == null ? "" : data.clientId) !== String(expect)) return { kind: "tenant", status: null, reason: String(data.clientId == null ? "" : data.clientId) };
  return { kind: "ok", status: 200, reason: "" };
}

// The status line for a red box (plan 3.14). `where` is "Test Barn 12x24", `field` { name, kind:
// "price" | "active" | "qty" }, `err` the field's error. The grid shows what the server holds; what
// was typed is said here.
function ssPgErrorLine(where, field, err) {
  if (!err) return "";
  const kind = field && field.kind;
  const blank = (v) => (kind === "price" ? v == null : kind === "active" ? false : !(Number(v) > 0));
  const show = (v) => (kind === "price" ? ssPgFmtPrice(v) : kind === "active" ? (v ? "offered" : "not offered") : String(v));
  const dot = (s) => { const t = String(s || "").trim(); return /[.!?]$/.test(t) ? t : t + "."; };
  const head = `${where} · ${(field && field.name) || ""}: `;
  if (err.kind === "conflict" && err.reason) return head + dot(err.reason);
  if (err.kind === "conflict") {
    const theirs = blank(err.server) ? "cleared elsewhere" : `changed elsewhere to ${show(err.server)}`;
    const yours = kind === "active" ? (err.typed ? "ticked it" : "unticked it") : blank(err.typed) ? "cleared it" : `typed ${show(err.typed)}`;
    return head + `${theirs} while you ${yours}. ${kind === "active" ? "Set it again" : "Type it again"} if yours is right.`;
  }
  if (err.kind === "invalid") return head + `“${err.typed}” wasn't saved. ${dot(err.reason)}`;
  return head + dot(err.reason || "This change couldn't be saved");
}

// Where a column sits across the grid: { x, w, frozen }, x from the grid's left edge. The widths are
// the colgroup's (Size 64, Price 76, Offered 30, each option 44). A frozen column (Size, Price and
// Offered; Size alone below 700 px) is sticky: the selection overlay and the editor draw it in a
// sticky lane of their own (PgSelectionOverlay), whose left edge rides along with those columns, so
// its x is the same however far the grid has scrolled sideways.
function ssPgColBox(col, narrow) {
  const c = Math.max(0, Number(col) || 0);
  return { x: c < 3 ? [0, 64, 140][c] : 170 + (c - 3) * 44, w: c < 3 ? [64, 76, 30][c] : 44, frozen: c < (narrow ? 1 : 3) };
}

// ─── Sizes & prices table: adding sizes, refresh and the backup, the pure half (Phase 4a, 2026-10-31) ───
// Lifted and run by pricingTableHelpers_test.ts like the helpers above. The plan's sections 3.7, 4.6,
// 4.8 and 4.9.

// "＋ Add sizes", List (plan 3.7): "10x12, 12x16" → the sizes to add, in the order typed. A size is a
// width and a length in feet with x, X, × or "by" between them, spaces or not ("10x12", "10 x 12",
// "10X12", "10 by 12", "10.5x12"); sizes are split by commas, semicolons or new lines. Each number is
// judged by ssPgParseDim, the server's own rule (pricingCells.ts parseDim, in validatePayload), so a
// list the browser takes is never a 400. ONE BAD ENTRY REFUSES THE WHOLE ADD, and is named. A size
// already in the style (`existing`: [{ width, length }]) is skipped and named; a repeat in the list
// collapses; at most `max` (100) sizes go in one add. Labels are the server's `${w}x${l}` (10.5x12,
// never 10.50x12). → { ok: true, sizes: [{ width, length, label }], skipped: [label], repeats } or
// { ok: false, error }.
function ssPgParseSizeList(text, existing, max) {
  const cap = Number(max) > 0 ? Number(max) : 100;
  const tokens = String(text == null ? "" : text).split(/[,;\r\n]+/).map((t) => t.trim()).filter(Boolean);
  if (!tokens.length) return { ok: false, error: "Type sizes like 10x12, 12x16." };
  const have = {};
  (existing || []).forEach((z) => { if (z && z.width != null && z.length != null) have[String(Number(z.width)) + "x" + String(Number(z.length))] = true; });
  const sizes = [], skipped = [], seen = {}, bad = [];
  let repeats = 0;
  tokens.forEach((t) => {
    const m = /^(.+?)\s*(?:x|×|by)\s*(.+)$/i.exec(t);
    const w = m ? ssPgParseDim(m[1]) : null, l = m ? ssPgParseDim(m[2]) : null;
    if (!w || !l || !w.ok || !l.ok) { bad.push({ t, sized: !!m && /^[\d.\s]+$/.test(m[1]) && /^[\d.\s]+$/.test(m[2]) }); return; }
    const label = String(w.value) + "x" + String(l.value);
    if (seen[label]) { repeats++; return; }
    seen[label] = true;
    if (have[label]) skipped.push(label);
    else sizes.push({ width: w.value, length: l.value, label });
  });
  if (bad.length) {
    const b = bad[0];
    const why = b.sized ? `“${b.t}”: a width or length is above 0, at most 500, with at most 2 decimals.` : `“${b.t}” isn't a size like 10x12.`;
    return { ok: false, error: `Nothing added. ${why}${bad.length > 1 ? ` ${bad.length - 1} more ${bad.length === 2 ? "entry isn't" : "entries aren't"} right either.` : ""}` };
  }
  if (sizes.length > cap) return { ok: false, error: `Nothing added. At most ${cap} sizes go in one add; this list has ${sizes.length}.` };
  return { ok: true, sizes, skipped, repeats };
}

// "＋ Add sizes", Add several (plan 3.7): widths × lengths as a tick-box grid, widths down and lengths
// across. Widths and lengths are typed as lists ("8, 10, 12" or "8 10 12"), each number judged by
// ssPgParseDim, a repeat dropped, in the order typed. Every pair starts ticked; one already in the
// style (`existing`) is "already there" (greyed, never added); `unticked` ({ label: true }) are the
// pairs the builder unticked. `sizes` is what [Add N sizes] adds: the ticked new pairs, row by row
// (each width's lengths in turn), which is the order they go in. More than `max` (100) is refused
// (`error`), and so is a bad number, which is named. `blank`: a box is still empty (no grid yet, no
// complaint). → { ok, blank?, error?, widths, lengths, rows: [[{ width, length, label, there,
// ticked }]], sizes }.
function ssPgSizeGrid(widthsText, lengthsText, existing, unticked, max) {
  const cap = Number(max) > 0 ? Number(max) : 100;
  const off = unticked || {};
  const list = (text, what) => {
    const out = [], seen = {};
    const toks = String(text == null ? "" : text).split(/[\s,;]+/).filter(Boolean);
    for (const t of toks) {
      const p = ssPgParseDim(t);
      if (!p.ok) return { error: `“${t}” isn't a ${what}: a number of feet above 0, at most 500, with at most 2 decimals.` };
      if (!seen[p.value]) { seen[p.value] = true; out.push(p.value); }
    }
    return { values: out };
  };
  const ws = list(widthsText, "width"), ls = list(lengthsText, "length");
  const none = { widths: [], lengths: [], rows: [], sizes: [] };
  if (ws.error || ls.error) return { ok: false, error: ws.error || ls.error, ...none };
  if (!ws.values.length || !ls.values.length) return { ok: false, blank: true, error: null, ...none };
  const have = {};
  (existing || []).forEach((z) => { if (z && z.width != null && z.length != null) have[String(Number(z.width)) + "x" + String(Number(z.length))] = true; });
  const rows = ws.values.map((w) => ls.values.map((l) => {
    const label = String(w) + "x" + String(l);
    const there = !!have[label];
    return { width: w, length: l, label, there, ticked: !there && !off[label] };
  }));
  const sizes = [];
  rows.forEach((r) => r.forEach((c) => { if (c.ticked) sizes.push({ width: c.width, length: c.length, label: c.label }); }));
  const error = sizes.length > cap ? `At most ${cap} sizes go in one add; ${sizes.length} are ticked. Untick some, or add them in two goes.` : null;
  return { ok: !error, error, widths: ws.values, lengths: ls.values, rows, sizes };
}

// The model the grid draws (plan 3.7): the last read, with this page's own changes to its rows that
// no read has shown yet. Sizes this page added (`added`: [{ id, styleId, width, length, label }], in
// the order typed) go after their style's last size, which is where the server puts them (max
// sort_order + 1), for as long as the queue knows them (`sizes`, ssPgQueue's): while their create is
// unanswered ("Adding…"), and once created, until a read has them. A size the queue no longer has is
// gone from the grid: removed here, or an add the server refused, or answered `exists` for (the
// existing size takes its place). The same model object comes back when nothing changes, so the
// grid's memos hold; `sections` and `cols` are always the read's own.
function ssPgLocalModel(model, added, sizes) {
  if (!model || !sizes) return model;
  const known = {};
  [...model.styles, ...model.hiddenStyles].forEach((st) => st.sizes.forEach((z) => { known[z.id] = true; }));
  const extra = {};
  (Array.isArray(added) ? added : []).forEach((a) => { if (a && sizes[a.id] && !known[a.id]) (extra[a.styleId] = extra[a.styleId] || []).push(a); });
  const blank = (model.cols || []).map(() => "");
  let changed = false;
  const fix = (st) => {
    const keep = st.sizes.filter((z) => !!sizes[z.id]);
    const more = (extra[st.id] || []).map((a) => ({
      id: a.id, styleId: st.id, label: String(a.label), title: `${a.width} ft × ${a.length} ft`, width: a.width, length: a.length,
      price: null, priceText: "", active: false, offered: false, hidden: true, values: blank, version: null, created: null, onFile: 0, local: true,
    }));
    if (keep.length === st.sizes.length && !more.length) return st;
    changed = true;
    return { ...st, sizes: [...keep, ...more] };
  };
  const styles = model.styles.map(fix), hiddenStyles = model.hiddenStyles.map(fix);
  return changed ? { ...model, styles, hiddenStyles } : model;
}

// Whether a size shows Remove (plan 3.7; the function's rule 2 in migration 350): it was never priced
// or edited since it was added (its version is still its created_at, both verbatim), nothing is
// included and no inclusion row is on file (`z`, the model's row: onFile), and nothing of it is local
// here (an unsent, in-flight or red box, an unanswered create, a remove already on its way). The
// server checks it all again and answers anything else refused.
function ssPgCanRemove(q, id, z) {
  const s = q && q.sizes ? q.sizes[id] : null;
  if (!s || s.creating || s.version == null || s.created == null || String(s.version) !== String(s.created)) return false;
  if (s.price != null || Object.keys(s.cells || {}).some((k) => Number(s.cells[k]) > 0)) return false;
  if (z && Number(z.onFile) > 0) return false;
  return !(q.fields && q.fields[id]) && !(q.removes && q.removes[id]);
}

// The active cell, or a range's far corner ({ sizeId, col }), after a read changed the option columns
// (`before` → `after`, each [{ key }]; plan 4.6's column change: a new option in Options, one
// archived there): it stays on ITS option, wherever that column sits now, never on whatever option
// moved into its place. Size, Price and Offered never move. An option that went away hands the cell
// to the column now standing where it was (the last one when it was last). The same object comes
// back when nothing moved.
function ssPgRekeyCell(cell, before, after) {
  if (!cell || !(Number(cell.col) >= 3)) return cell;
  const was = (before || [])[cell.col - 3], cols = after || [];
  const i = was ? cols.findIndex((c) => c && c.key === was.key) : -1;
  const col = i >= 0 ? 3 + i : Math.min(cell.col, 2 + cols.length);
  return col === cell.col ? cell : { ...cell, col };
}

/// THE LOCAL BACKUP (plan 4.9): what to keep in this browser so a closed tab, a crash or a sign-out
// loses nothing typed. Stored by the page under ss-pg-pending:<userId>:<clientId> (each table under
// its own key below that), rewritten on every change of the queue and every keystroke in the editor,
// cleared when nothing is left. Shape:
//   { savedAt, sizes: { <id>: { base, fields: { <field>: { to, from } } } }, red: [...], draft: null }
// `base` is the size's version the edits were made against and `from` the value each box was typed
// over: an unsent edit's own starting value, an in-flight one's, or, for a box typed again while its
// value was in flight, that in-flight value (plan 4.6: 480 out, then 500 typed, is { to: 500, from:
// 480 }). Save them goes on the stored base and never resends (ssPgQueue's restore), so the server's
// checks judge every box: one whose in-flight value never landed comes back red, and nothing is ever
// written over a colleague's change. `off`: a first price pasted with Offered "no" (ssPgPlanCells),
// kept only while its `from` is blank. A size still being added has no version yet: what was typed on
// it goes under `creates` ({ <id>: { styleId, width, length, fields } }), with the size, so Save them
// can add it again first (or find it on file, if its create landed after all) and the boxes go after
// it. `red`: every red box, { sizeId, key, kind, typed, reason, server? }; listed on open, never sent.
// The open editor's changed text (`draft` in: { sizeId, key, text, seen }; plan 3.10: it counts as
// typed) is stored as the edit committing it would make: put through the queue's own commit, parsed
// as commitText parses it, or its invalid event when the rules refuse it. So the stored `draft` is
// always null. null when there is nothing to keep.
function ssPgBackup(q, draft, at) {
  let st = q;
  if (draft && q && q.sizes && q.sizes[draft.sizeId] && draft.key && draft.key !== "active") {
    const text = String(draft.text == null ? "" : draft.text);
    const p = (draft.key === "price" ? ssPgParsePrice : ssPgParseQty)(text, ssPgVal(q.sizes[draft.sizeId], draft.key));
    st = p.ok ? ssPgQueue(q, { type: "commit", sizeId: draft.sizeId, f: draft.key, value: p.value, seen: draft.seen, at })
      : ssPgQueue(q, { type: "invalid", sizeId: draft.sizeId, f: draft.key, typed: text, reason: p.error, at });
  }
  const sizes = {}, creates = {}, red = [];
  const entryOf = (f, v) => {
    const e = { to: v.to, from: v.from };
    if (f === "price" && v.off && v.to != null && v.from == null) e.off = true;
    return e;
  };
  const put = (id, base, f, v) => { (sizes[id] || (sizes[id] = { base, fields: {} })).fields[f] = entryOf(f, v); };
  const newOne = (id, c) => creates[id] || (creates[id] = { styleId: c.styleId, width: c.width, length: c.length, fields: {} });
  const fieldsOf = (st && st.fields) || {};
  Object.keys(fieldsOf).forEach((id) => {
    const s = st.sizes ? st.sizes[id] : null;
    Object.keys(fieldsOf[id]).forEach((f) => {
      const x = fieldsOf[id][f];
      if (x.error) {
        const r = { sizeId: id, key: f, kind: x.error.kind, typed: x.error.typed === undefined ? null : x.error.typed, reason: x.error.reason || null };
        if (x.error.kind === "conflict") r.server = x.error.server === undefined ? null : x.error.server;
        red.push(r);
      }
      if (!(x.pending || x.inflight) || !s) return;
      if (s.creating) {
        const p = x.pending || x.inflight;
        if (s.create && !ssPgSame(p.to, p.from)) newOne(id, s.create).fields[f] = entryOf(f, p);
        return;
      }
      if (s.version == null) return;
      if (x.pending && x.inflight) put(id, s.version, f, { to: x.pending.to, from: x.inflight.to, off: x.pending.off });
      else {
        const p = x.pending || x.inflight;
        if (!ssPgSame(p.to, p.from)) put(id, s.version, f, p);
      }
    });
  });
  const anyNew = Object.keys(creates).length > 0;
  if (!Object.keys(sizes).length && !anyNew && !red.length) return null;
  return { savedAt: at, sizes, red, draft: null, ...(anyNew ? { creates } : {}) };
}

// A stored backup, read back for the banner (plan 4.9): null when there is none, it cannot be read,
// or it was saved more than 7 days before `now` (`maxAge`, ms): each table's key ages by its own
// savedAt. Anything the server would refuse whole (a malformed id, version, field or value: one bad
// entry is a 400 for the call) is dropped here, so Save them never sends it. `creates` (sizes still
// being added, ssPgBackup) need an id, a style id and the server's own width and length rule. A
// stored `draft` is ignored: ssPgBackup stores the editor's text as the edit it would make. →
// { savedAt, sizes, red, count, creates? }, `count` the edits Save them would send.
function ssPgBackupLoad(raw, now, maxAge) {
  let b = null;
  try { b = typeof raw === "string" ? JSON.parse(raw) : raw; } catch (_e) { return null; }
  if (!b || typeof b !== "object") return null;
  const savedAt = Number(b.savedAt);
  const age = Number(maxAge) > 0 ? Number(maxAge) : 7 * 24 * 3600 * 1000;
  if (!isFinite(savedAt) || Number(now) - savedAt > age) return null;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const VERSION = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/;
  const isField = (f) => f === "price" || f === "active" || (typeof f === "string" && f.slice(0, 2) === "c:" && f.length > 2 && f.length <= 66);
  const isVal = (f, v) => (f === "price" ? v === null || (typeof v === "number" && isFinite(v))
    : f === "active" ? typeof v === "boolean" : typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 2147483647);
  const ok = (f, x) => isField(f) && !!x && isVal(f, x.to) && isVal(f, x.from) && !ssPgSame(x.to, x.from);
  const entry = (f, x) => {
    const e = { to: x.to, from: x.from };
    if (f === "price" && x.off === true && x.to !== null && x.from === null) e.off = true;
    return e;
  };
  const sizes = {}, red = [];
  let count = 0;
  const src = b.sizes && typeof b.sizes === "object" ? b.sizes : {};
  Object.keys(src).forEach((id) => {
    const s = src[id];
    if (!UUID.test(id) || !s || typeof s.base !== "string" || !VERSION.test(s.base) || !s.fields || typeof s.fields !== "object") return;
    Object.keys(s.fields).forEach((f) => {
      const x = s.fields[f];
      if (!ok(f, x)) return;
      (sizes[id] = sizes[id] || { base: s.base, fields: {} }).fields[f] = entry(f, x);
      count++;
    });
  });
  const creates = {};
  const dim = (v) => typeof v === "number" && ssPgParseDim(String(v)).ok && ssPgParseDim(String(v)).value === v;
  const csrc = b.creates && typeof b.creates === "object" ? b.creates : {};
  Object.keys(csrc).forEach((id) => {
    const c = csrc[id];
    if (!UUID.test(id) || !c || !UUID.test(String(c.styleId)) || !dim(c.width) || !dim(c.length) || !c.fields || typeof c.fields !== "object") return;
    const fields = {};
    Object.keys(c.fields).forEach((f) => {
      const x = c.fields[f];
      if (!ok(f, x)) return;
      fields[f] = entry(f, x);
      count++;
    });
    if (Object.keys(fields).length) creates[id] = { styleId: String(c.styleId), width: c.width, length: c.length, fields };
  });
  (Array.isArray(b.red) ? b.red : []).forEach((r) => {
    if (r && UUID.test(String(r.sizeId)) && isField(r.key) && ["invalid", "refused", "conflict"].indexOf(r.kind) >= 0) red.push(r);
  });
  if (!count && !red.length) return null;
  return { savedAt, sizes, red, count, ...(Object.keys(creates).length ? { creates } : {}) };
}

// Every other table's backup this page may offer (plan 4.9; one per table, so two tabs of one
// account never write over each other's), read back by ssPgBackupLoad and merged into one offer: a
// plain union, oldest first. Box by box, a newer backup's wins, and an older one that says something
// else is listed red (a conflict with nothing on file to show: "type it again", never sent). A size a
// newer backup holds on another version (another read) takes that backup's boxes whole, and every
// older box of it that the newer one doesn't also hold with the same value is listed red: Save them
// goes on one stored version per size and never resends. Sizes still being added (`creates`) box by
// box the same way. Red entries once per box, the newest. → { savedAt (the newest), sizes, red,
// count, creates? } or null, `count` the boxes Save them would send.
function ssPgBackupMerge(list) {
  const all = (Array.isArray(list) ? list : []).filter((b) => b && typeof b === "object").sort((a, b) => Number(a.savedAt) - Number(b.savedAt));
  if (!all.length) return null;
  const sizes = {}, creates = {}, red = {}, order = [];
  all.forEach((b) => {
    const lost = [];
    const lose = (id, f, x) => { lost.push({ sizeId: id, key: f, kind: "conflict", typed: x.to, server: null, reason: null }); };
    // One size's boxes, newer over older: the older box goes red when the newer says something else.
    const union = (id, was, now) => {
      const fields = { ...was };
      Object.keys(now).forEach((f) => {
        if (fields[f] && !ssPgSame(fields[f].to, now[f].to)) lose(id, f, fields[f]);
        fields[f] = now[f];
      });
      return fields;
    };
    Object.keys(b.sizes || {}).forEach((id) => {
      const s = b.sizes[id];
      if (!s || !s.fields) return;
      const was = sizes[id];
      if (was && was.base !== s.base) {
        Object.keys(was.fields).forEach((f) => { if (!s.fields[f] || !ssPgSame(s.fields[f].to, was.fields[f].to)) lose(id, f, was.fields[f]); });
        sizes[id] = { base: s.base, fields: { ...s.fields } };
        return;
      }
      sizes[id] = { base: s.base, fields: union(id, (was && was.fields) || {}, s.fields) };
    });
    Object.keys(b.creates || {}).forEach((id) => {
      const c = b.creates[id];
      if (!c || !c.fields) return;
      creates[id] = { styleId: c.styleId, width: c.width, length: c.length, fields: union(id, (creates[id] && creates[id].fields) || {}, c.fields) };
    });
    [...lost, ...(b.red || [])].forEach((r) => {
      if (!r) return;
      const k = r.sizeId + "|" + r.key;
      if (!(k in red)) order.push(k);
      red[k] = r;
    });
  });
  let count = 0;
  Object.keys(sizes).forEach((id) => { count += Object.keys(sizes[id].fields).length; });
  Object.keys(creates).forEach((id) => { count += Object.keys(creates[id].fields).length; });
  if (!count && !order.length) return null;
  const out = { savedAt: all[all.length - 1].savedAt, sizes, red: order.map((k) => red[k]), count };
  if (Object.keys(creates).length) out.creates = creates;
  return out;
}

// The status line for a backup's red entries (plan 4.9: listed for the builder to type again, never
// sent): "These didn't save before you left: Test Barn 12x24 · Price ($4,800); …. Type them again if
// they're right." `where` names each size ({ id: "Test Barn 12x24" }) and `fields` each box ({ field:
// { name, kind } }); an entry for a size or a column that is no longer drawn is left out. "" when none.
function ssPgEarlierText(red, where, fields) {
  const items = [];
  (red || []).forEach((r) => {
    const w = r && where ? where[r.sizeId] : null;
    const f = r && fields ? fields[r.key] : null;
    if (!w || !f) return;
    const v = r.typed;
    const shown = r.kind === "invalid" ? `“${v == null ? "" : v}”`
      : f.kind === "active" ? (v ? "ticked" : "unticked")
      : v == null || v === "" || (f.kind !== "price" && !(Number(v) > 0)) ? "cleared"
      : f.kind === "price" ? ssPgFmtPrice(v) : String(v);
    items.push(`${w} · ${f.name} (${shown})`);
  });
  if (!items.length) return "";
  const one = items.length === 1;
  const more = items.length > 3 ? `; and ${items.length - 3} more` : "";
  return `${one ? "This didn't" : "These didn't"} save before you left: ${items.slice(0, 3).join("; ")}${more}. Type ${one ? "it" : "them"} again if ${one ? "it's" : "they're"} right.`;
}

// ─── Sizes & prices table: copy, paste, fill down and clear, the pure half (Phase 4b, 2026-10-31) ───
// Lifted and run by pricingTableHelpers_test.ts like the helpers above. The plan's sections 3.10-3.12.
//
// A BLOCK is rows of cells, each the text of one box (ssPgParseTsv). The page hands these helpers its
// VIEW: { rows (ssPgRows, as drawn), order (the drawn size ids, top to bottom), cols (the option
// columns), rtp (Real-Time Pricing locks the prices), q (the save queue: what the server confirmed,
// and this page's edits) }. A box's value AS DRAWN is this page's newest edit, else the server's;
// what is STORED is the server's. A SELECTION is { r0, r1, c0, c1 }: rows as indexes into `order`,
// columns as the grid's (0 Size, 1 Price, 2 Offered, 3… the options).

// Text copied from Excel or Google Sheets → rows of cells (plan 3.11). A row ends at CRLF, LF or CR;
// cells are split by tabs; the one line break both apps put at the very end is not a row of its own,
// so "480\r\n" is one box and "\r\n" (an empty box copied) one empty box. A cell that STARTS with a
// double quote is quoted, the way both apps write a cell holding a tab, a line break or a quote: up
// to the closing quote, `""` being one quote, tabs and line breaks inside kept; what follows the
// closing quote is kept as typed. A quote that never closes is just a character, so one stray quote
// can't swallow the rest of the block. Rows may be ragged (shorter than the widest). "" → no rows.
function ssPgParseTsv(text) {
  const s = String(text == null ? "" : text);
  const rows = [];
  if (!s) return rows;
  let row = [], cell = "", i = 0, start = true;   // start: at a cell's first character
  while (i < s.length) {
    const ch = s[i];
    if (start && ch === '"') {
      let j = i + 1, out = "", closed = false;
      while (j < s.length) {
        if (s[j] === '"') {
          if (s[j + 1] === '"') { out += '"'; j += 2; continue; }
          closed = true;
          j++;
          break;
        }
        out += s[j];
        j++;
      }
      if (closed) { cell += out; i = j; start = false; continue; }
    }
    start = false;
    if (ch === "\t") { row.push(cell); cell = ""; start = true; i++; continue; }
    if (ch === "\r" || ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = []; cell = ""; start = true;
      i += ch === "\r" && s[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    cell += ch;
    i++;
  }
  if (row.length || !start) { row.push(cell); rows.push(row); }
  return rows;
}

// Rows of cells → the text Ctrl/Cmd+C puts on the clipboard (plan 3.10): Excel's own shape, tabs
// between cells and CRLF after every row, the last one too, so a copied empty box pastes back as one
// empty box. A cell holding a tab, a line break or a quote is quoted, `"` doubled.
function ssPgToTsv(rows) {
  if (!Array.isArray(rows) || !rows.length) return "";
  return rows.map((r) => (r || []).map((c) => {
    const t = String(c == null ? "" : c);
    return /[\t\r\n"]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  }).join("\t") + "\r\n").join("");
}

// An Offered box in a paste: yes or no in the words a sheet uses (the Excel template's `active`
// column says yes/no, and copying from this table writes the same). Blank is no: an empty cell
// clears its box, and a cleared Offered box is unticked.
function ssPgParseOffered(text) {
  const s = String(text == null ? "" : text).trim().toLowerCase();
  if (["yes", "y", "true", "1", "x", "✓", "✔", "on", "offered"].indexOf(s) >= 0) return { ok: true, value: true };
  if (["", "no", "n", "false", "0", "off", "not offered"].indexOf(s) >= 0) return { ok: true, value: false };
  return { ok: false, error: "Yes or no" };
}

// The selected boxes as text, as drawn (plan 3.10, Ctrl/Cmd+C; and the top row a fill copies down):
// the size's label, the price as a plain number ("4800.5", never "$4,800.50", so a sheet reads it as
// a number), Offered as yes/no, an option's included quantity, and "" for a blank price or an option
// not included. `ids` are size ids in drawn order; c0..c1 the columns, Size included.
function ssPgSelectionBlock(view, ids, c0, c1) {
  const v = view || {}, q = v.q || {}, cols = v.cols || [];
  const label = {};
  (v.rows || []).forEach((r) => { if (r.kind === "size") label[r.id] = r.size.label; });
  return (ids || []).map((id) => {
    const s = q.sizes ? q.sizes[id] : null, fs = q.fields ? q.fields[id] : null;
    const shown = (f) => { const x = fs && fs[f]; return x && x.pending ? x.pending.to : x && x.inflight ? x.inflight.to : ssPgVal(s, f); };
    const out = [];
    for (let c = c0; c <= c1; c++) {
      if (c === 0) out.push(label[id] == null ? "" : String(label[id]));
      else if (c === 1) { const p = shown("price"); out.push(p == null ? "" : String(p)); }
      else if (c === 2) out.push(shown("active") && shown("price") != null ? "yes" : "no");
      else { const col = cols[c - 3]; const n = col ? Number(shown("c:" + col.key)) || 0 : 0; out.push(n > 0 ? String(n) : ""); }
    }
    return out;
  });
}

// Whether a price edit's Offered (`off`, ssPgPlanCells: a paste or fill giving a size its first
// price says Offered unticked, or ticked by the server) would be lost if it went into the queue
// now (`q`). It rides on the call that sends the first price, so it holds while that price is
// unsent. Once the price is on its way, that call has said Offered (unticked when it carried
// `off`, ticked by the server when not), and once it is on file the server holds Offered: an edit
// asking otherwise would be dropped as no change to the price, and the size would end up the other
// way from what the paste said and the confirm counted (plan 3.11, 4.11). False with no `off`.
function ssPgOffLost(q, d) {
  if (!d || d.f !== "price" || !("off" in d) || d.value == null) return false;
  const s = q && q.sizes ? q.sizes[d.sizeId] : null;
  const fs = (q && q.fields && q.fields[d.sizeId]) || {};
  if (!s) return false;
  const a = fs.active, x = fs.price;
  if (s.price != null) {
    const now = a && a.pending ? a.pending.to : a && a.inflight ? a.inflight.to : !!s.active;
    return !!now !== !d.off;
  }
  return !!(x && x.inflight) && !!x.inflight.off !== !!d.off;
}

// THE VALUE CHECK of a paste, a fill or a clear (plan 3.9, 3.11): every target box is judged before
// anything changes, ALL OR NOTHING. `targets`: [{ id, n (its row in the block, from 1), cells:
// [{ col, text }] in column order }]. Each box follows the rules typing does:
//   Price     the importer's number rule (ssPgParsePrice); under Real-Time Pricing the box is locked.
//   Offered   yes/no (ssPgParseOffered). It can be ticked only on a size with a price: one left with no
//             price is "Add a price first." On a size with none on file that gets its first price
//             (in this very block, or waiting to be sent), Offered rides on that price: the server
//             ticks Offered with a first price (plan 3.9), so "yes" sends nothing more, and "no" marks
//             the price `off`, which sends Offered unticked with it (ssPgBuildBatch). Each box takes
//             what was pasted, as the Excel importer does (plan 4.11: a "no" row stays unoffered).
//             A first price already on its way has said Offered: a different answer is refused,
//             "its first price is still saving" (ssPgOffLost).
//   A size being removed takes nothing: "this size is being removed."
//   An option a whole number from 0 to 999,999; blank is 0 (not included).
//   A value equal to what is STORED is always accepted, and a box whose value as drawn already says
//   it is no change at all.
// One failure refuses everything, naming the first problem in reading order and counting the rest:
// "Row 3 (Test Barn 10x16), Loft: 'abc' isn't a whole number. 2 more problems." (opts.byRow; a fill
// or a clear names the size alone: "Test Barn 10x16, Loft: …"). → { ok: true, edits: [{ sizeId, f,
// value, seen }], sizes } or { ok: false, error, problems }. `seen` is the box as drawn now, for the
// queue's check that nothing moved it before the edit lands (a confirm can be open meanwhile).
// `sizes` is one entry per size that changes, in drawn order, for the confirm (ssPgChangeSummary):
// { id, name, prices, options, offered, wasShown, nowShown }; shown = offered in the designer.
function ssPgPlanCells(view, targets, opts) {
  const v = view || {}, o = opts || {}, q = v.q || {}, cols = v.cols || [];
  const byId = {};
  (v.rows || []).forEach((r) => { if (r.kind === "size") byId[r.id] = r; });
  const quote = (t) => { const s = String(t == null ? "" : t); return "'" + (s.length > 30 ? s.slice(0, 29) + "…" : s) + "'"; };
  const colName = (c) => (c === 1 ? "Price" : c === 2 ? "Offered" : cols[c - 3] ? cols[c - 3].label : "");
  const edits = [], sizes = [];
  let first = null, problems = 0;
  (targets || []).forEach((t) => {
    const r = byId[t.id], s = q.sizes ? q.sizes[t.id] : null, fs = q.fields ? q.fields[t.id] : null;
    const where = r ? `${r.style.label} ${r.size.label}` : "A size";
    const bad = (c, what) => {
      problems++;
      if (!first) first = `${o.byRow ? `Row ${t.n} (${where})` : where}${c != null ? `, ${colName(c)}` : ""}: ${what}`;
    };
    if (!r || !s) { bad(null, "that size isn't on this account any more."); return; }
    if (q.removes && q.removes[t.id]) { bad(null, "this size is being removed."); return; }
    const shown = (f) => { const x = fs && fs[f]; return x && x.pending ? x.pending.to : x && x.inflight ? x.inflight.to : ssPgVal(s, f); };
    const before = { price: shown("price"), active: !!shown("active") };
    // A first price waiting to be sent already says whether Offered goes with it unticked, and so
    // does one on its way (what its call carried).
    const px = fs && fs.price;
    const waitOff = !!(px && (px.inflight ? px.inflight.off : px.pending && px.pending.off));
    let price = before.price, activeTo, offTo;
    let prices = 0, options = 0, offered = 0;
    const mine = [];
    (t.cells || []).forEach((cell) => {
      const c = cell.col, text = cell.text;
      if (c === 1) {
        const stored = ssPgVal(s, "price");
        const p = ssPgParsePrice(text, stored);
        if (v.rtp && !(p.ok && ssPgSame(p.value, stored))) { bad(c, "Real-Time Pricing sets prices on this account."); return; }
        if (!p.ok) { bad(c, `${quote(text)} isn't a number of 0 or more.`); return; }
        price = p.value;
        if (!ssPgSame(p.value, before.price)) { mine.push({ sizeId: t.id, f: "price", value: p.value, seen: before.price }); prices++; }
      } else if (c === 2) {
        const p = ssPgParseOffered(text);
        if (!p.ok) { bad(c, `${quote(text)} isn't yes or no.`); return; }
        // Ticked with no price after this row: the server would refuse it (and untick it anyway).
        if (p.value && price == null && !ssPgSame(p.value, before.active)) { bad(c, "Add a price first."); return; }
        // A first price: Offered rides on it. "yes" is the server's own tick; "no" goes with the
        // price as unticked. A price that is already waiting is put in again to say which. One
        // already on its way has said it, and nothing more can go with it: a different answer is
        // refused, as the Offered box itself is disabled until that price is on file (plan 3.9).
        if (s.price == null && price != null) {
          offTo = !p.value;
          let pe = mine.find((d) => d.f === "price");
          if (!pe && offTo !== waitOff) { pe = { sizeId: t.id, f: "price", value: price, seen: before.price }; mine.push(pe); offered++; }
          if (pe) pe.off = offTo;
          if (pe && ssPgOffLost(q, pe)) bad(c, "its first price is still saving. Try again once it's saved.");
          return;
        }
        if (!ssPgSame(p.value, before.active)) { mine.push({ sizeId: t.id, f: "active", value: p.value, seen: before.active }); activeTo = p.value; offered++; }
      } else if (c >= 3) {
        const col = cols[c - 3];
        if (!col) { bad(c, "there's no box there."); return; }
        const f = "c:" + col.key;
        const p = ssPgParseQty(text, ssPgVal(s, f));
        if (!p.ok) {
          bad(c, /^\d+$/.test(String(text == null ? "" : text).replace(/[$,\s]/g, "")) ? `${quote(text)} is more than 999,999.` : `${quote(text)} isn't a whole number.`);
          return;
        }
        const was = Number(shown(f)) || 0;
        if (!ssPgSame(p.value, was)) { mine.push({ sizeId: t.id, f, value: p.value, seen: was }); options++; }
      }
    });
    if (!mine.length) return;
    mine.forEach((d) => edits.push(d));
    // Offered in the designer before and after: the server ticks Offered when a size with no price on
    // file gets one, unless Offered itself was sent, or goes with the price unticked (`off`).
    let active = activeTo !== undefined ? activeTo : before.active;
    if (activeTo === undefined && s.price == null && price != null) active = !(offTo !== undefined ? offTo : waitOff);
    sizes.push({ id: t.id, name: where, prices, options, offered, wasShown: before.active && before.price != null, nowShown: active && price != null });
  });
  if (problems) return { ok: false, error: `${first}${problems > 1 ? ` ${problems - 1} more ${problems === 2 ? "problem" : "problems"}.` : ""}`, problems };
  return { ok: true, edits, sizes };
}

// PASTE (plan 3.11): `block` (ssPgParseTsv) laid over the drawn rows and columns, its top-left box at
// `at` ({ sizeId, col }). Refused BEFORE ANY VALUE IS CHECKED when its rows cross a style's band or a
// placeholder row ("Paste one style at a time."), skip a size folded away by "Show hidden sizes"
// (counted), run past the last row or column, start on the Size column, or hold more than `max`
// (20,000) boxes. Then every box goes through ssPgPlanCells, all or nothing; a box missing from the
// end of a short row is left as it is, and an empty cell inside a row clears its box. `opts.verb`:
// "paste", or "fill" (ssPgFillPlan, whose block starts on the row it copies). → ssPgPlanCells' answer
// plus `area` ({ first, last, c0, c1 }: the sizes and columns it covers), or { ok: false, error }.
function ssPgPastePlan(view, at, block, opts) {
  const v = view || {}, o = opts || {};
  const rows = v.rows || [], b = Array.isArray(block) ? block : [];
  const fill = o.verb === "fill";
  const ncols = 3 + (v.cols || []).length;
  const max = Number(o.max) > 0 ? Number(o.max) : 20000;
  const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const no = (error) => ({ ok: false, error });
  if (!b.length) return no("There's nothing to paste.");
  const start = at ? rows.findIndex((r) => r.kind === "size" && r.id === at.sizeId) : -1;
  if (start < 0) return no("Click the box where the paste should start.");
  const style = rows[start].style;
  const pos = {};
  (style.sizes || []).forEach((z, i) => { pos[z.id] = i; });
  const ids = [];
  let folded = 0, past = false;
  for (let i = 0; i < b.length; i++) {
    const r = rows[start + i];
    if (!r) { past = true; break; }
    if (r.kind !== "size" || r.style.id !== style.id) return no(fill ? "Fill down one style at a time." : "Paste one style at a time.");
    if (ids.length && pos[r.id] != null && pos[ids[ids.length - 1]] != null) folded += Math.max(0, pos[r.id] - pos[ids[ids.length - 1]] - 1);
    ids.push(r.id);
  }
  if (folded) return no(`Show hidden sizes first. ${fill ? "Filling down" : "This block"} would skip ${folded === 1 ? "1 hidden size" : `${folded} hidden sizes`}.`);
  if (past) return no("This block runs past the last size.");
  const width = b.reduce((w, r) => Math.max(w, r.length), 0);
  const col = Number(at.col) || 0;
  if (col + width > ncols) return no("This block runs past the last column.");
  if (col === 0) return no("The Size column can't be pasted into. Start on a price or an option box.");
  const cells = b.reduce((n, r) => n + r.length, 0);
  if (cells > max) return no(fill ? `That's ${fmt(cells)} boxes. Fill down at most ${fmt(max)} at a time.` : `This block has ${fmt(cells)} boxes. Paste at most ${fmt(max)} at a time.`);
  const targets = ids.map((id, i) => ({ id, n: i + 1, cells: b[i].map((text, j) => ({ col: col + j, text })) }));
  const plan = ssPgPlanCells(v, targets, { byRow: !fill });
  return plan.ok ? { ...plan, area: { first: ids[0], last: ids[ids.length - 1], c0: col, c1: col + width - 1 } } : plan;
}

// FILL DOWN (plan 3.10-3.11, Ctrl/Cmd+D and the toolbar's Fill down): the selection's top row copied
// into the rows under it, the way a sheet does it; a selection one row tall takes the size drawn
// right above it. The Size column is never filled. Same rules as a paste (ssPgPastePlan, verb
// "fill"): one style at a time, never across a folded hidden size, all or nothing.
function ssPgFillPlan(view, sel, opts) {
  const v = view || {}, order = v.order || [], rows = v.rows || [];
  if (!sel || !order[sel.r0]) return { ok: false, error: "Click a box first." };
  const c0 = Math.max(1, sel.c0), c1 = sel.c1;
  if (c1 < c0) return { ok: false, error: "A size's width and length can't be changed here." };
  const one = sel.r1 <= sel.r0;
  const src = one ? sel.r0 - 1 : sel.r0;
  if (one) {
    const at = rows.findIndex((r) => r.kind === "size" && r.id === order[sel.r0]);
    const above = at > 0 ? rows[at - 1] : null;
    if (src < 0 || at < 0 || !above || above.kind !== "size" || above.style.id !== rows[at].style.id) {
      return { ok: false, error: `There's no size above this one in ${at >= 0 ? rows[at].style.label : "this style"} to fill down from.` };
    }
  }
  const top = ssPgSelectionBlock(v, [order[src]], c0, c1)[0];
  const block = [];
  for (let i = src; i <= Math.max(sel.r0, sel.r1); i++) block.push(top);
  return ssPgPastePlan(v, { sizeId: order[src], col: c0 }, block, { verb: "fill", max: opts && opts.max });
}

// CLEAR (plan 3.10, Delete or Backspace on a range, and the toolbar's Clear): every selected box
// emptied: a blank price (the size is then hidden), Offered unticked, an option not included. Across
// styles too (only the drawn rows are selected, so a folded size is never touched); the Size column
// is never cleared. All or nothing like a paste: under Real-Time Pricing a price on file is locked.
function ssPgClearPlan(view, sel, opts) {
  const v = view || {}, order = v.order || [];
  if (!sel || !order[sel.r0]) return { ok: false, error: "Click a box first." };
  const c0 = Math.max(1, sel.c0), c1 = sel.c1;
  if (c1 < c0) return { ok: false, error: "A size's width and length can't be changed here." };
  const max = opts && Number(opts.max) > 0 ? Number(opts.max) : 20000;
  const n = (sel.r1 - sel.r0 + 1) * (c1 - c0 + 1);
  if (n > max) return { ok: false, error: `That's ${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} boxes. Clear at most ${String(max).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} at a time.` };
  const targets = [];
  for (let i = sel.r0; i <= sel.r1; i++) {
    const cells = [];
    for (let c = c0; c <= c1; c++) cells.push({ col: c, text: "" });
    targets.push({ id: order[i], n: i - sel.r0 + 1, cells });
  }
  return ssPgPlanCells(v, targets, { byRow: false });
}

// THE CONFIRM'S QUESTION (plan 3.12), from ssPgPlanCells' `sizes`: any paste, fill or clear that
// changes boxes on MORE THAN ONE size asks first, naming the first and last size and counting what
// changes: "Change 6 sizes, Test Barn 10x12 to Test Barn 12x24: 6 prices, 2 sizes hidden from your
// designer, 14 included options. Continue?" A size that a first price puts in the designer is counted
// too. One size never asks (`ask` false, `text` ""), as typing in a box never does.
function ssPgChangeSummary(sizes) {
  const list = (Array.isArray(sizes) ? sizes : []).filter(Boolean);
  const sum = (k) => list.reduce((n, z) => n + (Number(z[k]) || 0), 0);
  const prices = sum("prices"), options = sum("options");
  const hidden = list.filter((z) => z.wasShown && !z.nowShown).length;
  const shown = list.filter((z) => !z.wasShown && z.nowShown).length;
  const n = (k, one, many) => (k === 1 ? `1 ${one}` : `${String(k).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} ${many}`);
  const parts = [];
  if (prices) parts.push(n(prices, "price", "prices"));
  if (hidden) parts.push(n(hidden, "size hidden from your designer", "sizes hidden from your designer"));
  if (shown) parts.push(n(shown, "size now offered in your designer", "sizes now offered in your designer"));
  if (options) parts.push(n(options, "included option", "included options"));
  const ask = list.length > 1;
  const text = ask ? `Change ${n(list.length, "size", "sizes")}, ${list[0].name} to ${list[list.length - 1].name}${parts.length ? ": " + parts.join(", ") : ""}. Continue?` : "";
  return { ask, sizes: list.length, prices, hidden, shown, options, text };
}

function PricingCsv({ viewingLabel = null, onGoToOptions = null }) {
  const [cat, setCat] = useState(null);   // { clientId, styles, sizes, items, inclusions }
  const [busy, setBusy] = useState(false);
  const [dlBusy, setDlBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  // The Excel row's own banner (2026-10-30): an upload's result and a download's refusal draw under
  // the two buttons that caused them, not at the top of the page over the styles card.
  const [xlMsg, setXlMsg] = useState(null);
  const [result, setResult] = useState(null);
  const [fileKey, setFileKey] = useState(0);
  // building-style manager state
  const [styleName, setStyleName] = useState("");
  const [styleCode, setStyleCode] = useState("");      // serial code, required (316)
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
  // The option columns live in ssPricingColumns (top level, above) so the Pricing Table builds
  // exactly the same columns as this sheet.
  const optionSections = () => ssPricingColumns(cat);
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
    // Serial code is REQUIRED (Carolyn 2026-10-18: "make sure we are requiring a code for each
    // style and color so that we always have a full serial number").
    if (!styleCode.trim()) { setMsg({ err: "Add a serial code for this style (e.g. LBA) — it is part of every building's serial number." }); return; }
    setStyleBusy(true); setMsg(null);
    try {
      const body = { action: "create_style", label: styleName.trim(), code: styleCode.trim() };
      if (styleImg) { body.imageBase64 = styleImg.base64; body.imageContentType = styleImg.contentType; }
      const { data, error } = await sb.functions.invoke("portal-settings", { body });
      if (error || (data && data.error)) throw new Error((error && error.message) || data.error);
      const added = styleName.trim();
      setStyleName(""); setStyleCode(""); setStyleImg(null); setStyleFileKey((k) => k + 1);
      await load();
      // Drawn as a link to the table, jumped to the new style (create_style answers its styleId).
      setMsg({ added: { name: added, styleId: (data && data.styleId) || null } });
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
    if (!editCode.trim()) { setMsg({ err: "A serial code is required for every style." }); return; }
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
    // FRESH READS, not `cat` (2026-10-30). Sheds loaded `cat` when it mounted, and the Sizes & prices
    // table may have changed numbers since, in another tab. A sheet built from the old copy puts
    // those numbers back on its next upload, because the importer writes every box it is given.
    // size_table also reads every list in pages: catalog's own inclusion read stops at 1000 rows, and
    // a row cut off there went out as 0, which the importer then DELETED. A list that does not add
    // up to its count (ssPgModel's "count") gets one more try, then the download is refused rather
    // than built (plan 4.8). Only that: the table's other guards ("cap", an orphan row) cannot put
    // a false 0 in the sheet, and the table sends a builder who trips them here, to Excel.
    // The view-as target is read in the click's tick, like every other write path here.
    const target = ssTargetClientId;
    setDlBusy(true); setXlMsg(null);
    let fresh = null;
    for (let attempt = 0; attempt < 2 && !fresh; attempt++) {
      const r = await ssPgFetch(target, cat.clientId || null);
      if (!r.ok) { setXlMsg({ err: `Couldn't read your catalog for the template: ${r.error}` }); setDlBusy(false); return; }
      if (ssPgModel(r.cat, r.table).guard !== "count") fresh = r;
    }
    if (!fresh) { setXlMsg({ err: "Couldn't read your whole catalog just now. Try again in a minute." }); setDlBusy(false); return; }
    // onUpload maps a sheet's headers through `cat`'s columns, so `cat` becomes the catalog this sheet
    // is built from. Kept as mounted, a column added or renamed in another tab since (the table's
    // no-columns box sends builders to Options) would be in the sheet and then dropped, unmatched, by
    // the upload, under a banner that still says "Imported". Same `catalog` answer load() stores.
    setCat(fresh.cat);
    const { sections, headers, rows } = ssPgTemplate(fresh.cat, fresh.table);
    const fileBase = fresh.table.clientId || cat.clientId || "pricing";

    let ExcelJS;
    try { ExcelJS = await loadExcelJS(); }
    catch (e) {
      // Library unreachable → still hand back a usable CSV so the download never fully fails.
      downloadFile(`${fileBase}-pricing.csv`, toCSV(headers, rows.map((r) => r.map((v) => (v == null ? "" : String(v))))));
      setXlMsg({ err: `${e.message} Downloaded a plain CSV instead.` });
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
      downloadBlob(`${fileBase}-pricing.xlsx`,
        new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    } catch (e) {
      setXlMsg({ err: `Could not build the Excel file: ${e.message}` });
    }
    setDlBusy(false);
  };
  const onUpload = async (file) => {
    if (!file) return;
    setBusy(true); setMsg(null); setXlMsg(null); setResult(null);
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
      setXlMsg({ ok: `Imported ${data.imported || 0} size(s)` + (parts.length ? ` (${parts.join(", ")})` : "") + (data.skipped && data.skipped.length ? `, ${data.skipped.length} skipped` : "") });
    } catch (e) { setXlMsg({ err: e.message }); }
    setBusy(false); setFileKey((k) => k + 1);
  };

  const errStyle = { background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 8, padding: "9px 13px", color: "#DC2626", fontSize: 13, fontWeight: 600, marginBottom: 12 };
  const okStyle = { background: "#F0FDF4", border: "1px solid #BBF7D0", borderRadius: 8, padding: "9px 13px", color: "#15803D", fontSize: 13, fontWeight: 600, marginBottom: 12 };
  const thumb = { width: 48, height: 36, borderRadius: 4, background: "#F1F5F9", objectFit: "cover", flexShrink: 0 };
  return (
    <>
      {msg && msg.err && <div style={errStyle}>{msg.err}</div>}
      {msg && msg.ok && <div style={okStyle}>{msg.ok}</div>}
      {/* Add style's answer points straight at the table, jumped to the new style. A real link in
          a new tab, like the card's own button below; the Excel template stays the other way. */}
      {msg && msg.added && (
        <div style={okStyle}>
          Building style “{msg.added.name}” added.{" "}
          <a href={ssPricingTableHref({ style: msg.added.styleId })} target="_blank" rel="noopener"
            style={{ color: "#15803D", fontWeight: 800, textDecoration: "underline" }}>Open the sizes &amp; prices table</a>{" "}
          to add its sizes, or use the Excel template below.
        </div>
      )}

      {editStyle && (
        <div onClick={() => !styleBusy && setEditStyle(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.5)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 1000 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "#FFF", borderRadius: 12, padding: 22, maxWidth: 440, width: "100%", boxShadow: "0 20px 50px rgba(0,0,0,0.25)" }}>
            <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 14 }}>Edit building style</div>
            <span style={S.lbl}>Name</span>
            <input value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="Building style name" style={{ ...S.input, marginBottom: 10 }} />
            {/* Serial code (163). Carolyn @57:20: "all of their buildings have codes. They
                come up with them. LBA. Okay. Stands for Lofted Barn." REQUIRED since 316
                (2026-10-18): Save stays off until it is filled. */}
            <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "#475569", marginBottom: 4 }}>Serial code <span style={{ color: "#DC2626" }}>*</span></label>
            <input value={editCode} maxLength={4}
              onChange={(e) => setEditCode(e.target.value.toUpperCase().slice(0, 4))}
              placeholder="e.g. LBA"
              style={{ ...S.input, marginBottom: 4, textTransform: "uppercase" }} />
            <p style={{ fontSize: 11, color: "#94A3B8", marginTop: 0, marginBottom: 14, lineHeight: 1.5 }}>
              Your short code for this building style. It becomes the second block of every serial number this style produces &mdash; the <b>LBA</b> in <code>1027-<b>LBA</b>-1216-REBUWHM-25698</code>.
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
              <button onClick={saveEdit} disabled={styleBusy || !editName.trim() || !editCode.trim()} style={{ ...S.btn(ACCENT, "#FFF"), opacity: (styleBusy || !editName.trim() || !editCode.trim()) ? 0.55 : 1 }}>
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
          Add each building style you sell — give it a name and a photo. Then press “Open sizes &amp; prices
          table ↗” below to set each style’s sizes &amp; prices. <b>Drag the ⠿ handle to reorder</b> — the top style shows first on your
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
                      {s.code
                        ? <span title="Serial code for this style" style={{ marginLeft: 8, fontSize: 11, fontWeight: 800, letterSpacing: 0.4, color: "#475569", background: "#F1F5F9", border: "1px solid #E2E8F0", borderRadius: 5, padding: "2px 6px" }}>{s.code}</span>
                        : <span title="Serial numbers for this style read XXX until you add a code — click Edit" style={{ marginLeft: 8, fontSize: 11, fontWeight: 800, color: "#B91C1C", background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 5, padding: "2px 6px" }}>Needs serial code</span>}
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
                    <label title="Sales tax is charged on this style's building line. Untick and it sits under the non-taxable subtotal on estimates and invoices." style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: "#475569", fontWeight: 600, cursor: styleBusy ? "default" : "pointer", flexShrink: 0 }}>
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
              <input value={styleCode} maxLength={4} onChange={(e) => setStyleCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4))}
                placeholder="Serial code *" title="Required — your short code for this style, e.g. LBA. It is part of every building's serial number."
                style={{ ...S.input, width: 120, textTransform: "uppercase" }} />
              <label style={{ ...S.btn("#F1F5F9", "#334155"), cursor: "pointer", display: "inline-block" }}>
                {styleImg ? "Image selected ✓" : "Choose image"}
                <input key={styleFileKey} type="file" accept="image/png,image/jpeg,image/webp,image/gif" style={{ display: "none" }} onChange={(e) => onStyleImg(e.target.files && e.target.files[0])} />
              </label>
              <button onClick={addStyle} disabled={styleBusy || !styleName.trim() || !styleCode.trim()} style={{ ...S.btn(ACCENT, "#FFF"), opacity: (styleBusy || !styleName.trim() || !styleCode.trim()) ? 0.55 : 1 }}>{styleBusy ? "Adding…" : "Add style"}</button>
            </div>
          </div>
        )}
      </div>

      <div style={S.card}>
        {/* Retitled 2026-10-30: the table is the way in now, and Excel is the alternative under it. */}
        <div style={S.h2}>Sizes, prices &amp; included options</div>
        {/* Sequencing banner (Carolyn 2026-08-06): the option columns ARE the tenant's Options
            catalog, so pricing a size before the catalog exists means coming back later to say
            what's included. Say so before they start. */}
        <div style={{ background: "#FEF3C7", border: "1px solid #FDE68A", borderRadius: 8, padding: "11px 14px", marginBottom: 12, display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
          <span aria-hidden="true" style={{ fontSize: 15, lineHeight: 1.4 }}>💡</span>
          <div style={{ flex: 1, minWidth: 220, fontSize: 13, color: "#92400E", lineHeight: 1.55 }}>
            <b>Set up your Options first.</b> Every door, window, ramp, and add-on you offer becomes a
            column in the table and the sheet — that's how you say what comes <b>included</b> with each style and size.
            Build that list under <b>Options</b> first, so nothing is missing from it.
          </div>
          {onGoToOptions && (
            <button onClick={onGoToOptions} style={{ ...S.btn("#FFF", "#92400E"), border: "1px solid #FDE68A", padding: "6px 12px", whiteSpace: "nowrap" }}>Go to Options →</button>
          )}
        </div>
        {/* This gate gives way to the table link and the two-button Excel row, so the skeleton is
            those three button-sized blocks — nothing more. Claiming any more shape here would be
            inventing controls this card doesn't have. */}
        {!cat ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <SkelBar w={236} h={36} />
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <SkelBar w={96} h={14} /><SkelBar w={186} h={30} /><SkelBar w={156} h={30} />
            </div>
          </div>
        ) : activeStyles().length === 0 ? (
          <div style={{ background: "#DBEAFF", border: "1px solid #75E6DA", borderRadius: 8, padding: "11px 14px", color: "#1B7895", fontSize: 13, lineHeight: 1.5 }}>
            <b>Add a building style above first.</b> Sizes and prices are set per style — add at least one
            (with a name &amp; photo), then come back here to set its sizes &amp; prices.
          </div>
        ) : (
          <>
            <p style={{ fontSize: 13, color: "#64748B", marginBottom: 10, lineHeight: 1.5 }}>
              Every size you sell, its price and what comes <b>included</b>, for all your styles in one table. It opens in its own tab.
            </p>
            {/* A REAL anchor in a new tab, never ssNavClick (01-core.jsx), which turns a plain left
                click into same-document navigation. Middle-click and "open in new tab" work too. */}
            <a href={ssPricingTableHref()} target="_blank" rel="noopener"
              style={{ ...S.btn(ACCENT, "#FFF"), display: "inline-block", textDecoration: "none", marginBottom: 14 }}>
              Open sizes &amp; prices table ↗
            </a>
            {/* Prefer Excel? (Carolyn Q5: kept for good). The upload's answer draws right under it. */}
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: "#475569" }}>Prefer Excel?</span>
              <button onClick={downloadTemplate} disabled={dlBusy} style={{ ...S.btn("#F1F5F9", "#334155"), opacity: dlBusy ? 0.6 : 1, cursor: dlBusy ? "default" : "pointer" }}>{dlBusy ? "Preparing…" : "⬇ Download Excel template"}</button>
              <label style={{ ...S.btn(busy ? "#9CA3AF" : "#1E293B", "#FFF"), cursor: busy ? "default" : "pointer", display: "inline-block" }}>
                {busy ? "Importing…" : "⬆ Upload filled sheet"}
                <input key={fileKey} type="file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" disabled={busy} style={{ display: "none" }}
                  onChange={(e) => onUpload(e.target.files && e.target.files[0])} />
              </label>
            </div>
            {xlMsg && xlMsg.err && <div data-ss-xl-msg="err" style={{ ...errStyle, marginTop: 12, marginBottom: 0 }}>{xlMsg.err}</div>}
            {xlMsg && xlMsg.ok && <div data-ss-xl-msg="ok" style={{ ...okStyle, marginTop: 12, marginBottom: 0 }}>{xlMsg.ok}</div>}
          </>
        )}
        {result && result.skipped && result.skipped.length > 0 && (
          <div style={{ marginTop: 12, fontSize: 13 }}>
            <div style={{ color: "#B91C1C", fontWeight: 700 }}>{result.skipped.length} row(s) not imported in full:</div>
            <ul style={{ margin: "4px 0 0 18px", color: "#B91C1C", maxHeight: 160, overflow: "auto" }}>
              {result.skipped.slice(0, 30).map((s, i) => <li key={i}>{s}</li>)}
            </ul>
          </div>
        )}
        <p style={{ fontSize: 12.5, color: "#64748B", marginTop: 14, marginBottom: 0, lineHeight: 1.5 }}>
          <b>Using Excel:</b> download the template (one row per building style), then add a row for every size you offer: type the
          <b> width</b> and <b>length</b> (in feet) and the <b>price</b>. The option columns hold the <b>quantity
          included in the price</b> — for a loft that's the included <b>square footage</b> (e.g. <b>50</b>), for doors
          and windows a <b>count</b> (e.g. <b>1</b>). Put <b>0</b> to charge for it instead. If a customer declines an
          included item, their estimate credits the quantity × your configured rate. Re-upload anytime to update prices
          (matched by style + size, so no duplicates). A blank price — or <b>active = no</b> — hides that size from your designer.
          The option columns include <b>every door, window, and ramp in your catalog</b> (each shown with its size) alongside the
          built-in items — so you can set how many of a specific catalog item come included with each size.
          {" "}<b>Changed numbers in the table? Download a fresh template before you use Excel again.</b>
        </p>
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
      // Allowed on interior walls (313): ticked on the Interior walls tab; carried through this
      // card's save so it survives. Absent reads as yes, the column's default.
      interiorWallOk: r.interior_wall_ok !== false,
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
      {/* `it.id` guard: an item added in this session has no id yet, and an option with
          value="" reads back as "— none —" the moment it is picked. Save first, then point a
          standard at it. */}
      {(() => {
        const pickable = items.filter((it) => it.id && (it.name || "").trim());
        return (
          <>
            {pickable.length === 0 && (
              /* A brand-new tenant saw three dropdowns holding nothing but "— none —" and no
                 clue why (Carolyn 2026-10-12). The choices ARE the saved items below. */
              <p style={{ margin: "0 0 8px", fontSize: 12.5, color: "#B45309", background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 8, padding: "8px 12px", maxWidth: 640 }}>
                Nothing to choose from yet. Add your outlet, switch and light under <b>Your electrical items</b> below,
                click <b>Save</b>, then come back here and pick them &mdash; that is how the package knows what to lay out.
              </p>
            )}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 18, alignItems: "flex-start", marginBottom: 14 }}>
              {[["outletItemId", "Outlets are"], ["switchItemId", "The switch is"], ["lightItemId", "Lights are"]].map(([k, label]) => (
                <label key={k} style={{ display: "block", minWidth: 180 }}>
                  <span style={{ ...S.lbl, display: "block", marginBottom: 4 }}>{label}</span>
                  <select value={f[k] || ""} onChange={(e) => set(k, e.target.value || null)} disabled={pickable.length === 0}
                    style={{ ...S.input, width: 180, opacity: pickable.length === 0 ? 0.55 : 1 }}>
                    <option value="">{pickable.length === 0 ? "no saved items yet" : "— none —"}</option>
                    {pickable.map((it) => (
                      <option key={it.id} value={it.id}>{it.name}</option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          </>
        );
      })()}
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
        each one lands as its own line on the estimate. Only insulate under the floor? Fill in just the
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
        Each one the customer chooses lands as its own line on the estimate.
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
              <th style={S.th} title="How it reads on the designer and the estimate. Blank keeps the built-in name.">Shown as</th>
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
  ["rep", "The rep's home lot", "The location set for whoever is making the estimate (Settings → Company → Team). The customer designer, which has no rep, uses the nearest location."],
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
        they enter their address, and it lands on the estimate — or left for the rep, who sees the figure
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
            {" "}&middot; <a href={ssPagePath("settings", "company")} style={{ color: "#1B7895" }}>Company</a> &middot; <a href={ssPagePath("settings", "locations")} style={{ color: "#1B7895" }}>Locations</a>
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
            {/* The twin of "Charge tax on delivery" on Company → Tax (both write ss_tax_delivery;
                until 2026-10-09 the other one was on GHL Connection → Estimates & Invoices). It used to
                point at Company → Business details, which has no such switch. */}
            <span style={{ fontWeight: 500, color: "#64748B" }}>&mdash; charge sales tax on the delivery line (the same switch as Company &rarr; Tax)</span>
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

// ─── The library (migration 339; Carolyn's 10-26 call, Ahsan's answers 2026-10-27) ───
// Cladding, Doors and Windows each carry a Library card above their own list: a search and a Browse
// button over the StructureStudio templates (Ahsan 2026-10-27), where the builder imports templates,
// renames or removes what they imported, and requests what is not there. A builder USES a template under their own name and may edit their
// copy (a lap course, a door look, a window grid); only their copy changes. Their rows then pick
// from these entries (the cladding table's dropdown, a door's "How it looks in 3D", a window's
// grid), and an entry's edit moves every row on it (339 writes it through).
//
// Shown only with client_settings.library_beta on: the card reads the catalog first (joining the
// same in-flight read as the list beside it, so it costs nothing) and asks for `library` only when
// libraryBeta says yes. Asking with the flag off would answer 403, and every 4xx is an info row.
//
// Names here are prefixed ssLib / SsLib: portal/01..12 are ONE lexical scope once concatenated.
const SS_LIB_NOUN = { cladding: "cladding", door: "door", window: "window" };
const SS_LIB_DOOR_LOOKS = [
  ["auto", "Use the door's photo"], ["plank", "Board-and-batten (built in 3D)"], ["zbrace", "Board-and-batten with a Z brace"],
  ["xbrace", "Board-and-batten with an X brace"], ["rollup", "Roll-up / garage door"], ["american", "American (built in 3D)"],
  ["basic", "Basic (built in 3D)"], ["classic", "Classic (built in 3D)"], ["dutch", "Dutch (built in 3D)"],
];
const SS_LIB_CLADDING_NAMES = { panel: "Panel Siding", lap: "7\" LP Lap Siding", vinyl: "4.5\" Vinyl Siding", batten: "Board & Batten", agpanel: "AG Panel" };
const SS_LIB_REQ_STATUS = {
  submitted: ["Sent", "#1D4ED8", "#DBEAFE"], in_progress: ["Being built", "#92400E", "#FEF3C7"], generating: ["Being built", "#92400E", "#FEF3C7"],
  review: ["Being checked", "#92400E", "#FEF3C7"], ready: ["Ready", "#15803D", "#DCFCE7"], done: ["Ready", "#15803D", "#DCFCE7"],
  refused: ["Not possible", "#B91C1C", "#FEE2E2"], failed: ["Didn't work", "#B91C1C", "#FEE2E2"], cancelled: ["Cancelled", "#475569", "#F1F5F9"],
};
// What a look IS, in words, for the line under an entry's name.
function ssLibLookWords(category, look) {
  const l = look || {};
  if (category === "cladding") {
    const base = SS_LIB_CLADDING_NAMES[l.profile] || l.profile || "Cladding";
    return l.profile === "lap" && l.exposureIn != null ? `${base}, ${l.exposureIn} in boards` : base;
  }
  if (category === "door" && l.doorLookId) return `Made from your photo, drawn over ${(SS_LIB_DOOR_LOOKS.find(([k]) => k === l.doorStyle) || [null, "a built look"])[1].replace(/ \(built in 3D\)$/, "")}`;
  if (category === "door") return (SS_LIB_DOOR_LOOKS.find(([k]) => k === l.doorStyle) || [null, "Door"])[1];
  if (l.liteRows == null) return "Standard grid (sized to the window)";
  const n = Number(l.liteRows) * Number(l.liteCols);
  return n < 2 ? "No grid" : `${n}-lite: ${l.liteRows} ${Number(l.liteRows) === 1 ? "row" : "rows"} of ${l.liteCols}`;
}
// A small drawing of a look: courses or grooves for cladding, the panel for a door, the grid for a
// window. Not the 3D (that is the designer's job), just enough to tell entries apart at a glance.
function SsLibPic({ category, look, size = 44, thumbUrl = null }) {
  const l = look || {};
  const w = size, h = Math.round(size * 0.82), stroke = "#334155";
  // A door made from a photo shows our own render of it (its tile), when it has one.
  if (category === "door" && thumbUrl) return <img src={thumbUrl} alt="" width={w} height={h} style={{ objectFit: "contain", background: "#F1F5F9", borderRadius: 4, flexShrink: 0 }} />;
  const lines = [];
  if (category === "cladding") {
    const p = l.profile;
    if (p === "lap" || p === "vinyl") {
      const step = p === "vinyl" ? 4 : Math.max(4, Math.min(9, Number(l.exposureIn || 7)));
      for (let y = step; y < h; y += step) lines.push(<line key={y} x1="0" y1={y} x2={w} y2={y} stroke="#64748B" strokeWidth={p === "vinyl" ? 0.8 : 1.2} />);
    } else if (p === "batten") {
      for (let x = 7; x < w; x += 9) lines.push(<rect key={x} x={x} y="0" width="2.2" height={h} fill="#64748B" />);
    } else if (p === "agpanel") {
      for (let x = 4; x < w; x += 8) lines.push(<path key={x} d={`M${x} 0V${h}`} stroke="#475569" strokeWidth="2.4" />);
    } else {
      for (let x = 6; x < w; x += 6) lines.push(<line key={x} x1={x} y1="0" x2={x} y2={h} stroke="#94A3B8" strokeWidth="0.8" />);
    }
    return <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" style={{ background: "#E2E8F0", borderRadius: 4, flexShrink: 0 }}>{lines}</svg>;
  }
  if (category === "window") {
    const R = l.liteRows == null ? 2 : Number(l.liteRows), C = l.liteRows == null ? 2 : Number(l.liteCols);
    for (let i = 1; i < R; i++) lines.push(<line key={"r" + i} x1="3" y1={3 + ((h - 6) * i) / R} x2={w - 3} y2={3 + ((h - 6) * i) / R} stroke={stroke} strokeWidth="1.2" strokeDasharray={l.liteRows == null ? "2 2" : null} />);
    for (let j = 1; j < C; j++) lines.push(<line key={"c" + j} x1={3 + ((w - 6) * j) / C} y1="3" x2={3 + ((w - 6) * j) / C} y2={h - 3} stroke={stroke} strokeWidth="1.2" strokeDasharray={l.liteRows == null ? "2 2" : null} />);
    return <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" style={{ flexShrink: 0 }}><rect x="2" y="2" width={w - 4} height={h - 4} fill="#F0F9FF" stroke={stroke} strokeWidth="2" />{lines}</svg>;
  }
  // A door: frame, then what the look puts in its panels.
  const s = l.doorStyle, dw = Math.round(h * 0.62), x0 = (w - dw) / 2, mid = h * 0.42;
  const mark = [];
  if (s === "auto") mark.push(<path key="cam" d={`M${x0 + dw * 0.25} ${h * 0.55}h${dw * 0.5}v${h * 0.2}h${-dw * 0.5}z`} fill="#94A3B8" />);
  if (s === "plank" || s === "zbrace" || s === "xbrace") for (let x = x0 + 4; x < x0 + dw - 2; x += 4) mark.push(<line key={x} x1={x} y1="3" x2={x} y2={h - 3} stroke="#94A3B8" strokeWidth="0.8" />);
  if (s === "zbrace") mark.push(<path key="z" d={`M${x0 + 2} ${h - 4}L${x0 + dw - 2} 4`} stroke={stroke} strokeWidth="2" />);
  if (s === "xbrace") mark.push(<path key="x" d={`M${x0 + 2} ${mid}L${x0 + dw - 2} ${h - 3}M${x0 + dw - 2} ${mid}L${x0 + 2} ${h - 3}`} stroke={stroke} strokeWidth="1.6" />);
  if (s === "rollup") for (let y = 5; y < h - 2; y += 3.5) mark.push(<line key={y} x1={x0 + 1} y1={y} x2={x0 + dw - 1} y2={y} stroke="#64748B" strokeWidth="0.9" />);
  if (s === "american" || s === "basic" || s === "classic" || s === "dutch") mark.push(<line key="m" x1={x0} y1={mid} x2={x0 + dw} y2={mid} stroke={stroke} strokeWidth="2" />);
  if (s === "american") for (let k = 1; k <= 3; k++) mark.push(<line key={"p" + k} x1={x0 + (dw * k) / 4} y1={mid} x2={x0 + (dw * k) / 4} y2={h - 3} stroke={stroke} strokeWidth="2" />);
  if (s === "classic") mark.push(<path key="cl" d={`M${x0 + 3} ${mid + 2}L${x0 + dw - 3} ${h - 4}M${x0 + dw - 3} ${mid + 2}L${x0 + 3} ${h - 4}M${x0 + dw / 2} ${mid * 0.35}l${dw * 0.18} ${mid * 0.25}l${-dw * 0.18} ${mid * 0.25}l${-dw * 0.18} ${-mid * 0.25}z`} stroke={stroke} strokeWidth="1.4" fill="none" />);
  if (s === "dutch") mark.push(<rect key="v" x={x0 + dw * 0.3} y={h * 0.62} width={dw * 0.4} height={h * 0.18} fill="#334155" />);
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" style={{ flexShrink: 0 }}>
      <rect x={x0} y="2" width={dw} height={h - 4} fill="#FEF3C7" stroke={stroke} strokeWidth="2" />{mark}
    </svg>
  );
}

// A window's grid of lites (335), set here in Settings and nowhere else. Carolyn, 10-27 call: "The
// customer can't select the grid" (the designer's grid picker is gone), and "The way it's in the
// Designer is how I want it here ... no grids or then one grid, vertical, horizontal, whatever, to
// replace this drop-down". So this is that picker: No grid, rows and lites across with a little drawing
// of the grid, and Standard (the grid every window drew before 335, sized to the window). `look` is
// { liteRows, liteCols }, or {} for Standard. With `entries` (the builder's imported window grids, 339),
// each is a chip that takes its grid from the library; `linkedId` marks the one in use. Used by the
// window editor, the Library card's grid editor and the operator's library (07-admin).
function SsGridPicker({ look, onChange, entries = null, linkedId = null, onPickEntry = null, onFindMore = null }) {
  const l = look || {};
  const cur = l.liteRows == null ? null : { rows: Number(l.liteRows), cols: Number(l.liteCols) || 1 };
  const base = cur || { rows: 1, cols: 1 };
  const set = (rows, cols) => { if (rows >= 1 && cols >= 1 && rows <= 8 && cols <= 8) onChange({ liteRows: rows, liteCols: cols }); };
  const ink = "#334155", line = "#E2E8F0", accent = "#0284C7";
  const chip = (key, on, text, onClick, extra) => (
    <button key={key} type="button" onClick={onClick} data-ss-lites-chip={key} {...(extra || {})}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 20, fontSize: 12, fontWeight: 700, cursor: "pointer",
        border: `2px solid ${on ? accent : line}`, background: on ? "#E0F2FE" : "#FFF", color: on ? "#075985" : ink }}>{text}</button>
  );
  const step = (key, n, onDown, onUp, unit) => (
    <span key={key} data-ss-lites-step={key} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, color: ink, fontWeight: 600 }}>
      <button type="button" onClick={onDown} disabled={n <= 1} aria-label={`Fewer ${key === "rows" ? "rows" : "across"}`}
        style={{ width: 26, height: 26, borderRadius: 6, border: `1px solid ${line}`, background: "#FFF", color: ink, cursor: n <= 1 ? "default" : "pointer", padding: 0, fontWeight: 800, opacity: n <= 1 ? 0.45 : 1 }}>−</button>
      <span style={{ minWidth: 14, textAlign: "center", fontWeight: 800 }}>{cur ? n : "–"}</span>
      <button type="button" onClick={onUp} disabled={n >= 8} aria-label={`More ${key === "rows" ? "rows" : "across"}`}
        style={{ width: 26, height: 26, borderRadius: 6, border: `1px solid ${line}`, background: "#FFF", color: ink, cursor: n >= 8 ? "default" : "pointer", padding: 0, fontWeight: 800, opacity: n >= 8 ? 0.45 : 1 }}>+</button>
      <span>{unit}</span>
    </span>
  );
  return (
    <div data-ss-grid-picker="1">
      {entries && (
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }} data-ss-window-grid-library="1">
          <span style={{ fontSize: 12, fontWeight: 700, color: "#64748B" }}>From your library:</span>
          {entries.map((x) => chip("lib-" + x.id, linkedId === x.id, <><SsLibPic category="window" look={x.look} size={22} />{x.name}</>, () => onPickEntry && onPickEntry(x),
            { "data-ss-window-grid-library-entry": x.name, title: ssLibLookWords("window", x.look) }))}
          {onFindMore && chip("more", false, "Find more in the library…", onFindMore)}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {chip("plain", !!cur && cur.rows === 1 && cur.cols === 1, "No grid", () => set(1, 1))}
        {step("rows", base.rows, () => set(base.rows - 1, base.cols), () => set(base.rows + 1, base.cols), base.rows === 1 ? "row" : "rows")}
        <span style={{ color: ink, fontSize: 12 }}>×</span>
        {step("cols", base.cols, () => set(base.rows, base.cols - 1), () => set(base.rows, base.cols + 1), "across")}
        <span aria-hidden="true" data-ss-window-lite-pic={cur ? `${cur.rows}x${cur.cols}` : "auto"}
          style={{ width: 36, height: 28, boxSizing: "border-box", border: `2px solid ${ink}`, background: "#F0F9FF", display: "grid",
            gridTemplateRows: `repeat(${cur ? cur.rows : 2}, 1fr)`, gridTemplateColumns: `repeat(${cur ? cur.cols : 2}, 1fr)`, borderStyle: cur ? "solid" : "dashed" }}>
          {Array.from({ length: cur ? cur.rows * cur.cols : 4 }, (_, k) => {
            const rr = cur ? cur.rows : 2, cc = cur ? cur.cols : 2;
            return <span key={k} style={{ borderRight: (k % cc) < cc - 1 ? `1px ${cur ? "solid" : "dashed"} ${ink}` : "none", borderBottom: Math.floor(k / cc) < rr - 1 ? `1px ${cur ? "solid" : "dashed"} ${ink}` : "none" }} />;
          })}
        </span>
        <span data-ss-lites-name="1" style={{ fontSize: 12, color: "#64748B" }}>
          {!cur ? "sized to the window, as before" : cur.rows * cur.cols < 2 ? "1 lite, no bars" : `${cur.rows * cur.cols}-lite (${cur.rows} ${cur.rows === 1 ? "row" : "rows"} of ${cur.cols})`}
        </span>
        {chip("standard", !cur, "Standard", () => onChange({}), { title: "The grid windows had before: two rows of two or three lites by width (one row in a transom)" })}
      </div>
    </div>
  );
}

// The look editor for one entry (or a template being copied): the course on lap, the built look on a
// door, the grid on a window. Cladding other than lap has nothing to edit but its name.
function SsLibLookEdit({ category, look, onChange }) {
  const l = look || {};
  if (category === "cladding") {
    if (l.profile !== "lap") return null;
    return (
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "#475569" }}>
        Board size (in)
        <input type="number" min="3" max="12" step="0.25" value={l.exposureIn == null ? "" : l.exposureIn} placeholder="7"
          onChange={(e) => onChange(e.target.value === "" ? { profile: "lap" } : { profile: "lap", exposureIn: Number(e.target.value) })}
          style={{ ...S.input, width: 80 }} />
      </label>
    );
  }
  if (category === "door") {
    return (
      <select value={l.doorStyle || "auto"} onChange={(e) => onChange({ doorStyle: e.target.value })} style={{ ...S.input, width: "auto", minWidth: 0 }}>
        {SS_LIB_DOOR_LOOKS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
      </select>
    );
  }
  return <SsGridPicker look={l} onChange={onChange} />;
}

// ─── "Don't see your door? Make it from a photo" (door looks from a photo, P6; Ahsan 2026-10-27) ───
// The right side of the Doors page's Library card. A builder whose door is not in the StructureStudio
// library uploads ONE straight-on photo of it, closed (plus optional close-ups of a hinge, the handle and
// the middle of a double: Ahsan 2026-10-27), drags four dots onto the door's corners, and presses
// Generate. The server drafts the door from the photo (generate_door_look, P4); the builder sees it
// drawn in 3D beside their photo, names it and saves it, and it goes into THEIR library, so it shows in
// every door's "How it looks in 3D" like any other library door (345).
//
// WHAT THE SERVER NEEDS, AND WHY THE STRAIGHTENER IS HERE. The model is told the photo is straightened:
// the door's leaves fill the picture from the top of the threshold to the top of the leaves, with
// DOOR_EDGE_PAD_IN (2 in) of what is past each side edge left showing, because a butt hinge's knuckle
// sits ON that edge (DOOR_LOOK_V2). So the four dragged corners are warped onto the box doorEdgePadPx
// leaves inside the picture, sized with doorFitSize (the 1568 px / 1.15 MP limits), exactly as
// scripts/doorLookLocal.mjs prepares a photo. The server refuses any other shape (door_photo_shape).
// The copies below (ssDoorFitSize, ssDoorPreparedSize, ssDoorEdgePadPx) are _shared/doorLookPrompt.ts's
// and doorLookLocal.mjs's, line for line; doorStudio_test pins them to each other.
//
// Every photo is re-encoded on a canvas (which drops EXIF and GPS) before it is uploaded, the front photo
// by the warp itself. Nothing is uploaded or charged until the three checks pass. One press is one key:
// a retryable failure is retried ONCE with `lean: true` while 150 s of the 8-minute press clock remain,
// and a dropped stream is picked up by the same key (generate_door_look_recover).
//
// Shown only with client_settings.door_looks_beta on (and the library's own flag, since it lives in the
// library card). Names are prefixed ssDoor / SsDoor: portal/01..12 are ONE lexical scope.
const SS_DOOR_PAD_IN = 2;
const SS_DOOR_MAX_LONG = 1568;
const SS_DOOR_MAX_PIXELS = Math.floor(1.15 * 1024 * 1024);
const SS_DOOR_PRESS_MS = 8 * 60 * 1000;
const SS_DOOR_LEAN_MIN_LEFT_MS = 150 * 1000;
const SS_DOOR_MIN_PX = 600;
const SS_DOOR_GOOD_PX = 1000;
const SS_DOOR_SHAPE_TOL = 0.35;
// The progress line moves on a timer: the stream carries only a space every 10 s, then the answer.
const SS_DOOR_STAGES = [[0, "Reading your door"], [75, "Looking closely at the hinges and the handle"], [170, "Putting your 3D door together"], [300, "Almost there, still working"]];

// _shared/doorLookPrompt.ts's doorFitSize: the largest size inside both limits with this aspect, never
// larger than the source.
function ssDoorFitSize(src, aspect) {
  const a = aspect && Number.isFinite(aspect) && aspect > 0 ? aspect : src[0] / src[1];
  let w = a >= 1 ? Math.min(src[0], SS_DOOR_MAX_LONG) : Math.min(src[1], SS_DOOR_MAX_LONG) * a;
  let h = w / a;
  if (Math.max(w, h) > SS_DOOR_MAX_LONG) [w, h] = a >= 1 ? [SS_DOOR_MAX_LONG, SS_DOOR_MAX_LONG / a] : [SS_DOOR_MAX_LONG * a, SS_DOOR_MAX_LONG];
  if (w * h > SS_DOOR_MAX_PIXELS) {
    const k = Math.sqrt(SS_DOOR_MAX_PIXELS / (w * h));
    [w, h] = [w * k, h * k];
  }
  return [Math.max(1, Math.floor(w)), Math.max(1, Math.floor(h))];
}
// doorEdgePadPx: the strip, in output pixels, that DOOR_EDGE_PAD_IN takes at this photo's width.
function ssDoorEdgePadPx(photoW, widthIn, padIn = SS_DOOR_PAD_IN) {
  return padIn > 0 ? (photoW * padIn) / (widthIn + 2 * padIn) : 0;
}
// doorLookLocal.mjs's preparedSize: the typed shape plus the strips, at the largest size the quad's own
// pixels can fill (never enlarged).
function ssDoorPreparedSize(quad, widthIn, heightIn, padIn = SS_DOOR_PAD_IN) {
  const len = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const w = Math.max(len(quad[0], quad[1]), len(quad[3], quad[2])), h = Math.max(len(quad[0], quad[3]), len(quad[1], quad[2]));
  const aspect = widthIn / heightIn, span = (widthIn + 2 * padIn) / widthIn;
  const natural = h * aspect <= w ? [h * aspect, h] : [w, w / aspect];
  return ssDoorFitSize([Math.round(natural[0] * span), Math.round(natural[1])], aspect * span);
}
// The three checks before anything is uploaded or charged (plan §2, screen 2). `quad` is in the
// original photo's pixels: top-left, top-right, bottom-right, bottom-left.
function ssDoorQuadCheck(quad, widthIn, heightIn, hasHingeCloseUp) {
  const len = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const tall = Math.max(len(quad[0], quad[3]), len(quad[1], quad[2]));
  const wide = (len(quad[0], quad[1]) + len(quad[3], quad[2])) / 2;
  const high = (len(quad[0], quad[3]) + len(quad[1], quad[2])) / 2;
  if (tall < SS_DOOR_MIN_PX) return { ok: false, tall, error: "This photo is too small. Use one where the door fills most of the picture." };
  if (tall < SS_DOOR_GOOD_PX && !hasHingeCloseUp) return { ok: false, tall, error: "This photo is too small to read the hinges. Add a close-up of a hinge, or use a photo where the door fills more of the picture." };
  const want = widthIn / heightIn, got = high > 0 ? wide / high : 0;
  if (!(got > 0) || Math.abs(got / want - 1) > SS_DOOR_SHAPE_TOL) return { ok: false, tall, error: "This photo doesn't match the door's size. Check the width and height you typed, or stand straight in front of the door and try again." };
  return { ok: true, tall };
}
// The warp: the output's door box (padPx in from each side, full height) onto the dragged quad, the
// strips carried on past the corners, and plain grey where they run off the photo (never the edge
// pixels smeared). doorLookLocal.mjs's render, on this page's canvas. Null when the quad is not a sane
// convex shape or the photo would not decode.
function ssDoorWarp(img, quad, out, padPx) {
  const [W, H] = out;
  const natW = img.naturalWidth || img.width, natH = img.naturalHeight || img.height;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const signs = [0, 1, 2, 3].map((i) => Math.sign(cross(quad[i], quad[(i + 1) % 4], quad[(i + 2) % 4])));
  if (!(signs.every((s) => s > 0) || signs.every((s) => s < 0))) return null;
  const edge = Math.max(...quad.map((p, i) => Math.hypot(p[0] - quad[(i + 1) % 4][0], p[1] - quad[(i + 1) % 4][1])));
  if (!(edge > 8)) return null;
  // Shrink the source first so the warp samples about 2 source pixels per output pixel (and a 48 MP
  // phone photo never meets Safari's canvas cap).
  const k = Math.min(1, (2 * Math.max(W, H)) / edge, 4096 / Math.max(natW, natH));
  const sw = Math.max(1, Math.round(natW * k)), sh = Math.max(1, Math.round(natH * k));
  const s = document.createElement("canvas");
  s.width = sw; s.height = sh;
  const sctx = s.getContext("2d");
  sctx.imageSmoothingQuality = "high";
  sctx.drawImage(img, 0, 0, sw, sh);
  const src = sctx.getImageData(0, 0, sw, sh).data;
  const q = quad.map(([x, y]) => [x * k, y * k]);
  const Hm = ssSolveHomography([[padPx, 0], [W - padPx, 0], [W - padPx, H], [padPx, H]], q);
  if (!Hm) return null;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  const outImg = ctx.createImageData(W, H);
  const o = outImg.data;
  let sampled = 0;
  for (let Y = 0; Y < H; Y++) {
    for (let X = 0; X < W; X++) {
      const x = X + 0.5, y = Y + 0.5, d = Hm[6] * x + Hm[7] * y + Hm[8];
      const sx = (Hm[0] * x + Hm[1] * y + Hm[2]) / d - 0.5, sy = (Hm[3] * x + Hm[4] * y + Hm[5]) / d - 0.5;
      const at = (Y * W + X) * 4;
      if (sx < -0.5 || sy < -0.5 || sx > sw - 0.5 || sy > sh - 0.5) {
        o[at] = o[at + 1] = o[at + 2] = 128;
        o[at + 3] = 255;
        continue;
      }
      const x0 = Math.max(0, Math.min(sw - 1, Math.floor(sx))), y0 = Math.max(0, Math.min(sh - 1, Math.floor(sy)));
      const x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1);
      const fx = Math.max(0, Math.min(1, sx - x0)), fy = Math.max(0, Math.min(1, sy - y0));
      for (let ch = 0; ch < 3; ch++) {
        const v00 = src[(y0 * sw + x0) * 4 + ch], v10 = src[(y0 * sw + x1) * 4 + ch];
        const v01 = src[(y1 * sw + x0) * 4 + ch], v11 = src[(y1 * sw + x1) * 4 + ch];
        o[at + ch] = (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
      }
      o[at + 3] = 255;
      if (src[(y0 * sw + x0) * 4 + 3] > 0) sampled++;
    }
  }
  // A photo the browser could not decode reads as fully transparent: report it, never upload grey.
  if (sampled < W * H * 0.2) return null;
  ctx.putImageData(outImg, 0, 0);
  return c;
}
const ssDoorBlob = (canvas, type = "image/jpeg", q = 0.92) => new Promise((res) => canvas.toBlob((b) => res(b), type, q));
const ssDoorLoadImage = (file) => new Promise((res, rej) => {
  const url = URL.createObjectURL(file);
  const im = new Image();
  im.onload = () => res(im);
  im.onerror = () => { URL.revokeObjectURL(url); rej(new Error("That photo could not be opened. Try a JPG or PNG straight from the camera.")); };
  im.src = url;
});
// A close-up: re-encoded on a canvas (no EXIF, no GPS), inside the same size limits as the front photo.
async function ssDoorReencode(file) {
  const img = await ssDoorLoadImage(file);
  const [w, h] = ssDoorFitSize([img.naturalWidth, img.naturalHeight]);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  g.fillStyle = "#FFFFFF"; g.fillRect(0, 0, w, h);
  g.imageSmoothingQuality = "high";
  g.drawImage(img, 0, 0, w, h);
  const b = await ssDoorBlob(c);
  if (!b) throw new Error("That close-up could not be read. Try another photo.");
  return b;
}
// A refusal's own words and code, from either way supabase-js hands an answer back (a 2xx body, or a
// non-2xx whose body sits unread on error.context).
async function ssDoorAnswerOf(res) {
  if (res && res.data && typeof res.data === "object") return { status: res.error ? (res.error.ssStatus || 500) : 200, body: res.data };
  const e = res && res.error;
  if (e && e.context && typeof e.context.clone === "function") {
    try { return { status: e.context.status || 500, body: await e.context.clone().json() }; } catch (_) { /* not JSON */ }
  }
  return { status: e && e.ssStatus ? e.ssStatus : null, body: null, error: e || null };
}

// Drag four dots onto the corners of the door itself (inside the trim; the bottom ones on top of the
// threshold). The small drawing beside it shows where they go: dots on a 3.5 in casing instead would
// shift every measurement on a 36 in door by about 10 %.
function SsDoorCorners({ img, quad, setQuad }) {
  const [drag, setDrag] = useState(null);
  const boxRef = useRef(null);
  useEffect(() => {
    if (drag == null) return undefined;
    const end = () => setDrag(null);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("blur", end);
    return () => { window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end); window.removeEventListener("blur", end); };
  }, [drag]);
  const view = Math.max(220, Math.min(420, (typeof window !== "undefined" ? window.innerWidth : 420) - 120));
  const scale = view / Math.max(img.naturalWidth, img.naturalHeight);
  const dispW = img.naturalWidth * scale, dispH = img.naturalHeight * scale;
  const moveTo = (e) => {
    if (drag == null || !boxRef.current) return;
    if (e.cancelable) e.preventDefault();
    const r = boxRef.current.getBoundingClientRect();
    const px = Math.max(0, Math.min(img.naturalWidth, (e.clientX - r.left) / scale));
    const py = Math.max(0, Math.min(img.naturalHeight, (e.clientY - r.top) / scale));
    setQuad((q) => q.map((pt, i) => (i === drag ? [px, py] : pt)));
  };
  const labels = ["Top left", "Top right", "Bottom right", "Bottom left"];
  return (
    <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }} onPointerMove={moveTo}>
      <div ref={boxRef} data-ss-door-corners="1" style={{ position: "relative", width: dispW, height: dispH, userSelect: "none", touchAction: "none", flexShrink: 0 }}>
        <img src={img.src} alt="Your door photo" draggable={false} style={{ width: dispW, height: dispH, display: "block", borderRadius: 6 }} />
        <svg viewBox={`0 0 ${dispW} ${dispH}`} style={{ position: "absolute", inset: 0, width: dispW, height: dispH, pointerEvents: "none" }}>
          <polygon points={quad.map(([x, y]) => `${x * scale},${y * scale}`).join(" ")} fill="rgba(27,120,149,0.16)" stroke="#1B7895" strokeWidth="2" />
        </svg>
        {quad.map(([x, y], i) => (
          <div key={i} role="slider" aria-label={labels[i] + " corner"} data-ss-door-corner={i}
            onPointerDown={(e) => { if (e.currentTarget.setPointerCapture && e.pointerId != null) { try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_e) { /* old browser */ } } setDrag(i); }}
            style={{ position: "absolute", left: x * scale - 10, top: y * scale - 10, width: 20, height: 20, borderRadius: "50%", background: "#1B7895", border: "2px solid #FFF", boxShadow: "0 1px 4px rgba(0,0,0,0.4)", cursor: "grab" }} />
        ))}
      </div>
      <div style={{ flex: "1 1 160px", minWidth: 150, fontSize: 12.5, color: "#475569", lineHeight: 1.5 }}>
        <svg width="120" height="150" viewBox="0 0 120 150" aria-hidden="true" style={{ display: "block", marginBottom: 6 }}>
          <rect x="18" y="10" width="84" height="130" fill="#E2E8F0" stroke="#94A3B8" strokeWidth="6" />
          <rect x="24" y="16" width="72" height="118" fill="#FEF3C7" stroke="#334155" strokeWidth="1.5" />
          <rect x="12" y="136" width="96" height="6" fill="#94A3B8" />
          {[[24, 16], [96, 16], [96, 134], [24, 134]].map(([x, y], i) => <circle key={i} cx={x} cy={y} r="5" fill="#1B7895" stroke="#FFF" strokeWidth="1.5" />)}
        </svg>
        Put each dot on a corner of the <b>door itself</b>: inside the trim, with the bottom dots on top of the threshold. On a double door, use the outer corners of both doors.
      </div>
    </div>
  );
}

// ── The press, above every page (Ahsan 2026-10-28) ───────────────────────────────────────────
// "Once I start the generation, I should see a button for generating in background, or if I click
// outside the pop-up, it should automatically move the generation in the background. And once it is
// generated, I should see a pop-up on my screen that it is generated."
// So one press (the server refuses a second while one runs) lives here, not in the Doors page's
// dialog: the dialog only watches it, and SsDoorJobDock (mounted by the Dashboard on every page) shows
// a pill while nobody is watching, then a pop-up when it is done. It is kept in localStorage under
// its key, without the photos, so a reload or a closed tab picks it up again by
// generate_door_look_recover: the server keeps drawing after a dropped connection (heartbeatJson
// hands the work to EdgeRuntime.waitUntil) and answers by the key with the draft, still-working, or
// a failure. After a reload the one lean retry can still go out: the body (the photos' server paths,
// never the photos) is kept too.
const SS_DOOR_JOB_STORE = "ss.doorJob.v1";
const ssDoorJob = (() => {
  let job = null;      // { id, clientId, target, key, name, widthIn, heightIn, leaves, startedAt, sent, body, lean, status, note, result, error, seen }
  let watching = 0;    // the dialog is showing this press: no pill, and it takes the answer itself
  let review = null;   // a finished press the Doors page should open in its review
  let booted = null;   // the client whose saved press was looked at
  // A reload or a closed tab cancels the request under a running press: that is not an answer, and
  // the next page asks the server by the key, so nothing may be recorded once the page is going.
  let leaving = false;
  try { window.addEventListener("pagehide", () => { leaving = true; }); } catch (_e) { /* no window */ }
  const subs = new Set();
  const emit = () => subs.forEach((f) => { try { f(); } catch (_e) { /* a gone view */ } });
  const save = () => {
    try {
      if (!job || (job.seen && job.status !== "running")) localStorage.removeItem(SS_DOOR_JOB_STORE);
      else {
        const { straightUrl, ...kept } = job;
        localStorage.setItem(SS_DOOR_JOB_STORE, JSON.stringify(kept));
      }
    } catch (_e) { /* storage blocked: the press still runs, it just cannot outlive the tab */ }
  };
  const set = (patch) => { if (!job || leaving) return; job = { ...job, ...patch }; save(); emit(); };
  const notify = (title, body) => {
    try {
      if (document.hidden && typeof Notification !== "undefined" && Notification.permission === "granted") new Notification(title, { body });
    } catch (_e) { /* not offered here */ }
  };
  const finish = (patch) => {
    // A dialog watching it takes the answer (and marks it seen); otherwise the dock pops up.
    set({ ...patch, seen: false });
    if (!watching) {
      if (patch.status === "ready") notify("Your 3D door is ready", `${job.name ? `“${job.name}”` : "Your door"} is drawn. Check it, then save it to your library.`);
      else notify("We couldn't draw your door", patch.error || "Try again.");
    }
  };
  async function run(blobs) {
    const j0 = job;
    const invoke = (body) => sb.functions.invoke("portal-settings", { body: j0.target ? { ...body, targetClientId: j0.target } : body });
    const call = async (body) => {
      const { data, error } = await invoke(body);
      if (error || (data && data.error)) throw new Error((data && data.error) || (error && error.message) || "Something went wrong.");
      return data;
    };
    const mine = () => job && job.id === j0.id;
    const left = () => SS_DOOR_PRESS_MS - (Date.now() - j0.startedAt);
    try {
      // 1. The photos, at paths the server picks, into the private bucket (only on the first run:
      //    after a reload the press is already out, and the photos are gone from this page anyway).
      if (!job.sent) {
        const up = await call({ action: "door_ref_upload_url", contentTypes: blobs.map(() => "image/jpeg") });
        const photos = {};
        for (let i = 0; i < blobs.length; i++) {
          const u = up.uploads[i];
          const { error } = await sb.storage.from("door-refs").uploadToSignedUrl(u.path, u.token, blobs[i].blob, { contentType: "image/jpeg" });
          if (error) throw new Error("A photo didn't upload: " + error.message);
          photos[blobs[i].kind] = u.path;
        }
        if (!mine()) return;
        set({ sent: true, fresh: true, body: { action: "generate_door_look", stream: true, idempotencyKey: job.key, name: job.name, widthIn: job.widthIn, heightIn: job.heightIn, leaves: job.leaves, photos } });
      }
      // 2. One press: one key, a lean retry at most, and a pickup by the key when the stream drops.
      for (;;) {
        let got = null, refusal = null, brokeOff = true;
        if (job.fresh) {
          const res = await invoke(job.lean ? { ...job.body, lean: true } : job.body);
          if (!mine()) return;
          set({ fresh: false });
          // No HTTP answer at all (a body that broke off, the network gone, the page reloading) is a
          // dropped stream: the server keeps drawing, so ask by the key. Only a real status refuses.
          const e = res.error;
          brokeOff = Boolean(e && !e.ssStatus && !(e.context && typeof e.context.status === "number"));
          const a = brokeOff ? { status: null, body: null } : await ssDoorAnswerOf(res);
          got = a.body && a.body.ok && a.body.spec ? a.body : null;
          refusal = !got && a.body && a.body.error ? a.body : null;
          if (!got && !brokeOff && !(a.body && a.body.code === "stream_deadline")) {
            if (!refusal) refusal = { error: (res.error && res.error.message) || "We couldn't draw this door. Try again." };
          } else if (!got) brokeOff = true;
        }
        if (!got && brokeOff) {
          // The server may still be working, or done: ask by this press's key until the clock runs out.
          set({ note: "Your door is still being drawn. Picking it up…" });
          const firstAsk = Date.now();
          for (;;) {
            const r = await ssDoorAnswerOf(await invoke({ action: "generate_door_look_recover", idempotencyKey: job.key }));
            if (!mine()) return;
            if (r.body && r.body.ok && r.body.spec) { got = r.body; break; }
            if (r.body && r.body.ok && r.body.pending === false) {
              if (r.body.reason === "no_row" && Date.now() - j0.startedAt < 90_000) { /* its row may not be written yet */ }
              else { refusal = { error: r.body.message, code: r.body.code, retryable: r.body.retryable === true }; break; }
            }
            if (left() < 10_000 && Date.now() - firstAsk > 60_000) { refusal = { error: "This took too long. Look for your door under “Not in your library yet” on the Doors page before you press Generate again." }; break; }
            await new Promise((ok) => setTimeout(ok, 10_000));
          }
        }
        if (got) {
          finish({ status: "ready", note: null, name: job.name || (got.look && got.look.name) || "", result: { lookId: got.lookId || null, look: got.look || null, spec: got.spec, warnings: got.warnings || [] } });
          return;
        }
        if (refusal && refusal.retryable === true && !job.lean && left() >= SS_DOOR_LEAN_MIN_LEFT_MS) { set({ lean: true, fresh: true, note: "Trying once more, a quicker way" }); continue; }
        finish({ status: "failed", note: null, error: (refusal && refusal.error) || "We couldn't draw this door. Try again." });
        return;
      }
    } catch (e) {
      if (mine() && !leaving) finish({ status: "failed", note: null, error: e.message || "Something went wrong. Try again." });
    }
  }
  return {
    get: () => job,
    review: () => review,
    subscribe: (f) => { subs.add(f); return () => subs.delete(f); },
    // false when a press is already running (one at a time).
    start(o) {
      if (job && job.status === "running") return false;
      job = {
        id: "j" + Date.now().toString(36), clientId: o.clientId || null, target: o.target || null,
        key: "dl" + Date.now().toString(36) + Math.random().toString(36).slice(2, 12),
        name: o.name, widthIn: o.widthIn, heightIn: o.heightIn, leaves: o.leaves, startedAt: Date.now(),
        sent: false, body: null, lean: false, fresh: false, status: "running", note: null, result: null, error: null, seen: false,
        straightUrl: o.straightUrl || null,
      };
      save(); emit();
      run(o.blobs);
      return true;
    },
    watch(on) { watching = Math.max(0, watching + (on ? 1 : -1)); emit(); },
    watched: () => watching > 0,
    // The answer has been shown (the dialog took it, or the pop-up was closed): forget the press.
    seen() { if (job && job.status !== "running") { job = { ...job, seen: true }; save(); job = null; emit(); } },
    // "See my door": the Doors page opens it in its review.
    openReview() {
      if (!job || job.status !== "ready") return;
      review = { ...job.result, name: job.name, widthIn: job.widthIn, heightIn: job.heightIn, straightUrl: job.straightUrl || null };
      this.seen();
      emit();
    },
    takeReview() { const r = review; review = null; return r; },
    // The Dashboard, once per client: a press saved by an earlier page of THIS client comes back.
    boot(clientId) {
      if (!clientId || booted === clientId || (job && job.status === "running")) return;
      booted = clientId;
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem(SS_DOOR_JOB_STORE) || "null"); } catch (_e) { saved = null; }
      if (!saved || saved.clientId !== clientId || typeof saved.key !== "string") return;
      job = saved;
      if (job.status === "running") {
        if (!job.sent) {
          // Closed before the photos went up: nothing is being drawn.
          finish({ status: "failed", error: "The page closed before your door started drawing. Make it from your photo again." });
        } else if (Date.now() - job.startedAt > SS_DOOR_PRESS_MS + 5 * 60_000) {
          finish({ status: "failed", error: "This took too long. Look for your door under “Not in your library yet” on the Doors page before you press Generate again." });
        } else {
          job = { ...job, fresh: false };
          emit();
          run([]);
        }
      } else emit();
    },
  };
})();
// Re-render on every change to the press, and once a second while it runs (the clock).
function useSsDoorJob() {
  const [, bump] = useState(0);
  useEffect(() => ssDoorJob.subscribe(() => bump((n) => n + 1)), []);
  const job = ssDoorJob.get();
  const running = !!(job && job.status === "running");
  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(() => bump((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [running]);
  return job;
}
const ssDoorJobClock = (job) => {
  const s = Math.max(0, Math.floor((Date.now() - job.startedAt) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const ssDoorJobStage = (job) => {
  if (job.note) return job.note;
  if (!job.sent) return "Sending your photo";
  const s = (Date.now() - job.startedAt) / 1000;
  return (SS_DOOR_STAGES.filter(([t]) => s >= t).pop() || SS_DOOR_STAGES[0])[1];
};

// The pill while a press runs out of sight, and the pop-up when it is done. On every page: the
// Dashboard mounts it beside its other app-wide pieces.
function SsDoorJobDock({ clientId, onOpenDoors }) {
  const job = useSsDoorJob();
  useEffect(() => { ssDoorJob.boot(clientId); }, [clientId]);
  if (!job || job.clientId !== (clientId || null) || ssDoorJob.watched()) return null;
  const btn = { ...S.btn("#F1F5F9", "#1E293B"), padding: "8px 14px", fontSize: 13 };
  const go = { ...S.btn(DOOR_MINT, "#0F4C46"), padding: "8px 16px", fontSize: 13 };
  if (job.status === "running") {
    return (
      <button type="button" data-ss-door-job-pill="1" onClick={onOpenDoors} title="Open the Doors page"
        style={{ position: "fixed", left: "50%", bottom: 20, transform: "translateX(-50%)", zIndex: 1150, display: "flex", alignItems: "center", gap: 10,
          background: "#0F4C5C", color: "#FFF", border: "none", borderRadius: 999, padding: "9px 16px", boxShadow: "0 6px 20px rgba(15,23,42,0.28)", cursor: "pointer", fontSize: 13, maxWidth: "calc(100vw - 32px)" }}>
        <span aria-hidden="true" style={{ width: 9, height: 9, borderRadius: "50%", background: DOOR_MINT, boxShadow: "0 0 0 3px rgba(117,230,218,0.3)", flexShrink: 0 }} />
        <span style={{ fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{job.name ? <>Drawing &ldquo;{job.name}&rdquo;…</> : "Drawing your door…"}</span>
        <span style={{ fontVariantNumeric: "tabular-nums", opacity: 0.85 }}>{ssDoorJobClock(job)}</span>
      </button>
    );
  }
  const ready = job.status === "ready";
  return (
    <div role="dialog" aria-modal="true" aria-label={ready ? "Your 3D door is ready" : "We couldn't draw your door"}
      data-ss-door-job-ready={ready ? "1" : undefined} data-ss-door-job-failed={ready ? undefined : "1"}
      onClick={(e) => { if (e.target === e.currentTarget) ssDoorJob.seen(); }}
      style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)", zIndex: 1250, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ background: "#FFF", borderRadius: 14, padding: 20, maxWidth: 420, width: "100%", boxShadow: "0 12px 40px rgba(15,23,42,0.3)" }}>
        <div style={{ fontWeight: 800, fontSize: 17, color: "#0F172A", marginBottom: 6 }}>{ready ? "Your 3D door is ready" : "We couldn't draw your door"}</div>
        <div style={{ fontSize: 13.5, color: "#475569", lineHeight: 1.55 }}>
          {ready ? <>{job.name ? <>&ldquo;{job.name}&rdquo;</> : "Your door"} is drawn from your photo. Check it, then save it to your library.</> : (job.error || "Try again.")}
        </div>
        {!ready && <div style={{ fontSize: 12.5, color: "#64748B", marginTop: 6 }}>You can make it from the photo again on the Doors page.</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
          <button type="button" style={btn} onClick={() => ssDoorJob.seen()}>{ready ? "Later" : "Close"}</button>
          <button type="button" style={go} onClick={() => { if (ready) ssDoorJob.openReview(); else ssDoorJob.seen(); onOpenDoors(); }}>
            {ready ? "See my door" : "Go to Doors"}
          </button>
        </div>
      </div>
    </div>
  );
}

// The flow itself, in a dialog: the photo, the corners, the press, the review, saved.
function SsDoorStudio({ call, scoped, money, ai, resume, onClose, onSaved }) {
  // Hooks first, every one of them, above every early return (React #310 otherwise).
  const [step, setStep] = useState(resume ? "review" : "photo");   // photo | corners | press | review | saved
  const [name, setName] = useState(resume ? resume.name : "");
  const [leaves, setLeaves] = useState(resume && resume.spec && resume.spec.src && resume.spec.src.leaves === 2 ? 2 : 1);
  const [widthIn, setWidthIn] = useState(resume && resume.widthIn ? String(resume.widthIn) : "");
  const [heightIn, setHeightIn] = useState(resume && resume.heightIn ? String(resume.heightIn) : "");
  const [front, setFront] = useState(null);     // the chosen file
  const [img, setImg] = useState(null);
  const [quad, setQuad] = useState(null);
  const [closeUps, setCloseUps] = useState({}); // { hinge, handle, meet }: files
  // { blob, url, size }; a press picked up from the background brings its photo's url only.
  const [straight, setStraight] = useState(resume && resume.straightUrl ? { blob: null, url: resume.straightUrl, size: null } : null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(resume ? { lookId: resume.lookId, look: resume.look || null, spec: resume.spec, warnings: resume.warnings || [] } : null);
  const [shots, setShots] = useState(null);     // [{ view, url }] or "failed"
  const [saved, setSaved] = useState(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  // The press is ssDoorJob's (above every page); this dialog only watches the one it started.
  const job = useSsDoorJob();
  const myJob = useRef(null);
  useEffect(() => {
    if (step !== "press") return undefined;
    ssDoorJob.watch(true);
    return () => ssDoorJob.watch(false);
  }, [step]);
  useEffect(() => {
    if (step !== "press" || !job || job.id !== myJob.current || job.status === "running") return;
    if (job.status === "ready") {
      const r = job.result;
      setDraft({ lookId: r.lookId, look: r.look, spec: r.spec, warnings: r.warnings || [] });
      if (!name.trim() && r.look && r.look.name) setName(r.look.name);
      setStep("review");
    } else {
      setErr(job.error);
      setStep("corners");
    }
    ssDoorJob.seen();
  }, [job, step]);
  const otherRunning = !!(job && job.status === "running" && job.id !== myJob.current);
  // "Keep working": the press carries on above the page; the pill and the pop-up take it from here.
  const toBackground = () => { if (onClose) onClose(); };
  useEffect(() => {
    if (!front) { setImg(null); return undefined; }
    let gone = false;
    ssDoorLoadImage(front).then((im) => {
      if (gone) return;
      setImg(im);
      const w = im.naturalWidth, h = im.naturalHeight, ix = w * 0.18, iy = h * 0.1;
      setQuad([[ix, iy], [w - ix, iy], [w - ix, h - iy], [ix, h - iy]]);
    }).catch((e) => { if (!gone) setErr(e.message); });
    return () => { gone = true; };
  }, [front]);
  // The drawn door, once there is a draft: front, 35° left and right, from the designer's own renderer.
  useEffect(() => {
    if (!draft || !draft.spec) return undefined;
    let gone = false;
    setShots(null);
    const w = Number(widthIn) || (resume && resume.widthIn) || 36, h = Number(heightIn) || (resume && resume.heightIn) || 80;
    window.ssLoadDesigner()
      .then(() => (typeof window.ssRenderDoorLookShots === "function" ? window.ssRenderDoorLookShots({ spec: draft.spec, widthIn: w, heightIn: h }) : null))
      .then((s) => { if (!gone) setShots(s && s.length ? s : "failed"); })
      .catch(() => { if (!gone) setShots("failed"); });
    return () => { gone = true; };
  }, [draft]);

  const W = Number(widthIn), H = Number(heightIn);
  const sizeOk = W >= 12 && W <= 240 && H >= 24 && H <= 192;
  const priceLine = !money ? null
    : money.exempt ? "Free on your account."
    : !money.meterActive ? "Free right now."
    : money.priceCents != null ? `${(money.priceCents / 100).toFixed(2)} a door, taken from your wallet only when we draw one.`
    : null;

  const toCorners = () => {
    setErr(null);
    if (!sizeOk) { setErr("Type the door's width (12 to 240 in) and height (24 to 192 in)."); return; }
    if (!front) { setErr("Add a photo of the door first."); return; }
    setStep("corners");
  };
  const straighten = async () => {
    setErr(null);
    const chk = ssDoorQuadCheck(quad, W, H, !!closeUps.hinge);
    if (!chk.ok) { setErr(chk.error); return; }
    setBusy(true);
    try {
      const size = ssDoorPreparedSize(quad, W, H);
      const c = ssDoorWarp(img, quad, size, ssDoorEdgePadPx(size[0], W));
      const blob = c ? await ssDoorBlob(c) : null;
      if (!blob) { setErr("We couldn't straighten this photo. Try another one."); return; }
      setStraight({ blob, url: URL.createObjectURL(blob), size });
    } finally { setBusy(false); }
  };

  // ── The press: handed to ssDoorJob, which outlives this dialog ──────────────────────────────
  const generate = async () => {
    setErr(null);
    if (otherRunning) { setErr("Another door is being drawn. Wait for it to finish, then press Generate again."); return; }
    setBusy(true);
    try {
      const kinds = ["front", ...["hinge", "handle", "meet"].filter((k) => closeUps[k] && (k !== "meet" || leaves === 2))];
      const blobs = [{ kind: "front", blob: straight.blob }];
      for (const k of kinds.slice(1)) blobs.push({ kind: k, blob: await ssDoorReencode(closeUps[k]) });
      const t = scoped({});
      const started = ssDoorJob.start({ clientId: ssResolvedClientId, target: t.targetClientId || null, name: name.trim(), widthIn: W, heightIn: H, leaves, blobs, straightUrl: straight.url });
      if (!started) { setErr("Another door is being drawn. Wait for it to finish, then press Generate again."); return; }
      myJob.current = ssDoorJob.get().id;
      setStep("press");
    } catch (e) {
      setErr(e.message || "Something went wrong. Try again.");
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  // ── Save: the look Ready with our front render as its tile, then into the library ─────────────
  const save = async () => {
    setErr(null);
    const nm = name.trim().replace(/\s+/g, " ");
    if (!nm || nm.length > 60) { setErr("Give the door a name of 1 to 60 characters."); return; }
    setBusy(true);
    try {
      let thumbPath;
      const frontShot = Array.isArray(shots) ? shots.find((s) => s.view === "front") : null;
      if (frontShot) {
        const blob = await (await fetch(frontShot.url)).blob();
        const t = await call({ action: "door_look_thumb_upload_url" });
        const { error } = await sb.storage.from("fixtures").uploadToSignedUrl(t.path, t.token, blob, { contentType: "image/png" });
        if (!error) thumbPath = t.path;
      }
      let look = draft.look;
      if (draft.lookId && !(look && look.version)) {
        const l = await call({ action: "list_door_looks" });
        look = (l.looks || []).find((x) => x.id === draft.lookId) || null;
      }
      const saveBody = draft.lookId && look
        ? { action: "save_door_look", id: draft.lookId, version: look.version, name: nm, ...(thumbPath ? { thumbPath } : {}) }
        : { action: "save_door_look", name: nm, spec: draft.spec, ...(thumbPath ? { thumbPath } : {}) };
      const s = await call(saveBody);
      const add = await call({ action: "library_add", doorLookId: s.look.id, name: nm });
      if (!alive.current) return;
      setSaved(add.entry);
      setStep("saved");
      if (onSaved) onSaved(add.entry);
    } catch (e) { if (alive.current) setErr(e.message); }
    finally { if (alive.current) setBusy(false); }
  };

  const btn = { ...S.btn("#F1F5F9", "#1E293B"), padding: "8px 14px", fontSize: 13 };
  const go = { ...S.btn(DOOR_MINT, "#0F4C46"), padding: "8px 16px", fontSize: 13 };
  const title = { photo: "Make your door from a photo", corners: "Mark the door's corners", press: "Drawing your door", review: "Check your 3D door", saved: "Saved to your library" }[step];
  return (
    <div role="dialog" aria-modal="true" aria-label={title} data-ss-door-studio={step}
      onClick={(e) => { if (step === "press" && e.target === e.currentTarget) toBackground(); }}
      style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.72)", zIndex: 1200, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ background: "#FFF", borderRadius: 14, padding: 20, maxWidth: step === "review" ? 980 : 640, width: "100%", maxHeight: "92vh", overflowY: "auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <div style={{ fontWeight: 800, fontSize: 17, color: "#0F172A", flex: 1 }}>{title}</div>
          {step !== "press" && <button type="button" onClick={onClose} aria-label="Close" style={{ ...btn, padding: "4px 10px" }}>✕</button>}
        </div>
        {err && <div style={S.err} data-ss-door-error="1">{err}</div>}

        {step === "photo" && (
          <div style={{ display: "grid", gap: 12 }}>
            <p style={{ margin: 0, fontSize: 13, color: "#475569", lineHeight: 1.55 }}>
              Stand straight in front of the door. Close it. Get the whole door in, and show both doors on a double. Move anything that's in front of it.
            </p>
            <label style={{ fontSize: 12.5, color: "#334155", fontWeight: 700 }}>Name
              <input type="text" value={name} maxLength={60} placeholder="e.g. Ranch barn door" onChange={(e) => setName(e.target.value)} style={{ ...S.input, marginTop: 4 }} />
            </label>
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "flex-end" }}>
              <div style={{ fontSize: 12.5, color: "#334155", fontWeight: 700 }}>Door
                <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                  {[[1, "Single"], [2, "Double"]].map(([n, t]) => (
                    <button key={n} type="button" aria-pressed={leaves === n} onClick={() => setLeaves(n)}
                      style={{ ...btn, background: leaves === n ? "#DBEAFE" : "#F1F5F9", border: leaves === n ? "1px solid #1D4ED8" : "1px solid transparent" }}>{t}</button>
                  ))}
                </div>
              </div>
              <label style={{ fontSize: 12.5, color: "#334155", fontWeight: 700 }}>Width (in)
                <input type="number" min="12" max="240" value={widthIn} onChange={(e) => setWidthIn(e.target.value)} style={{ ...S.input, width: 110, marginTop: 4 }} aria-label="Width in inches" />
              </label>
              <label style={{ fontSize: 12.5, color: "#334155", fontWeight: 700 }}>Height (in)
                <input type="number" min="24" max="192" value={heightIn} onChange={(e) => setHeightIn(e.target.value)} style={{ ...S.input, width: 110, marginTop: 4 }} aria-label="Height in inches" />
              </label>
            </div>
            <div style={{ border: "1px dashed #94A3B8", borderRadius: 10, padding: 12, background: "#F8FAFC" }}>
              <div style={{ fontWeight: 800, fontSize: 13.5, marginBottom: 6 }}>Photo of the closed door</div>
              <label style={{ ...btn, display: "inline-block" }}>
                {front ? "Use a different photo" : "Choose a photo"}
                <input type="file" accept="image/jpeg,image/png,image/webp,image/avif,.avif" data-ss-door-front="1" style={{ display: "none" }}
                  onChange={(e) => { const f = e.target.files && e.target.files[0]; if (f) { setFront(f); setStraight(null); setErr(null); } e.target.value = ""; }} />
              </label>
              {front && <span style={{ marginLeft: 10, fontSize: 12.5, color: "#15803D", fontWeight: 700 }}>✓ {front.name}</span>}
              <div style={{ fontSize: 12.5, color: "#64748B", marginTop: 10 }}>Close-ups help, but you can skip them:</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
                {[["hinge", "A hinge"], ["handle", "The handle"], ...(leaves === 2 ? [["meet", "Where the doors meet"]] : [])].map(([k, t]) => (
                  <label key={k} style={{ ...btn, padding: "5px 10px", fontSize: 12, display: "inline-block" }}>
                    {closeUps[k] ? "✓ " : "+ "}{t}
                    <input type="file" accept="image/jpeg,image/png,image/webp,image/avif,.avif" data-ss-door-closeup={k} style={{ display: "none" }}
                      onChange={(e) => { const f = e.target.files && e.target.files[0]; if (f) setCloseUps((c) => ({ ...c, [k]: f })); e.target.value = ""; }} />
                  </label>
                ))}
              </div>
            </div>
            {priceLine && <div style={{ fontSize: 12.5, color: "#475569" }} data-ss-door-price="1">{priceLine}</div>}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button type="button" style={btn} onClick={onClose}>Cancel</button>
              <button type="button" style={go} onClick={toCorners}>Next: mark the corners</button>
            </div>
          </div>
        )}

        {step === "corners" && img && quad && (
          <div style={{ display: "grid", gap: 12 }}>
            {!straight ? <SsDoorCorners img={img} quad={quad} setQuad={setQuad} /> : (
              <div style={{ display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
                <img src={straight.url} alt="Your door, straightened" data-ss-door-straight="1" style={{ maxHeight: 360, maxWidth: "100%", borderRadius: 6, border: "1px solid #CBD5E1" }} />
                <div style={{ flex: "1 1 200px", fontSize: 13, color: "#475569", lineHeight: 1.55 }}>
                  This is the photo we'll read: your door, squared up, with a little of what's beside it showing on each side.
                  If the door's edges aren't at the sides of the picture, move the dots again.
                </div>
              </div>
            )}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
              <button type="button" style={btn} onClick={() => { setStraight(null); setStep("photo"); }}>Back</button>
              {!straight && <button type="button" style={go} disabled={busy} onClick={straighten}>{busy ? "Straightening…" : "Straighten"}</button>}
              {straight && <button type="button" style={btn} onClick={() => setStraight(null)}>Move the dots again</button>}
              {straight && <button type="button" style={go} disabled={busy || !ai || otherRunning} onClick={generate} data-ss-door-generate="1">Generate my 3D door</button>}
            </div>
            {straight && !ai && <div style={{ fontSize: 12.5, color: "#92400E" }}>Making doors from photos is turned off right now. Try again later.</div>}
            {straight && ai && otherRunning && <div style={{ fontSize: 12.5, color: "#92400E" }}>We&rsquo;re still drawing &ldquo;{job.name || "your other door"}&rdquo;. You can press Generate once it&rsquo;s ready.</div>}
          </div>
        )}

        {step === "press" && (
          <div style={{ display: "grid", gap: 12, justifyItems: "center", padding: "18px 0" }} aria-live="polite">
            <SkelBar />
            <div style={{ fontWeight: 700, fontSize: 14, color: "#1E293B" }} data-ss-door-stage="1">
              {job && job.id === myJob.current ? ssDoorJobStage(job) : SS_DOOR_STAGES[0][1]}…
              {job && job.id === myJob.current && <span style={{ fontWeight: 600, color: "#64748B", marginLeft: 8, fontVariantNumeric: "tabular-nums" }}>{ssDoorJobClock(job)}</span>}
            </div>
            <div style={{ fontSize: 12.5, color: "#64748B", textAlign: "center", maxWidth: 420 }}>
              This usually takes 1 to 6 minutes, and never more than 8. You can keep working: we&rsquo;ll tell you when it&rsquo;s ready.
            </div>
            <button type="button" onClick={toBackground} data-ss-door-background="1"
              style={{ ...S.btn("#F1F5F9", "#1E293B"), padding: "8px 14px", fontSize: 13 }}>Keep working, run it in the background</button>
          </div>
        )}

        {step === "review" && draft && (
          <div style={{ display: "grid", gap: 12 }}>
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "flex-start" }}>
              {straight && (
                <figure style={{ margin: 0, textAlign: "center" }}>
                  <img src={straight.url} alt="Your photo" style={{ height: 340, maxWidth: "100%", borderRadius: 6, border: "1px solid #CBD5E1" }} />
                  <figcaption style={{ fontSize: 12, color: "#64748B" }}>Your photo</figcaption>
                </figure>
              )}
              {shots === null && <div style={{ width: 240, height: 340, display: "flex", alignItems: "center", justifyContent: "center", background: "#F1F5F9", borderRadius: 6, fontSize: 12.5, color: "#64748B" }}>Drawing it in 3D…</div>}
              {shots === "failed" && <div style={{ width: 240, height: 340, display: "flex", alignItems: "center", justifyContent: "center", background: "#FEF2F2", borderRadius: 6, fontSize: 12.5, color: "#B91C1C", padding: 10, textAlign: "center" }}>We couldn't draw the 3D preview on this device. You can still save it and see it in the designer.</div>}
              {Array.isArray(shots) && shots.map((s) => (
                <figure key={s.view} style={{ margin: 0, textAlign: "center" }}>
                  <img src={s.url} alt={`Our 3D door, ${s.view === "front" ? "straight on" : s.view === "left35" ? "from the left" : "from the right"}`} data-ss-door-shot={s.view}
                    style={{ height: s.view === "front" ? 340 : 250, maxWidth: "100%", borderRadius: 6, border: "1px solid #CBD5E1" }} />
                  <figcaption style={{ fontSize: 12, color: "#64748B" }}>{s.view === "front" ? "Our 3D door" : s.view === "left35" ? "From the left" : "From the right"}</figcaption>
                </figure>
              ))}
            </div>
            {(draft.warnings || []).length > 0 && (
              <div style={{ background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 8, padding: "8px 12px", fontSize: 13, color: "#92400E" }} data-ss-door-warnings="1">
                <div style={{ fontWeight: 800, marginBottom: 4 }}>Check these before you save</div>
                <ul style={{ margin: 0, paddingLeft: 18 }}>{draft.warnings.map((w, i) => <li key={i}>{typeof w === "string" ? w : (w && (w.text || w.message)) || ""}</li>)}</ul>
              </div>
            )}
            <label style={{ fontSize: 12.5, color: "#334155", fontWeight: 700, maxWidth: 360 }}>Name it
              <input type="text" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} style={{ ...S.input, marginTop: 4 }} data-ss-door-name="1" />
            </label>
            <div style={{ fontSize: 12.5, color: "#64748B" }}>Saving puts it in your library. Then pick it in any door&rsquo;s <b>How it looks in 3D</b>; it follows that door&rsquo;s colours.</div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
              <button type="button" style={btn} onClick={onClose}>Not now</button>
              {front && <button type="button" style={btn} onClick={() => { setDraft(null); setShots(null); setStraight(null); setStep("corners"); }}>Try another photo</button>}
              <button type="button" style={go} disabled={busy || shots === null} onClick={save} data-ss-door-save="1">{busy ? "Saving…" : "Save to my library"}</button>
            </div>
          </div>
        )}

        {step === "saved" && saved && (
          <div style={{ display: "grid", gap: 12 }}>
            <div style={S.okMsg} data-ss-door-saved="1">&ldquo;{saved.name}&rdquo; is in your library. Pick it in any door&rsquo;s <b>How it looks in 3D</b> below.</div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}><button type="button" style={go} onClick={onClose}>Done</button></div>
          </div>
        )}
      </div>
    </div>
  );
}

// The box on the Library card's right: the way in, and any door drafted from a photo that is not in the
// library yet (a press whose page was closed, or a draft not saved), so a paid draft is never lost.
function SsDoorFromPhoto({ call, scoped, money, ai, entries, openKey = 0, onSaved }) {
  const [open, setOpen] = useState(null);       // null | { resume? }
  const [looks, setLooks] = useState(null);
  const loadLooks = async () => {
    try { const d = await call({ action: "list_door_looks" }); setLooks(d.looks || []); } catch (_) { setLooks([]); }
  };
  useEffect(() => { loadLooks(); }, []);
  useEffect(() => { if (openKey) setOpen({}); }, [openKey]);
  // A press running above the page: its line here, a fresh list once it is done, and the review the
  // pop-up's "See my door" asked for.
  const job = useSsDoorJob();
  const jobStatus = job ? job.status : null;
  useEffect(() => { if (jobStatus && jobStatus !== "running") loadLooks(); }, [jobStatus]);
  useEffect(() => {
    const r = ssDoorJob.takeReview();
    if (r) { loadLooks(); setOpen({ resume: { lookId: r.lookId, look: r.look, spec: r.spec, name: r.name, warnings: r.warnings || [], widthIn: r.widthIn, heightIn: r.heightIn, straightUrl: r.straightUrl } }); }
  }, [job]);
  const inLibrary = new Set((entries || []).filter((e) => e.category === "door" && e.look && e.look.doorLookId).map((e) => e.look.doorLookId));
  const waiting = (looks || []).filter((l) => l.fromPhoto && !inLibrary.has(l.id)).slice(0, 3);
  return (
    <div data-ss-door-from-photo="1" style={{ flex: "0 1 320px", minWidth: 240, border: "1px solid #BFE3EA", background: "#F0FAFC", borderRadius: 12, padding: "12px 14px" }}>
      <div style={{ fontWeight: 800, fontSize: 14, color: "#0F4C5C" }}>Don&rsquo;t see your door?</div>
      <div style={{ fontSize: 12.5, color: "#335B66", lineHeight: 1.5, margin: "4px 0 10px" }}>
        Upload a photo of it and we&rsquo;ll draw it in 3D, with its boards, braces, hinges and handle. It goes into your library.
      </div>
      <button type="button" onClick={() => setOpen({})} data-ss-door-open="1" style={{ ...S.btn("#1B7895", "#FFF"), padding: "8px 14px", fontSize: 13 }}>Make it from a photo</button>
      {!ai && <div style={{ fontSize: 12, color: "#92400E", marginTop: 8 }}>Making doors from photos is turned off right now.</div>}
      {job && job.status === "running" && !open && (
        <div data-ss-door-job-line="1" style={{ fontSize: 12.5, color: "#0F4C5C", marginTop: 8, lineHeight: 1.45 }}>
          Drawing &ldquo;{job.name || "your door"}&rdquo;… <span style={{ fontVariantNumeric: "tabular-nums" }}>{ssDoorJobClock(job)}</span>. We&rsquo;ll tell you when it&rsquo;s ready.
        </div>
      )}
      {waiting.length > 0 && (
        <div style={{ marginTop: 10, borderTop: "1px solid #CFE8EE", paddingTop: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: "#0F4C5C" }}>Not in your library yet</div>
          {waiting.map((l) => (
            <div key={l.id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5, marginTop: 6 }} data-ss-door-waiting={l.name}>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.name}</span>
              <button type="button" style={{ ...S.btn("#FFF", "#0F4C5C"), padding: "3px 10px", fontSize: 12, border: "1px solid #9FD3DE" }}
                onClick={() => setOpen({ resume: { lookId: l.id, look: l, spec: l.spec, name: l.name, warnings: [] } })}>Review</button>
            </div>
          ))}
        </div>
      )}
      {open && (
        <SsDoorStudio call={call} scoped={scoped} money={money} ai={ai} resume={open.resume || null}
          onClose={() => { setOpen(null); loadLooks(); }}
          onSaved={(entry) => { loadLooks(); if (onSaved) onSaved(entry); }} />
      )}
    </div>
  );
}

function SsLibrarySection({ category, viewingLabel = null, clientId = null, onChanged = null }) {
  // Hooks first, every one of them, above every early return (React #310 otherwise).
  const scoped = (body) => (viewingLabel && clientId ? { ...body, targetClientId: clientId } : body);
  const [on, setOn] = useState(null);           // null = still asking the catalog; false = flag off
  const [lib, setLib] = useState(null);         // { templates, entries, requests, requestPrice }
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(null);
  const [browse, setBrowse] = useState(false);
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(null);   // { template, name, look }
  const [editing, setEditing] = useState(null); // { id, name, look }
  const [reqOpen, setReqOpen] = useState(false);
  const [reqDraft, setReqDraft] = useState(null);
  // Doors only: "make it from a photo" (door looks, P6), when client_settings.door_looks_beta is on.
  // null = off; { ai, money } = on (ai: the kill switch; money: the door meter's line).
  const [doorGen, setDoorGen] = useState(null);
  const [photoOpenKey, setPhotoOpenKey] = useState(0);
  const seeded = useRef(false);
  const rootRef = useRef(null);
  const noun = SS_LIB_NOUN[category];

  const call = async (body) => {
    const { data, error } = await sb.functions.invoke("portal-settings", { body: scoped(body) });
    if (error || (data && data.error)) throw new Error((error && error.message) || data.error);
    return data;
  };
  const load = async () => {
    const body = scoped({ action: "catalog" });
    const cat = await window.__ssCatalogFlight(
      () => sb.functions.invoke("portal-settings", { body }),
      String(body.targetClientId == null ? (ssTargetClientId || "") : body.targetClientId));
    if (!cat || cat.error || !cat.data || cat.data.libraryBeta !== true) { setOn(false); return; }
    setOn(true);
    setDoorGen(category === "door" && cat.data.doorLooksBeta === true ? { ai: cat.data.doorLookAiOn === true, money: cat.data.doorWallet || null } : null);
    try {
      let d = await call({ action: "library" });
      // First open: copy in what the builder uses today, so their rows keep working (Ahsan
      // 2026-10-27). Once only, and only while the library is empty; it creates nothing twice.
      if (!seeded.current && !(d.entries || []).length) {
        seeded.current = true;
        try { await call({ action: "library_seed_mine" }); d = await call({ action: "library" }); if (onChanged) onChanged(); }
        catch (_s) { /* a view-only login cannot seed; the empty library says so below */ }
      }
      setLib(d);
    } catch (e) { setMsg({ err: e.message }); }
  };
  useEffect(() => { load(); }, []);
  // "Find more in the library..." in a door's or a window's look picker opens this card.
  useEffect(() => {
    const open = (ev) => {
      if (!ev || !ev.detail || ev.detail.category !== category) return;
      if (ev.detail.photo) setPhotoOpenKey((n) => n + 1);
      else setBrowse(true);
      if (rootRef.current) rootRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    window.addEventListener("ss:library-open", open);
    return () => window.removeEventListener("ss:library-open", open);
  }, [category]);

  // Nothing until the catalog has said the flag is on, so a builder without the library never sees a
  // card appear and then go (it did, with a loading bar, until 2026-10-27).
  if (on !== true) return null;
  if (!lib) {
    return <div style={S.card} ref={rootRef}><div style={S.h2}>Library</div>{msg && msg.err ? <div style={S.err}>{msg.err}</div> : <SkelBar />}</div>;
  }

  const mine = (lib.entries || []).filter((e) => e.category === category);
  const needle = q.trim().toLowerCase();
  const hit = (t) => !needle || [t.name, t.description || "", ...(t.searchTerms || [])].some((s) => String(s).toLowerCase().includes(needle));
  const templates = (lib.templates || []).filter((t) => t.category === category && hit(t));
  const requests = (lib.requests || []).filter((r) => r.category === category);
  const price = lib.requestPrice;
  const priceLine = !price ? null
    : price.exempt ? "Requests are free on your account."
    : !price.active ? "Requests are free right now."
    : price.priceCents != null ? `A request costs $${(price.priceCents / 100).toFixed(2)}, taken from your wallet when you send it, and credited back if we can't build it or you cancel before we start.`
    : null;

  const run = async (key, fn, ok) => {
    setBusy(key); setMsg(null);
    try { await fn(); await load(); if (onChanged) onChanged(); if (ok) setMsg({ ok }); }
    catch (e) { setMsg({ err: e.message }); }
    setBusy(null);
  };
  const addEntry = () => run("add", async () => {
    // A promoted door (347) is copied with its own look; the server takes no look for it.
    await call({ action: "library_add", templateId: adding.template.id, name: adding.name, ...(adding.template.fromPhoto ? {} : { look: adding.look }) });
    setAdding(null);
  }, `Imported. Pick it on your ${noun === "cladding" ? "styles" : noun + "s"} below.`);
  const saveEdit = () => run("edit:" + editing.id, async () => {
    await call({ action: "library_edit", id: editing.id, name: editing.name, look: editing.look });
    setEditing(null);
  }, "Saved. Everything using it now shows the change.");
  const remove = (e) => run("rm:" + e.id, () => call({ action: "library_remove", id: e.id }), `Removed "${e.name}".`);
  const cancelReq = (r) => run("cx:" + r.id, () => call({ action: "library_request_cancel", id: r.id }), "Request cancelled." + (r.chargedCents ? " It was credited back to your wallet." : ""));

  const openRequest = () => {
    setReqDraft({ name: "", widthIn: "", heightIn: "", supplierUrl: "", notes: "", photos: [], key: "lr" + Math.random().toString(36).slice(2, 12) + Date.now().toString(36), uploading: false });
    setReqOpen(true);
  };
  const addPhotos = async (files) => {
    const list = Array.from(files || []).slice(0, Math.max(0, 4 - reqDraft.photos.length));
    if (!list.length) return;
    setReqDraft((d) => ({ ...d, uploading: true })); setMsg(null);
    try {
      const added = [];
      for (const f of list) {
        // An AVIF (or anything else the browser opens that isn't JPEG, PNG or WebP) goes up as a
        // JPEG: a small one would otherwise go up untouched, labelled image/jpeg.
        const plain = ["image/jpeg", "image/png", "image/webp"].includes(f.type);
        const fit = plain ? await ssFitImageForUpload(f).catch(() => f)
          : new File([await ssDoorReencode(f).catch(() => { throw new Error((f.name || "That photo") + " could not be opened. Try a JPG or PNG."); })], "photo.jpg", { type: "image/jpeg" });
        const file = fit && fit.size ? fit : f;
        const ct = ["image/jpeg", "image/png", "image/webp"].includes(file.type) ? file.type : "image/jpeg";
        const up = await call({ action: "library_request_upload_url", contentType: ct });
        const { error } = await sb.storage.from("library-refs").uploadToSignedUrl(up.path, up.token, file, { contentType: ct });
        if (error) throw new Error("A photo didn't upload: " + error.message);
        added.push({ path: up.path, role: "front", name: f.name, preview: URL.createObjectURL(file) });
      }
      setReqDraft((d) => ({ ...d, photos: [...d.photos, ...added], uploading: false }));
    } catch (e) { setMsg({ err: e.message }); setReqDraft((d) => ({ ...d, uploading: false })); }
  };
  const sendRequest = () => run("req", async () => {
    const d = reqDraft;
    await call({
      action: "library_request", category, name: d.name, widthIn: d.widthIn, heightIn: d.heightIn,
      supplierUrl: d.supplierUrl.trim(), notes: d.notes, idempotencyKey: d.key, photos: d.photos.map((p) => ({ path: p.path, role: p.role })),
    });
    setReqOpen(false); setReqDraft(null);
  }, "Request sent. You'll see it below as we work on it.");

  // THE CARD IS A SEARCH AND A BROWSE BUTTON (Ahsan 2026-10-27: "the library tab should only show a search
  // bar and Browse the StructureStudio library button ... import the template from the library into the
  // subaccount and then user can select the doors in the dropdown of How it looks in 3D"). Importing happens
  // in the list; what is already imported is managed in the same list (Imported as <name>, Rename, Remove),
  // and the pickers on the page below are where imported entries are used. A request for something missing
  // sits at the bottom of the list, with the builder's requests.
  const total = (lib.templates || []).filter((t) => t.category === category).length;
  const templateIds = new Set((lib.templates || []).map((t) => t.id));
  const importedFrom = (t) => mine.filter((e) => e.templateId === t.id);
  // Entries with no live template behind them (a grid the builder already used that no template matches,
  // one CSM made from a request, or one whose template was archived) are listed after the templates.
  const own = mine.filter((e) => !e.templateId || !templateIds.has(e.templateId));
  const ownHits = needle ? own.filter((e) => e.name.toLowerCase().includes(needle)) : own;
  const open = browse || !!needle;
  const usedWords = (e) => (e.usedOn && e.usedOn.length
    ? `used on ${e.usedOn.length}: ${e.usedOn.slice(0, 4).join(", ")}${e.usedOn.length > 4 ? "…" : ""}`
    : "not used yet");
  const rowStyle = { display: "flex", alignItems: "flex-start", gap: 12, padding: "10px 0", borderBottom: "1px solid #F1F5F9", flexWrap: "wrap" };
  const smallBtn = { ...S.btn("#F1F5F9", "#1E293B"), padding: "6px 12px", fontSize: 12.5 };
  const tinyBtn = { ...S.btn("#F1F5F9", "#1E293B"), padding: "3px 10px", fontSize: 12 };
  // One imported entry: its name, how it differs from the template, where it is used, Rename and Remove.
  const entryLine = (e, label) => (editing && editing.id === e.id ? (
    <div key={e.id} data-ss-library-entry={e.name} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
      <input type="text" value={editing.name} maxLength={60} onChange={(ev) => setEditing({ ...editing, name: ev.target.value })} style={{ ...S.input, width: 240 }} aria-label="Name" />
      {!(editing.look && editing.look.doorLookId) && <SsLibLookEdit category={category} look={editing.look} onChange={(look) => setEditing({ ...editing, look })} />}
      <button style={{ ...S.btn(DOOR_MINT, "#0F4C46"), padding: "6px 12px" }} disabled={busy === "edit:" + e.id} onClick={saveEdit}>{busy === "edit:" + e.id ? "Saving…" : "Save"}</button>
      <button style={smallBtn} onClick={() => setEditing(null)}>Cancel</button>
    </div>
  ) : (
    <div key={e.id} data-ss-library-entry={e.name} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 6, fontSize: 12.5, color: "#334155" }}>
      {label && <span style={{ fontWeight: 800, color: "#15803D" }}>✓ {label}</span>}
      <b>{e.name}</b>
      <span style={{ color: "#64748B" }}>· {e.look && e.look.doorLookId && e.templateId ? "From the StructureStudio library, drawn in 3D" : ssLibLookWords(category, e.look)} · {usedWords(e)}</span>
      <button style={tinyBtn} onClick={() => { setEditing({ id: e.id, name: e.name, look: e.look || {} }); setMsg(null); }}>Rename</button>
      <button style={{ ...tinyBtn, color: "#B91C1C" }} disabled={busy === "rm:" + e.id} onClick={() => remove(e)}>{busy === "rm:" + e.id ? "Removing…" : "Remove"}</button>
    </div>
  ));
  return (
    <div style={S.card} ref={rootRef} data-ss-library={category}>
      <div style={{ ...S.h2, display: "flex", alignItems: "center", gap: 8 }}>Library <span style={{ fontSize: 11, fontWeight: 700, color: "#92400E", background: "#FEF3C7", borderRadius: 999, padding: "2px 8px" }}>Beta</span></div>
      <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
      <div style={{ flex: "1 1 420px", minWidth: 0 }}>
      <p style={{ fontSize: 12.5, color: "#64748B", margin: "0 0 12px", maxWidth: 720, lineHeight: 1.5 }}>
        Import {noun === "cladding" ? "claddings" : noun + "s"} from the StructureStudio library under your own names. Everything you import shows up
        {category === "door" && <> in each door&rsquo;s <b>How it looks in 3D</b> below.</>}
        {category === "window" && <> in each window&rsquo;s <b>Grid</b> below.</>}
        {category === "cladding" && <> in each style&rsquo;s <b>Cladding</b> column below.</>}
      </p>
      {msg && msg.err && <div style={S.err}>{msg.err}</div>}
      {msg && msg.ok && <div style={S.okMsg}>{msg.ok}</div>}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the StructureStudio library"
          placeholder={category === "cladding" ? "Search: lap, metal, T1-11, vinyl…" : category === "door" ? "Search: barn, roll-up, pickets…" : "Search: transom, 6 lite, slider…"}
          style={{ ...S.input, maxWidth: 380 }} />
        <button style={smallBtn} onClick={() => { setBrowse((b) => !(b || !!needle)); if (needle) setQ(""); }} aria-expanded={open}>
          {open ? "Hide the StructureStudio library" : `Browse the StructureStudio library (${total})`}
        </button>
      </div>
      </div>
      {doorGen && (
        <SsDoorFromPhoto call={call} scoped={scoped} money={doorGen.money} ai={doorGen.ai} entries={lib.entries || []} openKey={photoOpenKey}
          onSaved={() => { load(); if (onChanged) onChanged(); }} />
      )}
      </div>

      {open && (
        <div style={{ marginTop: 12, border: "1px solid #E2E8F0", borderRadius: 10, padding: "4px 12px 12px" }} data-ss-library-browse="1">
          {!templates.length && !ownHits.length && (
            <div style={{ fontSize: 13, color: "#64748B", padding: "10px 0" }}>Nothing matches “{q}”.{category !== "door" ? " Request it below and we’ll build it." : ""}</div>
          )}
          {templates.map((t) => {
            const imp = importedFrom(t);
            const addingThis = adding && adding.template.id === t.id;
            return (
              <div key={t.id} style={rowStyle} data-ss-library-template={t.name}>
                <SsLibPic category={category} look={addingThis ? adding.look : t.look} thumbUrl={t.fromPhoto ? t.thumbUrl : null} />
                <div style={{ flex: "1 1 320px", minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 13.5, color: "#1E293B" }}>{t.name}</div>
                  <div style={{ fontSize: 12, color: "#64748B", lineHeight: 1.45 }}>{t.description || (t.fromPhoto ? "A door drawn in 3D from a photo" : ssLibLookWords(category, t.look))}</div>
                  {imp.map((e) => entryLine(e, "Imported as"))}
                  {addingThis && (
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
                      <input type="text" value={adding.name} maxLength={60} placeholder="Your name for it" onChange={(e) => setAdding({ ...adding, name: e.target.value })} style={{ ...S.input, width: 240 }} aria-label="Your name for it" />
                      {!t.fromPhoto && <SsLibLookEdit category={category} look={adding.look} onChange={(look) => setAdding({ ...adding, look })} />}
                      <button style={{ ...S.btn(DOOR_MINT, "#0F4C46"), padding: "6px 12px" }} disabled={busy === "add"} onClick={addEntry}>{busy === "add" ? "Importing…" : "Import"}</button>
                      <button style={smallBtn} onClick={() => setAdding(null)}>Cancel</button>
                    </div>
                  )}
                </div>
                {!addingThis && (
                  <button style={smallBtn} onClick={() => { setAdding({ template: t, name: imp.length ? "" : t.name, look: t.look || {} }); setMsg(null); }}>
                    {imp.length ? "Import again" : "Import"}
                  </button>
                )}
              </div>
            );
          })}
          {ownHits.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 12.5, fontWeight: 800, color: "#1E293B" }}>Yours, not from a template</div>
              {ownHits.map((e) => (
                <div key={e.id} style={rowStyle}>
                  <SsLibPic category={category} look={editing && editing.id === e.id ? editing.look : e.look} thumbUrl={e.doorLook ? e.doorLook.thumbUrl : null} />
                  <div style={{ flex: "1 1 320px", minWidth: 0 }}>{entryLine(e, null)}</div>
                </div>
              ))}
            </div>
          )}
          {category === "door" ? (
            <div style={{ fontSize: 12.5, color: "#64748B", marginTop: 10 }}>
              {doorGen
                ? <>Don&rsquo;t see your door? <button type="button" style={{ ...tinyBtn, color: "#0F4C5C" }} onClick={() => setPhotoOpenKey((n) => n + 1)}>Make it from a photo</button></>
                : <>Don&rsquo;t see your door? Making a 3D door from your supplier&rsquo;s photo is coming next.</>}
            </div>
          ) : (
            <div style={{ marginTop: 12 }}>
              {!reqOpen && <button style={smallBtn} onClick={openRequest}>Can&rsquo;t find yours? Request it</button>}
              {reqOpen && reqDraft && (
                <div style={{ border: "1px solid #E2E8F0", borderRadius: 10, padding: 12, background: "#F8FAFC" }} data-ss-library-request-form="1">
                  <div style={{ fontWeight: 800, fontSize: 13.5, marginBottom: 8 }}>Request a {noun}</div>
                  <div style={{ display: "grid", gap: 8, maxWidth: 560 }}>
                    <input type="text" value={reqDraft.name} maxLength={80} placeholder={category === "window" ? "Product name, e.g. Arched top window" : "Product name, e.g. Stone veneer panel"}
                      onChange={(e) => setReqDraft({ ...reqDraft, name: e.target.value })} style={S.input} aria-label="Product name" />
                    {category === "window" && (
                      <div style={{ display: "flex", gap: 8 }}>
                        <input type="number" min="1" max="600" value={reqDraft.widthIn} placeholder="Width (in)" onChange={(e) => setReqDraft({ ...reqDraft, widthIn: e.target.value })} style={{ ...S.input, width: 130 }} aria-label="Width in inches" />
                        <input type="number" min="1" max="600" value={reqDraft.heightIn} placeholder="Height (in)" onChange={(e) => setReqDraft({ ...reqDraft, heightIn: e.target.value })} style={{ ...S.input, width: 130 }} aria-label="Height in inches" />
                      </div>
                    )}
                    <input type="url" value={reqDraft.supplierUrl} placeholder="Link to the product on your supplier's site (https://…)" onChange={(e) => setReqDraft({ ...reqDraft, supplierUrl: e.target.value })} style={S.input} aria-label="Supplier link" />
                    <textarea value={reqDraft.notes} maxLength={2000} rows={3} placeholder="Anything we should know (colours, sizes you sell, how it's installed)" onChange={(e) => setReqDraft({ ...reqDraft, notes: e.target.value })} style={{ ...S.input, resize: "vertical" }} aria-label="Notes" />
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      {reqDraft.photos.map((p) => <img key={p.path} src={p.preview} alt="" style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 6, border: "1px solid #CBD5E1" }} />)}
                      {reqDraft.photos.length < 4 && (
                        <label style={{ ...smallBtn, display: "inline-block" }}>
                          {reqDraft.uploading ? "Uploading…" : "Add photos"}
                          <input type="file" accept="image/jpeg,image/png,image/webp,image/avif,.avif" multiple style={{ display: "none" }} disabled={reqDraft.uploading} onChange={(e) => { addPhotos(e.target.files); e.target.value = ""; }} />
                        </label>
                      )}
                      <span style={{ fontSize: 12, color: "#64748B" }}>A clear, straight-on photo from the supplier&rsquo;s website works best.</span>
                    </div>
                    {priceLine && <div style={{ fontSize: 12.5, color: "#475569" }} data-ss-library-request-price="1">{priceLine}</div>}
                    <div style={{ display: "flex", gap: 8 }}>
                      <button style={S.btn(DOOR_MINT, "#0F4C46")} disabled={busy === "req" || reqDraft.uploading} onClick={sendRequest}>{busy === "req" ? "Sending…" : "Send request"}</button>
                      <button style={smallBtn} onClick={() => { setReqOpen(false); setReqDraft(null); }}>Cancel</button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
          {requests.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12.5, fontWeight: 800, color: "#1E293B", marginBottom: 2 }}>Your requests</div>
              {requests.map((r) => {
                const st = SS_LIB_REQ_STATUS[r.status] || [r.status, "#475569", "#F1F5F9"];
                return (
                  <div key={r.id} style={{ ...rowStyle, alignItems: "center" }} data-ss-library-request={r.name}>
                    <span style={{ fontSize: 11.5, fontWeight: 800, color: st[1], background: st[2], borderRadius: 999, padding: "3px 10px", whiteSpace: "nowrap" }}>{st[0]}</span>
                    <div style={{ flex: "1 1 320px", minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 13.5 }}>{r.name}</div>
                      <div style={{ fontSize: 12, color: "#64748B" }}>
                        Sent {new Date(r.createdAt).toLocaleDateString()}
                        {r.chargedCents ? ` · $${(r.chargedCents / 100).toFixed(2)}${r.refundedCents ? `, $${(r.refundedCents / 100).toFixed(2)} credited back` : ""}` : ""}
                        {r.resultNote ? ` · ${r.resultNote}` : ""}
                      </div>
                    </div>
                    {r.status === "submitted" && <button style={smallBtn} disabled={busy === "cx:" + r.id} onClick={() => cancelReq(r)}>{busy === "cx:" + r.id ? "Cancelling…" : "Cancel"}</button>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Settings → Options → Cladding: the Library card (339) above the per-style table, which re-reads its
// choices when an entry changes. With the library off the card renders nothing and this is the table.
function SsCladdingPage({ viewingLabel = null, clientId = null }) {
  const [libRev, setLibRev] = useState(0);
  return (
    <>
      <SsLibrarySection category="cladding" viewingLabel={viewingLabel} clientId={clientId} onChanged={() => setLibRev((n) => n + 1)} />
      <CladdingView viewingLabel={viewingLabel} clientId={clientId} refreshKey={libRev} />
    </>
  );
}

function CladdingView({ viewingLabel = null, clientId = null, refreshKey = 0 }) {
  // Operator view-as: state the effective tenant explicitly, same as every sibling card here.
  const scoped = (body) => (viewingLabel && clientId ? { ...body, targetClientId: clientId } : body);
  const [cat, setCat] = useState(null);
  const [byStyle, setByStyle] = useState({});
  const [busyId, setBusyId] = useState(null);
  const [msg, setMsg] = useState(null);
  // Can this database hold a lap course size (style_cladding.exposure_in, 275)? portal-settings
  // answers false only before 275, and then the box is hidden rather than offered and lost.
  const [courses, setCourses] = useState(false);
  // The builder's library (339), when client_settings.library_beta is on: each style then lists only
  // what it offers, and the CLADDING column is a dropdown of the builder's own entries (Carolyn
  // 10-26: "This becomes a dropdown from the library, from their library"). null = the table as before.
  const [lib, setLib] = useState(null);

  const load = async () => {
    const body = scoped({ action: "catalog" });
    const { data, error } = await window.__ssCatalogFlight(
      () => sb.functions.invoke("portal-settings", { body }),
      String(body.targetClientId == null ? (ssTargetClientId || "") : body.targetClientId));
    if (error || (data && data.error)) { setMsg({ err: (error && error.message) || data.error }); return; }
    setCat(data);
    setCourses(data.claddingCourses === true);
    const libOn = data.libraryBeta === true && data.library ? data.library : null;
    setLib(libOn);
    const links = (libOn && libOn.claddingLinks) || {};
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
          // The library entry this row offers (339), or null; and whether it was just added here.
          clientLibraryId: (r && links[r.id]) || null,
          added: false,
        };
      });
    });
    setByStyle(m);
  };
  // refreshKey: the Library card above bumps it after an entry changes, so the dropdowns follow.
  useEffect(() => { load(); }, [refreshKey]);

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
      // A cladding just added from the library needs its price: blank would save it as not offered.
      const unpriced = lib ? rows.filter((r) => r.added && String(r.rate == null ? "" : r.rate).trim() === "") : [];
      if (unpriced.length) {
        throw new Error("Nothing was saved — give these a rate (0 = included) or remove them: " + unpriced.map((r) => r.labelOverride || r.builtIn).join(", "));
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
            // The library entry (339), sent only with the library on. Its name and course win on the
            // server; null takes a row off the library.
            ...(lib ? { clientLibraryId: r.clientLibraryId || null } : {}),
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

  // ── The library version of a style's table (339) ──────────────────────────────────────────
  // Only what the style offers (a rate, or a library link, or just added here), each row's cladding a
  // dropdown of the builder's entries OF THAT LOOK (the 207 key allows one row per look per style),
  // and an "Add" dropdown of the entries whose look the style does not offer yet. A row still offered
  // but not on any entry stays visible and is marked, so nothing a customer can buy disappears.
  const libEntries = lib ? (lib.entries || []).filter((e) => e.category === "cladding" && e.active !== false) : [];
  const pickEntry = (styleId, idx, entryId) => {
    const e = libEntries.find((x) => x.id === entryId) || null;
    setByStyle((p) => ({ ...p, [styleId]: (p[styleId] || []).map((r, i) => (i !== idx ? r : e
      ? { ...r, clientLibraryId: e.id, labelOverride: e.name, exposureIn: e.look && e.look.exposureIn != null ? String(e.look.exposureIn) : "" }
      : { ...r, clientLibraryId: null })) }));
  };
  const addFromLibrary = (styleId, entryId) => {
    const e = libEntries.find((x) => x.id === entryId);
    if (!e) return;
    setByStyle((p) => ({ ...p, [styleId]: (p[styleId] || []).map((r) => (r.claddingId !== (e.look && e.look.profile) ? r
      : { ...r, added: true, active: true, clientLibraryId: e.id, labelOverride: e.name, exposureIn: e.look && e.look.exposureIn != null ? String(e.look.exposureIn) : "" })) }));
  };
  const removeFromStyle = (styleId, idx) =>
    setByStyle((p) => ({ ...p, [styleId]: (p[styleId] || []).map((r, i) => (i === idx ? { ...r, rate: "", clientLibraryId: null, added: false } : r)) }));
  const renderLibSection = (st) => {
    const rows = byStyle[st.id] || [];
    const visible = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.added || r.clientLibraryId || String(r.rate == null ? "" : r.rate).trim() !== "");
    const offeredLooks = new Set(visible.map(({ r }) => r.claddingId));
    const addable = libEntries.filter((e) => e.look && !offeredLooks.has(e.look.profile));
    return (
      <div key={st.id} style={{ ...S.card, marginBottom: 12 }} data-ss-cladding-style={st.label}>
        <div style={S.h2}>{st.label}</div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", maxWidth: 860 }}>
            <thead><tr>
              <th style={S.th} title="Picked from your library above. The name is what your customers see.">Cladding</th>
              <th style={S.th} title="The same seven methods the rest of Options uses — the definitions are above the table.">How it&rsquo;s priced</th>
              <th style={S.th} title="0 = included at no charge. Anything else is an upcharge.">Rate (USD)</th>
              <th style={{ ...S.th, textAlign: "center" }} title="Available in the rep designer only — hidden from the customer-facing page.">Internal only</th>
              <th style={{ ...S.th, textAlign: "center" }} title="Untick if you don't charge sales tax on this.">Taxable</th>
              <th style={S.th} />
            </tr></thead>
            <tbody>
              {!visible.length && (
                <tr><td colSpan={6} style={{ ...S.td, color: "#64748B" }}>Nothing offered on this style yet. Add a cladding from your library below.</td></tr>
              )}
              {visible.map(({ r, i }) => {
                const choices = libEntries.filter((e) => e.look && e.look.profile === r.claddingId);
                const entry = r.clientLibraryId ? libEntries.find((e) => e.id === r.clientLibraryId) : null;
                return (
                  <tr key={r.claddingId} data-ss-cladding-row={entry ? entry.name : r.builtIn}>
                    <td style={S.td}>
                      <select value={r.clientLibraryId || ""} onChange={(e) => pickEntry(st.id, i, e.target.value)}
                        aria-label={`${st.label} cladding`} style={{ ...S.input, width: 240 }}>
                        {!r.clientLibraryId && <option value="">{(r.labelOverride || r.builtIn) + " (not in your library)"}</option>}
                        {choices.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                      </select>
                      <div style={{ fontSize: 11.5, color: entry ? "#64748B" : "#B45309", marginTop: 4 }}>
                        {entry ? ssLibLookWords("cladding", entry.look) : "Not in your library: pick one, or add it to your library above."}
                      </div>
                    </td>
                    <td style={S.td}>
                      <select value={r.basis} onChange={(e) => setRow(st.id, i, "basis", e.target.value)} style={{ ...S.input, width: 230 }}>
                        {SS_CLADDING_BASES.map(([v, lbl]) => <option key={v} value={v}>{lbl}</option>)}
                      </select>
                    </td>
                    <td style={S.td}>
                      <input type="number" min="0" step="0.01" value={r.rate} placeholder={r.added ? "enter a rate" : "not offered"}
                        aria-label={`${st.label} ${entry ? entry.name : r.builtIn} rate`}
                        onChange={(e) => setRow(st.id, i, "rate", e.target.value)} style={{ ...S.input, width: 120 }} />
                    </td>
                    <td style={{ ...S.td, textAlign: "center" }}>
                      <input type="checkbox" checked={r.internalOnly} onChange={(e) => setRow(st.id, i, "internalOnly", e.target.checked)}
                        style={{ width: 16, height: 16, cursor: "pointer", accentColor: DOOR_MINT }} />
                    </td>
                    <td style={{ ...S.td, textAlign: "center" }}>
                      <input type="checkbox" checked={r.taxable} onChange={(e) => setRow(st.id, i, "taxable", e.target.checked)}
                        style={{ width: 16, height: 16, cursor: "pointer", accentColor: DOOR_MINT }} />
                    </td>
                    <td style={S.td}>
                      <button type="button" title="Stop offering it on this style" aria-label={`Remove from ${st.label}`} onClick={() => removeFromStyle(st.id, i)}
                        style={{ background: "none", border: "none", color: "#94A3B8", fontSize: 18, cursor: "pointer", padding: 0 }}>×</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          {addable.length > 0 && (
            <select value="" onChange={(e) => addFromLibrary(st.id, e.target.value)} aria-label={`Add a cladding to ${st.label}`} style={{ ...S.input, width: "auto", minWidth: 0 }}>
              <option value="">+ Add a cladding from your library…</option>
              {addable.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          )}
          <button onClick={() => save(st.id, st.label)} disabled={busyId === st.id} style={S.btn(DOOR_MINT, "#0F4C46")}>
            {busyId === st.id ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    );
  };

  const renderSection = (st) => {
    if (lib) return renderLibSection(st);
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
      {lib && (
        <p style={{ fontSize: 12.5, color: "#64748B", margin: "0 0 14px", maxWidth: 680 }} data-ss-cladding-library-intro="1">
          The siding a customer can choose, per building style. Each style lists only what you offer
          there: pick from <b>your library</b> above, set the price, and the customer sees your name for
          it. Enter <b>0</b> and it is included at no charge; anything else is an upcharge.
        </p>
      )}
      {!lib && <p style={{ fontSize: 12.5, color: "#64748B", margin: "0 0 14px", maxWidth: 680 }}>
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
      </p>}
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

// `group` picks which of the catalog's layout items this card prices: "interior" (the
// Interior items tab, the default) or "doors" / "windows", where the two rough openings
// live beside their fixture catalogs (Carolyn 2026-10-12: "Move the Window one on to
// Windows and Door one to Doors"). One component, three mounts — the save action upserts
// per row, so a card that holds only its own group can never touch another's prices.
function LayoutPricing({ viewingLabel = null, clientId = null, group = "interior" }) {
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
    // The interior wall (278's partitionWall) has its own tab since 313 (InteriorWalls), and
    // save_layout_pricing no longer writes it, so it is not listed here either.
    return (data.items || []).filter((it) => it.key !== "ramp" && it.key !== "partitionWall" && (it.paletteGroup || "interior") === group).map((it) => {
      const p = byKey[it.key] || {};
      // An item that stays out of the customer's palette until it is PRICED (171's shelves) starts BLANK rather than 0, and Save leaves a blank one alone: a 0 would be a price, and the
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
      setMsg({ ok: taxable ? "Sales tax will be charged on this option." : "This option is no longer taxed — it appears under the non-taxable subtotal on estimates and invoices." });
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
        {/* "Interior items", not "Options" (Carolyn 2026-09-07). A card called Options, inside
            a tab called Options, inside the Interior group, said nothing about what it holds.
            HEADING ONLY — the component, the save_layout_pricing action and every item_key are
            untouched, so nothing joins on this string. */}
        <div style={S.h2}>{group === "doors" ? "Rough opening (door)" : group === "windows" ? "Rough opening (window)" : "Interior items"}</div>
        {group !== "interior" ? (
          <p style={{ fontSize: 13, color: "#64748B", marginBottom: 14, lineHeight: 1.5 }}>
            A framed hole with no {group === "doors" ? "door" : "window"} in it — the customer places it like any other
            {group === "doors" ? " door" : " window"} and types the size. <b>each</b> = rate × count; the other methods
            work as on the Interior items tab.
          </p>
        ) : (
        <p style={{ fontSize: 13, color: "#64748B", marginBottom: 14, lineHeight: 1.5 }}>
          Set how each item customers can place on the floor plan is priced —
          <b>each</b> = rate × count; <b>lineal ft</b> = rate × total feet; <b>sqft option</b> = rate × option area;
          <b>sqft building</b> = rate × (width × depth); <b>perimeter building</b> = rate × 2 × (width + depth);
          <b>pct building price</b> = (rate ÷ 100) × base building price; <b>pct estimate total</b> = (rate ÷ 100) × subtotal of all other lines, resolved last.
          These rates are used on estimates when you don’t price through your CRM’s products. Building sizes are priced on the <b>Sheds</b> tab.
          <br />Add an optional <b>product image</b> per item — it appears on that line of the customer’s estimate.
        </p>
        )}
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
          <div style={{ fontSize: 13, color: "#64748B" }}>{group === "interior" ? "No placeable items are enabled for your designer yet." : "No rough opening is enabled for your designer."}</div>
        ) : (
          <>
            {/* overflowX wrapper: the method select + rate input enforce ~300px of minimum
                cell width, so on narrow viewports (68px icon rail) the table scrolls inside
                its card instead of forcing page-level horizontal scroll. */}
            <div className="tight" style={{ overflowX: "auto", marginBottom: 14 }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>
                <th style={S.th}>Item</th><th style={S.th}>How it’s priced</th><th style={S.th}>Rate (USD)</th><th style={S.th} title="Wall-mounted items only — how far it stands out from the wall, in inches. This is the depth drawn on the customer's plan.">Depth (in)</th><th style={S.th} title="Wall-mounted items only — how high off the floor it hangs, in inches. It is what lets a shelf sit above a workbench instead of colliding with it.">Height off floor (in)</th><th style={S.th}>Image</th><th style={{ ...S.th, textAlign: "center" }} title="Available in the rep designer only — hidden from customers’ placement buttons on the client-facing page (already-placed items still show).">Internal only</th><th style={{ ...S.th, textAlign: "center" }} title="Untick if you don’t charge sales tax on this option. It then sits under the non-taxable subtotal on estimates and invoices.">Taxable</th><th style={S.th}></th>
              </tr></thead>
              <tbody>
                {rows.map((r) => r).sort((a, b) => (a.archived ? 1 : 0) - (b.archived ? 1 : 0)).map((r) => (
                  <tr key={r.item_key} style={r.archived ? { opacity: 0.55 } : undefined}>
                    <td style={{ ...S.td, fontWeight: 700 }} data-ss-lp-item={r.item_key}>{r.label}{r.archived && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 800, color: "#B45309", background: "#FEF3C7", borderRadius: 4, padding: "1px 6px" }}>Archived</span>}
                      {r.unpriced && <div style={{ fontSize: 11.5, fontWeight: 500, color: "#64748B", marginTop: 2, maxWidth: 240 }}>Not offered yet. Customers see it once you set a rate and save.</div>}
                    </td>
                    <td style={S.td}>
                      <select value={r.pricing_method} onChange={(e) => setRow(r.item_key, "pricing_method", e.target.value)} style={{ ...S.input, width: "auto", minWidth: 170 }}>
                        {LP_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
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
                      <label title="Taxable: sales tax is charged on this option. Untick and it sits under the non-taxable subtotal on estimates and invoices." style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: busy ? "default" : "pointer" }}>
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
              {group === "interior" && (<>
              <button onClick={downloadCsv} disabled={busy || !cat} style={S.btn("#F1F5F9", "#334155")}>⬇ Download CSV</button>
              <label style={{ ...S.btn(busy ? "#9CA3AF" : "#1E293B", "#FFF"), cursor: busy ? "default" : "pointer", display: "inline-block" }}>
                {busy ? "Working…" : "⬆ Upload CSV"}
                <input key={fileKey} type="file" accept=".csv,text/csv" disabled={busy} style={{ display: "none" }} onChange={(e) => onUpload(e.target.files && e.target.files[0])} />
              </label>
              </>)}
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

// ─── Interior walls (migration 313): Settings → Options → Interior walls ───
// Four cards on one Save: framing and price (interior_wall_settings), the builder's own wall
// coverings (interior_wall_coverings, the Electrical card's list pattern), what may go IN a wall
// (rough openings, and the door/window "Allowed in interior walls" tick) and what may go ON one (the
// electrical "Allowed on interior walls" tick). The two tick lists are written column-only by
// save_interior_walls, so this tab never resends either catalog. The wall used to be one row on
// Interior items (278); that card no longer lists it, and nothing is copied from it (Carolyn,
// 2026-10-17): each builder sets interior walls up here, and until this tab is saved no customer or
// rep is offered one. The wall is priced the builder's choice of exactly two ways.
const IW_METHODS = [
  { value: "lineal_ft", label: "Per lineal ft of wall" },
  { value: "sqft_option", label: "Per sq ft of wall" },
];
const IW_COVER_METHODS = [
  { value: "sqft_option", label: "per sq ft of that side" },
  { value: "lineal_ft", label: "per foot of wall" },
  { value: "each", label: "each side" },
];
function InteriorWalls({ viewingLabel = null, clientId = null }) {
  const scoped = (body) => (viewingLabel && clientId ? { ...body, targetClientId: clientId } : body);
  const [f, setF] = useState(null);
  const [covers, setCovers] = useState([]);
  const [fixtures, setFixtures] = useState([]);   // doors and windows: { id, name, category, inPartition }
  const [elec, setElec] = useState([]);           // electrical items: { id, name, icon, interiorWallOk }
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [saved, setSaved] = useState(true);       // false until this tab has been saved once

  const load = async () => {
    const body = scoped({ action: "catalog" });
    const { data, error } = await window.__ssCatalogFlight(
      () => sb.functions.invoke("portal-settings", { body }),
      String(body.targetClientId == null ? (ssTargetClientId || "") : body.targetClientId));
    if (error || (data && data.error)) { setMsg({ err: (error && error.message) || data.error }); return; }
    // Null until the tab is first saved (nothing is seeded): the table's own defaults, rates blank,
    // and interior walls not offered to anyone yet.
    setSaved(!!data.interiorWalls);
    const w = data.interiorWalls || {};
    const str = (v) => (v != null ? String(v) : "");
    setF({
      standardStud: w.standard_stud === "2x6" ? "2x6" : "2x4",
      method: IW_METHODS.some((m) => m.value === w.pricing_method) ? w.pricing_method : "lineal_ft",
      rate2x4: str(w.rate_2x4),
      rate2x6: str(w.rate_2x6),
      standardHeight: w.standard_height === "rafters" ? "rafters" : "plate",
      allowRafters: w.allow_rafters !== false,
      allowRo: w.allow_rough_openings !== false,
      taxable: w.taxable !== false,
      internalOnly: w.internal_only === true,
    });
    setCovers((data.interiorWallCoverings || []).map((c) => ({
      id: c.id, name: c.name || "", method: c.pricing_method || "sqft_option", rate: str(c.rate),
      taxable: c.taxable !== false, internalOnly: c.internal_only === true, active: c.active !== false,
    })));
    setFixtures((data.fixtures || []).filter((x) => (x.category === "door" || x.category === "window") && !x.archived)
      .map((x) => ({ id: x.id, name: x.name || "", category: x.category, inPartition: x.in_partition !== false })));
    setElec((data.electricalItems || []).map((e) => ({ id: e.id, name: e.name || "", icon: e.icon || "⚡", interiorWallOk: e.interior_wall_ok !== false })));
  };
  useEffect(() => { load(); }, [clientId]);

  const set = (k, v) => setF((prev) => ({ ...prev, [k]: v }));
  const updCover = (i, k, v) => setCovers((p) => p.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const moveCover = (i, d) => setCovers((p) => {
    const j = i + d; if (j < 0 || j >= p.length) return p;
    const n = p.slice(); const t = n[i]; n[i] = n[j]; n[j] = t; return n;
  });

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const stdRate = f.standardStud === "2x6" ? f.rate2x6 : f.rate2x4;
      if (String(stdRate).trim() === "") throw new Error(`Enter a rate for a ${f.standardStud} wall: it is your standard framing. Leave the other size blank if you don't offer it.`);
      const bad = [["2x4", f.rate2x4], ["2x6", f.rate2x6]].filter(([, v]) => { const t = String(v).trim(); return t !== "" && !(Number.isFinite(Number(t)) && Number(t) >= 0); });
      if (bad.length) throw new Error(`Nothing was saved. The ${bad.map((b) => b[0]).join(" and ")} rate isn't a dollar amount.`);
      const badCover = covers.filter((c) => c.name.trim() && String(c.rate).trim() !== "" && !(Number.isFinite(Number(c.rate)) && Number(c.rate) >= 0));
      if (badCover.length) throw new Error(`Nothing was saved. Fix the rate on: ${badCover.map((c) => c.name.trim()).join(", ")}.`);
      const inPartition = {}; fixtures.forEach((x) => { inPartition[x.id] = x.inPartition; });
      const interiorWallOk = {}; elec.forEach((e) => { interiorWallOk[e.id] = e.interiorWallOk; });
      const { data, error } = await sb.functions.invoke("portal-settings", { body: scoped({
        action: "save_interior_walls",
        standardStud: f.standardStud, method: f.method, rate2x4: f.rate2x4, rate2x6: f.rate2x6,
        standardHeight: f.standardHeight, allowRafters: f.standardHeight === "rafters" ? true : f.allowRafters,
        allowRo: f.allowRo, taxable: f.taxable, internalOnly: f.internalOnly,
        inPartition, interiorWallOk,
      }) });
      if (error || (data && data.error)) throw new Error((error && error.message) || data.error);
      const rows = covers.map((c, i) => ({ ...c, sortOrder: (i + 1) * 10 }));
      const r2 = await sb.functions.invoke("portal-settings", { body: scoped({ action: "save_interior_wall_coverings", rows }) });
      if (r2.error || (r2.data && r2.data.error)) throw new Error((r2.error && r2.error.message) || r2.data.error);
      await load();
      setMsg({ ok: "Saved." });
    } catch (e) { setMsg({ err: e.message }); }
    setBusy(false);
  };

  const cbx = { width: 16, height: 16, cursor: "pointer", accentColor: DOOR_MINT };
  const hint = { display: "block", fontSize: 11, color: "#94A3B8", marginTop: 3 };
  const note = { fontSize: 12.5, color: "#64748B", margin: "0 0 14px", maxWidth: 680, lineHeight: 1.5 };
  if (!f) {
    return (
      <div style={S.card}>
        <div style={S.h2}>Interior walls</div>
        {msg && msg.err ? <div style={S.err}>{msg.err}</div> : <SkelRows cols={3} rows={4} widths={["40%", "60%", "30%"]} />}
      </div>
    );
  }
  const offered = String(f.standardStud === "2x6" ? f.rate2x6 : f.rate2x4).trim() !== "";
  const tickList = (list, key, label, onTick) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
      {list.map((x) => (
        <label key={x.id} style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13 }}>
          <input type="checkbox" checked={!!x[key]} onChange={(e) => onTick(x.id, e.target.checked)} style={cbx} />
          {x.icon ? <span>{x.icon}</span> : null}{x.name}
        </label>
      ))}
      {!list.length && <span style={{ fontSize: 12.5, color: "#94A3B8" }}>{label}</span>}
    </div>
  );
  const tickFixture = (id, v) => setFixtures((p) => p.map((x) => (x.id === id ? { ...x, inPartition: v } : x)));
  const tickElec = (id, v) => setElec((p) => p.map((x) => (x.id === id ? { ...x, interiorWallOk: v } : x)));

  return (
    <>
      {msg && msg.err && <div style={S.err}>{msg.err}</div>}
      {msg && msg.ok && <div style={S.okMsg}>{msg.ok}</div>}

      {/* 1. Framing & price */}
      <div style={S.card}>
        <div style={S.h2}>Framing &amp; price</div>
        <p style={note}>
          A wall your customer draws inside the building. Pick the framing you build with as standard and
          a rate for each size you offer. <b>Leave a size blank and you don&rsquo;t offer it.</b> Owners,
          admins and reps can switch any wall to the other size in the designer; customers never see the
          choice. {!saved
            ? <b style={{ color: "#B45309" }}>Interior walls aren&rsquo;t offered to your customers or reps until you set a price here and save.</b>
            : !offered && <b style={{ color: "#B45309" }}>Customers can&rsquo;t add interior walls until your standard size has a rate.</b>}
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 18, alignItems: "flex-start", marginBottom: 16 }}>
          <div style={{ minWidth: 170 }}>
            <span style={{ ...S.lbl, marginBottom: 6 }}>Standard framing</span>
            {["2x4", "2x6"].map((s) => (
              <label key={s} style={{ display: "inline-flex", alignItems: "center", gap: 6, marginRight: 14, cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
                <input type="radio" name="iw-stud" checked={f.standardStud === s} onChange={() => set("standardStud", s)} style={cbx} />{s}
              </label>
            ))}
          </div>
          {["2x4", "2x6"].map((s) => (
            <label key={s} style={{ display: "block", minWidth: 150 }}>
              <span style={{ ...S.lbl }}>{s} wall rate{f.standardStud === s ? " (standard)" : ""}</span>
              <input type="number" min="0" step="0.01" placeholder="not offered" value={s === "2x4" ? f.rate2x4 : f.rate2x6}
                onChange={(e) => set(s === "2x4" ? "rate2x4" : "rate2x6", e.target.value)} style={{ ...S.input, width: 130 }} />
              <span style={hint}>Blank = not offered. 0 = included.</span>
            </label>
          ))}
          <label style={{ display: "block", minWidth: 200 }}>
            <span style={{ ...S.lbl }}>How it&rsquo;s priced</span>
            <select value={f.method} onChange={(e) => set("method", e.target.value)} style={{ ...S.input, width: 200 }}>
              {IW_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
            <span style={hint}>Per sq ft uses the wall&rsquo;s length times its height.</span>
          </label>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 18, alignItems: "flex-start", marginBottom: 14 }}>
          <label style={{ display: "block", minWidth: 320 }}>
            <span style={{ ...S.lbl }}>Standard height</span>
            <select value={f.standardHeight} onChange={(e) => set("standardHeight", e.target.value)} style={{ ...S.input, width: 320 }}>
              <option value="plate">Stud wall height (level with the wall plate)</option>
              <option value="rafters">To the rafters (follows the roof)</option>
            </select>
            <span style={hint}>Where a new wall&rsquo;s top stops. Customers can change it on each wall.</span>
          </label>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 8, marginTop: 22, cursor: f.standardHeight === "rafters" ? "default" : "pointer", fontSize: 13 }}
            title={f.standardHeight === "rafters" ? "Your standard is to the rafters, so it is always offered." : undefined}>
            <input type="checkbox" checked={f.standardHeight === "rafters" || f.allowRafters} disabled={f.standardHeight === "rafters"}
              onChange={(e) => set("allowRafters", e.target.checked)} style={cbx} />
            Offer &ldquo;To the rafters&rdquo;
          </label>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 18, alignItems: "center" }}>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 7, cursor: "pointer", fontSize: 13 }}
            title="Available in the rep designer only. Hidden from the customer-facing page; a wall a rep adds still prices normally.">
            <input type="checkbox" checked={f.internalOnly} onChange={(e) => set("internalOnly", e.target.checked)} style={cbx} />
            Internal only
          </label>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 7, cursor: "pointer", fontSize: 13 }}>
            <input type="checkbox" checked={f.taxable} onChange={(e) => set("taxable", e.target.checked)} style={cbx} />
            Taxable
          </label>
        </div>
      </div>

      {/* 2. Wall coverings */}
      <div style={S.card}>
        <div style={S.h2}>Wall coverings</div>
        <p style={note}>
          What can go on each side of an interior wall: drywall, OSB, shiplap. The customer picks one for
          each side, or leaves it bare. <b>Leave a rate blank and you don&rsquo;t offer it; 0 means it&rsquo;s
          included.</b> Per sq ft is that side&rsquo;s length times its height.
        </p>
        <div style={{ overflowX: "auto", marginBottom: 12 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 640 }}>
            <thead>
              <tr>
                <th style={S.th}>Covering</th>
                <th style={S.th}>How it&rsquo;s priced</th>
                <th style={S.th}>Rate ($)</th>
                <th style={{ ...S.th, textAlign: "center" }} title="Rep designer only, hidden from the customer-facing page.">Internal</th>
                <th style={{ ...S.th, textAlign: "center" }}>Taxable</th>
                <th style={S.th}></th>
              </tr>
            </thead>
            <tbody>
              {covers.map((c, i) => (
                <tr key={c.id || ("new-" + i)}>
                  <td style={S.td}><input value={c.name} maxLength={60} onChange={(e) => updCover(i, "name", e.target.value)} style={{ ...S.input, width: 170 }} /></td>
                  <td style={S.td}>
                    <select value={c.method} onChange={(e) => updCover(i, "method", e.target.value)} style={{ ...S.input, width: 180 }}>
                      {IW_COVER_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                    </select>
                  </td>
                  <td style={S.td}><input type="number" min="0" step="0.01" placeholder="not offered" value={c.rate} onChange={(e) => updCover(i, "rate", e.target.value)} style={{ ...S.input, width: 110 }} /></td>
                  <td style={{ ...S.td, textAlign: "center" }}><input type="checkbox" checked={c.internalOnly} onChange={(e) => updCover(i, "internalOnly", e.target.checked)} style={cbx} /></td>
                  <td style={{ ...S.td, textAlign: "center" }}><input type="checkbox" checked={c.taxable} onChange={(e) => updCover(i, "taxable", e.target.checked)} style={cbx} /></td>
                  <td style={{ ...S.td, whiteSpace: "nowrap" }}>
                    <button onClick={() => moveCover(i, -1)} disabled={i === 0} title="Move up" style={{ background: "transparent", border: "none", cursor: i === 0 ? "default" : "pointer", color: "#64748B", fontSize: 13 }}>&uarr;</button>
                    <button onClick={() => moveCover(i, 1)} disabled={i === covers.length - 1} title="Move down" style={{ background: "transparent", border: "none", cursor: i === covers.length - 1 ? "default" : "pointer", color: "#64748B", fontSize: 13 }}>&darr;</button>
                    <button onClick={() => setCovers((p) => p.filter((_, j) => j !== i))}
                      style={{ background: "transparent", border: "none", cursor: "pointer", color: "#B91C1C", fontWeight: 700, fontSize: 13 }}>Remove</button>
                  </td>
                </tr>
              ))}
              {!covers.length && (
                <tr><td colSpan={6} style={{ ...S.td, color: "#94A3B8", fontSize: 12.5 }}>No coverings yet. Walls are bare studs until you add one.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <button onClick={() => setCovers((p) => p.concat([{ id: "", name: "", method: "sqft_option", rate: "", taxable: true, internalOnly: false, active: true }]))}
          style={S.btn("#F1F5F9", "#334155")}>+ Add a covering</button>
      </div>

      {/* 3. Openings */}
      <div style={S.card}>
        <div style={S.h2}>Openings</div>
        <p style={note}>
          What a customer can put in an interior wall. Rough openings use the rates you set on the
          Doors and Windows tabs.
        </p>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 8, marginBottom: 14, cursor: "pointer", fontSize: 13, fontWeight: 700, color: "#1E293B" }}>
          <input type="checkbox" checked={f.allowRo} onChange={(e) => set("allowRo", e.target.checked)} style={cbx} />
          Rough openings allowed in interior walls
        </label>
        <div style={{ ...S.lbl, marginBottom: 8 }}>Doors allowed in interior walls</div>
        {tickList(fixtures.filter((x) => x.category === "door"), "inPartition", "No doors in your catalog yet.", tickFixture)}
        <div style={{ ...S.lbl, marginBottom: 8 }}>Windows allowed in interior walls</div>
        {tickList(fixtures.filter((x) => x.category === "window"), "inPartition", "No windows in your catalog yet.", tickFixture)}
      </div>

      {/* 4. Electrical */}
      <div style={S.card}>
        <div style={S.h2}>Electrical</div>
        <p style={note}>
          Which of your electrical items a customer can put on an interior wall. Each one is charged at
          its own price, the same as one added on an outside wall beyond your package.
        </p>
        <div style={{ ...S.lbl, marginBottom: 8 }}>Allowed on interior walls</div>
        {tickList(elec, "interiorWallOk", "No electrical items yet. Add them on the Electrical tab.", tickElec)}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <button onClick={save} disabled={busy} style={S.btn(busy ? "#9CA3AF" : DOOR_MINT, "#0F4C46")}>{busy ? "Saving…" : "Save interior walls"}</button>
        {msg && <span style={{ fontSize: 12.5, color: msg.err ? "#B91C1C" : "#047857" }}>{msg.err || msg.ok}</span>}
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
  // The builder's library (339) when client_settings.library_beta is on: a door's "How it looks in
  // 3D" and a window's grid then pick from the builder's own entries. null = the editor as before.
  const [lib, setLib] = useState(null);
  // Door looks from a photo (P6): the dropdown's "Make one from a photo…" when door_looks_beta is on.
  const [doorLooksOn, setDoorLooksOn] = useState(false);

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
    // Where in the door (the transom, 2026-10-21): "top" a transom, anything else the upper panel.
    door_window_at: d.door_window_at === "top" ? "top" : "panel",
    // Grid of lites (335): "" = automatic (NULL, today's look); otherwise rows and lites across as
    // text, for the selects.
    lite_rows: d.lite_rows != null ? String(d.lite_rows) : "",
    lite_cols: d.lite_cols != null ? String(d.lite_cols) : "",
    // Allowed in interior walls (313): doors and windows; absent reads as YES, the column's default.
    in_partition: d.in_partition !== false,
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
    const libOn = data.libraryBeta === true && data.library ? data.library : null;
    setLib(libOn);
    setDoorLooksOn(isDoorCat && !!libOn && data.doorLooksBeta === true);
    const links = (libOn && libOn.fixtureLinks) || {};
    const list = (data.fixtures || []).filter((f) => (f.category || "door") === category)
      .map((d) => ({ ...mapRow(d), client_library_id: links[d.id] || null }));
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
    // Where in the door rides beside it, "top" only for a window that goes in doors at all.
    ...(isWindowCat ? { inDoor: r.in_door === true, doorWindowAt: r.in_door === true && r.door_window_at === "top" ? "top" : "panel" } : {}),
    // Grid of lites (335), windows only: both null is automatic.
    ...(isWindowCat ? { liteRows: r.lite_rows ? Number(r.lite_rows) : null, liteCols: r.lite_rows && r.lite_cols ? Number(r.lite_cols) : null } : {}),
    // Allowed in interior walls (313): doors and windows only. Ticked on the Interior walls tab; it
    // rides every line save so the tick survives a price edit made here.
    ...((isWindowCat || isDoorCat) ? { inPartition: r.in_partition !== false } : {}),
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
    // The library entry (339), doors and windows, only with the library on. Its look wins on the
    // server; null takes the line off the library. Absent (library off) leaves any link alone.
    ...(lib && (isDoorCat || isWindowCat) ? { clientLibraryId: r.client_library_id || null } : {}),
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
  // "Interior walls" (313): may this door or window go in an interior wall. Doors and windows only;
  // a sheet from before it has no such column, and import leaves the tick alone.
  const inWalls = isDoorCat || isWindowCat;
  const HEADERS = hasSwingOp
    ? ["ID", "Style", "Label on plan", "Width", "Height", "Price", "Swing out", "Swing in", "Default swing", "Opens right", "Opens left", "Double", "Slide up", "Default operation", "Color mode", "Trim color", "Fixed color", "Height off floor", ...(inWalls ? ["Interior walls"] : []), "Photo on estimate", "Active", "Internal only", "Taxable", "Archived"]
    : ["ID", "Style", "Label on plan", "Width", sizeWord === "length" ? "Length" : "Height", "Price", ...(isWindowCat ? ["Colors", "Height off floor", "Placement"] : []), ...(inWalls ? ["Interior walls"] : []), "Photo on estimate", "Active", "Internal only", "Taxable", "Archived"];
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
    ? [r.id || "", r.name, r.plan_label, r.width_in, r.height_in, r.price === "" ? "" : Number(r.price), yn(r.swing_out), yn(r.swing_in), r.swing_default || "", yn(r.op_right), yn(r.op_left), yn(r.op_double), yn(r.op_slideup), r.op_default || "", r.color_mode || "fixed", yn(r.has_trim_color), fixedColorLabel(r), r.sill_in || "", ...(inWalls ? [yn(r.in_partition !== false)] : []), yn(r.show_image_on_estimate), yn(r.active), yn(r.internalOnly), yn(r.taxable), yn(r.archived)]
    : [r.id || "", r.name, r.plan_label, r.width_in, r.height_in, r.price === "" ? "" : Number(r.price), ...(isWindowCat ? [winColorsCell(r), r.sill_in || "", (r.sill_mode === "variable" ? "variable" : "fixed")] : []), ...(inWalls ? [yn(r.in_partition !== false)] : []), yn(r.show_image_on_estimate), yn(r.active), yn(r.internalOnly), yn(r.taxable), yn(r.archived)]);
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
        iSill = col("height off floor"), iSillMode = col("placement"), iInWalls = col("interior walls", "interior wall"),
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
        // Interior walls (313): absent column leaves the tick alone; a blank cell is the default, yes.
        if (inWalls && iInWalls >= 0) row.inPartition = bool(cols, iInWalls, true);
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
  const blank = () => ({ id: null, name: "", plan_label: "", show_image_on_estimate: true, width_in: "", height_in: "", price: "", swing_in: false, swing_out: hasSwingOp, swing_default: null, op_right: hasSwingOp, op_left: false, op_double: false, op_slideup: false, op_default: null, color_mode: "fixed", has_trim_color: false, fixed_color_id: null, window_color_ids: null, in_door: false, door_window_at: "panel", lite_rows: "1", lite_cols: "1", in_partition: true, style_ids: null, sill_in: "", sill_mode: "fixed", door_style: "auto", image_url: null, active: true, archived: false, internalOnly: false, taxable: true });
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
    // Can go inside a door (289): said on the row, only when ticked, and how (the transom, 2026-10-21).
    if (isWindowCat && r.in_door) parts.push(r.door_window_at === "top" ? "transom in doors" : "can go in a door");
    // Grid of lites (335): said only when set, so an automatic window's line is unchanged.
    if (isWindowCat && r.lite_rows && r.lite_cols) parts.push(Number(r.lite_rows) * Number(r.lite_cols) < 2 ? "no grid" : `${Number(r.lite_rows) * Number(r.lite_cols)}-lite`);
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
          as its own window line, once per leaf. Windows only.
          The tick became a select on 2026-10-21 (Yoder Barns: "transom windows in doors"): No, in the
          upper panel (in_door, door_window_at 'panel'), or as a transom across the top of each leaf
          (door_window_at 'top'), which the designer also offers in the board-and-batten doors and a
          plain door with no photo. One control because "as a transom" only means anything in a door. */}
      {isWindowCat && (
        <div style={{ marginBottom: 12 }}>
          <div style={fldLbl}>Use in doors</div>
          <select data-ss-door-window-at="1" value={!edit.draft.in_door ? "no" : edit.draft.door_window_at === "top" ? "top" : "panel"}
            onChange={(e) => setDraft(e.target.value === "no" ? { in_door: false, door_window_at: "panel" } : { in_door: true, door_window_at: e.target.value })}
            style={{ ...S.input, minWidth: 0, maxWidth: 380 }}>
            <option value="no">No</option>
            <option value="panel">In the door's upper panel</option>
            <option value="top">As a transom at the top of the door</option>
          </select>
          <div style={{ fontSize: 12, color: "#94A3B8", marginTop: 6 }}>
            {!edit.draft.in_door
              ? "Only on the walls. Choose a door option to offer it inside doors as well."
              : edit.draft.door_window_at === "top"
                ? "Offered in the door picker as a transom across the top of the doors it fits: the American, Basic, Classic and Dutch doors, the board-and-batten doors, and plain doors without a photo. Each one is charged as a window, one per door (two on a double door)."
                : "Offered in the door picker for the American, Basic, Classic and Dutch doors it fits. Each one is charged as a window, one per door (two on a double door)."}
          </div>
        </div>
      )}
      {/* Grid (migration 335; Carolyn, 2026-10-23: "every window shows grids although nobody asked for
          them"; spec Ahsan, 2026-10-24). The window's grid of lites, ROWS x lites ACROSS, for this window
          on a wall, in a door's upper panel and as a transom. Since Carolyn's 10-27 call it is set HERE
          only: "The customer can't select the grid", so the designer has no picker, and this one is built
          the way that one was. 1 x 1 is no grid; a transom of five is 1 row of 5; a "6-lite" is 3 rows of 2.
          Standard is the look every window had before. A window with a photo shows the photo instead.
          With the library (339) the builder's imported grids sit above it as chips; picking one links the
          window to that entry, and any other change unlinks it. Windows only. */}
      {isWindowCat && (() => {
        const lr = edit.draft.lite_rows || "", lc = edit.draft.lite_cols || "1";
        const R = Number(lr) || 0, Cn = Number(lc) || 1;
        const winEntries = lib ? (lib.entries || []).filter((x) => x.category === "window" && x.active !== false) : null;
        const cur = edit.draft.client_library_id || null;
        const linked = winEntries && cur && winEntries.some((x) => x.id === cur) ? cur : null;
        const draftOf = (l) => ({ lite_rows: l.liteRows == null ? "" : String(l.liteRows), lite_cols: l.liteRows == null ? "" : String(l.liteCols) });
        return (
          <div style={{ marginBottom: 12 }} data-ss-window-grid="1">
            <div style={fldLbl}>Grid (lites)</div>
            <SsGridPicker look={R > 0 ? { liteRows: R, liteCols: Cn } : {}}
              onChange={(l) => setDraft({ ...draftOf(l), ...(lib ? { client_library_id: null } : {}) })}
              entries={winEntries} linkedId={linked}
              onPickEntry={(x) => setDraft({ client_library_id: x.id, ...draftOf(x.look || {}) })}
              onFindMore={lib ? () => window.dispatchEvent(new CustomEvent("ss:library-open", { detail: { category: "window" } })) : null} />
            <div data-ss-window-lite-hint="1" style={{ fontSize: 12, color: "#94A3B8", marginTop: 6 }}>
              {R === 0
                ? "Standard is the look windows had before: two rows of two or three lites by width (one row in a transom)."
                : R * Cn < 2
                  ? "No grid: one clear lite."
                  : `${R * Cn}-lite: ${R} ${R === 1 ? "row" : "rows"} of ${Cn}, all the same size.`}
              {" "}Customers get this grid on this window; they can't change it in the designer.
            </div>
          </div>
        );
      })()}
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
          {lib ? (() => {
            // From the builder's library (339; Carolyn 10-26: "everything in the library that is doors
            // then comes in as an option in here"). The line's current look stays pickable even when it
            // is in no entry, so opening and saving a line never changes how it draws.
            const doorEntries = (lib.entries || []).filter((x) => x.category === "door" && x.active !== false);
            const cur = edit.draft.client_library_id || null;
            const curStyle = D3_DOOR_STYLES.includes(edit.draft.door_style) ? edit.draft.door_style : "auto";
            const val = cur && doorEntries.some((x) => x.id === cur) ? "lib:" + cur : "style:" + curStyle;
            return (
              <select data-ss-door-look-library="1" value={val} style={{ ...S.input, minWidth: 0, maxWidth: 380 }}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "__more") { window.dispatchEvent(new CustomEvent("ss:library-open", { detail: { category: "door" } })); return; }
                  if (v === "__photo") { window.dispatchEvent(new CustomEvent("ss:library-open", { detail: { category: "door", photo: true } })); return; }
                  if (v.startsWith("lib:")) {
                    const x = doorEntries.find((y) => y.id === v.slice(4));
                    if (x) setDraft({ client_library_id: x.id, door_style: (x.look && x.look.doorStyle) || "auto" });
                    return;
                  }
                  setDraft({ client_library_id: null, door_style: v.slice(6) });
                }}>
                {doorEntries.map((x) => <option key={x.id} value={"lib:" + x.id}>{x.name}</option>)}
                {val.startsWith("style:") && <option value={val}>{ssLibLookWords("door", { doorStyle: curStyle })} (not in your library)</option>}
                <option value="__more">Find more in the library…</option>
                {doorLooksOn && <option value="__photo">Make one from a photo…</option>}
              </select>
            );
          })() : (
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
          )}
          <div style={{ fontSize: 12, color: "#94A3B8", marginTop: 6 }}>
            {(() => {
              // A door made from a photo (345) draws its own look, not its base's description.
              const e = lib && edit.draft.client_library_id ? (lib.entries || []).find((x) => x.id === edit.draft.client_library_id) : null;
              return e && e.look && e.look.doorLookId
                ? "Your door, drawn in 3D from your photo. It follows this door's colours."
                : D3_DOOR_STYLE_HINT[edit.draft.door_style] || D3_DOOR_STYLE_HINT.auto;
            })()}
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
        {dCbx("taxable", "Taxable", "Untick if you don't charge sales tax on this item. It then shows on the estimate and invoice under a separate non-taxable subtotal.")}
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
      {r.taxable === false && chip("No tax", "#FEF3C7", "#B45309", "Not subject to sales tax — appears under the non-taxable subtotal on estimates and invoices")}
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
  // Bumped by the Library card after an entry changes, so the door lines re-read their choices.
  const [libRev, setLibRev] = useState(0);
  return (
    <>
    <SsLibrarySection category="door" viewingLabel={viewingLabel} clientId={clientId} onChanged={() => setLibRev((n) => n + 1)} />
    <div style={S.card}>
      <div style={S.h2}>Doors</div>
      <p style={{ fontSize: 13, color: "#64748B", marginBottom: 14, lineHeight: 1.5 }}>
        The doors your customers can drop onto a building. Each door is <b>one line</b> — click <b>Edit</b> to change it;
        every line saves on its own. Drag <b>⠿</b> to set the order customers see. The <b style={{ color: "#F59E0B" }}>★</b> marks
        the swing/operation default the customer sees first (only needed when more than one is allowed; they can switch to any
        other you’ve checked). Sizes are feet/inches — 8', 6'3", 36" (no spaces). <b>Export Excel</b> to edit in bulk and
        re-import — rows are matched by the ID column, and rows missing from the file are never deleted.
      </p>
      <FixtureCatalog category="door" noun="door" addLabel="Add door" namePh="e.g. Steel door" labelPh="SD" wPh={'36"'} hPh={'80"'} hasSwingOp sizeWord="height" viewingLabel={viewingLabel} clientId={clientId} refreshKey={libRev} />
    </div>
    <LayoutPricing group="doors" viewingLabel={viewingLabel} clientId={clientId} />
    </>
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
  // Bumped by the Library card after an entry changes (339), the same way the colors are.
  const [libRev, setLibRev] = useState(0);
  return (
    <>
    <SsLibrarySection category="window" viewingLabel={viewingLabel} clientId={clientId} onChanged={() => setLibRev((n) => n + 1)} />
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
      <FixtureCatalog category="window" noun="window" addLabel="Add window" namePh="e.g. Slider window" labelPh="SL" wPh={'36"'} hPh={'36"'} sizeWord="height" viewingLabel={viewingLabel} clientId={clientId} refreshKey={colorsSavedAt * 1000 + libRev} />
    </div>
    <LayoutPricing group="windows" viewingLabel={viewingLabel} clientId={clientId} />
    </>
  );
}

// SPLIT INTO THREE TABS on 2026-09-11 (Carolyn: "in colors I want to split out the paint,
// shingles and metal colors to their own tab/nav"). `section` chooses which card renders.
//
// ⚠️ ONE component, one mount, one `rows` buffer — ColorsShell passes `section` to a SINGLE
// <ColorsView> rather than rendering three of them behind {sub === ...} branches, and that is
// load-bearing. `rows` is ONE flat list across all three categories, so three mounts would
// remount on every tab switch and edits made in Paint would be silently thrown away by a click
// on Shingles. Keep the element in one stable position so React preserves this state.
//
// SINCE 2026-10-30 EACH PAGE'S SAVE IS ITS OWN (Carolyn: "currently the save on each page is
// saving all 3 pages"): `save(ckey)` sends only that section's rows plus `section`, which
// narrows the server's delete sweep to match, and `load(ckey)` refreshes only that section so
// unsaved edits on the other two survive. The shared buffer above is what makes that refresh
// scoping necessary — a plain reload would wipe the pages you had not saved yet.
function ColorsView({ viewingLabel = null, section = "all" }) {
  const [cat, setCat] = useState(null);
  // One flat list across all categories; a row's category is set by its flags:
  // paint = siding/trim (and not shingle/metal), shingle = shingle, metal = metal.
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [libOpen, setLibOpen] = useState(null);   // which section's library is open

  // `only` reloads ONE section's rows and leaves the other two alone (see `save`): all three
  // palettes share this one unsaved-edit buffer, so a scoped save must not refetch over edits
  // a builder has sitting on another page. Without it, saving Paint silently discarded them —
  // the same whole-buffer coupling the section-scoped save exists to break.
  const load = async (only = null) => {
    const { data, error } = await sb.functions.invoke("portal-settings", { body: { action: "catalog" } });
    if (error || (data && data.error)) { setMsg({ err: (error && error.message) || data.error }); return; }
    setCat(data);
    const fresh = (data.colors || []).map((c) => ({
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
    }));
    if (!only) { setRows(fresh); return; }
    setRows((prev) => [...prev.filter((r) => catOf(r) !== only), ...fresh.filter((r) => catOf(r) === only)]);
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

  // Which palette a row belongs to. Mirrors renderSection's filter exactly — paint is the
  // absence of the other two flags, not a flag of its own. Defined above `save`/`load`
  // because both now use it to work one section at a time.
  const catOf = (r) => (r.shingle ? "shingle" : r.metal ? "metal" : "paint");
  const SECTION_WORD = { paint: "paint", shingle: "shingle", metal: "metal" };

  // EACH PAGE SAVES ITS OWN PALETTE (Carolyn 2026-10-30: "we need all the save colors to work
  // on their own page. currently the save on each page is saving all 3 pages"). `ckey` is the
  // section whose Save button was clicked; only that section's rows are validated and sent,
  // and `section` tells the server to narrow its delete sweep to the same set.
  //
  // ⚠️ SENDING FEWER ROWS IS NOT ENOUGH ON ITS OWN — `save_colors` deletes anything absent
  // from the payload, so posting only the paint rows without `section` would wipe every
  // shingle and metal colour. The two halves ship together; never send a filtered list to a
  // server build that does not read `section`.
  const save = async (ckey) => {
    const mine = rows.map((r, gi) => ({ r, gi })).filter(({ r }) => catOf(r) === ckey);
    const word = SECTION_WORD[ckey] || ckey;
    // Full-list replace WITHIN THIS SECTION: the server removes any colour of this kind not in
    // the payload. Harmless on your own palette, not harmless on someone else's.
    if (viewingLabel && !window.confirm(`Replace ${viewingLabel}'s ENTIRE ${word} colour list with these ${mine.length} colour(s)?

Any ${word} colour not shown here will be removed from their account. Their other colour pages are left alone.`)) return;
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
      mine.forEach(({ r }) => {
        const name = r.label || "unnamed colour";
        if (badRate(r.rate)) bad.push(`${name} ("${r.rate}")`);
        if (badRate(r.door_rate)) bad.push(`${name} door price ("${r.door_rate}")`);
      });
      if (bad.length) throw new Error(`Nothing was saved — fix these rate(s) first, they aren't usable dollar amounts: ${bad.join(", ")}.`);
      // Serial code is REQUIRED on every siding, trim and roof colour (316, Carolyn 2026-10-18).
      // A door-only colour never appears in a serial, so it is exempt.
      const noCode = mine.filter(({ r }) => ssColorNeedsCode(r) && !String(r.code || "").trim()).map(({ r }) => r.label || "unnamed colour");
      if (noCode.length) throw new Error(`Nothing was saved — every siding, trim and roof colour needs a serial code (it is part of each building's serial number). Missing: ${noCode.join(", ")}.`);
      // sortOrder stays the row's GLOBAL index, exactly as before: the three palettes are read
      // back filtered, so only the order WITHIN a section matters, and keeping the global index
      // means a scoped save never renumbers rows it did not send.
      const colors = mine.map(({ r, gi: i }) => ({
        id: r.id || undefined, label: r.label,
        siding: !!r.siding, trim: !!r.trim, shingle: !!r.shingle, metal: !!r.metal, door: !!r.door,
        allowCustom: !!r.allow_custom, isDefault: !!r.is_default, active: r.active !== false,
        sortOrder: i, hex: r.hex || null, pricingMethod: r.pricing_method || "each", rate: numOf(r.rate),
        doorRate: numOf(r.door_rate), taxable: r.taxable !== false, code: r.code || "",
      }));
      const { data, error } = await sb.functions.invoke("portal-settings", { body: { action: "save_colors", section: ckey, colors } });
      if (error || (data && data.error)) throw new Error((error && error.message) || data.error);
      await load(ckey);
      const skipped = data.skipped || [];
      setMsg({ ok: `Saved ${data.saved || 0} ${word} colour(s)` + (data.deleted ? `, removed ${data.deleted}` : "") + (skipped.length ? `, ${skipped.length} skipped` : "") + ".", skipped });
    } catch (e) { setMsg({ err: e.message }); }
    setBusy(false);
  };

  const errStyle = { background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 8, padding: "9px 13px", color: "#DC2626", fontSize: 13, fontWeight: 600, marginBottom: 12 };
  const okStyle = { background: "#F0FDF4", border: "1px solid #BBF7D0", borderRadius: 8, padding: "9px 13px", color: "#15803D", fontSize: 13, fontWeight: 600, marginBottom: 12 };
  const ctr = { ...S.td, padding: "8px 5px", textAlign: "center" };
  const tdc = { ...S.td, padding: "8px 5px" };
  const thc = { ...S.th, padding: "8px 5px", whiteSpace: "normal" };
  const chk = (gi, field) => <input type="checkbox" checked={!!rows[gi][field]} onChange={(e) => setRow(gi, field, e.target.checked)} style={{ width: 16, height: 16, cursor: "pointer" }} />;

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
    const saveLabel = `Save ${SECTION_WORD[ckey] || ckey} colors`;
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
              <th style={thc} title="Required for siding, trim and roof colours. Your short code for this colour becomes part of every building serial number, e.g. the RE, BU and WH in 1027-LBA-1216-REBUWHM-25698.">Code *</th>
              {showST && <th style={thc}>Siding</th>}
              {showST && <th style={thc}>Trim</th>}
              {showST && <th style={thc} title="Customers can pick this color for doors set to use paint colors">Doors</th>}
              <th style={thc}>How it’s priced</th><th style={thc}>Rate (USD)</th>
              {showST && <th style={thc} title="Flat $ added per door painted this color — separate from the siding/trim rate">Door price (USD)</th>}
              <th style={thc} title="Lets the customer type their own color instead of picking one">Custom</th>
              <th style={thc}>Default</th><th style={thc}>Active</th>
              <th style={thc} title="Untick if you don’t charge sales tax on this colour’s upcharge. It then sits under the non-taxable subtotal on estimates and invoices.">Taxable</th>
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
                      title={ssColorNeedsCode(r) && !String(r.code || "").trim() ? "Required — part of every building serial number" : undefined}
                      onChange={(e) => setRow(gi, "code", e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4))}
                      style={{ ...S.input, width: "100%", minWidth: 0, boxSizing: "border-box", textTransform: "uppercase",
                        ...(ssColorNeedsCode(r) && !String(r.code || "").trim() ? { borderColor: "#DC2626", background: "#FEF2F2" } : {}) }} />
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
          {/* Named for its own palette, because it only saves that one now — "Save colors" on
              three pages is what made the old whole-list save look like a page-level save. */}
          <button onClick={() => save(ckey)} disabled={busy} style={S.btn(busy ? "#9CA3AF" : ACCENT, "#FFF")}>{busy ? "Saving…" : saveLabel}</button>
        </div>
        {libOpen === ckey && (
          <div style={{ marginTop: 12, padding: 12, background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 8 }}>
            <div style={{ fontSize: 12, color: "#64748B", marginBottom: 10 }}>Click a color to add it to this list (swatches are approximate — rename or set exact codes after adding). Then click <b>{saveLabel}</b>.</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {lib.map((c) => (
                <button key={c.name} onClick={() => { addRow(c, ckey); setMsg({ ok: `Added “${c.name}” — click ${saveLabel} to apply.` }); }}
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


// ═══ THE SIZES & PRICES TABLE (/settings/sheds-table, 2026-10-30) ══════════════════════════════
// Carolyn, 10-29 call: every style's sizes, prices and included options in one table, instead of
// the Excel download and upload. Settings → Sheds opens it in its own tab (ssPricingTableHref,
// 01-core.jsx), and Dashboard (12-shell.jsx) renders PricingTableGate for that address, chromeless,
// before its main return. The build plan is _Extras/StructureStudio Pricing Table Editor Plan
// 2026-10-30.md; this is its Phase 2 (the shell and the read-only grid) and Phase 3 (editing and
// autosave). Paste, fill, clear, adding and removing sizes, refresh and the local backup come in
// Phase 4, on the seams marked "Phase 4" below.
//
// The pure half (ssPgModel, ssPgRows, ssPgMove, ssPgReanchor, ssPgHeaderHeight, ssPgTemplate,
// ssPgFmtPrice; the parsers, ssPgQueue and the save helpers) sits above PricingCsv, where
// pricingTableHelpers_test.ts lifts it from this file.
//
// SPEED (plan 3.5). Cells are plain <td> text, not inputs. Each size row is a PgRow (React.memo)
// whose props are primitives, or arrays built once per change of that size; the whole <thead> and
// <tbody> are memoised. So moving the active cell re-renders the toolbar and nothing in the table:
// the ring and the selection are ONE absolutely placed overlay (PgSelectionOverlay), and
// aria-selected is set on that one <td> directly. A commit re-renders one row. One editor
// (PgEditor) floats over the active cell while typing, and keeps its text out of React state, so a
// keystroke re-renders nothing.
//
// SAVING (plan 4.6-4.7, 4.9). Every box edit goes into the save queue (ssPgQueue), which sends one
// save_pricing_cells call at a time through ssStyleSaveCall, 800 ms after the last edit and at most
// 3 s after the first unsent one, each size with the version and every starting value it was made
// against. The server checks both and never merges; the queue rebases a conflict once and turns what
// someone else changed red. Transport failures resend the same call with backoff, and the fifth stops.

const SS_PRICING_HOLD_MS = 10000;          // how long "Opening <account>…" waits for ?view= to arm
const SS_PG_NARROW_MQ = "(max-width: 699.98px)";
const SS_PG_SHOW_HIDDEN_KEY = "ss-pg-show-hidden";
const SS_PG_SEC_H = 22;                     // the section band above the option names
const SS_PG_LINE_H = 15;                    // one line of a standing name (portal.html .ss-pg-vh)
const SS_PG_HEAD_MIN = 64;
const SS_PG_HEAD_MAX = 600;
const SS_PG_HEAD_NARROW = 90;               // below 700 px: capped, with an ellipsis
const SS_PG_FROZEN_W = 170;                 // Size 64 + Price 76 + Offered 30
const SS_PG_COL_W = 44;                     // one option column, about three digits wide
const SS_PG_LEGEND = "Empty = not included. A number = how many come included (loft = sq ft). Blank price = size not offered. $0 = free.";
const SS_PG_TOO_BIG = "This catalog is too big for the table right now. Use the Excel sheet, and let us know.";
const SS_PG_RTP = "Real-Time Pricing sets prices on this account";
const SS_PG_NO_UNDO = "Undo isn't in this version yet. Type the old value back.";
const SS_PG_ADD_PRICE = "Add a price first";
const SS_PG_SIZE_FIXED = "A size's width and length can't be changed here.";
const SS_PG_REFUSED_CALL = "This change couldn't be saved. Tell CSM Synergy if it keeps happening";
const SS_PG_FORBIDDEN = "You can't change Sheds on this account";
const SS_PG_REMOVING = "This size is being removed.";
const SS_PG_REMOVE_RULE = "Only a size that was never priced or edited can be removed. Untick Offered to hide it.";
const SS_PG_OPEN_CH = "ss-pg-open";            // the tables that are open answer here (PricingTablePage, offerEarlier)

// A Settings address in THIS tab that keeps the account (?view=) and the person (?as=), and
// nothing else: Back to Sheds, Options, Billing.
function ssPgSettingsHref(sub) {
  const q = new URLSearchParams();
  try {
    const cur = new URLSearchParams(window.location.search || "");
    ["view", "as"].forEach((k) => { const v = cur.get(k); if (v) q.set(k, v); });
  } catch (_e) { /* no query */ }
  const qs = q.toString();
  return ssPageBase("settings", sub) + (qs ? "?" + qs : "");
}

// The browser's Back and Forward, held while the table has something unsaved: installed by
// PricingTablePage while it is mounted, and asked first by Dashboard's popstate handler
// (12-shell.jsx), which routes nothing when it answers true. The page has then put its own address
// back and leaves once its edits have saved, the way Back to Sheds does. Asked from the shell, not
// from a popstate listener of the page's own: Chrome runs window's popstate listeners in the order
// they were added, and the shell's (added first, and again whenever its view-as state changes)
// unmounts the table before a later one runs.
let ssPgPopHold = null;

// One canvas for measuring header names in the header's own font (ssPgHeaderHeight's `measure`).
let ssPgCanvas = null;
function ssPgMeasureCtx() {
  try {
    if (!ssPgCanvas) ssPgCanvas = document.createElement("canvas");
    return ssPgCanvas.getContext("2d");
  } catch (_e) { return null; }
}

// The table's two reads, side by side (plan 4.1): portal-settings `catalog` for the option columns
// and `size_table` for styles, sizes, inclusions and their counts. Through ssStyleSaveCall
// (12-shell.jsx) for its 25 s deadline and one retry through the functions host, filed as
// pricing_table_side_door rather than as a style save.
//
// That side door is a raw fetch that skips 01-core's invoke wrapper, so:
//   * `targetClientId` is ALWAYS on the body: the view-as target, or null on your own account;
//   * `withUnpriced` is on the catalog body (the wrapper adds it on the main host only);
//   * the wrapper's tenant tripwire never runs, so `expect` is checked HERE, on both answers, and a
//     different account in either is a failure, never a table.
// The Excel template's fresh read (PricingCsv) goes through here too.
// Resolves { ok: true, cat, table } or { ok: false, error, status }.
async function ssPgFetch(target, expect) {
  const call = (body) => ssStyleSaveCall({ ...body, targetClientId: target || null }, "Pricing table", "pricing_table_side_door");
  const [c, t] = await Promise.all([call({ action: "catalog", withUnpriced: true }), call({ action: "size_table" })]);
  for (const r of [t, c]) {
    if (r.error || !r.data || r.data.error) {
      return { ok: false, status: (r.error && r.error.ssStatus) || null,
        error: (r.error && r.error.message) || (r.data && r.data.error) || "No answer from the server." };
    }
  }
  if (expect && (String(c.data.clientId || "") !== String(expect) || String(t.data.clientId || "") !== String(expect))) {
    ssLogError("portal", "pricing table: the server answered for a different account", "pricing_table_wrong_tenant",
      { asked: String(expect), catalog: c.data.clientId || null, sizeTable: t.data.clientId || null });
    return { ok: false, status: null, error: "This account view isn't wired up on the server yet — reload, and tell CSM Synergy if it persists." };
  }
  if (!Array.isArray(t.data.styles) || !Array.isArray(t.data.sizes) || !Array.isArray(t.data.inclusions)) {
    return { ok: false, status: null, error: "The server's answer was missing your sizes." };
  }
  return { ok: true, cat: c.data, table: t.data };
}

// The toolbar's badge (plan 3.13), aria-live: how the load went, why the page is view-only, or what
// the save queue is doing. `onClick` makes the words a button ("3 boxes need you" jumps to the next
// red box); `actions` (Retry now, Retry, Discard these changes) sit beside it, outside the live
// region, so a screen reader hears the state and not the buttons on every change.
function PgBadge({ tone, text, title = null, onClick = null, actions = null }) {
  return (
    <>
      <span className={"ss-pg-badge ss-pg-badge-" + tone} aria-live="polite" title={title || undefined}>
        {onClick ? <button type="button" className="ss-pg-badge-btn" onClick={onClick}>{text}</button> : text}
      </span>
      {actions}
    </>
  );
}

// The line under the toolbar (plan 3.14), role=status: the active red box's reason with what was
// typed, a note from the queue (a column that went away), a one-off tip (undo, a locked price), or
// why the page is view-only, or that the read did not add up.
function PgStatusLine({ tone = "grey", children, action = null }) {
  return (
    <div className={"ss-pg-status ss-pg-status-" + tone} role="status">
      <span>{children}</span>
      {action}
    </div>
  );
}

// A whole-tab message in the table's frame: the hold, its timeout, the billing lock, no access.
function PgMessage({ children, onNav = null }) {
  return (
    <div className="ss-pg">
      <div className="ss-pg-bar">
        {onNav && <a className="ss-pg-back" href={ssPgSettingsHref("sheds")} onClick={ssNavClick(() => onNav("sheds"))}>← Back to Sheds</a>}
        <span className="ss-pg-title">Sizes &amp; prices</span>
      </div>
      <div className="ss-pg-msg" role="status">{children}</div>
    </div>
  );
}

// THE GATE (plan 5). Whether this tab may show the table at all, and for which account.
//
// ⛔ THE HOLD. A new tab starts as the operator's OWN account: isOperator is false until its rpc
// answers, ?view= arms only after that (Dashboard's ?view= effect), and ssTargetClientId follows
// `viewing` during render. Mount the table any sooner and its reads go to the operator's own
// tenant under the builder's address. So while ?view= is in the address and the account on screen
// is not yet that one (the test Dashboard's ?open= effect uses, a support operator's viewedCtx
// included), this draws "Opening <account>…" and mounts NOTHING. After SS_PRICING_HOLD_MS it says
// the account could not be opened, and it never falls back to the operator's own.
//
// ?as= (an operator wearing a team member) opens the table VIEW-ONLY. A cold load never reads `as`
// back into the shell, so this tab has the operator's full rights, not that person's.
//
// Every hook is above the first return (React #310); the timer lives here so Dashboard gains none.
function PricingTableGate({ clientId, viewing, isSupportOp, supportCheckGaveUp, viewedCtx, canAdmin, access, gateLocked, billingActor, companyName, onNav }) {
  // What this tab was opened with, read once. `view` is lowercased the way Dashboard reads it.
  const params = useMemo(() => {
    try {
      const q = new URLSearchParams(window.location.search || "");
      return { view: (q.get("view") || "").trim().toLowerCase() || null, as: (q.get("as") || "").trim() || null, style: (q.get("style") || "").trim() || null };
    } catch (_e) { return { view: null, as: null, style: null }; }
  }, []);
  const v = params.view;
  const held = !!v && (!(viewing && viewing.clientId === v && (isSupportOp !== null || supportCheckGaveUp))
    || (!!isSupportOp && !(viewedCtx && viewedCtx.clientId === v)));
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    if (!held) { setTimedOut(false); return undefined; }
    const ms = (typeof window !== "undefined" && Number(window.__ssPricingHoldMs)) || SS_PRICING_HOLD_MS;
    const t = setTimeout(() => setTimedOut(true), ms);
    return () => clearTimeout(t);
  }, [held]);
  // The tab's title names the account (the popout's pattern), and goes back when the page does.
  const shown = held ? v : companyName;
  useEffect(() => {
    let prev = null;
    try { prev = document.title; document.title = `Sizes & prices · ${shown || ""} · Structure Studio`; } catch (_e) { /* no document */ }
    return () => { try { if (prev != null) document.title = prev; } catch (_e) { /* no document */ } };
  }, [shown]);
  // ?as= names the person in the view-only message (plan 5), but this tab has only their id: a cold
  // load never reads `as` back into the shell. So the name comes from the people list the account
  // switcher reads (operator-portal list_users), once the hold lets go. Until it answers, or if it
  // is refused, the message says "a team member", as the shell's own banner does.
  const [asName, setAsName] = useState(null);
  useEffect(() => {
    if (held || !v || !params.as) return undefined;
    let gone = false;
    (async () => {
      try {
        const { data, error } = await sb.functions.invoke("operator-portal", { body: { action: "list_users", clientId: v } });
        if (gone || error || !data || data.error || !Array.isArray(data.users)) return;
        const u = data.users.find((x) => x && x.userId === params.as);
        if (u && (u.fullName || u.email)) setAsName(String(u.fullName || u.email));
      } catch (_e) { /* the message keeps "a team member" */ }
    })();
    return () => { gone = true; };
  }, [held, v, params.as]);

  if (held) {
    return (
      <PgMessage>
        {timedOut
          ? "Couldn't open that account here. Close this tab and use the button on Sheds again."
          : `Opening ${v}…`}
      </PgMessage>
    );
  }
  if (gateLocked) {
    return (
      <PgMessage onNav={onNav}>
        This account's subscription needs attention.{" "}
        {billingActor
          ? <a href={ssPgSettingsHref("billing")} onClick={ssNavClick(() => onNav("billing"))}>Open Billing</a>
          : "Ask the account owner to open Billing."}
      </PgMessage>
    );
  }
  // Both are booleans; never compare them with "edit" (memory disabled-ui-fails-silently).
  const canRead = !!canAdmin || ssCanRead(access, "settings_structures");
  const canEdit = !!canAdmin || ssCanWrite(access, "settings_structures");
  if (!canRead) return <PgMessage onNav={onNav}>You don't have access to Sheds on this account.</PgMessage>;
  const viewOnly = params.as
    ? { as: true, short: "viewing as a team member", long: `You're viewing as ${asName || "a team member"}. The table is view-only here; open it from the account without “view as” to edit.` }
    : !canEdit
      ? { as: false, short: "no edit access", long: "You can see Sheds on this account but not change it. Ask an owner or admin for edit access to Sheds." }
      : null;
  return (
    <PricingTablePage clientId={clientId} target={viewing ? viewing.clientId : null} companyName={companyName}
      operatorView={!!viewing} viewOnly={viewOnly} styleParam={params.style} onNav={onNav} />
  );
}

// THE PAGE (plan 3.2-3.17, 4.6-4.9). A flex column the height of the window: the toolbar, the
// operator strip in view-as, the status line, the legend, and the grid box, which is the only thing
// on the page that scrolls, both ways.
//
// ⚠️ EVERY HOOK IS IN THE TOP BLOCK, and there is no early return at all: the one return picks what
// to draw. Later phases add their state up here too, never beside the handlers that use it (React
// #310 turns the page white the moment its data arrives).
function PricingTablePage({ clientId, target, companyName, operatorView, viewOnly, styleParam, onNav }) {
  const [load, setLoad] = useState({ phase: "loading" });     // { phase: loading|error|ready, model?, at?, error?, status? }
  // On by default; remembered in this browser. Storage can be blocked: then it is simply not kept.
  const [showHidden, setShowHidden] = useState(() => {
    try { return localStorage.getItem(SS_PG_SHOW_HIDDEN_KEY) !== "0"; } catch (_e) { return true; }
  });
  const [narrow, setNarrow] = useState(() => { try { return window.matchMedia(SS_PG_NARROW_MQ).matches; } catch (_e) { return false; } });
  const [legendOpen, setLegendOpen] = useState(() => !narrow);   // starts folded on a phone (plan 3.15)
  const [noteOff, setNoteOff] = useState(false);
  const [hiddenStylesOpen, setHiddenStylesOpen] = useState(false);
  const [active, setActive] = useState(null);      // { sizeId, col }: the active cell
  const [extent, setExtent] = useState(null);      // the far corner of a range (Shift+arrows, a drag); null: one cell
  const [peek, setPeek] = useState(null);          // the header column being pointed at, for the readout
  const [headH, setHeadH] = useState(SS_PG_HEAD_MIN);
  const [jumpTick, setJumpTick] = useState(0);     // the style picker asked for a jump (jumpRef)
  // Phase 3: the save queue and the editor.
  const [q, setQ] = useState(null);                // the save queue (ssPgQueue); qRef holds the same state, synchronously
  const [editing, setEditing] = useState(null);    // { sizeId, f, init, label, price, frozen } while the editor is open
  const [draftDirty, setDraftDirty] = useState(false);   // the open editor's text differs from its box
  const [tip, setTip] = useState(null);            // a one-off line under the toolbar (undo, a locked price)
  const [retryAt, setRetryAt] = useState(null);    // when a failed call goes again (the amber badge counts down)
  const [, setTick] = useState(0);                 // redraws that count once a second
  const [leaving, setLeaving] = useState(null);    // { to, was }: Back to Sheds or Go to Options waits for the queue to empty
  const [stuck, setStuck] = useState(null);        // { to }: that wait was called off (stopped, retrying, view only)
  const [savedAt, setSavedAt] = useState(null);    // when the last save was answered (the green badge)
  // Phase 4a: adding sizes, the refresh and the backup.
  const [added, setAdded] = useState([]);          // [{ id, styleId, width, length, label }]: sizes this page added, in the order typed
  const [addOpen, setAddOpen] = useState({});      // { [styleId]: true }: that style's "＋ Add sizes" strip is open
  const [addFocus, setAddFocus] = useState(null);  // { id, n }: the cursor goes into that style's strip (each new n)
  const [earlier, setEarlier] = useState(null);    // a backup from earlier on offer ({ savedAt, sizes, count }) until Save them or Discard
  const [earlierRed, setEarlierRed] = useState(null);   // its red entries, listed in the status line until dismissed
  // Phase 4b: copy, paste, fill down and clear.
  const [confirm, setConfirm] = useState(null);    // { text, edits, area }: a change to more than one size, waiting for Continue
  const [said, setSaid] = useState(null);          // { tone, text }: what the last copy, paste, fill or clear said (a refusal, "Copied 6 boxes.")
  const boxRef = useRef(null);
  const gridRef = useRef(null);
  const seqRef = useRef(0);
  const markRef = useRef(null);
  const activeRef = useRef(null);
  const extentRef = useRef(null);
  const scrollNextRef = useRef(false);             // "active" | "extent": a keyboard move scrolls that cell into view
  const jumpRef = useRef(null);
  const styleDoneRef = useRef(false);
  const measuredRef = useRef(null);
  const drawnRef = useRef(null);                   // the size order last drawn (ssPgReanchor)
  const qRef = useRef(null);
  const editRef = useRef(null);                    // the open editor: { sizeId, f, text0, replace, seen }, on its FIELD (a read can move columns)
  const draftRef = useRef("");                     // its text, out of React state: typing re-renders nothing
  const dirtyRef = useRef(false);
  const edInputRef = useRef(null);
  const ringFRef = useRef(null);                   // the overlay's four pieces (PgSelectionOverlay): F in the
  const ringBRef = useRef(null);                   // sticky lane over the frozen columns, B over the options
  const rangeFRef = useRef(null);
  const rangeBRef = useRef(null);
  const awaitRef = useRef(0);                      // the flight this page last sent (ssPgQueue's flight.n)
  const retryTimerRef = useRef(null);
  const aliveRef = useRef(true);
  const addrRef = useRef(null);                    // this page's own address, for putting it back over a held Back
  const passRef = useRef(false);                   // the popstate this page sends itself on its way out (go)
  const viewsRef = useRef({});                     // size id → its last row view (ssPgRowView), so PgRow's memo holds
  const dragRef = useRef(false);
  const flashRef = useRef(null);
  const fnRef = useRef({});                        // this render's handlers, for listeners added once
  const loadRef = useRef(null);                    // `load`, for the refresh (an async read reads it after it lands)
  const refreshTimerRef = useRef(null);            // the 1 s wait after a refresh trigger (plan 4.8), coalescing the rest
  const refreshingRef = useRef(false);             // a refresh read is out
  const refreshAgainRef = useRef(false);           // …and another trigger came meanwhile
  const ownBackupRef = useRef(false);              // this page wrote the backup, so it clears it once nothing is left
  const offeredRef = useRef(false);                // a backup from earlier was looked for (once, on the first read that can edit)
  const tookRef = useRef([]);                      // the keys of the backups on offer (offerEarlier), left in place until answered
  const adoptedRef = useRef([]);                   // keys to remove after this table's next successful own write (filled by Save them)
  // This table's own name for its backup and the "who's open?" answer (plan 4.9 with two tabs): one
  // per mount, so the same tab opening the table again finds what the last one left.
  const [mountId] = useState(() => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);
  const cursorToRef = useRef(null);                // a size just added: the cursor goes to its price once it is drawn
  activeRef.current = active;
  extentRef.current = extent;
  loadRef.current = load;

  // `base` is the last read; `model` is what the grid draws: that read with the sizes this page added
  // and removed since (ssPgLocalModel). Header and columns come from the read alone.
  const base = load.phase === "ready" ? load.model : null;
  const model = useMemo(() => ssPgLocalModel(base, added, q ? q.sizes : null), [base, added, q && q.sizes]);
  // Who may change what (plan 3.16): no editor, no add strip and no paste unless canEdit. RTP locks
  // the price column alone (model.rtpOn). `readOnly` is every reason the badge says "View only", and
  // the operator strip follows it too, so the page never says both "View only" and "Changes are live".
  const tooBig = !!(model && model.guard);
  const readOnly = !!viewOnly || tooBig;
  const editable = load.phase === "ready" && !readOnly;
  // …and once open: a 403 on a save turns the page view-only (q.viewOnly), and an answer for another
  // account stops every save for good (stopped "tenant"). Saving stopped for any other reason still
  // takes edits: they wait for Retry.
  const lostEdit = !!(q && (q.viewOnly || (q.stopped && q.stopped.kind === "tenant")));
  const canEdit = editable && !lostEdit;
  const keepIds = useMemo(() => { const k = {}; added.forEach((a) => { k[a.id] = true; }); return k; }, [added]);
  const rows = useMemo(() => ssPgRows(model, { showHidden, hiddenStylesOpen, adding: canEdit ? addOpen : null, addEmpty: canEdit, keep: keepIds }),
    [model, showHidden, hiddenStylesOpen, addOpen, canEdit, keepIds]);
  const order = useMemo(() => rows.filter((r) => r.kind === "size").map((r) => r.id), [rows]);
  const byId = useMemo(() => {
    const m = {};
    rows.forEach((r) => { if (r.kind === "size") m[r.id] = r; });
    return m;
  }, [rows]);
  const colAt = useMemo(() => {                    // option key → its column in the row
    const m = {};
    if (model) model.cols.forEach((c, i) => { m[c.key] = 3 + i; });
    return m;
  }, [model]);
  const ncols = 3 + (model ? model.cols.length : 0);
  const hh = narrow ? SS_PG_HEAD_NARROW : headH;
  const counts = useMemo(() => ssPgCount(q), [q]);

  // Both reads, and once more when the answer does not add up (plan 4.2): a save landing between two
  // list reads is the usual cause, and a second read settles it. "cap" cannot change by reading
  // again, so it is believed at once. Sequenced, so a Retry that overtakes a slow read wins.
  // The save queue starts from what the read says the server holds: the FIRST load only (and a Retry
  // after it failed). Once the queue exists, every read (the "too big" Reload, Reload after a
  // Discard) is a refresh (refreshNow), through ssPgQueue's refresh and columns rules, which keep red
  // boxes, unsent edits and the call out. Re-initialising would drop them.
  // The first load also reads the backup from earlier (plan 4.9), before the queue can write over it.
  const fetchAll = useCallback(async () => {
    if (qRef.current) { fnRef.current.refreshNow(); return; }
    const my = ++seqRef.current;
    setLoad({ phase: "loading" });
    let r = null, m = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      r = await ssPgFetch(target, clientId);
      if (my !== seqRef.current) return;
      if (!r.ok) break;
      m = ssPgModel(r.cat, r.table);
      if (!m.guard || m.guard === "cap") break;
    }
    if (!r.ok) { setLoad({ phase: "error", error: r.error, status: r.status || null }); return; }
    // Where tests/harness/pricingTable.mjs starts its first-render clock.
    try { performance.mark("ss-pg-data"); } catch (_m) { /* no User Timing */ }
    const fresh = ssPgQueue(null, { type: "init", sizes: ssPgServerSizes(m), cols: m.cols.map((c) => c.key) });
    qRef.current = fresh;
    setQ(fresh);
    setLoad({ phase: "ready", model: m, at: Date.now() });
    fnRef.current.offerEarlier(m);
  }, [target, clientId]);
  useEffect(() => { fetchAll(); }, [fetchAll]);

  useEffect(() => {
    let mq = null;
    try { mq = window.matchMedia(SS_PG_NARROW_MQ); } catch (_e) { return undefined; }
    const on = () => { measuredRef.current = null; setNarrow(mq.matches); };
    if (mq.addEventListener) mq.addEventListener("change", on); else mq.addListener(on);
    return () => { if (mq.removeEventListener) mq.removeEventListener("change", on); else mq.removeListener(on); };
  }, []);

  // THE HEADER HEIGHT IS MEASURED, NOT CAPPED (plan 3.4). An estimate first, from the names' widths
  // in the header's own font (ssPgHeaderHeight); then the drawn names are checked, and if any still
  // runs to a third line or past its box the header grows 8 px and is checked again. All before
  // paint, so no name is ever drawn cut. Below 700 px the header is a fixed 90 px with an ellipsis
  // (portal.html), and the toolbar's readout carries the full name.
  React.useLayoutEffect(() => {
    if (!base || narrow || !gridRef.current) return;
    const spans = [...gridRef.current.querySelectorAll("thead .ss-pg-vh")];
    if (!spans.length) return;
    if (measuredRef.current !== base) {
      measuredRef.current = base;
      const ctx = ssPgMeasureCtx();
      let est = SS_PG_HEAD_MIN;
      if (ctx) {
        // From the longhands: the computed `font` shorthand is "" here, because the grid's
        // tabular-nums is a font-variant the shorthand cannot say, and the canvas then measures in
        // its own 10px default and the header grows 8 px at a time, one layout of the grid each.
        try {
          const cs = getComputedStyle(spans[spans.length - 1]);
          ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        } catch (_f) { /* the canvas default */ }
        est = Math.max(est, ssPgHeaderHeight(spans.map((sp) => sp.textContent), (s) => ctx.measureText(s).width + 1, 16));
      }
      est = Math.min(SS_PG_HEAD_MAX, est);
      if (est !== headH) { setHeadH(est); return; }
    }
    const cut = spans.some((sp) => sp.getBoundingClientRect().width > SS_PG_LINE_H * 2 + 1 || sp.scrollHeight > sp.clientHeight + 1);
    if (cut && headH < SS_PG_HEAD_MAX) setHeadH(Math.min(SS_PG_HEAD_MAX, headH + 8));
  }, [base, narrow, headH]);

  // The active cell's size folded away ("Show hidden sizes" off) or did not come back on a Reload:
  // the cursor moves to the nearest size still drawn (ssPgReanchor), before paint, so the readout
  // keeps a cell and the next arrow key starts there. While a read is out there are no rows at all,
  // so the cursor and the order it was on are kept until the rows return. A range is dropped.
  React.useLayoutEffect(() => {
    if (!model) return;
    const prev = drawnRef.current;
    drawnRef.current = order;
    const a = activeRef.current;
    if (!a || !prev || prev === order) return;
    const next = ssPgReanchor(prev, order, a, ncols);
    if (next !== a) { setActive(next); setExtent(null); }
  }, [order]);

  // THE SELECTION OVERLAY AND THE EDITOR (plan 3.5): placed over the active cell and the range on
  // every move, before paint, by writing their style; no row renders. aria-selected goes on the
  // active <td> itself. A keyboard move scrolls the moved corner into view; the box's scroll-padding
  // keeps it clear of the frozen header and columns (plan 3.6).
  React.useLayoutEffect(() => { fnRef.current.place(); }, [active, extent, editing, rows, hh, narrow, model]);

  // Where tests/harness/pricingTable.mjs stops its first-render clock: the grid committed at its
  // measured height, and the frame after that.
  React.useLayoutEffect(() => {
    if (!base || !gridRef.current) return;
    try {
      performance.mark("ss-pg-grid");
      requestAnimationFrame(() => setTimeout(() => { try { performance.mark("ss-pg-painted"); } catch (_m) { /* no User Timing */ } }, 0));
    } catch (_m) { /* no User Timing */ }
  }, [base, headH]);

  // Jump to a style: ?style= once (Add style's link, which also opens the style's add box with the
  // cursor in it, plan 3.1), then the toolbar's picker. A hidden style opens the hidden section first
  // and jumps on the next commit. The scroll waits a frame, so it lands below the header at its
  // MEASURED height.
  React.useLayoutEffect(() => {
    if (!model) return;
    if (!styleDoneRef.current) {
      styleDoneRef.current = true;
      if (styleParam) {
        jumpRef.current = styleParam;
        const st = [...model.styles, ...model.hiddenStyles].find((s) => s.id === styleParam);
        if (st && canEdit) {
          if (st.sizes.length) setAddOpen((o) => ({ ...o, [st.id]: true }));
          setAddFocus((f) => ({ id: st.id, n: (f ? f.n : 0) + 1 }));
        }
        // Spent: ?style= comes back out of the address, so Back to Sheds and a reload do not jump.
        try {
          const q0 = new URLSearchParams(window.location.search);
          q0.delete("style");
          const rest = q0.toString();
          window.history.replaceState(window.history.state, "", window.location.pathname + (rest ? "?" + rest : "") + window.location.hash);
        } catch (_e) { /* history unavailable */ }
      }
    }
    const want = jumpRef.current;
    if (!want) return;
    if (!hiddenStylesOpen && model.hiddenStyles.some((s) => s.id === want)) { setHiddenStylesOpen(true); return; }
    jumpRef.current = null;
    const first = rows.find((r) => r.kind === "size" && r.style.id === want);
    requestAnimationFrame(() => {
      const g = gridRef.current, box = boxRef.current;
      const band = g && g.querySelector(`tr[data-band="${(window.CSS && CSS.escape) ? CSS.escape(String(want)) : want}"]`);
      const thead = g && g.querySelector("thead");
      if (!band || !box) return;
      box.scrollTop = Math.max(0, band.offsetTop - (thead ? thead.offsetHeight : 0));
      if (first) { setActive({ sizeId: first.id, col: Math.min(1, ncols - 1) }); setExtent(null); }
      // A style with no sizes has no box to land on: the cursor goes into its add strip (the
      // placeholder), the keyboard's way to it.
      else if (canEdit) setAddFocus((f) => ({ id: want, n: (f ? f.n : 0) + 1 }));
    });
  }, [model, rows, hiddenStylesOpen, jumpTick]);

  // THE SEND CLOCK (plan 4.6): 800 ms after the last edit, at most 3 s after the first unsent one,
  // at once after a flush. Re-armed on every change of the queue; one call out at a time.
  useEffect(() => {
    const due = ssPgDueIn(q, Date.now());
    if (due == null) return undefined;
    const t = setTimeout(() => fnRef.current.sendNow(), due);
    return () => clearTimeout(t);
  }, [q]);

  // The amber badge's "Retrying in 15 s" counts down.
  useEffect(() => {
    if (retryAt == null) return undefined;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [retryAt]);

  // Leaving (Back to Sheds, Go to Options, the browser's Back) waits for the queue to empty (plan
  // 3.2: it flushes first). A box that went red since the click calls the wait off and the cursor
  // goes to it, so the builder reads what didn't save before going anywhere (plan 1, 3.14): `was` is
  // the queue's boxes at the click, and a red box is new when its mark is not the one it had then. A
  // transport failure, a stop or a 403 calls the wait off too, and the status line says the page
  // stayed, with Leave anyway (`stuck`); the click is never swallowed and nothing unsent is dropped
  // unseen. Starting another edit while it waits calls it off as well (backToWork), so the page
  // never goes with the editor open.
  useEffect(() => {
    if (!leaving || !q) return;
    const isNew = (id, f, x) => { const p = leaving.was[id] && leaving.was[id][f]; return !p || p.error !== x.error; };
    const red = Object.keys(q.fields).some((id) => Object.keys(q.fields[id]).some((f) => q.fields[id][f].error && isNew(id, f, q.fields[id][f])));
    if (red) { setLeaving(null); fnRef.current.jumpRed(isNew); return; }
    if (q.viewOnly || q.stopped || q.failures) { setLeaving(null); setStuck({ to: leaving.to }); return; }
    if (!counts.pending && !counts.inflight && !counts.creating && !counts.removing && !q.flight) fnRef.current.go(leaving.to);
  }, [leaving, q, counts]);
  // This page's own address after every render (?style= comes back out of it once), for the held
  // Back below: by the time popstate fires the address bar has already moved.
  useEffect(() => {
    addrRef.current = { url: window.location.pathname + window.location.search + window.location.hash, state: window.history.state };
  });
  // "You're still on this page" goes away once nothing is left unsent.
  useEffect(() => {
    if (stuck && !(counts.pending + counts.inflight + counts.creating + counts.removing)) setStuck(null);
  }, [stuck, counts]);

  // A saved box flashes green for 600 ms (plan 3.13), on the <td> itself, so no row renders for it.
  // A box a refresh moved (someone else's save, an Excel upload) flashes grey the same way (plan 4.6).
  React.useLayoutEffect(() => {
    const fl = q && q.flash;
    if (!fl || flashRef.current === fl || !gridRef.current) return;
    flashRef.current = fl;
    const tds = [];
    const mark = (list, cls) => Object.keys(list || {}).forEach((id) => {
      const tr = gridRef.current.querySelector(`tr[data-s="${(window.CSS && CSS.escape) ? CSS.escape(String(id)) : id}"]`);
      if (!tr) return;
      list[id].forEach((f) => {
        const c = f === "price" ? 1 : f === "active" ? 2 : colAt[f.slice(2)];
        const td = c != null ? tr.children[c] : null;
        if (td) { td.classList.add(cls); tds.push([td, cls]); }
      });
    });
    mark(fl.saved, "ss-pg-ok");
    mark(fl.changed, "ss-pg-moved");
    if (tds.length) setTimeout(() => tds.forEach(([td, cls]) => td.classList.remove(cls)), 600);
  }, [q && q.flash]);

  // A size just added (addSizes): once its row is drawn, the cursor goes to its price, so the builder
  // types the prices straight away (plan 8.5, step 6). Before paint, like every move.
  // The grid takes the focus first: its onFocus would otherwise put the cursor on the first price.
  React.useLayoutEffect(() => {
    const id = cursorToRef.current;
    if (!id || order.indexOf(id) < 0) return;
    cursorToRef.current = null;
    const at = { sizeId: id, col: 1 };
    activeRef.current = at;
    try { gridRef.current.focus({ preventScroll: true }); } catch (_f) { /* gone */ }
    scrollNextRef.current = "active";
    setExtent(null);
    setActive(at);
  }, [order]);

  // REFRESH (plan 4.8). The table reads both tables again when another page saves Settings for this
  // account (the "ss:settings-saved" event, or the "ss-settings" BroadcastChannel from another tab of
  // this browser: Add style, a rename, an Excel upload, a colleague's table), and EVERY time the tab
  // comes back into view, which is how a save on another computer arrives (there is no push). Its
  // own saves are told apart by `source` (SS_PAGE_ID, ssSettingsSaved); an event for another account
  // is ignored, one that names none is believed (a read too many costs two reads). The read waits 1 s
  // and coalesces whatever else arrives meanwhile (pokeRefresh), then goes through the queue's refresh
  // and columns rules (refreshNow), never a re-initialised queue.
  useEffect(() => {
    const hear = (d) => {
      if (d && d.source === SS_PAGE_ID) return;
      if (d && d.clientId && clientId && String(d.clientId) !== String(clientId)) return;
      fnRef.current.pokeRefresh();
    };
    const onSaved = (ev) => hear(ev ? ev.detail : null);
    const onShown = () => { if (document.visibilityState === "visible") fnRef.current.pokeRefresh(); };
    let bc = null;
    window.addEventListener("ss:settings-saved", onSaved);
    try { bc = new BroadcastChannel("ss-settings"); bc.onmessage = (m) => hear(m ? m.data : null); } catch (_b) { bc = null; }
    document.addEventListener("visibilitychange", onShown);
    return () => {
      window.removeEventListener("ss:settings-saved", onSaved);
      if (bc) { try { bc.close(); } catch (_c) { /* closed */ } }
      document.removeEventListener("visibilitychange", onShown);
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    };
  }, [clientId]);

  // COPY AND PASTE (plan 3.10-3.11): the browser's own copy and paste events, Ctrl/Cmd+C and V, while
  // the grid itself has the focus (the editor, an add strip and the toolbar keep theirs). No clipboard
  // permission is asked for: the events carry the text. Added once; they call this render's handlers.
  useEffect(() => {
    const mine = () => !!gridRef.current && document.activeElement === gridRef.current;
    const onCopy = (e) => { if (mine()) fnRef.current.copySel(e); };
    const onPaste = (e) => { if (mine()) fnRef.current.pasteFrom(e); };
    document.addEventListener("copy", onCopy);
    document.addEventListener("paste", onPaste);
    return () => {
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("paste", onPaste);
    };
  }, []);

  // An answer or a read that takes the open editor's size out of the queue (a create answered
  // `exists`, the size removed elsewhere) closes the editor, with its text in the status line
  // (dropGoneEditor). Before the backup's write below, so that write no longer holds the text.
  useEffect(() => { fnRef.current.dropGoneEditor(); }, [q]);
  // THE BACKUP (plan 4.9) is rewritten whenever the queue or the editor's text changes (the editor's
  // keystrokes write it too, from onEditInput), and when a backup from earlier is answered.
  useEffect(() => { fnRef.current.saveBackup(); }, [q, draftDirty, earlier, earlierRed]);
  // TWO TABS OF ONE ACCOUNT (plan 8.5 step 10): each table keeps its backup under its own key and,
  // while it is open, answers "who's open?" on this channel with its mountId, so a table opening
  // beside it never offers its live edits back as "from earlier", and never clears or replaces them
  // (offerEarlier). A table that closed, crashed or unmounted answers nothing.
  useEffect(() => {
    let ch = null;
    try {
      ch = new BroadcastChannel(SS_PG_OPEN_CH);
      ch.onmessage = (m) => { if (m && m.data && m.data.ask) { try { ch.postMessage({ open: mountId }); } catch (_p) { /* closed */ } } };
    } catch (_b) { ch = null; }
    return () => { if (ch) { try { ch.close(); } catch (_c) { /* closed */ } } };
  }, [mountId]);

  // The overlay is placed on every move (place, above); the rows also move when the grid's own height
  // changes with nothing else changing: an add strip switching to Add several, its tick-box grid
  // appearing, its error line, its list box dragged taller. The ring then stays on its box.
  useEffect(() => {
    const g = gridRef.current;
    if (!g || typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(() => fnRef.current.place());
    ro.observe(g);
    return () => ro.disconnect();
  }, [load.phase]);

  // LEAVING THE TAB (plan 4.9): the browser asks first while anything is unsent or in flight, or the
  // editor holds text that differs from its box. There is no keepalive send (the invoke wrapper has
  // none, and a request cut off by leaving is an abort); Phase 4's local backup is the safety net.
  // Hiding the tab sends what is waiting at once (plan 4.6).
  //
  // THE BROWSER'S BACK AND FORWARD inside the app (and anything else that moves the address with
  // popstate) leave the way Back to Sheds does (ssPgPopHold): while anything is unsent, in flight or
  // typed in the editor, this page's address goes back (pushState, as the shell does for the
  // Advanced page) and leaveFor sends first, then goes where the pop was going, or stays on what
  // didn't save. Let through, the page would unmount with a follow-up still behind a call out (none
  // can go while one is), and that call's answer, red or not, would never be read. Nothing waiting:
  // the shell routes the pop as usual.
  //
  // Leaving any other way (an account change, signing out) commits the editor and sends what waits
  // on the way out, as far as one call can: its answer is never read, and the server's checks make
  // it safe.
  useEffect(() => {
    aliveRef.current = true;
    const onLeave = (e) => {
      const c = ssPgCount(qRef.current);
      if (!(c.pending + c.inflight + c.creating + c.removing) && !dirtyRef.current) return undefined;
      e.preventDefault();
      e.returnValue = "";
      return "";
    };
    const holdPop = () => {
      if (passRef.current) return false;
      const c = ssPgCount(qRef.current), back = addrRef.current;
      if ((!(c.pending + c.inflight + c.creating + c.removing) && !dirtyRef.current) || !back) return false;
      const to = { url: window.location.pathname + window.location.search + window.location.hash, state: window.history.state };
      try { window.history.pushState(back.state, "", back.url); } catch (_h) { return false; }
      try { ssPhonePortMoved(); } catch (_p) { /* the phone extension hears of it on the next move */ }
      fnRef.current.leaveFor(to);
      return true;
    };
    const onVis = () => { if (document.visibilityState === "hidden") fnRef.current.flushNow(); };
    const onUp = () => { dragRef.current = false; };
    window.addEventListener("beforeunload", onLeave);
    ssPgPopHold = holdPop;
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("mouseup", onUp);
    return () => {
      try { fnRef.current.commitEdit(); } catch (_c) { /* best effort: the page is going */ }
      try { fnRef.current.flushNow(); } catch (_f) { /* best effort: the page is going */ }
      aliveRef.current = false;
      clearTimeout(retryTimerRef.current);
      window.removeEventListener("beforeunload", onLeave);
      if (ssPgPopHold === holdPop) ssPgPopHold = null;
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const onPeek = useCallback((e) => {
    const th = e.target && e.target.closest ? e.target.closest("th[data-col]") : null;
    setPeek(th ? Number(th.getAttribute("data-col")) : null);
  }, []);
  const onPeekEnd = useCallback(() => setPeek(null), []);
  const toggleHiddenStyles = useCallback(() => setHiddenStylesOpen((o) => !o), []);
  const head = useMemo(() => (base ? (
    <>
      <colgroup>
        <col style={{ width: 64 }} /><col style={{ width: 76 }} /><col style={{ width: 30 }} />
        {base.cols.map((c) => <col key={c.key} style={{ width: SS_PG_COL_W }} />)}
      </colgroup>
      <PgHeader sections={base.sections} cols={base.cols} rtpOn={base.rtpOn} onPeek={onPeek} onPeekEnd={onPeekEnd} />
    </>
  ) : null), [base, onPeek, onPeekEnd]);
  // The add strips' two callbacks, stable so the rows' memo holds; they call this render's handlers.
  const onAddSizes = useCallback((styleId, sizes, skipped) => fnRef.current.addSizes(styleId, sizes, skipped), []);
  const onCloseAdd = useCallback((styleId) => fnRef.current.closeAdd(styleId), []);
  // Each size row draws the server's values with this page's edits on top (ssPgRowView). A row's
  // view is rebuilt only when its own size or its own boxes changed, and handed back as the very same
  // object when nothing it draws did, so PgRow's memo holds: an arrow key renders no row, a commit one.
  const body = useMemo(() => {
    const views = viewsRef.current;
    const qs = q ? q.sizes : null, qf = q ? q.fields : null;
    return rows.map((r, i) => {
      const ri = 3 + i;   // aria-rowindex: the two header rows come first
      if (r.kind === "size") {
        const z = r.size;
        const s = qs ? qs[z.id] : null, fs = qf ? qf[z.id] : null;
        let c = views[z.id];
        if (!c || c.z !== z || c.s !== s || c.fs !== fs) {
          const v = ssPgRowView(z, s, fs, model.cols);
          const was = c && c.v;
          if (was && was.values.join("\u0001") === v.values.join("\u0001")) v.values = was.values;
          const same = was && was.values === v.values && was.priceText === v.priceText && was.offered === v.offered
            && was.noPrice === v.noPrice && was.hidden === v.hidden && was.marks === v.marks;
          c = views[z.id] = { z, s, fs, v: same ? was : v };
        }
        const v = c.v;
        const busy = s && s.creating ? "adding" : q && q.removes[z.id] ? "removing" : "";
        return <PgRow key={r.id} rowIndex={ri} sizeId={z.id} label={z.label} title={z.title} priceText={v.priceText}
          offered={v.offered} noPrice={v.noPrice} hidden={v.hidden} values={v.values} marks={v.marks} rtp={!!(model && model.rtpOn)}
          busy={busy} removable={canEdit && ssPgCanRemove(q, z.id, z)} />;
      }
      if (r.kind === "band") {
        return <PgStyleBand key={r.id} rowIndex={ri} styleId={r.style.id} label={r.style.label} total={r.total} hidden={r.hidden} folded={r.folded} ncols={ncols}
          canAdd={canEdit} open={!!addOpen[r.style.id] || !r.total} />;
      }
      if (r.kind === "add") {
        return <PgAddSizes key={r.id} rowIndex={ri} styleId={r.style.id} styleLabel={r.style.label} existing={r.style.sizes} ncols={ncols}
          empty={r.empty} focusKey={addFocus && addFocus.id === r.style.id ? addFocus.n : 0} onAdd={onAddSizes} onClose={onCloseAdd} />;
      }
      if (r.kind === "empty") return <PgNoteRow key={r.id} rowIndex={ri} text={r.text} ncols={ncols} />;
      return <PgHiddenStylesRow key={r.id} rowIndex={ri} count={r.count} open={r.open} ncols={ncols} onToggle={toggleHiddenStyles} />;
    });
  }, [rows, model, ncols, toggleHiddenStyles, q && q.sizes, q && q.fields, q && q.removes, canEdit, addOpen, addFocus, onAddSizes, onCloseAdd]);

  // ── Handlers and what to draw (no hooks below this line) ──
  // (tooBig, readOnly, editable, lostEdit and canEdit are worked out above: the rows need them.)
  const canEditNow = () => editable && !!qRef.current && !qRef.current.viewOnly && !(qRef.current.stopped && qRef.current.stopped.kind === "tenant");
  const rtp = !!(model && model.rtpOn);

  // The queue, applied synchronously: qRef is the truth the transport reads, and setQ draws it.
  const apply = (ev) => {
    const next = ssPgQueue(qRef.current, ev);
    if (next !== qRef.current) { qRef.current = next; setQ(next); }
    return next;
  };
  const fieldOf = (col) => (col === 1 ? "price" : col === 2 ? "active" : model && model.cols[col - 3] ? "c:" + model.cols[col - 3].key : null);
  const colOf = (f) => (f === "price" ? 1 : f === "active" ? 2 : colAt[String(f).slice(2)]);
  // A box's value as drawn: this page's newest edit, else the server's.
  const shownOf = (sizeId, f) => {
    const cur = qRef.current;
    const s = cur && cur.sizes[sizeId];
    const x = cur && cur.fields[sizeId] && cur.fields[sizeId][f];
    return x && x.pending ? x.pending.to : x && x.inflight ? x.inflight.to : ssPgVal(s, f);
  };
  // A size whose Remove is waiting or out takes no edit: its boxes would go with it, unsaid.
  const removing = (sizeId) => !!(qRef.current && qRef.current.removes[sizeId]);
  const focusGrid = () => { try { gridRef.current.focus({ preventScroll: true }); } catch (_f) { /* gone */ } };
  const colName = (c) => (c === 0 ? "Size" : c === 1 ? "Price" : c === 2 ? "Offered" : (model && model.cols[c - 3] ? model.cols[c - 3].label : ""));
  const whereOf = (sizeId) => { const r = byId[sizeId]; return r ? `${r.style.label} ${r.size.label}` : ""; };

  // ── The transport (plan 4.7) ──
  // One call at a time through ssStyleSaveCall (25 s deadline, one retry through the functions
  // host), filed as pricing_table_side_door, with targetClientId ALWAYS on the body: the side door is
  // a raw fetch that skips 01-core's wrapper, so the view-as target must already be on it, and the
  // answer's clientId is checked here (ssPgAnswerKind), not by the wrapper's tripwire.
  const run = (flight) => {
    awaitRef.current = flight.n;
    clearTimeout(retryTimerRef.current);
    setRetryAt(null);
    const body = { action: "save_pricing_cells", targetClientId: target || null, creates: flight.body.creates, removes: flight.body.removes, sizes: flight.body.sizes };
    Promise.resolve(ssStyleSaveCall(body, "Pricing table", "pricing_table_side_door"))
      .catch((err) => ({ data: null, error: { message: (err && err.message) || "Save failed", name: "FunctionsFetchError" } }))
      .then((r) => {
        if (!aliveRef.current) return;   // the page is gone; the server's checks make a late answer harmless
        const cur = qRef.current;
        if (!cur || !cur.flight || cur.flight.n !== flight.n) return;   // discarded meanwhile
        const v = ssPgAnswerKind(r, clientId);
        if (v.kind === "ok") landed(flight, r.data); else failed(flight, v);
      });
  };
  const landed = (flight, data) => {
    apply({ type: "ok", n: flight.n, answer: data, at: Date.now() });
    setSavedAt(Date.now());
    const res = Array.isArray(data.results) ? data.results.filter(Boolean) : [];
    const made = Array.isArray(data.created) ? data.created.filter(Boolean) : [];
    const gone = Array.isArray(data.removed) ? data.removed.filter(Boolean) : [];
    // Designers open in this browser look again (the side door skips the wrapper that says so).
    if (res.some((x) => x.status === "saved") || made.some((x) => x.status === "created") || gone.some((x) => x.status === "removed" && !x.gone)) ssSettingsSaved(clientId);
    // `exists`: someone else added that size first, and it takes the new row's place; it may not be
    // in this page's read yet, so the table reads again to draw it (with what was typed on it, red).
    // A refused remove means the size changed somewhere else since this page read it: the read
    // brings its new version, and its Remove goes. A conflict or a duplicate says someone else saved
    // that size meanwhile, and its answer carries only the boxes this call named (and the price and
    // Offered): the read brings the rest of the size (plan 4.6's refresh rule, through the queue), so
    // no box goes on showing a number that is no longer on file.
    if (made.some((x) => x.status === "exists") || gone.some((x) => x.status === "refused")
      || res.some((x) => x.status === "conflict" || x.status === "duplicate")) pokeRefresh();
    // One info row per answer that had conflicts or refusals: counts only (plan 4.7).
    const conflicts = res.filter((x) => x.status === "conflict").length;
    const refused = res.filter((x) => x.status === "refused" || x.status === "missing").length
      + made.filter((x) => x.status === "refused" || x.status === "exists").length + gone.filter((x) => x.status === "refused").length;
    const boxes = res.reduce((n, x) => n + (x.cellErrors ? Object.keys(x.cellErrors).length : 0), 0);
    if (conflicts || refused || boxes) {
      ssLogError("portal", `pricing table: a save came back with ${conflicts} conflict(s), ${refused} refused size(s), ${boxes} refused box(es)`,
        "pricing_table_conflicts", { conflicts, refused, cellErrors: boxes, sizes: res.length }, "info");
    }
  };
  const failed = (flight, v) => {
    if (v.kind === "transport") {
      const st = apply({ type: "fail", n: flight.n, kind: "transport", at: Date.now() });
      if (st.stopped) {
        ssLogError("portal", "pricing table: saving stopped after 5 failed tries", "pricing_table_saving_stopped", { status: v.status || null }, "info");
        return;
      }
      const ms = ssPgBackoff(st.failures, typeof window !== "undefined" ? window.__ssPgBackoffMs : null);
      setRetryAt(Date.now() + ms);
      retryTimerRef.current = setTimeout(() => {
        const cur = qRef.current;
        if (aliveRef.current && cur && cur.flight && cur.flight.n === flight.n && !cur.stopped) run(cur.flight);
      }, ms);
      return;
    }
    if (v.kind === "refused") {
      // The server named something the browser let through: a parity bug. The server's sentence goes
      // in the row (it names fields and counts, never a price); the builder gets a plain one.
      ssLogError("portal", `pricing table: the server refused a save the page let through: ${String(v.reason || "").slice(0, 300)}`,
        "pricing_table_save_refused", { status: v.status || null });
      apply({ type: "fail", n: flight.n, kind: "refused", reason: SS_PG_REFUSED_CALL });
      return;
    }
    if (v.kind === "forbidden") { apply({ type: "fail", n: flight.n, kind: "forbidden", reason: SS_PG_FORBIDDEN }); closeEdit(); return; }
    if (v.kind === "auth") {
      apply({ type: "fail", n: flight.n, kind: "auth", reason: "you were signed out" });
      // The main host's 401 already signed this browser out (ssFetch); the side door's did not.
      try { if (ssOnSessionExpired) ssOnSessionExpired(); } catch (_s) { /* the shell's own guard */ }
      return;
    }
    ssLogError("portal", "pricing table: a save was answered for a different account", "pricing_table_wrong_tenant",
      { asked: String(clientId || ""), got: v.reason || null });
    apply({ type: "fail", n: flight.n, kind: "tenant", reason: "the server answered for a different account. Reload this tab" });
    closeEdit();
  };
  const sendNow = () => {
    const cur = qRef.current;
    if (!cur || cur.flight || cur.stopped || cur.viewOnly) return;
    const st = apply({ type: "send" });
    if (st.flight && st.flight.n !== awaitRef.current) run(st.flight);
  };
  const flushNow = () => { if (!qRef.current) return; apply({ type: "flush" }); sendNow(); };
  const retryNow = () => { const cur = qRef.current; if (cur && cur.flight) run(cur.flight); };
  const resume = () => {
    const st = apply({ type: "resume" });
    if (st.flight) run(st.flight); else sendNow();
  };
  // Discard, then read the table again when the dropped call may have landed (q.unsure): the boxes
  // show what is on file, not what was last confirmed. If the read fails too, the badge keeps saying
  // so, with Reload.
  const discard = () => {
    clearTimeout(retryTimerRef.current);
    setRetryAt(null);
    const st = apply({ type: "discard" });
    if (st.unsure) refreshNow();
  };

  // ── The refresh (plan 4.6, 4.8) ──
  // A trigger waits 1 s (the harness shortens it: window.__ssPgRefreshMs) and coalesces with any
  // other that comes meanwhile; one read is out at a time, and a trigger during it reads once more
  // after it.
  const pokeRefresh = () => {
    if (refreshTimerRef.current) return;
    const w = typeof window !== "undefined" ? window.__ssPgRefreshMs : null;
    const ms = w != null && isFinite(Number(w)) ? Number(w) : 1000;
    refreshTimerRef.current = setTimeout(() => { refreshTimerRef.current = null; fnRef.current.refreshNow(); }, ms);
  };
  // Both reads, then the queue's rules (adoptRead). Like the first load, a read that does not add up
  // is read once more. A read that fails changes nothing: the next trigger reads again.
  const refreshNow = async () => {
    clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = null;
    if (refreshingRef.current) { refreshAgainRef.current = true; return; }
    const cur = qRef.current;
    if (!cur || !loadRef.current || loadRef.current.phase !== "ready") return;
    refreshingRef.current = true;
    const okAt = cur.oks, my = seqRef.current;
    let r = null, m = null;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        r = await ssPgFetch(target, clientId);
        if (!aliveRef.current || my !== seqRef.current || !r.ok) break;
        m = ssPgModel(r.cat, r.table);
        if (!m.guard || m.guard === "cap") break;
      }
    } finally { refreshingRef.current = false; }
    if (!aliveRef.current || my !== seqRef.current) return;
    if (r && r.ok && m) fnRef.current.adoptRead(m, okAt);
    if (refreshAgainRef.current) { refreshAgainRef.current = false; fnRef.current.pokeRefresh(); }
  };
  // A fresh read into the queue (never a re-initialised queue): the columns first (an option archived
  // elsewhere drops its unsaved boxes, with the note; a new one is a new column), then the refresh
  // rule, which keeps red boxes, unsent edits and the call out, turns an unsent box red when its
  // starting value changed under it (an Excel upload, a colleague), and gives every other size the
  // read's version and values. A read asked for before the latest answer landed may predate that
  // save, so it is dropped and another is asked for. A read that does not add up (the guard) never
  // replaces one that did; while the page is already "too big" it does, so Reload can clear it, and
  // the backup from earlier, which the guarded first read could not offer, is offered then (before
  // the first edit could write over it).
  //
  // The columns can move under the cursor (an option added or archived in Options, in another tab).
  // The open editor is on its FIELD (editRef.f), so it still saves into its own option, wherever that
  // column now is; the cursor and a range move with their options too (ssPgRekeyCell). An editor
  // whose option went away is closed, and its changed text is counted in the columns note.
  const adoptRead = (m, okAt) => {
    const cur = qRef.current, was = loadRef.current && loadRef.current.model;
    if (!cur || !was) return;
    if (cur.oks !== okAt) { pokeRefresh(); return; }
    if (m.guard && !was.guard) return;
    const names = {};
    was.cols.forEach((c) => { names[c.key] = c.label; });
    const ed = editRef.current;
    const edKey = ed && ed.f.slice(0, 2) === "c:" ? ed.f.slice(2) : null;
    const edGone = edKey != null && !m.cols.some((c) => c.key === edKey);
    apply({ type: "columns", keys: m.cols.map((c) => c.key), names, drafts: edGone && dirtyRef.current ? [edKey] : [] });
    const st = apply({ type: "refresh", okAt, sizes: ssPgServerSizes(m) });
    const a = activeRef.current, x = extentRef.current;
    const na = ssPgRekeyCell(a, was.cols, m.cols), nx = ssPgRekeyCell(x, was.cols, m.cols);
    if (na !== a) { activeRef.current = na; setActive(na); }
    if (nx !== x) { extentRef.current = nx; setExtent(nx); }
    if (edGone) {
      const had = !!edInputRef.current && document.activeElement === edInputRef.current;
      closeEdit();
      if (had) focusGrid();
    }
    setLoad((l) => ({ phase: "ready", model: m, at: l.at }));
    if (st.reread) pokeRefresh();
    if (was.guard && !m.guard) offerEarlier(m);
  };

  // ── Adding and removing sizes (plan 3.7) ──
  const byStyle = (id) => (model ? [...model.styles, ...model.hiddenStyles].find((st) => st.id === id) || null : null);
  // A new id for a size, minted here (the server takes the browser's id: plan 4.3).
  const newId = () => {
    try { if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID(); } catch (_c) { /* not a secure context */ }
    const b = new Uint8Array(16);
    try { window.crypto.getRandomValues(b); } catch (_r) { for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256); }
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };
  // The strip hands over sizes it has checked (ssPgParseSizeList, ssPgSizeGrid). Each becomes a
  // create in the queue, in the order typed, and a row at the end of its style saying "Adding…"; the
  // queue sends creates first, at most 50 entries to a call, and edits typed on a new size wait for
  // its answer (its version). The strip closes, unless it is a style's empty placeholder; the cursor
  // goes to the first new price; sizes already there are named in the status line. False: nothing
  // was taken (the page can't edit now), and the strip keeps what was typed.
  const addSizes = (styleId, sizes, skipped) => {
    if (!canEditNow() || !Array.isArray(sizes) || !sizes.length) return false;
    commitEdit();
    backToWork();
    const made = sizes.map((z) => ({ id: newId(), styleId, width: z.width, length: z.length, label: z.label }));
    made.forEach((a) => apply({ type: "create", id: a.id, styleId, width: a.width, length: a.length, at: Date.now() }));
    setAdded((list) => [...list, ...made]);
    setAddOpen((o) => { if (!o[styleId]) return o; const next = { ...o }; delete next[styleId]; return next; });
    cursorToRef.current = made[0].id;
    const st = byStyle(styleId);
    const skip = Array.isArray(skipped) ? skipped : [];
    setTip(skip.length ? `${skip.join(", ")} ${skip.length === 1 ? "is" : "are"} already in ${st ? st.label : "this style"}, so ${skip.length === 1 ? "it was" : "they were"} skipped.` : null);
    sendNow();
    return true;
  };
  const closeAdd = (styleId) => {
    setAddOpen((o) => { if (!o[styleId]) return o; const next = { ...o }; delete next[styleId]; return next; });
    focusGrid();
  };
  // "＋ Add sizes" on a band: opens the strip with the cursor in it, or closes it. On a style with no
  // sizes the strip is the placeholder and is always open: the cursor goes into it.
  const toggleAdd = (styleId) => {
    if (!canEditNow()) return;
    const st = byStyle(styleId);
    if (st && st.sizes.length && addOpen[styleId]) { closeAdd(styleId); return; }
    if (st && st.sizes.length) setAddOpen((o) => ({ ...o, [styleId]: true }));
    setAddFocus((f) => ({ id: styleId, n: (f ? f.n : 0) + 1 }));
  };
  // Remove (plan 3.7): only a size that was never priced or edited (ssPgCanRemove; the server checks
  // again). Through the queue, sent at once; the row goes when the answer says removed.
  const removeSize = (id) => {
    if (!canEditNow() || !ssPgCanRemove(qRef.current, id, byId[id] ? byId[id].size : null)) return;
    commitEdit();
    backToWork();
    apply({ type: "remove", id, at: Date.now() });
    sendNow();
  };
  // Clicks on the grid's own buttons ("＋ Add sizes" on a band, ✕ Remove on a size): one handler on the
  // grid, so the bands and rows take no function and their memos hold.
  const onAct = (e) => {
    const b = e.target && e.target.closest ? e.target.closest("[data-pg-act]") : null;
    if (!b || !gridRef.current || !gridRef.current.contains(b)) return;
    const act = b.getAttribute("data-pg-act"), id = b.getAttribute("data-pg-id");
    if (act === "add") toggleAdd(id);
    else if (act === "remove") removeSize(id);
  };

  // ── The backup (plan 4.9) ──
  // Under "ss-pg-pending:<userId>:<clientId>": this person, this account (the view-as target when an
  // operator is viewing one), so a backup is only ever offered back to the account it was made on.
  // Each table writes its own key under that, ":<mountId>" after it, so two tabs of one account never
  // write over each other's (one tab's empty queue used to clear the other's draft); a backup under
  // the plain key is one no open table owns. Written only by a page that can edit, and cleared by the
  // page that wrote it once nothing is left. Storage can be blocked or full: then there is simply no
  // backup, and the page works the same.
  const backupKey = ssCurrentUserId && clientId ? `ss-pg-pending:${ssCurrentUserId}:${clientId}` : null;
  const ownKey = backupKey ? `${backupKey}:${mountId}` : null;
  const draftOf = () => {
    const ed = editRef.current;
    if (!ed || !dirtyRef.current) return null;
    return ed.f !== "active" ? { sizeId: ed.sizeId, key: ed.f, text: draftRef.current, seen: ed.seen } : null;
  };
  // The backups Save them put into the queue (adoptedRef) go after this table's next own write, once
  // the queue (and so this table's key) holds what they held; a write that fails keeps them in place.
  const saveBackup = () => {
    if (!backupKey || !editable || !qRef.current) return;
    const b = ssPgBackup(qRef.current, draftOf(), Date.now());
    try {
      if (b) { localStorage.setItem(ownKey, JSON.stringify(b)); ownBackupRef.current = true; }
      else if (ownBackupRef.current) { localStorage.removeItem(ownKey); ownBackupRef.current = false; }
      if (adoptedRef.current.length) { adoptedRef.current.forEach((k) => localStorage.removeItem(k)); adoptedRef.current = []; }
    } catch (_e) { /* storage blocked or full: no backup */ }
  };
  // Who else is open (SS_PG_OPEN_CH): `done` gets { mountId: true } for every table that answers
  // within a moment. Without the channel nobody answers, and every backup is from earlier.
  const whoIsOpen = (done) => {
    let ch = null;
    const open = {};
    try { ch = new BroadcastChannel(SS_PG_OPEN_CH); } catch (_b) { done(open); return; }
    ch.onmessage = (m) => { if (m && m.data && m.data.open) open[String(m.data.open)] = true; };
    try { ch.postMessage({ ask: true }); } catch (_p) { /* closed */ }
    setTimeout(() => { try { ch.close(); } catch (_c) { /* closed */ } done(open); }, 300);
  };
  // On open (the first read that can edit, once): the backups from earlier, every one under this
  // person and account that no open table answers for (a tab closed, a crash, a sign-out), merged
  // (ssPgBackupMerge) and offered back with the banner, unless this page can't edit (view-only pages
  // never send one, and leave them stored). One older than 7 days, or one that can't be read, is
  // dropped. What is offered stays under its own keys (tookRef) until Save them or Discard, so a
  // second crash before the builder answers loses nothing; red entries alone are shown once and go.
  const offerEarlier = (m) => {
    if (!backupKey || viewOnly || (m && m.guard)) return;
    if (offeredRef.current) return;
    offeredRef.current = true;
    const keys = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k !== ownKey && (k === backupKey || k.indexOf(backupKey + ":") === 0)) keys.push(k);
      }
    } catch (_e) { return; }
    if (!keys.length) return;
    whoIsOpen((open) => {
      if (!aliveRef.current) return;
      const found = [], took = [];
      keys.forEach((k) => {
        if (k !== backupKey && open[k.slice(backupKey.length + 1)]) return;   // another tab's own, live
        let raw = null;
        try { raw = localStorage.getItem(k); } catch (_e) { return; }
        if (raw == null) return;
        const b = ssPgBackupLoad(raw, Date.now());
        if (!b) { try { localStorage.removeItem(k); } catch (_e) { /* blocked */ } return; }
        found.push(b);
        took.push(k);
      });
      const b = ssPgBackupMerge(found);
      if (!b) return;
      tookRef.current = took;
      if (!b.count) {
        try { took.forEach((k) => localStorage.removeItem(k)); } catch (_e) { /* blocked */ }
        tookRef.current = [];
      }
      if (b.count) setEarlier({ savedAt: b.savedAt, sizes: b.sizes, creates: b.creates || null, count: b.count });
      if (b.red.length) setEarlierRed(b.red);
    });
  };
  // Save them: the stored edits go into the queue on their stored version and starting values
  // (ssPgQueue "restore"), and out at once. The red entries stay listed until dismissed, and are no
  // longer stored. Not while a call is out (the button is greyed): restore goes on stored versions
  // only when nothing is in flight.
  const saveEarlier = () => {
    const b = earlier;
    if (!b || !canEditNow() || (qRef.current && qRef.current.flight)) return;
    setEarlier(null);
    adoptedRef.current = [...adoptedRef.current, ...tookRef.current];
    tookRef.current = [];
    const had = qRef.current.sizes;
    const st = apply({ type: "restore", sizes: b.sizes, creates: b.creates, at: Date.now() });
    // A size added again (its create never landed) is drawn at the end of its style, "Adding…".
    const again = Object.keys(b.creates || {}).filter((id) => !had[id] && st.sizes[id] && st.sizes[id].creating)
      .map((id) => { const c = b.creates[id]; return { id, styleId: c.styleId, width: c.width, length: c.length, label: `${c.width}x${c.length}` }; });
    if (again.length) setAdded((list) => [...list, ...again]);
    sendNow();
    focusGrid();
  };
  // Discard: the backup is gone, red entries and all.
  const discardEarlier = () => {
    try { tookRef.current.forEach((k) => localStorage.removeItem(k)); } catch (_e) { /* blocked */ }
    tookRef.current = [];
    setEarlier(null);
    setEarlierRed(null);
    focusGrid();
  };
  const dismissEarlierRed = () => {
    setEarlierRed(null);
    focusGrid();
  };
  // The open editor's size left the queue under it (dropGoneEditor's effect): a create answered
  // `exists` (someone else added these dimensions first) or a read that no longer has the size. Its
  // text has no box to go into, so the editor closes and the status line quotes it.
  const dropGoneEditor = () => {
    const ed = editRef.current, cur = qRef.current;
    if (!ed || !cur || cur.sizes[ed.sizeId]) return;
    const t = dirtyRef.current ? draftRef.current : null;
    const label = editing ? editing.label : "";
    const had = !!edInputRef.current && document.activeElement === edInputRef.current;
    closeEdit();
    if (had) focusGrid();
    if (t == null) return;
    setSaid({ tone: "amber", text: cur.renamed[ed.sizeId]
      ? `${label}: someone else just added this size, so “${t}” wasn't saved. Check its numbers and type yours again.`
      : `${label} isn't on this account any more, so “${t}” wasn't saved.` });
  };

  // ── Editing (plan 3.5, 3.9, 3.10) ──
  // A box's text in the editor: the plain number ("4800.5", never "$4,800.50"), or empty.
  const editText = (sizeId, f) => {
    const v = shownOf(sizeId, f);
    return f === "price" ? (v == null ? "" : String(v)) : (Number(v) > 0 ? String(Number(v)) : "");
  };
  // Typed text into the queue, for one box by its FIELD (`f`: "price" or "c:<key>"): refused right
  // here when it breaks the rules (red, never sent), else a commit. "A value equal to what is stored
  // is always accepted" is the parsers' `stored`. `extra` is the editor's { seen }. False when the box
  // is red after it (refused text, or the box moved under the open editor): the caller keeps the
  // cursor there. An option no longer drawn takes nothing (the editor on one is closed first, with
  // the columns note: adoptRead).
  const commitText = (sizeId, f, text, extra = null) => {
    const s = qRef.current && qRef.current.sizes[sizeId];
    if (!f || !s || f === "active" || colOf(f) == null) return true;
    const p = f === "price" ? ssPgParsePrice(text, ssPgVal(s, f)) : ssPgParseQty(text, ssPgVal(s, f));
    if (!p.ok) { apply({ type: "invalid", sizeId, f, typed: text, reason: p.error, at: Date.now() }); return false; }
    const st = apply({ type: "commit", sizeId, f, value: p.value, at: Date.now(), ...(extra || {}) });
    return !(st.fields[sizeId] && st.fields[sizeId][f] && st.fields[sizeId][f].error);
  };
  // Back to work while a leave waits for its save (Back clicked, then a box): the leave is called
  // off, and the builder clicks Back again when done. Going once the queue emptied would drop an
  // editor opened meanwhile, whose text is in no queue, or leave in the middle of the next edit.
  const backToWork = () => { if (leaving) setLeaving(null); };
  const startEdit = (cell, key) => {
    if (!cell || !canEditNow()) return;
    if (cell.col === 0) { setTip(SS_PG_SIZE_FIXED); return; }
    if (cell.col === 2) { if (key == null) toggleOffered(cell); return; }
    if (cell.col === 1 && rtp) { setTip(SS_PG_RTP + "."); return; }
    const f = fieldOf(cell.col);
    if (!f || !qRef.current.sizes[cell.sizeId]) return;
    if (removing(cell.sizeId)) { setTip(SS_PG_REMOVING); return; }
    backToWork();
    const text0 = editText(cell.sizeId, f);
    const init = key != null ? key : text0;
    // `seen`: the value the builder is typing over, for the queue's check that nothing moved it
    // while the editor was open. The editor is on the FIELD, never on the column number: a read
    // that adds or archives an option moves the columns while it is open (adoptRead).
    editRef.current = { sizeId: cell.sizeId, f, text0, replace: key != null, seen: shownOf(cell.sizeId, f) };
    draftRef.current = init;
    dirtyRef.current = init !== text0;
    setDraftDirty(dirtyRef.current);
    setTip(null);
    setSaid(null);
    setExtent(null);
    setEditing({ sizeId: cell.sizeId, f, init, price: cell.col === 1, frozen: ssPgColBox(cell.col, narrow).frozen,
      label: `${whereOf(cell.sizeId)}, ${colName(cell.col)}` });
  };
  // Close the editor without a word (Escape, or the page went view-only).
  const closeEdit = () => {
    if (!editRef.current) return;
    editRef.current = null;
    dirtyRef.current = false;
    setDraftDirty(false);
    setEditing(null);
  };
  // Close it and put what it holds into the queue. Opened in place and left as it was: nothing.
  // False when the box is red after it (the text was refused here, or the box moved while the editor
  // was open); nothing was sent.
  const commitEdit = () => {
    const ed = editRef.current;
    if (!ed) return true;
    const text = draftRef.current;
    closeEdit();
    return ed.replace || text !== ed.text0 ? commitText(ed.sizeId, ed.f, text, { seen: ed.seen }) : true;
  };
  const toggleOffered = (cell) => {
    if (!canEditNow() || !qRef.current.sizes[cell.sizeId]) return;
    if (removing(cell.sizeId)) { setTip(SS_PG_REMOVING); return; }
    // Offered needs a price on file (the server ticks it with the first one): plan 3.9.
    if (qRef.current.sizes[cell.sizeId].price == null || shownOf(cell.sizeId, "price") == null) { setTip(SS_PG_ADD_PRICE + "."); return; }
    backToWork();
    apply({ type: "commit", sizeId: cell.sizeId, f: "active", value: !shownOf(cell.sizeId, "active"), at: Date.now() });
  };
  // Delete or Backspace on one box (plan 3.10): a blank price, an empty option, Offered unticked.
  // Never asks: only a change to more than one size does (plan 3.12: a range goes through clearSel).
  // On the Size box it is the keyboard's Remove (the ✕ is out of Tab's reach): a size added by
  // mistake goes (ssPgCanRemove, plan 3.7); any other says why it can't.
  const clearCell = (cell) => {
    if (!canEditNow() || !cell) return;
    if (cell.col === 0) {
      if (ssPgCanRemove(qRef.current, cell.sizeId, byId[cell.sizeId] ? byId[cell.sizeId].size : null)) removeSize(cell.sizeId);
      else setTip(removing(cell.sizeId) ? SS_PG_REMOVING : SS_PG_REMOVE_RULE);
      return;
    }
    if (removing(cell.sizeId)) { setTip(SS_PG_REMOVING); return; }
    if (cell.col === 1 && rtp) { setTip(SS_PG_RTP + "."); return; }
    if (cell.col === 2) { if (shownOf(cell.sizeId, "active")) toggleOffered(cell); return; }
    backToWork();
    commitText(cell.sizeId, fieldOf(cell.col), "");
  };
  const moveTo = (next, which = "active") => {
    if (!next) return;
    scrollNextRef.current = which;
    if (which === "extent") { setExtent(next); return; }
    setExtent(null);
    setActive(next);
  };
  // The editor's keys: Enter commits and moves down (Shift+Enter up), Tab right (Shift+Tab left,
  // wrapping rows), Up and Down commit and move; Left and Right stay in the text; Escape cancels.
  // Text the rules refuse turns the box red and the cursor STAYS on it, so its reason is on the
  // status line at once instead of behind the "boxes need you" badge.
  const onEditKey = (e) => {
    const k = e.key;
    if (k === "Escape") { e.preventDefault(); closeEdit(); focusGrid(); return; }
    if (k !== "Enter" && k !== "Tab" && k !== "ArrowUp" && k !== "ArrowDown") return;
    e.preventDefault();
    const ed = editRef.current;
    if (!ed) return;
    const at = { sizeId: ed.sizeId, col: colOf(ed.f) };
    const took = commitEdit();
    focusGrid();
    if (!took) return;
    moveTo(ssPgMove(order, ncols, at, k === "Enter" ? (e.shiftKey ? "ArrowUp" : "ArrowDown") : k, e.shiftKey));
  };
  const onEditInput = (e) => {
    draftRef.current = e.target.value;
    const d = !!editRef.current && e.target.value !== editRef.current.text0;
    if (d !== dirtyRef.current) { dirtyRef.current = d; setDraftDirty(d); }
    saveBackup();   // the open editor's text is part of the backup (plan 4.9), keystroke by keystroke
  };
  // Leaving the box commits it (plan 3.10: any move away commits), but not the window losing focus
  // to another app: the editor is still there when the builder comes back.
  const onEditBlur = () => {
    try { if (!document.hasFocus()) return; } catch (_d) { /* no document */ }
    commitEdit();
  };

  // ── Copy, paste, fill down and clear (plan 3.10-3.12, Phase 4b) ──
  // The selection as rows of the drawn sizes (`order`) and grid columns: the active cell and the far
  // corner of a range (ssPgFillPlan's `sel`). null when no box is active or its size isn't drawn.
  const selRect = () => {
    const a = activeRef.current;
    if (!a) return null;
    const x = extentRef.current || a;
    const i = order.indexOf(a.sizeId), j = order.indexOf(x.sizeId);
    if (i < 0 || j < 0) return null;
    return { r0: Math.min(i, j), r1: Math.max(i, j), c0: Math.min(a.col, x.col), c1: Math.max(a.col, x.col) };
  };
  // What the planners read: the rows as drawn now, and the queue as it is now (qRef, so an editor
  // committed a moment ago is in it).
  const viewOf = () => ({ rows, order, cols: model ? model.cols : [], rtp, q: qRef.current });
  // Ctrl/Cmd+C: the selection as TSV (ssPgToTsv), as drawn. A view-only page copies too.
  const copySel = (e) => {
    const sel = selRect();
    if (!sel || !e.clipboardData) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", ssPgToTsv(ssPgSelectionBlock(viewOf(), order.slice(sel.r0, sel.r1 + 1), sel.c0, sel.c1)));
    const k = (sel.r1 - sel.r0 + 1) * (sel.c1 - sel.c0 + 1);
    setSaid({ tone: "grey", text: k === 1 ? "Copied 1 box." : `Copied ${k} boxes.` });
  };
  // Ctrl/Cmd+V: the clipboard's block, its top-left box on the selection's top-left box. A view-only
  // page pastes nothing and sends nothing.
  const pasteFrom = (e) => {
    e.preventDefault();
    if (!canEditNow()) return;
    const sel = selRect();
    if (!sel) { setSaid({ tone: "grey", text: "Click the box where the paste should start." }); return; }
    const text = e.clipboardData ? e.clipboardData.getData("text/plain") : "";
    propose(ssPgPastePlan(viewOf(), { sizeId: order[sel.r0], col: sel.c0 }, ssPgParseTsv(text)));
  };
  // Ctrl/Cmd+D or Fill down; Delete or Backspace on a range, or Clear. An open editor is committed
  // first (any move away commits), and a box it turns red stops it there, with its reason on show.
  const fillDown = () => {
    if (!canEditNow()) return;
    if (!commitEdit()) { focusGrid(); return; }
    propose(ssPgFillPlan(viewOf(), selRect()));
  };
  const clearSel = () => {
    if (!canEditNow()) return;
    if (!commitEdit()) { focusGrid(); return; }
    propose(ssPgClearPlan(viewOf(), selRect()));
  };
  // A checked paste, fill or clear (plan 3.11-3.12). Refused: the status line says why, and nothing
  // changes. Nothing different: it says so. One size: done at once, as typing in a box is. More than
  // one: the confirm first (PgConfirm), naming the range and counting the changes; Cancel changes
  // nothing.
  const propose = (plan) => {
    if (!plan.ok) { setSaid({ tone: "amber", text: plan.error }); return; }
    if (!plan.edits.length) { setSaid({ tone: "grey", text: "Nothing to change: those boxes already say that." }); return; }
    const sum = ssPgChangeSummary(plan.sizes);
    setSaid(null);
    if (sum.ask) { setConfirm({ text: sum.text, edits: plan.edits, area: plan.area || null }); return; }
    applyChange(plan.edits, plan.area || null);
  };
  // Into the queue in ONE event (ssPgQueue "commits": every box by the commit rule, against what it
  // showed when it was checked, so a box an answer moved while the confirm was open turns red instead
  // of overwriting a colleague's number), and sent at once in calls the server takes (plan 4.6). A
  // pasted block stays selected, the way a sheet shows what it pasted.
  const applyChange = (edits, area) => {
    if (!canEditNow()) return;
    // A size that left the queue while the confirm was open (someone else added the same dimensions
    // first, or a read no longer has it) can take none of its boxes, so nothing changes (all or
    // nothing) and the status line says why, instead of the rest going without a word.
    const cur = qRef.current;
    const gone = edits.find((d) => !cur.sizes[d.sizeId]);
    if (gone) {
      setSaid({ tone: "amber", text: cur.renamed[gone.sizeId]
        ? "Someone else just added one of those sizes while you were deciding. Nothing was changed. Check its numbers and try again."
        : "One of those sizes isn't on this account any more. Nothing was changed. Try again." });
      return;
    }
    // A first price sent (or saved) while the confirm was open has said Offered already: a paste
    // saying otherwise would lose that box, so nothing changes (all or nothing, as when the paste
    // was checked: ssPgPlanCells) and the status line says why.
    const late = edits.find((d) => ssPgOffLost(qRef.current, d));
    if (late) { setSaid({ tone: "amber", text: `${whereOf(late.sizeId)}, Offered: its first price went out to save while you were deciding. Nothing was changed. Try again.` }); return; }
    backToWork();
    setTip(null);
    apply({ type: "commits", edits, at: Date.now() });
    sendNow();
    if (area) {
      setActive({ sizeId: area.first, col: area.c0 });
      setExtent(area.first === area.last && area.c0 === area.c1 ? null : { sizeId: area.last, col: area.c1 });
    }
  };
  const confirmYes = () => {
    const c = confirm;
    setConfirm(null);
    focusGrid();
    if (c) applyChange(c.edits, c.area);
  };
  const confirmNo = () => { setConfirm(null); focusGrid(); };
  // The toolbar's buttons keep the focus where it was (the grid, or the open editor, which their
  // click then commits).
  const keepFocus = (e) => { e.preventDefault(); };

  // ── The grid's own keys and mouse (plan 3.10) ──
  // Only keys pressed on the grid itself: an add strip's boxes and the buttons in the bands are
  // inside the table, and what is typed there is theirs.
  const onKeyDown = (e) => {
    if (e.target !== e.currentTarget) return;
    const k = e.key;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (k === "z" || k === "Z")) { e.preventDefault(); setTip(SS_PG_NO_UNDO); return; }
    // Ctrl/Cmd+D fills down (held back from the browser, whose own is "bookmark this page"). Ctrl/Cmd+C
    // and V go on to the browser, whose copy and paste events land in copySel and pasteFrom.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (k === "d" || k === "D")) { e.preventDefault(); fillDown(); return; }
    // Alt+Enter opens (or closes) "＋ Add sizes" for the active size's style: the band's button is
    // inside the grid, past every box Tab moves through, so the keyboard gets there this way (and
    // Delete on a Size box is its Remove: clearCell).
    if (e.altKey && !e.ctrlKey && !e.metaKey && k === "Enter") {
      e.preventDefault();
      const r = activeRef.current ? byId[activeRef.current.sizeId] : null;
      if (r) toggleAdd(r.style.id);
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const a = activeRef.current;
    if (e.shiftKey && k.indexOf("Arrow") === 0) {
      if (!a) return;
      const next = ssPgMove(order, ncols, extentRef.current || a, k, false);
      if (!next) return;
      e.preventDefault();
      moveTo(next, "extent");
      return;
    }
    const next = ssPgMove(order, ncols, a, k, e.shiftKey);
    if (next) { e.preventDefault(); setTip(null); setSaid(null); moveTo(next); return; }
    if (!a) return;
    if (k === "Enter" || k === "F2") { e.preventDefault(); startEdit(a, null); return; }
    if (k === " ") { e.preventDefault(); if (a.col === 2 && !extentRef.current) toggleOffered(a); return; }
    // Delete or Backspace: one box clears at once (clearCell); a range goes through Clear and, when it
    // changes more than one size, the confirm (plan 3.12).
    if (k === "Delete" || k === "Backspace") { e.preventDefault(); if (!extentRef.current) clearCell(a); else clearSel(); return; }
    if (k === "Escape") { setExtent(null); return; }
    // A digit, `$` or any other character starts typing over the box (plan 3.10); the editor opens
    // holding it, so nothing typed is lost.
    if (k.length === 1) { e.preventDefault(); startEdit(a, k); }
  };
  const cellAt = (e) => {
    const td = e.target && e.target.closest ? e.target.closest("td[data-c]") : null;
    const tr = td && td.parentElement;
    if (!td || !tr || !tr.getAttribute("data-s")) return null;
    return { sizeId: tr.getAttribute("data-s"), col: Number(td.getAttribute("data-c")) || 0 };
  };
  const onMouseDown = (e) => {
    // The grid's own buttons (onAct) act on the click; pressing one commits the editor and keeps
    // the focus where it was, so the keys still drive the grid afterwards.
    if (e.target && e.target.closest && e.target.closest("[data-pg-act]")) { e.preventDefault(); commitEdit(); return; }
    const cell = cellAt(e);
    if (!cell) return;
    e.preventDefault();   // no drag-select of text; focus is given by hand, without a scroll
    commitEdit();
    focusGrid();
    const a = activeRef.current;
    if (e.shiftKey && a) { setExtent(cell); return; }   // Shift+click: a range from the active cell
    const again = !!a && a.sizeId === cell.sizeId && a.col === cell.col && !extentRef.current;
    setActive(cell);
    setExtent(null);
    setTip(null);
    setSaid(null);
    if (e.button === 0) dragRef.current = true;
    // A click on an Offered box that is already selected ticks or unticks it.
    if (again && cell.col === 2 && e.button === 0 && e.detail === 1) toggleOffered(cell);
  };
  // A drag with the button held stretches the range over the cells it passes (not on touch).
  const onMouseOver = (e) => {
    if (!dragRef.current) return;
    const cell = cellAt(e);
    const a = activeRef.current;
    if (!cell || !a) return;
    setExtent(cell.sizeId === a.sizeId && cell.col === a.col ? null : cell);
  };
  const onDoubleClick = (e) => {
    const cell = cellAt(e);
    if (cell && cell.col !== 2) startEdit(cell, null);
  };
  // Tabbing into the grid lands on the first price (the grid itself: not a box in an add strip).
  const onFocus = (e) => { if (e.target === e.currentTarget && !activeRef.current && order.length) setActive({ sizeId: order[0], col: Math.min(1, ncols - 1) }); };
  const toggleShowHidden = (on) => {
    setShowHidden(on);
    try { localStorage.setItem(SS_PG_SHOW_HIDDEN_KEY, on ? "1" : "0"); } catch (_e) { /* not remembered */ }
  };
  // "3 boxes need you" jumps to the next red box, in reading order, after the active one. The badge
  // counts every red box, so this looks in every size, folded ones too: a red box on a hidden size
  // with "Show hidden sizes" off, or in the collapsed Hidden styles section, is unfolded first.
  // `keep(id, f, x)` narrows which red boxes count (leaving: only those gone red since the click).
  const jumpRed = (keep = null) => {
    const cur = qRef.current;
    if (!cur || !model) return;
    const all = ssPgRows(model, { showHidden: true, hiddenStylesOpen: true }).filter((r) => r.kind === "size");
    const reds = [];
    all.forEach((r, i) => {
      const fs = cur.fields[r.id];
      if (!fs) return;
      Object.keys(fs).forEach((f) => { const c = colOf(f); if (fs[f].error && c != null && (!keep || keep(r.id, f, fs[f]))) reds.push({ i, r, col: c }); });
    });
    if (!reds.length) return;
    reds.sort((x, y) => x.i - y.i || x.col - y.col);
    const a = activeRef.current;
    const ai = a ? all.findIndex((r) => r.id === a.sizeId) : -1;
    const next = reds.find((x) => x.i > ai || (x.i === ai && x.col > a.col)) || reds[0];
    if (next.r.size.hidden && !showHidden) toggleShowHidden(true);
    if (!next.r.style.active && !hiddenStylesOpen) setHiddenStylesOpen(true);
    focusGrid();
    moveTo({ sizeId: next.r.id, col: next.col });
  };

  // Places the overlay's pieces and the editor over the active cell and the range (plan 3.5): rows
  // from their own offsetTop, columns from ssPgColBox. Frozen pieces go in the sticky lane.
  const place = () => {
    const g = gridRef.current;
    const pieces = [ringFRef.current, ringBRef.current, rangeFRef.current, rangeBRef.current];
    pieces.forEach((el) => { if (el) el.style.display = "none"; });
    const prev = markRef.current;
    if (prev) { prev.removeAttribute("aria-selected"); markRef.current = null; }
    const a = activeRef.current;
    if (!g || !a) return;
    const esc = (s) => ((window.CSS && CSS.escape) ? CSS.escape(String(s)) : String(s));
    const tr = g.querySelector(`tr[data-s="${esc(a.sizeId)}"]`);
    if (!tr) return;
    const show = (el, x, y, w, h) => {
      if (!el) return;
      el.style.display = "block";
      el.style.left = x + "px"; el.style.top = y + "px"; el.style.width = w + "px"; el.style.height = h + "px";
    };
    const y0 = g.offsetTop;
    const ca = ssPgColBox(a.col, narrow);
    show(ca.frozen ? ringFRef.current : ringBRef.current, ca.x, y0 + tr.offsetTop, ca.w, tr.offsetHeight);
    // The editor sits over its own field's column, wherever a read has moved it.
    const ec = edInputRef.current && editRef.current ? colOf(editRef.current.f) : null;
    if (ec != null) {
      const cb = ssPgColBox(ec, narrow);
      const et = editRef.current.sizeId === a.sizeId ? tr : g.querySelector(`tr[data-s="${esc(editRef.current.sizeId)}"]`);
      if (et) show(edInputRef.current, cb.x, y0 + et.offsetTop, cb.w, et.offsetHeight);
    }
    const td = tr.children[a.col];
    if (td) { td.setAttribute("aria-selected", "true"); markRef.current = td; }
    const x = extentRef.current;
    let far = null;
    if (x && (x.sizeId !== a.sizeId || x.col !== a.col)) {
      const tx = g.querySelector(`tr[data-s="${esc(x.sizeId)}"]`);
      if (tx) {
        far = tx.children[x.col] || null;
        const top = y0 + Math.min(tr.offsetTop, tx.offsetTop);
        const bottom = y0 + Math.max(tr.offsetTop + tr.offsetHeight, tx.offsetTop + tx.offsetHeight);
        const c0 = Math.min(a.col, x.col), c1 = Math.max(a.col, x.col), fz = narrow ? 1 : 3;
        if (c0 < fz) {
          const l = ssPgColBox(c0, narrow), r = ssPgColBox(Math.min(c1, fz - 1), narrow);
          show(rangeFRef.current, l.x, top, r.x + r.w - l.x, bottom - top);
        }
        if (c1 >= fz) {
          const l = ssPgColBox(Math.max(c0, fz), narrow), r = ssPgColBox(c1, narrow);
          show(rangeBRef.current, l.x, top, r.x + r.w - l.x, bottom - top);
        }
      }
    }
    const which = scrollNextRef.current;
    if (which) {
      scrollNextRef.current = false;
      const el = which === "extent" ? far : td;
      try { if (el) el.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch (_s) { /* old browser */ }
    }
  };
  // Where leaving goes: a Settings tab by name (Back to Sheds, Go to Options), or the address a held
  // Back or Forward was going to, routed the way the shell routes those (the address moves, then a
  // popstate, which this page's hold lets through).
  const go = (to) => {
    if (typeof to === "string") { onNav(to); return; }
    passRef.current = true;
    try {
      window.history.pushState(to.state, "", to.url);
      window.dispatchEvent(new PopStateEvent("popstate", { state: to.state }));
    } catch (_h) { /* history unavailable */ } finally { passRef.current = false; }
  };

  // Back to Sheds, Go to Options and a held Back or Forward leave the same way (plan 3.2, 4.6): the
  // editor is committed and what waits is sent first; the page goes once the queue is empty (the
  // `leaving` effect). It stays when the editor's text went red (the cursor is on that box, its
  // reason on the status line), and when nothing can be sent first (saving stopped or retrying, or
  // view-only after a 403): then the status line says the page stayed, with Leave anyway. A middle
  // click or a modified one is the browser's: a new tab, nothing waits.
  const leaveFor = (to) => {
    setStuck(null);
    if (!commitEdit()) { focusGrid(); return; }
    const cur = qRef.current, c = ssPgCount(cur);
    if (!cur || !(c.pending + c.inflight + c.creating + c.removing)) { go(to); return; }
    if (cur.viewOnly || cur.stopped || cur.failures) { setStuck({ to }); return; }
    setLeaving({ to, was: cur.fields });
    flushNow();
  };
  const leaveTo = (sub) => ssNavClick(() => leaveFor(sub));
  const toSheds = leaveTo("sheds");
  fnRef.current = { place, sendNow, flushNow, jumpRed, go, commitEdit, leaveFor,
    refreshNow, pokeRefresh, adoptRead, addSizes, closeAdd, saveBackup, offerEarlier, copySel, pasteFrom, dropGoneEditor };
  // Pressing a link would blur the open editor, and the blur commits it before the click, so the
  // click would never see a box that commit turned red. Held on the editor, the click commits it.
  const holdEditor = (e) => { if (editRef.current) e.preventDefault(); };

  const at = active ? byId[active.sizeId] : null;
  // The active-column readout (plan 3.2): the full name of the column pointed at or in use, which
  // is also where a name cut short on a phone is read in full.
  const readout = !model ? "" : peek != null ? colName(peek) : at ? `${colName(active.col)} · ${at.style.label} ${at.size.label}` : "";
  const stamp = savedAt || load.at;
  const time = stamp ? new Date(stamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toLowerCase() : "";
  const n = (k, one, many) => (k === 1 ? one : `${k} ${many}`);
  const unsent = counts.pending + counts.creating + counts.removing + (draftDirty ? 1 : 0);
  const out = q && q.flight ? q.flight.changes : 0;
  const secs = retryAt ? Math.max(0, Math.ceil((retryAt - Date.now()) / 1000)) : 0;
  const bact = (label, fn) => <button type="button" className="ss-pg-bact" onClick={fn}>{label}</button>;
  // The badge (plan 3.13), first match wins.
  const badge = load.phase === "loading" ? { tone: "grey", text: "Loading…" }
    : load.phase === "error" ? { tone: "red", text: "Couldn't load" }
    : viewOnly ? { tone: "grey", text: "View only: " + viewOnly.short, title: viewOnly.long }
    : tooBig ? { tone: "grey", text: "View only: catalog too big", title: SS_PG_TOO_BIG }
    : q && q.viewOnly ? { tone: "grey", text: "View only: " + q.viewOnly.reason }
    : q && q.stopped ? { tone: "red", text: "Saving stopped: " + q.stopped.reason,
      actions: q.stopped.kind === "tenant" ? null : <>{bact("Retry", resume)}{bact("Discard these changes", discard)}</> }
    : q && q.flight && q.failures ? { tone: "amber", text: retryAt ? `Can't reach the server. Retrying in ${secs} s; your changes are kept` : "Can't reach the server. Trying again; your changes are kept",
      actions: retryAt ? bact("Retry now", retryNow) : null }
    : out ? { tone: "blue", text: `Saving ${n(out, "1 change", "changes")}…` }
    : unsent ? { tone: "blue", text: `${n(unsent, "1 change", "changes")} not saved yet` }
    : q && q.unsure ? { tone: "amber", text: "Discarded, but the last try may have saved", title: "Reload to see what's on file", actions: bact("Reload", fetchAll) }
    : counts.red ? { tone: "red", text: `${n(counts.red, "1 box needs", "boxes need")} you`, onClick: () => jumpRed(), title: "Go to the next box that didn't save" }
    : { tone: "green", text: `All changes saved · ${time}` };
  const noStyles = !!model && model.styles.length === 0;
  const noCols = !!model && model.cols.length === 0;
  const choices = model ? [...model.styles, ...model.hiddenStyles] : [];
  const shedsHref = ssPgSettingsHref("sheds");
  // The status line (plan 3.14): the active box's reason when it is red, else a note from the queue,
  // else a one-off tip.
  const af = active ? fieldOf(active.col) : null;
  const aerr = af && q && q.fields[active.sizeId] && q.fields[active.sizeId][af] ? q.fields[active.sizeId][af].error : null;
  const errLine = aerr && at ? ssPgErrorLine(`${at.style.label} ${at.size.label}`,
    { name: colName(active.col), kind: active.col === 1 ? "price" : active.col === 2 ? "active" : "qty" }, aerr) : null;
  // The button goes with the line it dismisses, so the keyboard goes back to the grid, not <body>.
  const dismissBtn = (fn) => <button type="button" onClick={() => { fn(); focusGrid(); }}>Dismiss</button>;
  // The backup's red entries (plan 4.9), named by what is drawn now; never sent.
  let earlierLine = "";
  if (earlierRed && model) {
    const where = {}, fields = { price: { name: "Price", kind: "price" }, active: { name: "Offered", kind: "active" } };
    [...model.styles, ...model.hiddenStyles].forEach((st) => st.sizes.forEach((z) => { where[z.id] = `${st.label} ${z.label}`; }));
    model.cols.forEach((c) => { fields["c:" + c.key] = { name: c.label, kind: "qty" }; });
    earlierLine = ssPgEarlierText(earlierRed, where, fields);
  }
  const tableW = SS_PG_FROZEN_W + SS_PG_COL_W * (ncols - 3);
  // Leaving was called off (`stuck`): the badge says why (stopped, retrying, view only), this says
  // the page stayed, and Leave anyway goes without what is unsent.
  const unsaved = counts.pending + counts.inflight + counts.creating + counts.removing;
  const stuckLine = stuck && unsaved > 0 ? (
    <PgStatusLine tone="amber" action={<>
      <button type="button" onClick={() => { const to = stuck.to; setStuck(null); go(to); }}>Leave anyway</button>
      {dismissBtn(() => setStuck(null))}
    </>}>{`${n(unsaved, "1 change isn't", "changes aren't")} saved yet, so you're still on this page.`}</PgStatusLine>
  ) : null;

  return (
    <div className="ss-pg" data-ss-pg-editable={canEdit ? "1" : "0"}>
      <div className="ss-pg-bar">
        <a className="ss-pg-back" href={shedsHref} onMouseDown={holdEditor} onClick={toSheds}>← Back to Sheds</a>
        <span className="ss-pg-title">Sizes &amp; prices</span>
        {operatorView && <span className="ss-pg-co" title={companyName}>{companyName}</span>}
        <select className="ss-pg-jump" aria-label="Jump to style" value="" disabled={!choices.length}
          onChange={(e) => { const id = e.target.value; if (id) { jumpRef.current = id; setJumpTick((k) => k + 1); } }}>
          <option value="">Jump to style…</option>
          {choices.map((s) => <option key={s.id} value={s.id}>{s.label}{s.active ? "" : " (hidden)"}</option>)}
        </select>
        <label className="ss-pg-tog">
          <input type="checkbox" checked={showHidden} onChange={(e) => toggleShowHidden(e.target.checked)} />
          Show hidden sizes
        </label>
        {/* Fill down and Clear (plan 3.10), for builders who don't know the keys. Drawn only while the
            page can edit, as the editor and the add strips are (plan 3.16). */}
        {canEdit && (
          <>
            <button type="button" className="ss-pg-tbtn" onMouseDown={keepFocus} onClick={() => { fillDown(); focusGrid(); }}
              title="Copy the top row of the selected boxes into the rows under it (Ctrl+D)">Fill down</button>
            <button type="button" className="ss-pg-tbtn" onMouseDown={keepFocus} onClick={() => { clearSel(); focusGrid(); }}
              title="Empty the selected boxes (Delete)">Clear</button>
          </>
        )}
        <span className="ss-pg-readout" title={readout || undefined}>{readout}</span>
        <PgBadge {...badge} />
        <button type="button" className="ss-pg-q" aria-expanded={legendOpen} aria-controls="ss-pg-legend"
          title="What the boxes mean" onClick={() => setLegendOpen((o) => !o)}>?</button>
      </div>
      {/* The chromeless page has no top bar, so it says for itself whose account this is. */}
      {operatorView && (
        <div className="ss-pg-op" role="note">
          {(readOnly || lostEdit)
            ? `Viewing ${companyName} as operator. This table is view-only.`
            : `Editing ${companyName} as operator. Changes are live.`}
        </div>
      )}
      {viewOnly && <PgStatusLine>{viewOnly.long}</PgStatusLine>}
      {tooBig && <PgStatusLine tone="amber" action={<button type="button" onClick={fetchAll}>Reload</button>}>{SS_PG_TOO_BIG}</PgStatusLine>}
      {/* The backup from earlier (plan 4.9): offered back once, until Save them or Discard. */}
      {earlier && canEdit && (
        <div className="ss-pg-earlier" role="status">
          <span>{earlier.count === 1 ? "You have 1 change from earlier that wasn't saved." : `You have ${earlier.count} changes from earlier that weren't saved.`}</span>
          {/* Greyed while a call is out (about a second, or while saving is stopped): Save them goes on
              the stored versions only when nothing is in flight (ssPgQueue's restore). */}
          <button type="button" onClick={saveEarlier} disabled={!!(q && q.flight)}
            title={q && q.flight ? "Wait a moment: a save is going out." : undefined}>Save them</button>
          <button type="button" onClick={discardEarlier}>Discard</button>
        </div>
      )}
      {stuckLine ? stuckLine
        : said ? <PgStatusLine tone={said.tone} action={dismissBtn(() => setSaid(null))}>{said.text}</PgStatusLine>
        : errLine ? <PgStatusLine tone={aerr.kind === "conflict" ? "amber" : "red"} action={dismissBtn(() => apply({ type: "dismiss", sizeId: active.sizeId, f: af }))}>{errLine}</PgStatusLine>
        : earlierLine ? <PgStatusLine tone="amber" action={dismissBtn(dismissEarlierRed)}>{earlierLine}</PgStatusLine>
        : q && q.note ? <PgStatusLine tone="amber" action={dismissBtn(() => apply({ type: "note-off" }))}>{q.note.text}</PgStatusLine>
        : tip ? <PgStatusLine action={dismissBtn(() => setTip(null))}>{tip}</PgStatusLine> : null}
      {legendOpen && <div id="ss-pg-legend" className="ss-pg-legend">{SS_PG_LEGEND}</div>}
      {narrow && !noteOff && (
        <div className="ss-pg-narrow">
          <span>Easiest on a computer. You can still check and change numbers here.</span>
          <button type="button" aria-label="Dismiss" onClick={() => setNoteOff(true)}>✕</button>
        </div>
      )}
      {noCols && (
        <div className="ss-pg-optbox">
          <b>Set up your Options first.</b> Every door, window, ramp, and add-on you offer becomes a column here — that's
          how you say what comes <b>included</b> with each size.{" "}
          <a href={ssPgSettingsHref("options")} onMouseDown={holdEditor} onClick={leaveTo("options")}>Go to Options →</a>
        </div>
      )}
      {noStyles && (
        <div className="ss-pg-msg ss-pg-msg-inline" role="status">
          No building styles yet. <a href={shedsHref} onMouseDown={holdEditor} onClick={toSheds}>Add one on Sheds.</a>
        </div>
      )}
      <div className="ss-pg-box" ref={boxRef} aria-busy={load.phase === "loading" ? "true" : undefined}
        style={{ scrollPaddingTop: SS_PG_SEC_H + hh, scrollPaddingLeft: narrow ? 64 : SS_PG_FROZEN_W }}>
        {load.phase === "loading" ? <PgSkeleton />
          : load.phase === "error" ? (
            <div className="ss-pg-fail" role="alert">
              <b>{load.status === 403 ? "You don't have access to Sheds on this account." : "Couldn't load your sizes."}</b>
              {load.status !== 403 && load.error && <span className="ss-pg-fail-why">{load.error}</span>}
              <button type="button" onClick={fetchAll}>Retry</button>
            </div>
          ) : (noStyles && !model.hiddenStyles.length) ? null : (
            <div className="ss-pg-sheet" style={{ width: tableW }}>
              <PgSelectionOverlay lane ringRef={ringFRef} rangeRef={rangeFRef}>
                {editing && editing.frozen && <PgEditor key={editing.sizeId + "|" + editing.f} inputRef={edInputRef} init={editing.init} label={editing.label}
                  price={editing.price} onKeyDown={onEditKey} onInput={onEditInput} onBlur={onEditBlur} />}
              </PgSelectionOverlay>
              <table ref={gridRef} className="ss-pg-grid" role="grid" aria-label="Sizes and prices" tabIndex={0}
                aria-rowcount={2 + rows.length} aria-colcount={ncols} aria-readonly={canEdit ? undefined : "true"}
                style={{ width: tableW, "--ss-pg-hh": hh + "px" }}
                onKeyDown={onKeyDown} onMouseDown={onMouseDown} onMouseOver={onMouseOver} onDoubleClick={onDoubleClick} onFocus={onFocus}
                onClick={onAct}>
                {head}
                <tbody>{body}</tbody>
              </table>
              <PgSelectionOverlay ringRef={ringBRef} rangeRef={rangeBRef}>
                {editing && !editing.frozen && <PgEditor key={editing.sizeId + "|" + editing.f} inputRef={edInputRef} init={editing.init} label={editing.label}
                  price={editing.price} onKeyDown={onEditKey} onInput={onEditInput} onBlur={onEditBlur} />}
              </PgSelectionOverlay>
            </div>
          )}
      </div>
      {/* The confirm before a change to more than one size (plan 3.12). Gone if the page stops being
          able to edit meanwhile (a 403 on a save already out). */}
      {confirm && canEdit && <PgConfirm text={confirm.text} onYes={confirmYes} onNo={confirmNo} />}
    </div>
  );
}

// THE CONFIRM (plan 3.12): before a paste, fill or clear that changes boxes on more than one size.
// A modal alertdialog named by its own question ("Change 6 sizes, Test Barn 10x12 to Test Barn 12x24:
// 6 prices, … Continue?"). The focus goes to Continue and stays inside (Tab and Shift+Tab go round
// the two buttons); Escape, Cancel or a click outside it cancel, and Cancel changes nothing. The page
// gives the focus back to the grid either way. Every hook is above the return.
function PgConfirm({ text, onYes, onNo }) {
  const yesRef = useRef(null);
  const noRef = useRef(null);
  React.useLayoutEffect(() => {
    try { yesRef.current.focus({ preventScroll: true }); } catch (_f) { /* gone */ }
  }, []);
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onNo(); return; }
    if (e.key === "Tab") {
      e.preventDefault();
      const next = document.activeElement === yesRef.current ? noRef.current : yesRef.current;
      try { next.focus(); } catch (_f) { /* gone */ }
    }
  };
  return (
    <div className="ss-pg-confirm" onMouseDown={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); onNo(); } }}>
      <div className="ss-pg-confirm-box" role="alertdialog" aria-modal="true" aria-labelledby="ss-pg-confirm-q" onKeyDown={onKey}>
        <p id="ss-pg-confirm-q">{text}</p>
        <div className="ss-pg-confirm-acts">
          <button type="button" ref={noRef} onClick={onNo}>Cancel</button>
          <button type="button" ref={yesRef} className="ss-pg-confirm-yes" onClick={onYes}>Continue</button>
        </div>
      </div>
    </div>
  );
}

// The two header rows (plan 3.3-3.4): the section band in each section's template colour, then the
// names. Option names stand on end in a .ss-pg-vh span, top to bottom (Carolyn Q6), and wrap onto a
// second line inside the column rather than being cut; the full name is also each header's title
// and aria-label, and the toolbar's readout while it is pointed at.
const PgHeader = React.memo(function PgHeader({ sections, cols, rtpOn, onPeek, onPeekEnd }) {
  let from = 4;
  return (
    <thead onMouseOver={onPeek} onMouseLeave={onPeekEnd}>
      <tr role="row" aria-rowindex={1} className="ss-pg-sec">
        <th className="ss-pg-corner" colSpan={3} role="columnheader" aria-colindex={1} aria-colspan={3} aria-label="Size, price and offered" />
        {sections.map((s) => {
          const at = from;
          from += s.cols.length;
          return (
            <th key={s.name} colSpan={s.cols.length} role="columnheader" aria-colindex={at} aria-colspan={s.cols.length}
              title={s.name} style={{ background: "#" + String(s.argb || "FFF1F5F9").slice(2) }}>{s.name}</th>
          );
        })}
      </tr>
      <tr role="row" aria-rowindex={2} className="ss-pg-names">
        <th role="columnheader" aria-colindex={1} data-col={0} className="ss-pg-f0 ss-pg-fh">Size</th>
        <th role="columnheader" aria-colindex={2} data-col={1} className={"ss-pg-f1 ss-pg-fh" + (rtpOn ? " ss-pg-rtp" : "")}
          title={rtpOn ? SS_PG_RTP : "Base price"}>Price{rtpOn ? " 🔒" : ""}</th>
        <th role="columnheader" aria-colindex={3} data-col={2} className="ss-pg-f2" title="Offered in your designer" aria-label="Offered">
          <span className="ss-pg-vh">Offered</span>
        </th>
        {cols.map((c, i) => (
          <th key={c.key} role="columnheader" aria-colindex={4 + i} data-col={3 + i} title={c.label} aria-label={c.label}
            className={i === 0 || cols[i - 1].section !== c.section ? "ss-pg-oh ss-pg-s0" : "ss-pg-oh"}>
            <span className="ss-pg-vh">{c.label}</span>
          </th>
        ))}
      </tr>
    </thead>
  );
});

// One size (plan 3.5). Primitive props only, plus `values`, which the page hands back as the same
// array while that size's boxes are unchanged, so a row re-renders only when its own size does.
// Size, Price and Offered are frozen (portal.html). The price is also the cell's title:
// "$123,456.78", or three decimals shown as stored, is wider than the 76 px column and ends in an
// ellipsis, and the title is where it reads whole. Under Real-Time Pricing the cell is grey with a
// lock (portal.html), and the title says why.
// `marks` (ssPgRowView) is one character per column, a shape as well as a colour (plan 3.13): "p"
// waiting to save (a blue corner), "r" refused or not valid (red outline and "!"), "c" changed
// elsewhere (amber outline and "↺"); "" when the size has nothing local. A red box is aria-invalid.
// Phase 4a: `busy` is "adding" while the size's create is unanswered and "removing" while its remove
// is, said in the empty Price box ("Adding…"); `removable` (ssPgCanRemove) puts a small ✕ Remove at
// the right of the Size box. The ✕ is a word too narrow to fit beside the size in 64 px, so its
// title and name say "Remove". It is handled by the grid's own click (data-pg-act), so PgRow takes
// no function and its memo holds.
const PgRow = React.memo(function PgRow({ rowIndex, sizeId, label, title, priceText, offered, noPrice, hidden, values, rtp, marks = "",
  busy = "", removable = false }) {
  const mark = (c) => {
    const m = marks ? marks.charAt(c) : "";
    return m === "p" ? "ss-pg-m-p" : m === "r" ? "ss-pg-m-r" : m === "c" ? "ss-pg-m-c" : "";
  };
  const cls = (c, base) => ([base, mark(c)].filter(Boolean).join(" ") || undefined);
  const bad = (c) => { const m = marks ? marks.charAt(c) : ""; return m === "r" || m === "c" ? "true" : undefined; };
  return (
    <tr role="row" aria-rowindex={rowIndex} data-s={sizeId} className={[hidden ? "ss-pg-hid" : "", busy ? "ss-pg-busy" : ""].filter(Boolean).join(" ") || undefined}>
      <td role="gridcell" aria-colindex={1} data-c={0} className={"ss-pg-f0 ss-pg-size" + (removable ? " ss-pg-rmable" : "")} title={title || undefined} aria-readonly="true">
        {label}
        {removable && <button type="button" className="ss-pg-rm" data-pg-act="remove" data-pg-id={sizeId} tabIndex={-1}
          title="Remove this size (it was never priced or changed). Delete on its Size box does the same." aria-label={`Remove size ${label}`}>✕</button>}
      </td>
      <td role="gridcell" aria-colindex={2} data-c={1} className={cls(1, "ss-pg-f1 ss-pg-price" + (rtp ? " ss-pg-rtp" : ""))}
        aria-invalid={bad(1)} aria-readonly={rtp ? "true" : undefined}
        title={rtp ? (priceText ? `${priceText} · ${SS_PG_RTP}` : SS_PG_RTP) : (priceText || undefined)}>
        {busy && !priceText ? <span className="ss-pg-wait">{busy === "removing" ? "Removing…" : "Adding…"}</span> : priceText}
      </td>
      <td role="gridcell" aria-colindex={3} data-c={2} className={cls(2, "ss-pg-f2 ss-pg-off" + (noPrice ? " ss-pg-dis" : ""))} aria-invalid={bad(2)}
        title={noPrice ? "Add a price to offer it" : offered ? "Offered in your designer" : "Not offered"}>{offered ? "✓" : ""}</td>
      {values.map((v, i) => <td key={i} role="gridcell" aria-colindex={4 + i} data-c={3 + i} className={cls(3 + i, "")} aria-invalid={bad(3 + i)}>{v}</td>)}
    </tr>
  );
});

// THE SELECTION OVERLAY (plan 3.5): the active cell's ring and the range's rectangle, absolutely
// placed over the grid by the page (PricingTablePage `place`), so a move re-renders no row. It comes
// twice, because Size, Price and Offered are sticky: the `lane` copy lives in a zero-size sticky strip
// at the grid's left edge, so it rides along with those columns as the grid scrolls sideways (above
// their cells, under the header); the other scrolls with the option columns, under the frozen ones.
// The editor sits in whichever holds its column.
function PgSelectionOverlay({ lane = false, ringRef, rangeRef, children = null }) {
  const parts = (
    <>
      <div ref={rangeRef} className="ss-pg-range" aria-hidden="true" />
      <div ref={ringRef} className="ss-pg-ring" aria-hidden="true" />
      {children}
    </>
  );
  return lane ? <div className="ss-pg-lane">{parts}</div> : parts;
}

// THE EDITOR (plan 3.5, 3.10, 3.17): one text box over the active cell while typing; type="text"
// with an inputMode, never type="number", whose spinners eat the 44 px. Its text lives in the DOM
// (the page reads it through a ref), so a keystroke re-renders nothing. Focused on mount with the
// caret at the end; named for screen readers ("Test Barn 12x24, Loft (sq ft)").
function PgEditor({ inputRef, init, label, price, onKeyDown, onInput, onBlur }) {
  React.useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    try { el.focus({ preventScroll: true }); } catch (_f) { el.focus(); }
    try { el.setSelectionRange(el.value.length, el.value.length); } catch (_s) { /* not a text box */ }
  }, []);
  return (
    <input ref={inputRef} type="text" className={"ss-pg-ed" + (price ? " ss-pg-ed-price" : "")} defaultValue={init}
      inputMode={price ? "decimal" : "numeric"} aria-label={label} autoComplete="off" spellCheck={false}
      onKeyDown={onKeyDown} onInput={onInput} onBlur={onBlur} />
  );
}

// A style's band: its name and how many sizes it has. The name sticks to the left edge while the
// grid scrolls sideways. "＋ Add sizes" (plan 3.7, `canAdd`: the page can edit) opens the style's add
// strip under it, or closes it (`open`); it is handled by the grid's own click (data-pg-act), so the
// band takes no function and its memo holds.
const PgStyleBand = React.memo(function PgStyleBand({ rowIndex, styleId, label, total, hidden, folded, ncols, canAdd = false, open = false }) {
  return (
    <tr role="row" aria-rowindex={rowIndex} className="ss-pg-band" data-band={styleId}>
      <td role="rowheader" colSpan={ncols} aria-colindex={1} aria-colspan={ncols}>
        <div className="ss-pg-bandin">
          <b>{label}</b>
          <span>{total === 1 ? "1 size" : `${total} sizes`}{hidden ? ` · ${hidden} hidden${folded ? ", folded away" : ""}` : ""}</span>
          {canAdd && <button type="button" className="ss-pg-addbtn" title="Add sizes to this style (Alt+Enter on any of its sizes)" data-pg-act="add" data-pg-id={styleId} aria-expanded={open}>＋ Add sizes</button>}
        </div>
      </td>
    </tr>
  );
});

// "＋ Add sizes" (plan 3.7): the strip under a style's band, in two modes.
//   List: type sizes like 10x12, 12x16 (commas, semicolons or new lines) and press Enter or Add.
//   Add several: the widths and the lengths you sell, and a tick-box grid of every pair, widths down
//   and lengths across, all ticked, the sizes already in the style greyed "already there"; untick what
//   you don't sell, then [Add N sizes].
// Every check runs here before anything is sent (ssPgParseSizeList, ssPgSizeGrid, the server's own
// number rule): one bad entry refuses the whole add and is named. Under a style with no sizes this is
// the placeholder row (`empty`), list box open. `onAdd(styleId, sizes, skipped)` hands the sizes to
// the page (it answers false when it could not take them); `focusKey` moves the cursor into the list
// box each time it changes. Its keys and clicks stay its own: the grid's handlers ignore anything
// that happens inside it. Every hook is above the return.
function PgAddSizes({ rowIndex, styleId, styleLabel, existing, ncols, empty, focusKey = 0, onAdd, onClose }) {
  const [mode, setMode] = useState("list");
  const [text, setText] = useState("");
  const [widths, setWidths] = useState("");
  const [lengths, setLengths] = useState("");
  const [off, setOff] = useState({});
  const [err, setErr] = useState(null);
  const listRef = useRef(null);
  const widthRef = useRef(null);
  const grid = useMemo(() => (mode === "several" ? ssPgSizeGrid(widths, lengths, existing, off) : null), [mode, widths, lengths, existing, off]);
  useEffect(() => {
    if (!focusKey) return;
    const el = mode === "several" ? widthRef.current : listRef.current;
    try { if (el) el.focus({ preventScroll: true }); } catch (_f) { /* gone */ }
  }, [focusKey]);
  const addList = () => {
    const p = ssPgParseSizeList(text, existing);
    if (!p.ok) { setErr(p.error); return; }
    if (!p.sizes.length) {
      setErr(`${p.skipped.join(", ")} ${p.skipped.length === 1 ? "is" : "are"} already in ${styleLabel}. Nothing to add.`);
      return;
    }
    if (onAdd(styleId, p.sizes, p.skipped) === false) return;
    setErr(null);
    setText("");
  };
  const n = grid ? grid.sizes.length : 0;
  const canGo = !!grid && grid.ok && n > 0;
  const addGrid = () => {
    if (!canGo) return;
    if (onAdd(styleId, grid.sizes, []) === false) return;
    setErr(null);
    setOff({});
    setWidths("");
    setLengths("");
  };
  const onListKey = (e) => {
    // Enter adds (plan 3.7: "and press Enter"); Shift+Enter starts a new line; Escape closes.
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); addList(); }
    else if (e.key === "Escape" && !empty) { e.preventDefault(); onClose(styleId); }
  };
  const tick = (label) => setOff((o) => { const next = { ...o }; if (next[label]) delete next[label]; else next[label] = true; return next; });
  const modeBtn = (m, label) => (
    <button type="button" className={"ss-pg-addmode" + (mode === m ? " ss-pg-on" : "")} aria-pressed={mode === m}
      onClick={() => { setMode(m); setErr(null); }}>{label}</button>
  );
  return (
    <tr role="row" aria-rowindex={rowIndex} className="ss-pg-add-row" data-add={styleId}>
      <td role="gridcell" colSpan={ncols} aria-colindex={1} aria-colspan={ncols}>
        <div className="ss-pg-add" role="group" aria-label={`Add sizes to ${styleLabel}`}>
          <div className="ss-pg-addtop">
            {empty && mode === "list"
              ? <span className="ss-pg-addhint">No sizes yet. Type sizes like 10x12, 12x16 and press Enter</span>
              : <b>Add sizes to {styleLabel}</b>}
            {modeBtn("list", "List")}
            {modeBtn("several", "Add several")}
            {!empty && <button type="button" className="ss-pg-addx" aria-label="Close" title="Close" onClick={() => onClose(styleId)}>✕</button>}
          </div>
          {mode === "list" ? (
            <div className="ss-pg-addline">
              <textarea ref={listRef} className="ss-pg-addin" rows={1} value={text} placeholder="10x12, 12x16"
                aria-label={`Sizes to add to ${styleLabel}`} spellCheck={false}
                onChange={(e) => { setText(e.target.value); if (err) setErr(null); }} onKeyDown={onListKey} />
              <button type="button" className="ss-pg-addgo" onClick={addList}>Add</button>
            </div>
          ) : (
            <>
              <div className="ss-pg-addline">
                <label>Widths <input ref={widthRef} className="ss-pg-addnum" value={widths} placeholder="8, 10, 12" spellCheck={false}
                  onChange={(e) => setWidths(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape" && !empty) onClose(styleId); }} /></label>
                <span aria-hidden="true">×</span>
                <label>Lengths <input className="ss-pg-addnum" value={lengths} placeholder="12, 16, 20" spellCheck={false}
                  onChange={(e) => setLengths(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape" && !empty) onClose(styleId); }} /></label>
                <span className="ss-pg-addhint">feet</span>
              </div>
              {grid && grid.rows.length > 0 && (
                <div className="ss-pg-tick" role="group" aria-label="Sizes to add: untick the ones you don't sell"
                  style={{ gridTemplateColumns: `auto repeat(${grid.lengths.length}, minmax(52px, auto))` }}>
                  <span />
                  {grid.lengths.map((l) => <span key={"l" + l} className="ss-pg-tickh">{l}</span>)}
                  {grid.rows.map((r, i) => (
                    <React.Fragment key={"w" + grid.widths[i]}>
                      <span className="ss-pg-tickh">{grid.widths[i]}</span>
                      {r.map((c) => (c.there
                        ? <span key={c.label} className="ss-pg-there" title={`${c.label} is already in ${styleLabel}`}>already there</span>
                        : (
                          <label key={c.label} className="ss-pg-tickc">
                            <input type="checkbox" checked={c.ticked} onChange={() => tick(c.label)} aria-label={c.label} />
                            {c.label}
                          </label>
                        )))}
                    </React.Fragment>
                  ))}
                </div>
              )}
              {grid && !grid.blank && (
                <div className="ss-pg-addline">
                  <button type="button" className="ss-pg-addgo" disabled={!canGo} onClick={addGrid}>{n === 1 ? "Add 1 size" : `Add ${n} sizes`}</button>
                </div>
              )}
            </>
          )}
          {(err || (grid && grid.error)) && <div className="ss-pg-adderr" role="alert">{err || grid.error}</div>}
        </div>
      </td>
    </tr>
  );
}

// A placeholder under a style with nothing to show. Not a cell: the cursor and a paste never land here.
function PgNoteRow({ rowIndex, text, ncols }) {
  return (
    <tr role="row" aria-rowindex={rowIndex} className="ss-pg-note-row">
      <td role="gridcell" colSpan={ncols} aria-colindex={1} aria-colspan={ncols}><div className="ss-pg-bandin">{text}</div></td>
    </tr>
  );
}

// "Hidden styles (not in your designer)": folded until opened (plan 3.3).
function PgHiddenStylesRow({ rowIndex, count, open, ncols, onToggle }) {
  return (
    <tr role="row" aria-rowindex={rowIndex} className="ss-pg-hs">
      <td role="gridcell" colSpan={ncols} aria-colindex={1} aria-colspan={ncols}>
        <div className="ss-pg-bandin">
          <button type="button" aria-expanded={open} onClick={onToggle}>{open ? "▾" : "▸"} Hidden styles (not in your designer) · {count}</button>
        </div>
      </td>
    </tr>
  );
}

// The grid while it loads: grey blocks in the grid's own shape (see SkelBar, 01-core.jsx).
function PgSkeleton() {
  const cols = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  return (
    <div className="ss-pg-skel" aria-hidden="true">
      <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
        <SkelBar w={164} h={96} />
        {cols.map((i) => <SkelBar key={i} w={38} h={96} />)}
      </div>
      {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((r) => (
        <div key={r} style={{ display: "flex", gap: 6, marginBottom: 6, opacity: 1 - r * 0.07 }}>
          <SkelBar w={164} h={20} />
          {cols.map((i) => <SkelBar key={i} w={38} h={20} />)}
        </div>
      ))}
    </div>
  );
}
