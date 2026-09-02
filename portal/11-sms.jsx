/* ─────────────────────────────────────────────────────────────────────────────
   Text messaging setup — the builder registers their own business with the
   carriers, then buys their own number.

   ⚠️ THIS PART IS CONCATENATED. It sits between 08-integrations and what was 09,
   sharing one lexical scope with every other part, so everything it needs
   (ACCENT, SkelRows, ssCacheGet, sb) is already in scope and nothing here may be
   re-declared. Order is load-bearing: `const` does not hoist.

   THE AUDIENCE IS A SHED BUILDER, NOT A TELECOM ENGINEER. Every label here says
   what the thing is for in the builder's own terms. "EIN" gets explained. "A2P
   campaign" is never said out loud — it is "carrier approval". The one place the
   copy gets blunt is where being vague would cost them money or a week: the
   website and privacy-policy requirements, and the EIN question that decides
   which registration tier they land in.
   ───────────────────────────────────────────────────────────────────────────── */

/** What the builder sees for each state. The server's `status` is a projection
 *  already — Twilio's own vocabulary never reaches this file. */
const SMS_STATE_COPY = {
  none:              { label: "Not set up",            tone: "idle",   blurb: "Text your customers from a number that belongs to your business." },
  intake:            { label: "Details needed",        tone: "idle",   blurb: "Tell us about your business so the phone carriers can approve you." },
  aup_pending:       { label: "One box to tick",       tone: "idle",   blurb: "Read and accept the texting rules to continue." },
  ready:             { label: "Ready to submit",       tone: "ready",  blurb: "Everything is filled in. Submitting sends your details to the carriers." },
  // ⚠️ NOT A WAITING STATE, despite where it sits in the chain. The server refuses to advance
  // this one on its own (portal-sms/index.ts:264-270 — advancing it REGISTERS A BILLED BRAND,
  // and the `status` action is only contacts:'view', so a sweep would let anyone who can open
  // the Contacts tab spend the tenant's money by refreshing a page). That exclusion is right,
  // but for a day it left the only exit unreachable and this copy told a builder to sit and
  // wait for something that was never coming. The tone and the words both say "your move" now.
  profile_pending:   { label: "One more step",         tone: "ready",  blurb: "Your business details are lodged. One more press registers your business with the carriers — that is the step that costs money." },
  brand_pending:     { label: "With the carriers",     tone: "wait",   blurb: "The phone carriers are checking your business. This usually takes a few days." },
  brand_failed:      { label: "Needs a correction",    tone: "bad",    blurb: "The carriers could not verify your business from what we sent." },
  brand_approved:    { label: "Business approved",     tone: "good",   blurb: "Your business passed. Now we register what you will use texting for." },
  campaign_pending:  { label: "Final review",          tone: "wait",   blurb: "The carriers are reviewing how you plan to use texting." },
  campaign_failed:   { label: "Needs a correction",    tone: "bad",    blurb: "The carriers rejected the description of how you will use texting." },
  campaign_approved: { label: "Pick your number",      tone: "good",   blurb: "Approved. Choose the phone number your customers will see." },
  number_pending:    { label: "Switching on",          tone: "wait",   blurb: "Your number is being connected. This is usually quick, but can take a day." },
  active:            { label: "Texting is on",         tone: "good",   blurb: "You can text customers from your Contacts." },
  paused:            { label: "Paused",                tone: "idle",   blurb: "Texting is paused. Your number is still yours." },
  releasing:         { label: "Closing down",          tone: "idle",   blurb: "Releasing the number." },
  off:               { label: "Off",                   tone: "idle",   blurb: "Texting is switched off for this account." },
};

const SMS_TONE_STYLE = {
  idle:  { bg: "#F1F5F9", fg: "#475569", dot: "#94A3B8" },
  ready: { bg: "#EFF6FF", fg: "#1D4ED8", dot: "#3B82F6" },
  wait:  { bg: "#FFFBEB", fg: "#B45309", dot: "#F59E0B" },
  good:  { bg: "#ECFDF5", fg: "#047857", dot: "#10B981" },
  bad:   { bg: "#FEF2F2", fg: "#B91C1C", dot: "#EF4444" },
};

function SmsStatusChip({ status }) {
  const copy = SMS_STATE_COPY[status] || SMS_STATE_COPY.none;
  const tone = SMS_TONE_STYLE[copy.tone] || SMS_TONE_STYLE.idle;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 7, background: tone.bg, color: tone.fg,
      borderRadius: 999, padding: "5px 12px", fontSize: 12, fontWeight: 800,
    }}>
      <span style={{ width: 7, height: 7, borderRadius: 999, background: tone.dot }} />
      {copy.label}
    </span>
  );
}

/** The progress rail. Five steps, because a builder who can see where they are stops
 *  emailing to ask. `number_pending` and `active` both read as step 5 — from the outside
 *  they are "nearly there" and "there". */
const SMS_STEPS = [
  { key: "details",  label: "Your details" },
  { key: "rules",    label: "The rules" },
  { key: "business", label: "Business check" },
  { key: "use",      label: "Usage review" },
  { key: "number",   label: "Your number" },
];
function smsStepIndex(status) {
  switch (status) {
    case "none": case "intake": return 0;
    case "aup_pending": return 1;
    case "ready": case "profile_pending": case "brand_pending": case "brand_failed": return 2;
    case "brand_approved": case "campaign_pending": case "campaign_failed": return 3;
    case "campaign_approved": case "number_pending": return 4;
    case "active": case "paused": return 5;
    default: return 0;
  }
}

function SmsSteps({ status }) {
  const at = smsStepIndex(status);
  return (
    <div style={{ display: "flex", gap: 0, flexWrap: "wrap", margin: "0 0 18px" }}>
      {SMS_STEPS.map((s, i) => {
        const done = i < at, here = i === at;
        return (
          <div key={s.key} style={{ display: "flex", alignItems: "center", gap: 8, marginRight: 6 }}>
            <div style={{
              width: 22, height: 22, borderRadius: 999, display: "grid", placeItems: "center",
              fontSize: 11, fontWeight: 800,
              background: done ? "#10B981" : here ? ACCENT : "#E2E8F0",
              color: done || here ? "#fff" : "#94A3B8",
            }}>{done ? "✓" : i + 1}</div>
            <span style={{ fontSize: 12, fontWeight: here ? 800 : 600, color: here ? "#0F172A" : "#64748B" }}>{s.label}</span>
            {i < SMS_STEPS.length - 1 && <span style={{ width: 18, height: 2, background: done ? "#10B981" : "#E2E8F0", marginLeft: 4 }} />}
          </div>
        );
      })}
    </div>
  );
}

/** The campaign copy form — ONE component, rendered at BOTH `ready` and `brand_approved`.
 *
 *  ⚠️ THE brand_approved CASE IS THE WHOLE POINT. The carriers take DAYS, so that card is
 *  reached after a page reload by definition — and until 2026-09-01 it rendered NO form at all,
 *  just a Continue button that posted a freshly-mounted state's two empty strings into a
 *  guaranteed 400, with nothing on screen to fix it. Two copies of this markup would drift
 *  straight back into that, so there is exactly one. */
function SmsCopyForm({ copy, setCopy, readOnly }) {
  return (
    <>
          <h4 style={{ margin: "0 0 6px", fontSize: 14 }}>What you will text people about</h4>
      <p style={{ margin: "0 0 12px", fontSize: 13, color: "#475569", lineHeight: 1.55 }}>
        The carriers read this. Write it about <em>your</em> business, and use real
        examples of messages you would actually send. Do not put a customer&rsquo;s name
        or number in an example — write <code>[Name]</code> instead.
      </p>
      <SmsField label="In a sentence, what will you text customers about?">
        <input style={SMS_INPUT} value={copy.description} disabled={readOnly}
          placeholder="Quote follow-ups, delivery times and build updates for customers who asked us for a quote."
          onChange={(e) => setCopy({ ...copy, description: e.target.value })} />
      </SmsField>
      <SmsField label="How do people agree to be texted?"
        hint="Describe where they tick the box. The carriers will look for it on your website, so it has to match what is actually there.">
        <input style={SMS_INPUT} value={copy.messageFlow} disabled={readOnly}
          placeholder="Customers tick a box giving us permission to text them when they request a quote on our website."
          onChange={(e) => setCopy({ ...copy, messageFlow: e.target.value })} />
      </SmsField>
      {copy.messageSamples.map((sample, i) => (
        <SmsField key={i} label={`Example message ${i + 1}`}>
          <input style={SMS_INPUT} value={sample} disabled={readOnly}
            placeholder={i === 0
              ? "Hi [Name], it's Junior Barns. Your 12x20 barn quote is ready — reply here with any questions. Reply STOP to opt out."
              : "Hi [Name], your building is scheduled for delivery on [Date]. Reply STOP to opt out."}
            onChange={(e) => {
              const next = copy.messageSamples.slice();
              next[i] = e.target.value;
              setCopy({ ...copy, messageSamples: next });
            }} />
        </SmsField>
      ))}
      <div style={{ fontSize: 12, color: "#64748B", marginBottom: 12 }}>
        Every message must say who you are and how to stop. Keep &ldquo;Reply STOP to opt
        out&rdquo; in your examples.
      </div>
    </>
  );
}

/** Mirrored from validateCampaignCopy in _shared/twilioTrustHub.ts, for the same reason
 *  ssCanRead/ssCanWrite are mirrored from access.ts: the portal has no module loader, the
 *  SERVER is the enforcement point, and a drift here costs a wrong button state, never a wrong
 *  submission. Keep the two in step. */
function smsCopyProblems(copy) {
  const out = [];
  const d = String((copy && copy.description) || "").trim();
  const f = String((copy && copy.messageFlow) || "").trim();
  const s = ((copy && copy.messageSamples) || []).map((x) => String(x || "").trim()).filter(Boolean);
  if (d.length < 40) out.push("Say a bit more about what you will text customers about — a full sentence.");
  if (f.length < 40) out.push("Describe where customers agree to be texted. Leaving this blank is one of the most common rejection reasons.");
  if (s.length < 2) out.push("Two example messages are required.");
  if (s.some((x) => x.length < 20)) out.push("Write each example out the way you would really send it.");
  if (s.length && !s.some((x) => /\bSTOP\b/i.test(x))) out.push("At least one example must show how to stop — keep “Reply STOP to opt out” in it.");
  return out;
}

/** Anything a human typed into a US phone box -> "+1XXXXXXXXXX", or "" if it is not one.
 *
 *  The portal shows a US number the way a person writes it; TrustHub takes +1XXXXXXXXXX and
 *  nothing else (validateIntake, _shared/twilioTrustHub.ts:237). The field used to pass raw
 *  keystrokes straight through, so anyone typing "(616) 548-5148" — which is how every US
 *  business writes their own number — was refused by the server with a message about a format
 *  the field never helped them produce.
 *
 *  ⚠️ NOT toE164US / smsE164US. Those two take DIGITS ONLY and return null for anything already
 *  carrying a "+", so neither can be pointed at formatPhone's "+1 (616) 548-5148" output. This
 *  is the one place the display shape and the wire shape meet, and every call site that sends
 *  `intake` goes through it — there is no route left that ships the display string. */
function smsE164(raw) {
  const d = String(raw == null ? "" : raw).replace(/\D/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d[0] === "1") return "+" + d;
  return "";
}

function SmsField({ label, hint, children, wide }) {
  return (
    <label style={{ display: "block", marginBottom: 12, gridColumn: wide ? "1 / -1" : "auto" }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#334155", marginBottom: 4 }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 11, color: "#64748B", marginTop: 4, lineHeight: 1.45 }}>{hint}</div>}
    </label>
  );
}

const SMS_INPUT = {
  width: "100%", padding: "9px 11px", border: "1px solid #CBD5E1", borderRadius: 8,
  fontSize: 13, fontFamily: "inherit", boxSizing: "border-box", background: "#fff",
};

function SmsMessagingView({ clientId, viewingLabel, canEdit }) {
  // ⚠️ HOOKS FIRST, ALL OF THEM, ABOVE EVERY EARLY RETURN. This file's siblings guard with
  // early returns and a hook added below one white-screens the page on React #310 — which
  // compiles and passes preflight. Cache seeding uses a useState initializer for the same
  // reason it does elsewhere: it paints a revisit synchronously and adds no hook.
  const [data, setData] = useState(() => ssCacheGet("portal-sms", "status", clientId));
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [hasEin, setHasEin] = useState(true);
  const [form, setForm] = useState({
    legalBusinessName: "", ein: "", businessType: "Limited Liability Corporation",
    businessIndustry: "CONSTRUCTION", websiteUrl: "", street: "", city: "", region: "",
    postalCode: "", isoCountry: "US", repFirstName: "", repLastName: "", repEmail: "",
    repPhone: "", repBusinessTitle: "Owner", repJobPosition: "CEO",
  });
  const [urls, setUrls] = useState({ privacyPolicyUrl: "", termsUrl: "" });
  const [copy, setCopy] = useState({
    description: "",
    messageFlow: "",
    messageSamples: ["", ""],
  });
  const [areaCode, setAreaCode] = useState("");
  const [found, setFound] = useState(null);
  const [problems, setProblems] = useState([]);

  const call = useCallback(async (action, body) => {
    const { data: d, error } = await sb.functions.invoke("portal-sms", { body: { action, ...(body || {}) } });
    if (error || (d && d.error)) throw new Error((d && d.error) || error.message);
    return d;
  }, []);

  const refresh = useCallback(async () => {
    try {
      const d = await call("status");
      setData(d);
      ssCachePut("portal-sms", "status", clientId, d);
      setErr(null);
      // Seed the form from the echo so a returning builder sees what they typed.
      if (d.intake && d.intake.legalBusinessName) {
        setForm((f) => ({ ...f, legalBusinessName: d.intake.legalBusinessName, websiteUrl: d.intake.websiteUrl || "" }));
        setUrls({ privacyPolicyUrl: d.intake.privacyPolicyUrl || "", termsUrl: d.intake.termsUrl || "" });
      }
      // ⚠️ SEED THE COPY ONLY WHILE THE FORM IS PRISTINE. refresh() runs after every action AND
      // on a 60-second timer while pending, so an unconditional seed would delete a sentence the
      // builder was halfway through typing. Empty-on-all-three is the only safe "they have not
      // started" test — a partially typed form must win over the stored value every time.
      if (d.copy) {
        setCopy((c) => {
          const pristine = !c.description && !c.messageFlow && !(c.messageSamples || []).some(Boolean);
          if (!pristine) return c;
          return {
            description: d.copy.description || "",
            messageFlow: d.copy.messageFlow || "",
            messageSamples: (d.copy.messageSamples || []).length >= 2 ? d.copy.messageSamples.slice(0, 5) : ["", ""],
          };
        });
      }
    } catch (e) { setErr(e.message); }
  }, [call, clientId]);

  useEffect(() => { refresh(); }, [refresh]);

  // A registration in a waiting state moves on its own. Poll gently so the builder does not
  // have to know to come back — but only while something is actually pending.
  // ⚠️ TWO DIFFERENT QUESTIONS THAT USED TO SHARE ONE ANSWER, and the disagreement stranded a
  // tenant for a day. `pending` asks "does this move on its own, so keep polling?".
  // `waitingOnYou` asks "is the next move the BUILDER's?". profile_pending is the one state
  // where they differ — the server's sweepable list (portal-sms/index.ts:270) excludes it on
  // purpose, so the reassurance below was a promise nothing could keep.
  //
  // profile_pending STAYS in `pending`: the poll is what makes an operator-side unstick appear
  // on a builder's already-open tab within the minute.
  const waitingOnYou = data && data.status === "profile_pending";
  const pending = data && ["profile_pending", "brand_pending", "campaign_pending", "number_pending"].includes(data.status);
  useEffect(() => {
    if (!pending) return undefined;
    const t = setInterval(() => { refresh(); }, 60000);
    return () => clearInterval(t);
  }, [pending, refresh]);

  const act = async (fn) => {
    if (busy) return;
    setBusy(true); setErr(null); setProblems([]);
    try { await fn(); await refresh(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  if (!data) return <SkelRows cols={2} rows={5} />;

  const status = data.status || "none";
  const copyFor = SMS_STATE_COPY[status] || SMS_STATE_COPY.none;
  const readOnly = !canEdit;

  const card = {
    background: "#fff", border: "1px solid #E2E8F0", borderRadius: 12, padding: 18, marginBottom: 14,
  };

  return (
    <div>
      {/* ── Where they are ─────────────────────────────────────────────────── */}
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>Text messaging{viewingLabel ? ` — ${viewingLabel}` : ""}</h3>
          <SmsStatusChip status={status} />
          {/* ⚠️ A MOCK REGISTRATION IS INDISTINGUISHABLE FROM A REAL ONE until a text fails
              to arrive. It moves through the same states and reports the same "approved".
              So it is labelled here, next to the status, and not behind a debug setting.
              Only an internal account can have one (migration 170 enforces that in the
              database), so nobody outside CSM Synergy will ever see this. */}
          {data.mockBrand && (
            <span title="Registered with Twilio Mock=true: free and unvetted, but it cannot send messages and Twilio deletes it after 30 days."
              style={{
                fontSize: 11, fontWeight: 800, letterSpacing: 0.3, textTransform: "uppercase",
                color: "#92400E", background: "#FEF3C7", border: "1px solid #FDE68A",
                borderRadius: 999, padding: "3px 9px",
              }}>
              Test registration &middot; cannot send
            </span>
          )}
          <button type="button" onClick={() => refresh()} disabled={busy}
            style={{ marginLeft: "auto", background: "none", border: "1px solid #CBD5E1", borderRadius: 8, padding: "6px 12px", cursor: "pointer", fontSize: 12, fontWeight: 700, color: "#475569" }}>
            Refresh
          </button>
        </div>
        <SmsSteps status={status} />
        <p style={{ margin: 0, fontSize: 13, color: "#475569", lineHeight: 1.55 }}>{copyFor.blurb}</p>

        {data.needsAttention && data.attentionNote && (
          <div style={{ marginTop: 12, background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 8, padding: "10px 12px", fontSize: 13, color: "#991B1B" }}>
            <strong>Needs attention.</strong> {data.attentionNote}
          </div>
        )}
        {Array.isArray(data.errors) && data.errors.length > 0 && (
          <ul style={{ marginTop: 10, paddingLeft: 18, fontSize: 12, color: "#B91C1C" }}>
            {data.errors.slice(0, 5).map((e, i) => (
              <li key={i} style={{ marginBottom: 3 }}>{(e && (e.description || e.message)) || String(e)}</li>
            ))}
          </ul>
        )}
        {err && <div style={{ marginTop: 12, color: "#B91C1C", fontSize: 13 }}>{err}</div>}

        {/* Waiting states are where builders email to ask what is happening. Say it here —
            but ONLY where it is true. See waitingOnYou above. */}
        {pending && !waitingOnYou && (
          <div style={{ marginTop: 12, fontSize: 12, color: "#64748B", lineHeight: 1.5 }}>
            Nothing for you to do — this page checks by itself and will update when the
            carriers answer. You can close it and come back.
          </div>
        )}
      </div>

      {/* ── What they have to have ready ───────────────────────────────────── */}
      {["none", "intake", "aup_pending", "ready", "brand_failed"].includes(status) && (
        <div style={card}>
          <h4 style={{ margin: "0 0 8px", fontSize: 14 }}>Before you start</h4>
          <p style={{ margin: "0 0 10px", fontSize: 13, color: "#475569", lineHeight: 1.55 }}>
            The phone carriers check these themselves, and they are the usual reason a
            registration comes back rejected. It is worth getting them right first.
          </p>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: "#334155", lineHeight: 1.7 }}>
            <li><strong>A working website</strong> at your own domain. A Facebook page or a
              &ldquo;coming soon&rdquo; page will not pass — someone screenshots it.</li>
            <li><strong>A privacy policy page</strong> anyone can open without logging in,
              saying you do not share phone numbers with anyone else, and containing the
              sentence &ldquo;Message and data rates may apply.&rdquo;</li>
            <li><strong>A terms page on the same website</strong> as your business site.</li>
            <li><strong>Your business name exactly as the IRS has it</strong> — off your EIN
              letter, not your trading name.</li>
            <li><strong>A company email address.</strong> A Gmail or Yahoo address is a
              documented rejection reason.</li>
          </ul>
          <div style={{ marginTop: 10, fontSize: 12, color: "#64748B" }}>
            One more: if your EIN was issued in the last 90 days, wait. It takes that long to
            reach the databases the carriers check, and registering early just fails.
          </div>
        </div>
      )}

      {/* ── Step 1: the intake ─────────────────────────────────────────────── */}
      {["none", "intake", "aup_pending", "ready", "brand_failed"].includes(status) && (
        <div style={card}>
          <h4 style={{ margin: "0 0 12px", fontSize: 14 }}>Your business</h4>

          {/* ⚠️ THE QUESTION THAT DECIDES EVERYTHING. Sole proprietor is not a "small
              business" option — it is for businesses with NO tax ID, and the carriers reject
              anyone holding an EIN who claims it. Asking it plainly here is what keeps a
              builder out of a paid rejection. */}
          <SmsField
            label="Does your business have an EIN (a federal tax ID)?"
            hint="Almost every LLC, Inc. or Corp. has one. If you file taxes under your own Social Security number instead, answer no.">
            <div style={{ display: "flex", gap: 8 }}>
              {[["yes", true], ["no", false]].map(([lbl, v]) => (
                <button key={lbl} type="button" disabled={readOnly} onClick={() => setHasEin(v)}
                  style={{
                    padding: "8px 18px", borderRadius: 8, cursor: readOnly ? "default" : "pointer",
                    fontSize: 13, fontWeight: 700, fontFamily: "inherit",
                    border: hasEin === v ? `2px solid ${ACCENT}` : "1px solid #CBD5E1",
                    background: hasEin === v ? "#EFF6FF" : "#fff",
                    color: hasEin === v ? ACCENT : "#475569",
                  }}>{lbl === "yes" ? "Yes" : "No"}</button>
              ))}
            </div>
          </SmsField>

          {/* ⚠️ SAY IT THE MOMENT THEY ANSWER NO, not after they have filled fifteen fields.
              The server refuses this intake (validateIntake), so without this the builder
              completes the whole form and is turned away at Save — the worst possible place
              to learn it. Sole proprietor needs a different Twilio chain that is not built:
              a Starter profile, no EIN fields, and the mobile carried on the brand. */}
          {hasEin === false && (
            <div style={{
              border: "1px solid #FDE68A", background: "#FFFBEB", borderRadius: 8,
              padding: "11px 13px", margin: "0 0 14px",
            }}>
              <div style={{ fontSize: 13, color: "#92400E", fontWeight: 700, marginBottom: 5 }}>
                We can&rsquo;t set this up without an EIN yet
              </div>
              <div style={{ fontSize: 12.5, color: "#78350F", lineHeight: 1.55 }}>
                Registering a business with no tax ID goes through a different carrier process,
                and we haven&rsquo;t built it. If your business does have an EIN, answer
                &ldquo;Yes&rdquo; above. If it genuinely doesn&rsquo;t, get in touch and
                we&rsquo;ll tell you where it stands &mdash; please don&rsquo;t fill the rest of
                this in, it won&rsquo;t save.
              </div>
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 14px" }}>
            <SmsField label="Legal business name" hint="Exactly as it appears on your IRS letter." wide>
              <input style={SMS_INPUT} value={form.legalBusinessName} disabled={readOnly}
                onChange={(e) => setForm({ ...form, legalBusinessName: e.target.value })} />
            </SmsField>
            {hasEin && (
              <SmsField label="EIN" hint="Nine digits, like 12-3456789.">
                <input style={SMS_INPUT} value={form.ein} disabled={readOnly} placeholder="12-3456789"
                  onChange={(e) => setForm({ ...form, ein: e.target.value })} />
              </SmsField>
            )}
            {hasEin && (
              <SmsField label="Business type">
                <select style={SMS_INPUT} value={form.businessType} disabled={readOnly}
                  onChange={(e) => setForm({ ...form, businessType: e.target.value })}>
                  {(data.businessTypes || []).map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </SmsField>
            )}
            <SmsField label="Website" hint="Must be live and public." wide>
              <input style={SMS_INPUT} value={form.websiteUrl} disabled={readOnly} placeholder="https://"
                onChange={(e) => setForm({ ...form, websiteUrl: e.target.value })} />
            </SmsField>
            <SmsField label="Privacy policy page">
              <input style={SMS_INPUT} value={urls.privacyPolicyUrl} disabled={readOnly} placeholder="https://"
                onChange={(e) => setUrls({ ...urls, privacyPolicyUrl: e.target.value })} />
            </SmsField>
            <SmsField label="Terms page">
              <input style={SMS_INPUT} value={urls.termsUrl} disabled={readOnly} placeholder="https://"
                onChange={(e) => setUrls({ ...urls, termsUrl: e.target.value })} />
            </SmsField>

            <SmsField label="Street address" wide>
              <input style={SMS_INPUT} value={form.street} disabled={readOnly}
                onChange={(e) => setForm({ ...form, street: e.target.value })} />
            </SmsField>
            <SmsField label="City">
              <input style={SMS_INPUT} value={form.city} disabled={readOnly}
                onChange={(e) => setForm({ ...form, city: e.target.value })} />
            </SmsField>
            <SmsField label="State / ZIP">
              <div style={{ display: "flex", gap: 8 }}>
                <input style={{ ...SMS_INPUT, width: 70 }} value={form.region} disabled={readOnly} placeholder="TX" maxLength={2}
                  onChange={(e) => setForm({ ...form, region: e.target.value.toUpperCase() })} />
                <input style={SMS_INPUT} value={form.postalCode} disabled={readOnly} placeholder="78701"
                  onChange={(e) => setForm({ ...form, postalCode: e.target.value })} />
              </div>
            </SmsField>
          </div>

          <h4 style={{ margin: "14px 0 10px", fontSize: 14 }}>Who the carriers can contact</h4>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 14px" }}>
            <SmsField label="First name">
              <input style={SMS_INPUT} value={form.repFirstName} disabled={readOnly}
                onChange={(e) => setForm({ ...form, repFirstName: e.target.value })} />
            </SmsField>
            <SmsField label="Last name">
              <input style={SMS_INPUT} value={form.repLastName} disabled={readOnly}
                onChange={(e) => setForm({ ...form, repLastName: e.target.value })} />
            </SmsField>
            <SmsField label="Work email" hint="Must be on your own company domain — not gmail, yahoo or outlook.">
              <input style={SMS_INPUT} value={form.repEmail} disabled={readOnly}
                onChange={(e) => setForm({ ...form, repEmail: e.target.value })} />
            </SmsField>
            <SmsField label="Mobile number" hint={hasEin ? "In case the carriers need to reach you." : "You will get a text with a code you must reply to within 24 hours."}>
              {/* formatPhone lives in 12-shell.jsx, a LATER part — but the parts are
                  concatenated into one IIFE and it is a `function` declaration, so it hoists
                  across the whole scope. (The "part order is load-bearing" rule in CLAUDE.md
                  is about `const`, which does not hoist. This is the exception.) */}
              <input style={SMS_INPUT} value={form.repPhone} disabled={readOnly} placeholder="(555) 123-4567"
                onChange={(e) => setForm({ ...form, repPhone: formatPhone(e.target.value) })} />
            </SmsField>
            <SmsField label="Job title">
              <input style={SMS_INPUT} value={form.repBusinessTitle} disabled={readOnly}
                onChange={(e) => setForm({ ...form, repBusinessTitle: e.target.value })} />
            </SmsField>
            <SmsField label="Role">
              <select style={SMS_INPUT} value={form.repJobPosition} disabled={readOnly}
                onChange={(e) => setForm({ ...form, repJobPosition: e.target.value })}>
                {(data.jobPositions || []).map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </SmsField>
          </div>

          {problems.length > 0 && (
            <ul style={{ margin: "6px 0 10px", paddingLeft: 18, fontSize: 13, color: "#B91C1C", lineHeight: 1.6 }}>
              {problems.map((pr, i) => <li key={i}>{pr}</li>)}
            </ul>
          )}

          {!readOnly && (
            <button type="button" disabled={busy}
              onClick={() => act(async () => {
                const d = await call("save_intake", {
                  hasEin, intake: { ...form, repPhone: smsE164(form.repPhone) },
                  privacyPolicyUrl: urls.privacyPolicyUrl, termsUrl: urls.termsUrl,
                }).catch((e) => { throw e; });
                void d;
              })}
              style={{ background: ACCENT, color: "#fff", border: "none", borderRadius: 8, padding: "10px 18px", cursor: "pointer", fontWeight: 800, fontSize: 13, fontFamily: "inherit" }}>
              {busy ? "Saving…" : "Save details"}
            </button>
          )}
        </div>
      )}

      {/* ── Step 2: the rules ──────────────────────────────────────────────── */}
      {["intake", "aup_pending", "ready"].includes(status) && !data.aupAcceptedAt && (
        <div style={card}>
          <h4 style={{ margin: "0 0 10px", fontSize: 14 }}>The texting rules</h4>
          <p style={{ margin: "0 0 10px", fontSize: 13, color: "#475569", lineHeight: 1.6 }}>{data.aupText}</p>
          {!readOnly && (
            <button type="button" disabled={busy} onClick={() => act(() => call("accept_aup"))}
              style={{ background: ACCENT, color: "#fff", border: "none", borderRadius: 8, padding: "10px 18px", cursor: "pointer", fontWeight: 800, fontSize: 13, fontFamily: "inherit" }}>
              I agree
            </button>
          )}
        </div>
      )}

      {/* ── Step 3: what they will send, then submit ───────────────────────── */}
      {status === "ready" && (
        <div style={card}>
          <SmsCopyForm copy={copy} setCopy={setCopy} readOnly={readOnly} />

          {!readOnly && (
            <>
              {/* This step creates the TrustHub bundles and spends NOTHING — the charge is one
                  state later, on the profile_pending card. Saying "starts the one-time setup
                  charge" here was wrong twice over: it warned about money on the free step and
                  left the paid step with no warning at all. */}
              <div style={{ background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 8, padding: "10px 12px", fontSize: 13, color: "#92400E", marginBottom: 12 }}>
                Submitting sends your business details to the carriers. Nothing is charged yet —
                the next screen tells you before anything is.
              </div>
              {smsCopyProblems(copy).length > 0 && (
                <ul style={{ margin: "0 0 10px", paddingLeft: 18, fontSize: 13, color: "#B91C1C", lineHeight: 1.6 }}>
                  {smsCopyProblems(copy).map((pr, i) => <li key={i}>{pr}</li>)}
                </ul>
              )}
              {/* Save the copy BEFORE advancing, so a refusal further down does not cost the
                  builder their typing — and so it is on the row when they come back days later. */}
              <button type="button" disabled={busy || smsCopyProblems(copy).length > 0}
                onClick={() => act(async () => {
                  await call("save_copy", { copy });
                  await call("advance", { intake: { ...form, repPhone: smsE164(form.repPhone) }, copy });
                })}
                style={{ background: smsCopyProblems(copy).length > 0 ? "#CBD5E1" : ACCENT, color: "#fff", border: "none", borderRadius: 8, padding: "11px 20px", cursor: smsCopyProblems(copy).length > 0 ? "default" : "pointer", fontWeight: 800, fontSize: 14, fontFamily: "inherit" }}>
                {busy ? "Submitting…" : "Submit to the carriers"}
              </button>
            </>
          )}
        </div>
      )}

      {/* ── The money step, and the only card that is deliberately a SECOND click ──────────
          ⚠️ THIS STATE IS NOT SWEPT AND MUST NEVER BE. portal-sms's lazy sweep excludes
          profile_pending on purpose (index.ts:264-270): advancing it REGISTERS A BILLED BRAND,
          and the `status` action is gated contacts:'view', so sweeping it would let anyone who
          can open the Contacts tab spend the tenant's money by refreshing a page.

          The consequence of that correct exclusion is that a PERSON has to press something —
          and until 2026-09-01 there was nothing to press. The transition code sat right there
          at index.ts:700 with all three routes to it blocked, so profile_pending was a dead end
          that stranded the first real builder for a day while the page told her to wait. This
          card is the missing press. */}
      {status === "profile_pending" && (
        <div style={card}>
          <h4 style={{ margin: "0 0 8px", fontSize: 14 }}>Register your business with the carriers</h4>
          <p style={{ margin: "0 0 12px", fontSize: 13, color: "#475569", lineHeight: 1.55 }}>
            Your business details are lodged with the carriers. The next step registers the
            business itself so they can start their checks — that usually takes a few days.
          </p>
          <div style={{ background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 8, padding: "10px 12px", fontSize: 13, color: "#92400E", marginBottom: 12 }}>
            <strong>This is the step that costs money.</strong> Pressing Register submits a paid
            carrier registration for your business. It cannot be undone and it is not refundable.
          </div>
          {readOnly ? (
            <div style={{ fontSize: 12.5, color: "#64748B", lineHeight: 1.5 }}>
              Only an owner — or an admin an owner has given billing access to — can start the
              paid registration. Ask them to open Settings → Text Messaging.
            </div>
          ) : (
            <button type="button" disabled={busy}
              onClick={() => {
                if (!window.confirm(
                  "Register this business with the phone carriers?\n\n"
                  + "This is the paid step. It cannot be undone or refunded, and it only needs "
                  + "to be done once for this business.")) return;
                act(() => call("advance"));
              }}
              style={{ background: ACCENT, color: "#fff", border: "none", borderRadius: 8, padding: "11px 20px", cursor: "pointer", fontWeight: 800, fontSize: 14, fontFamily: "inherit" }}>
              {busy ? "Registering…" : "Register with the carriers"}
            </button>
          )}
        </div>
      )}

      {/* Brand approved → the campaign goes next, same copy form. */}
      {status === "brand_approved" && !readOnly && (
        <div style={card}>
          <h4 style={{ margin: "0 0 10px", fontSize: 14 }}>One more review</h4>
          <p style={{ margin: "0 0 12px", fontSize: 13, color: "#475569" }}>
            Your business passed. The last step describes how you will use texting — check it
            still reads the way you want, because the carriers cannot be sent a correction later.
          </p>
          {/* ⚠️ THE FORM MUST BE HERE. This card is reached DAYS later, so the page has certainly
              reloaded and the in-memory copy is empty. It used to render no fields at all and
              post that empty state straight into a refusal. It is pre-filled from the row now. */}
          <SmsCopyForm copy={copy} setCopy={setCopy} readOnly={readOnly} />
          {smsCopyProblems(copy).length > 0 && (
            <ul style={{ margin: "0 0 10px", paddingLeft: 18, fontSize: 13, color: "#B91C1C", lineHeight: 1.6 }}>
              {smsCopyProblems(copy).map((pr, i) => <li key={i}>{pr}</li>)}
            </ul>
          )}
          <button type="button" disabled={busy || smsCopyProblems(copy).length > 0}
            onClick={() => act(async () => {
              await call("save_copy", { copy });
              await call("advance", { copy });
            })}
            style={{ background: smsCopyProblems(copy).length > 0 ? "#CBD5E1" : ACCENT, color: "#fff", border: "none", borderRadius: 8, padding: "10px 18px", cursor: smsCopyProblems(copy).length > 0 ? "default" : "pointer", fontWeight: 800, fontSize: 13, fontFamily: "inherit" }}>
            {busy ? "Submitting…" : "Continue"}
          </button>
        </div>
      )}

      {/* A rejection the builder can act on. */}
      {status === "brand_failed" && !readOnly && (
        <div style={card}>
          <h4 style={{ margin: "0 0 8px", fontSize: 14 }}>Fix and try again</h4>
          <p style={{ margin: "0 0 10px", fontSize: 13, color: "#475569", lineHeight: 1.55 }}>
            Correct the details above, then resubmit. You have{" "}
            <strong>{data.brandUpdatesLeft}</strong> free {data.brandUpdatesLeft === 1 ? "attempt" : "attempts"} left —
            after that it has to go through support.
          </p>
          <button type="button" disabled={busy || data.brandUpdatesLeft < 1}
            onClick={() => act(() => call("advance", { intake: { ...form, repPhone: smsE164(form.repPhone) }, copy }))}
            style={{ background: data.brandUpdatesLeft < 1 ? "#CBD5E1" : ACCENT, color: "#fff", border: "none", borderRadius: 8, padding: "10px 18px", cursor: data.brandUpdatesLeft < 1 ? "default" : "pointer", fontWeight: 800, fontSize: 13, fontFamily: "inherit" }}>
            Resubmit
          </button>
        </div>
      )}

      {/* A campaign rejection cannot be retried from here — see the server. */}
      {/* ── A rejected campaign, and the way out of it ────────────────────────────────────
          This card used to say "we have been notified and will be in touch" and offer NOTHING —
          no button here, no branch in portal-sms, and deleteCampaign() had no callers anywhere.
          That stranded the first real rejection exactly the way profile_pending did, one stage
          later, and the promise of a human had no mechanism behind it.

          ⚠️ THE ERRORS ARE THE POINT OF THIS SCREEN. A campaign is refused for a NAMED reason,
          so the reasons are shown verbatim, above the form that fixes them. They were empty
          for the whole life of this card until 2026-09-02 — the webhook received Twilio's
          error array and dropped it — so this rendered "they told us why" over nothing while
          the same two fields were refused twice. */}
      {status === "campaign_failed" && (
        <div style={card}>
          <h4 style={{ margin: "0 0 8px", fontSize: 14 }}>The carriers turned this one down</h4>
          <p style={{ margin: "0 0 10px", fontSize: 13, color: "#475569", lineHeight: 1.55 }}>
            They told us why. Change what they named below and send it again — there is no
            charge for sending it again, and no limit on how many times you can.
          </p>

          {(data.errors || []).length > 0 && (
            <ul style={{ margin: "0 0 12px", paddingLeft: 18, fontSize: 13, color: "#B91C1C", lineHeight: 1.6 }}>
              {(data.errors || []).map((e, i) => (
                <li key={i}>
                  {e.description || String(e)}
                  {e.fields && e.fields.length > 0 && (
                    <span style={{ color: "#64748B" }}> — they looked at: {e.fields.join(", ")}</span>
                  )}
                </li>
              ))}
            </ul>
          )}

          {readOnly ? (
            <div style={{ fontSize: 12.5, color: "#64748B", lineHeight: 1.5 }}>
              An owner — or an admin with billing access — can rewrite this and send it again
              from Settings &rarr; Text Messaging.
            </div>
          ) : (
            <>
              {/* ⚠️ THE FORM BELONGS HERE, ON THE REJECTION ITSELF. Until 2026-09-02 this card
                  offered exactly one control — a button that DELETED the campaign at Twilio —
                  so the only route to the wording ran through destroying the thing being
                  fixed, and the yellow box beside it said that cost nothing. It cost the
                  vetting fee and a try, on the click. Editing in place is free and unlimited,
                  so the builder edits right here and presses send. */}
              <SmsCopyForm copy={copy} setCopy={setCopy} readOnly={false} />
              {smsCopyProblems(copy).length > 0 && (
                <ul style={{ margin: "0 0 10px", paddingLeft: 18, fontSize: 13, color: "#B91C1C", lineHeight: 1.6 }}>
                  {smsCopyProblems(copy).map((pr, i) => <li key={i}>{pr}</li>)}
                </ul>
              )}
              <button type="button" disabled={busy || smsCopyProblems(copy).length > 0}
                onClick={() => act(async () => {
                  await call("save_copy", { copy });
                  await call("advance", { copy });
                })}
                style={{ background: smsCopyProblems(copy).length > 0 ? "#CBD5E1" : ACCENT, color: "#fff", border: "none", borderRadius: 8, padding: "10px 18px", cursor: smsCopyProblems(copy).length > 0 ? "default" : "pointer", fontWeight: 800, fontSize: 13, fontFamily: "inherit" }}>
                {busy ? "Sending…" : "Send it again"}
              </button>
            </>
          )}
        </div>
      )}

      {/* ── Step 5: the number ─────────────────────────────────────────────── */}
      {status === "campaign_approved" && !readOnly && (
        <div style={card}>
          <h4 style={{ margin: "0 0 10px", fontSize: 14 }}>Choose your number</h4>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginBottom: 12 }}>
            <SmsField label="Area code">
              <input style={{ ...SMS_INPUT, width: 110 }} value={areaCode} placeholder="512" maxLength={3}
                onChange={(e) => setAreaCode(e.target.value.replace(/\D/g, ""))} />
            </SmsField>
            <button type="button" disabled={busy}
              onClick={() => act(async () => { const d = await call("search_numbers", { areaCode }); setFound(d.numbers || []); })}
              style={{ background: "#fff", border: "1px solid #CBD5E1", borderRadius: 8, padding: "9px 16px", cursor: "pointer", fontWeight: 700, fontSize: 13, marginBottom: 12, fontFamily: "inherit" }}>
              Search
            </button>
          </div>
          {found && found.length === 0 && (
            <div style={{ fontSize: 13, color: "#64748B" }}>No numbers free in that area code — try a nearby one.</div>
          )}
          {found && found.length > 0 && (
            <div style={{ display: "grid", gap: 8 }}>
              {found.map((n) => (
                <div key={n.phoneNumber} style={{ display: "flex", alignItems: "center", gap: 12, border: "1px solid #E2E8F0", borderRadius: 8, padding: "10px 12px" }}>
                  <div style={{ fontWeight: 800, fontSize: 14 }}>{n.friendlyName || n.phoneNumber}</div>
                  {/* locality comes back null on real Twilio results — render nothing, never "null". */}
                  <div style={{ fontSize: 12, color: "#64748B" }}>{[n.locality, n.region].filter(Boolean).join(", ")}</div>
                  <button type="button" disabled={busy}
                    onClick={() => act(() => call("buy_number", { phoneNumber: n.phoneNumber }))}
                    style={{ marginLeft: "auto", background: ACCENT, color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", cursor: "pointer", fontWeight: 800, fontSize: 13, fontFamily: "inherit" }}>
                    Use this number
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Live ───────────────────────────────────────────────────────────── */}
      {(data.numbers || []).length > 0 && (
        <div style={card}>
          <h4 style={{ margin: "0 0 10px", fontSize: 14 }}>Your number</h4>
          {data.numbers.map((n) => (
            <div key={n.phoneNumber} style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ fontSize: 18, fontWeight: 800 }}>{n.phoneNumber}</div>
              <span style={{ fontSize: 12, fontWeight: 700, color: n.registrationStatus === "registered" ? "#047857" : "#B45309" }}>
                {n.registrationStatus === "registered" ? "Ready to use" : "Being connected…"}
              </span>
            </div>
          ))}
          {status === "active" && (
            <p style={{ margin: "10px 0 0", fontSize: 13, color: "#475569" }}>
              Open any contact to text them. They can reply and it lands on their record.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
