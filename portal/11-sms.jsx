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

/** What each carrier refusal actually means, and what to change.
 *
 *  ⚠️ TWILIO'S OWN SENTENCE IS NOT AN INSTRUCTION. "The campaign submission has been reviewed
 *  and it was rejected because of provided Opt-in information" tells a shed builder nothing
 *  they can act on, and it is all the screen showed for three refusals in a row. Each entry
 *  below adds the two lines that are missing: what the carriers were looking at, and what to
 *  change. Keyed on the numeric CODE, never on the sentence — the sentence is Twilio's to
 *  reword, and a text key would silently stop matching the day they do.
 *
 *  An unmapped code still renders: Twilio's own description, the field it named, and a link.
 *  Better a bare reason than a swallowed one — that is the whole lesson of this card. */
const SMS_ERROR_HELP = {
  "30886": {
    title: "The description of what you text about was not accepted",
    what: "The carriers read the sentence describing what you send, and could not tell from it who is texting, who they are texting, or why. Listing what you send — quotes, invoices, updates — is not enough on its own.",
    fix: "Rewrite it so it names your business, says the customer asked you for a quote, and says what the texts are about. Something like: \"Acme Sheds sends text messages to customers who have requested a quote from us, about their quote, their invoice and the delivery date of the building they ordered. Customers give permission on our quote form.\"",
  },
  "30896": {
    title: "They could not verify how customers agree to be texted",
    what: "This is the one about your opt-in. The carriers go and look for the consent box you described, and they have to be able to SEE it — the wording, the tick box, and links to your privacy policy and terms — on a page that opens without signing in or clicking around.",
    fix: "Give them a page they can open. Describe where the box is, quote the exact wording next to it, and include the link. If the box only appears part-way through a form, they will not find it, and this comes back rejected every time.",
  },
  "30908": {
    title: "Your privacy policy was not accepted",
    what: "Either no privacy policy reached them, or the one they read does not say what happens to a phone number. They look for a plain statement that mobile numbers and texting permission are never shared or sold to anyone else for marketing.",
    fix: "Add a short SMS section to your privacy policy saying you do not share, sell or rent mobile numbers or texting consent to third parties or affiliates for marketing, and that the number is only used to message that customer about their own quote and building.",
  },
  "30932": {
    title: "Your privacy policy has to say who else sees the data",
    what: "The carriers want the policy to be explicit about sharing with anyone outside your business — and explicit that texting permission is excluded from any sharing you do.",
    fix: "Say it in one sentence: mobile information and texting consent are not shared with third parties or affiliates for marketing or promotional purposes.",
  },
  "30882": {
    title: "Your terms page was not accepted",
    what: "Either no terms page reached them, or the page they opened does not cover texting.",
    fix: "Add a short texting section to your terms: what the messages are about, that message frequency varies, that message and data rates may apply, and that customers can reply STOP to stop or HELP for help.",
  },
  "30922": {
    title: "They could not verify your website",
    what: "The website on the registration has to be a real, public business site with your business name on it, and it has to carry links to your privacy policy and terms.",
    fix: "Use your main business website, not a social page or a landing page, and make sure the privacy and terms links are on it.",
  },
  "30924": {
    title: "The consent wording is not where they need it",
    what: "The message-frequency and \"message and data rates may apply\" lines have to sit next to the tick box itself — not only inside a linked privacy policy or terms page.",
    fix: "Put the full sentence beside the box, including who is texting, what about, that frequency varies, that rates may apply, and how to stop.",
  },
  "30933": { title: "The terms URL was missing from the submission", what: "The registration reached the carriers without a terms address at all.", fix: "Fill in the terms page address and send it again." },
  "30934": { title: "The privacy policy URL was missing from the submission", what: "The registration reached the carriers without a privacy policy address at all.", fix: "Fill in the privacy policy address and send it again." },
};

/** ⚠️ TWILIO NAMES THE FIELD, AND THE FIELD NAME IS THE MOST USEFUL THING IN THE PAYLOAD.
 *  `fields: ["MESSAGE_FLOW"]` is what turns "your campaign was rejected" into "the box on
 *  your screen labelled How do people agree to be texted". Rendered as the label the builder
 *  is actually looking at, never as Twilio's constant. */
const SMS_ERROR_FIELD_LABEL = {
  USE_CASE_DESCRIPTION: "In a sentence, what will you text customers about?",
  MESSAGE_FLOW: "How do people agree to be texted?",
  MESSAGE_SAMPLES: "Your example messages",
  PRIVACY_POLICY_URL: "Privacy policy address",
  TERMS_AND_CONDITIONS_URL: "Terms page address",
  WEBSITE_URL: "Website",
  BRAND_NAME: "Legal business name",
};

/** The rejection reasons, each with what it means and what to change. */
function SmsErrorList({ errors }) {
  const list = (errors || []).filter(Boolean);
  if (!list.length) return null;
  return (
    <div style={{ margin: "0 0 12px", display: "grid", gap: 10 }}>
      {list.map((e, i) => {
        const code = String((e && e.error_code) || "");
        const help = SMS_ERROR_HELP[code];
        const fields = (e && Array.isArray(e.fields) ? e.fields : [])
          .map((f) => SMS_ERROR_FIELD_LABEL[f] || f);
        return (
          <div key={i} style={{ background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 8, padding: "11px 13px" }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: "#991B1B", marginBottom: fields.length ? 4 : 6 }}>
              {help ? help.title : (e.description || String(e))}
            </div>
            {fields.length > 0 && (
              <div style={{ fontSize: 12, color: "#B91C1C", marginBottom: 6 }}>
                What they were looking at: <strong>{fields.join(", ")}</strong>
              </div>
            )}
            {help && (
              <>
                <div style={{ fontSize: 12.5, color: "#7F1D1D", lineHeight: 1.55, marginBottom: 6 }}>{help.what}</div>
                <div style={{ fontSize: 12.5, color: "#166534", background: "#F0FDF4", border: "1px solid #BBF7D0", borderRadius: 6, padding: "8px 10px", lineHeight: 1.55 }}>
                  <strong>What to change:</strong> {help.fix}
                </div>
              </>
            )}
            {code && (
              <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 6 }}>
                Carrier code {code}
                {!help && e.description ? " — " + e.description : ""}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** The pre-submission check: the things the carriers look at, graded before money is spent.
 *
 *  ⚠️ A WARNING NEVER STOPS ANYONE SUBMITTING, AND THAT IS THE WHOLE DESIGN. Most of these rows
 *  come from fetching the builder's own website. About a quarter of the web sits behind bot
 *  protection, policies get served as PDFs or drawn by JavaScript, and a cookie wall answers 200
 *  with the wall. We cannot tell a non-compliant policy from an unreadable one — so a builder who
 *  IS compliant must never be locked out of buying a registration by our failure to read their
 *  page. Only the deterministic rows we compute from our own data may say `fail`, and even those
 *  gate nothing here: they add a line to the confirmation on the paid press. Advice, bought with
 *  three seconds, not a gate.
 *
 *  The three-way verdict cell is lifted from the Email Settings DNS table, where an advisory row
 *  already had to be visibly different from a failing one. */
const SMS_CHECK_MARK = {
  pass: { glyph: "✓", color: "#16A34A", title: "Looks right" },
  warn: { glyph: "★", color: "#B45309", title: "Worth a look — we could not confirm this" },
  fail: { glyph: "✕", color: "#DC2626", title: "This will be refused" },
};

const SMS_CHECK_GROUP = {
  policy: "Your privacy policy and terms",
  optin: "Your opt-in",
  consistency: "Do they all match?",
};

function SmsComplianceCard({ compliance, busy, onRun, readOnly, card }) {
  const checks = (compliance && compliance.checks) || [];
  const checkedAt = compliance && compliance.checkedAt;
  const failures = checks.filter((c) => c.verdict === "fail").length;
  const warnings = checks.filter((c) => c.verdict === "warn").length;
  // Insertion order of the group map IS the display order — policies, then the opt-in, then the
  // cross-checks. Grouping walks the map rather than the rows so an empty group renders nothing.
  const groups = Object.keys(SMS_CHECK_GROUP)
    .map((g) => [g, checks.filter((c) => c.group === g)])
    .filter(([, rows]) => rows.length > 0);

  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 6 }}>
        <h4 style={{ margin: 0, fontSize: 14 }}>Check before you send</h4>
        {!readOnly && (
          <button type="button" disabled={busy} onClick={onRun}
            style={{ background: "#fff", border: "1px solid #CBD5E1", borderRadius: 8, padding: "7px 14px", cursor: busy ? "default" : "pointer", fontWeight: 700, fontSize: 12.5, fontFamily: "inherit", opacity: busy ? 0.6 : 1 }}>
            {busy ? "Checking…" : (checkedAt ? "Check again" : "Check my pages")}
          </button>
        )}
      </div>

      <p style={{ margin: "0 0 12px", fontSize: 13, color: "#475569", lineHeight: 1.55 }}>
        These are the things the phone carriers look at, and the usual reasons a registration
        comes back rejected. We open your pages and read them the way a reviewer would.
      </p>

      {/* ⚠️ THE CROSS-CHECKS ARE ALWAYS HERE, EVEN BEFORE ANYONE PRESSES THE BUTTON. They cost
          nothing — they compare fields we already hold — so withholding them behind a press
          would be hiding an answer we already have. Only the rows that need us to open the
          builder's website wait for the press. */}
      <div style={{ fontSize: 12, color: "#64748B", marginBottom: 10 }}>
        {checkedAt
          ? `Your pages were checked ${ssRelTime(checkedAt) || "just now"}`
          : "Your pages have not been opened yet — that part takes a few seconds and costs nothing."}
        {failures > 0 || warnings > 0
          ? ` · ${failures ? `${failures} to fix` : ""}${failures && warnings ? " · " : ""}${warnings ? `${warnings} worth a look` : ""}`
          : (checkedAt ? " · nothing to fix" : "")}
      </div>

      {groups.length > 0 && (
        <>
          {groups.map(([g, rows]) => (
            <div key={g} style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: ".04em", textTransform: "uppercase", color: "#94A3B8", marginBottom: 6 }}>
                {SMS_CHECK_GROUP[g]}
              </div>
              {rows.map((c) => {
                const m = SMS_CHECK_MARK[c.verdict] || SMS_CHECK_MARK.warn;
                return (
                  <div key={c.key} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "7px 0", borderTop: "1px solid #F1F5F9" }}>
                    <span title={m.title} aria-label={m.title}
                      style={{ color: m.color, fontWeight: 800, fontSize: 13, lineHeight: "20px", flex: "0 0 14px", textAlign: "center" }}>
                      {m.glyph}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, color: "#0F172A", lineHeight: 1.45 }}>{c.label}</div>
                      {c.verdict !== "pass" && c.reason && (
                        <div style={{ fontSize: 12, color: "#64748B", lineHeight: 1.5, marginTop: 2 }}>{c.reason}</div>
                      )}
                      {c.verdict !== "pass" && c.hint && (
                        <div style={{ fontSize: 12, color: "#166534", background: "#F0FDF4", border: "1px solid #BBF7D0", borderRadius: 6, padding: "6px 9px", lineHeight: 1.5, marginTop: 5 }}>
                          {c.hint}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
          {warnings > 0 && (
            <div style={{ fontSize: 12, color: "#64748B", lineHeight: 1.5, borderTop: "1px solid #F1F5F9", paddingTop: 8 }}>
              A star does not stop you sending. It means we could not confirm something from
              here — a page that blocks automated visitors reads the same to us as a page that is
              missing the words, and the carriers may well see it fine.
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Where "Use this number for texting" is offered while a CALLING-ONLY number is still on the
 *  account: the server's ADOPT_STATES (portal-sms/adoptNumber.ts), exactly. number_pending and
 *  active are an adoption whose last write did not land ("Press it again to finish"); until
 *  2026-09-29 the card showed only at campaign_approved, so after a reload that press was gone
 *  and the number stayed "Calls only" for good (review BE-5). */
const SMS_ADOPT_STATES = ["campaign_approved", "number_pending", "active"];

/** The calling-only number texting will take over (portal-sms buy_number, adoptNumber.ts buyPlan),
 *  or null: only while NO number texts yet (one in a Messaging Service means the account already
 *  has its texting number, and the server answers 409), and a team line before someone's own
 *  number (migration 266: a business can have several, and its main texting number should not be
 *  one person's). A server before 266 sends no `assigned`: the oldest, as before. */
function smsAdoptNumber(numbers) {
  const list = numbers || [];
  if (!list.length || list.some((n) => !n.callingOnly)) return null;
  return list.find((n) => !n.assigned) || list[0];
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
 *  straight back into that, so there is exactly one.
 *
 *  `suggested` is true while the boxes hold the wording portal-sms suggested (suggestedCopy,
 *  _shared/smsCopyTemplate.ts) rather than anything the builder wrote or saved: the form says
 *  so in one line, with "Start blank" for a builder who would rather write their own. */
function SmsCopyForm({ copy, setCopy, readOnly, optInUrl, suggested = false, onStartBlank = null }) {
  return (
    <>
          <h4 style={{ margin: "0 0 6px", fontSize: 14 }}>What you will text people about</h4>
      <p style={{ margin: "0 0 12px", fontSize: 13, color: "#475569", lineHeight: 1.55 }}>
        The carriers read this. Write it about <em>your</em> business, and use real
        examples of messages you would actually send. Do not put a customer&rsquo;s name
        or number in an example — write <code>[Name]</code> instead.
      </p>
      {suggested && (
        <div data-ss-sms-copy-suggested=""
          style={{ background: "#EFF6FF", border: "1px solid #BFDBFE", borderRadius: 8, padding: "10px 12px", margin: "0 0 12px", fontSize: 12.5, color: "#1E3A8A", lineHeight: 1.55 }}>
          We filled this in with wording carriers have approved before. Check it describes your
          business and change anything that doesn&rsquo;t.
          {!readOnly && onStartBlank && (
            <>
              {" "}
              <button type="button" data-ss-sms-copy-blank="" onClick={onStartBlank}
                style={{ background: "none", border: "none", padding: 0, color: ACCENT, textDecoration: "underline", cursor: "pointer", fontSize: 12.5, fontWeight: 700, fontFamily: "inherit" }}>
                Start blank
              </button>
            </>
          )}
        </div>
      )}
      <SmsField label="In a sentence, what will you text customers about?">
        <textarea style={SMS_TEXTAREA} rows={4} value={copy.description} disabled={readOnly}
          placeholder="Quote follow-ups, delivery times and build updates for customers who asked us for a quote."
          onChange={(e) => setCopy({ ...copy, description: e.target.value })} />
      </SmsField>
      <SmsField label="How do people agree to be texted?"
        hint="Describe where they tick the box. The carriers will look for it on your website, so it has to match what is actually there.">
        <textarea style={SMS_TEXTAREA} rows={4} value={copy.messageFlow} disabled={readOnly}
          placeholder="Customers tick a box giving us permission to text them when they request a quote on our website."
          onChange={(e) => setCopy({ ...copy, messageFlow: e.target.value })} />
      </SmsField>

      {/* ⚠️ THE ANSWER TO ERROR 30896, AND IT HAS TO BE A LINK THEY CAN OPEN.
          The carriers do not take "customers tick a box on our quote form" on trust — they go
          and look, and on 2026-09-03 they looked at a page that renders "Loading…" and refused
          the campaign. The consent box is real, but it is drawn by JavaScript, only appears
          once a visitor works the canvas, and never appears again after that. This page is the
          same wording on a plain public URL with nothing to click through, which is exactly
          what Twilio's own remediation for 30924 asks for. */}
      {optInUrl && !readOnly && (
        <div style={{ background: "#F0FDF4", border: "1px solid #BBF7D0", borderRadius: 8, padding: "11px 13px", marginBottom: 14 }}>
          <div style={{ fontSize: 12.5, fontWeight: 800, color: "#166534", marginBottom: 4 }}>
            Give them a page they can open
          </div>
          <div style={{ fontSize: 12.5, color: "#166534", lineHeight: 1.55, marginBottom: 8 }}>
            We publish your opt-in wording, your policy links and your example messages on a
            public page. Put its address in the answer above — a reviewer who can see the box
            for themselves is the difference between approved and refused.
          </div>
          <a href={optInUrl} target="_blank" rel="noopener noreferrer"
            style={{ fontSize: 12, color: "#166534", wordBreak: "break-all", display: "block", marginBottom: 8 }}>
            {optInUrl}
          </a>
          {/* Says so when the address is already there — the suggested wording carries it, and a
              button that silently does nothing reads as broken. */}
          {String(copy.messageFlow || "").includes(optInUrl) ? (
            <button type="button" disabled data-ss-sms-optin-link="present"
              style={{ background: "#DCFCE7", color: "#166534", border: "1px solid #BBF7D0", borderRadius: 7, padding: "7px 13px", cursor: "default", fontWeight: 700, fontSize: 12, fontFamily: "inherit" }}>
              Already in your answer &#10003;
            </button>
          ) : (
            <button type="button" data-ss-sms-optin-link="add"
              onClick={() => {
                const line = `The exact wording, the tick box and links to our privacy policy and terms can be seen at ${optInUrl}`;
                if (String(copy.messageFlow || "").includes(optInUrl)) return;
                const base = String(copy.messageFlow || "").trim();
                setCopy({ ...copy, messageFlow: (base ? base.replace(/\s*$/, " ") : "") + line });
              }}
              style={{ background: "#166534", color: "#fff", border: "none", borderRadius: 7, padding: "7px 13px", cursor: "pointer", fontWeight: 700, fontSize: 12, fontFamily: "inherit" }}>
              Add this link to my answer
            </button>
          )}
        </div>
      )}
      {copy.messageSamples.map((sample, i) => (
        <SmsField key={i} label={`Example message ${i + 1}`}>
          <textarea style={SMS_TEXTAREA} rows={3} value={sample} disabled={readOnly} data-ss-sms-sample={i}
            placeholder={i === 0
              ? "[Your business]: Hi [Name], your 12x20 barn quote is ready. Reply here with any questions. Reply STOP to opt out."
              : "[Your business]: Hi [Name], your building is scheduled for delivery on [Date]. Reply HELP for help or STOP to opt out."}
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

/** Four empty boxes: the copy form before anything is in it. A fresh object every call. */
function smsCopyBlank() {
  return { description: "", messageFlow: "", messageSamples: ["", ""] };
}

/** Any copy-shaped value in the form's shape: three strings, two to five example boxes. */
function smsCopyFrom(c) {
  const s = (c && Array.isArray(c.messageSamples)) ? c.messageSamples.map((x) => String(x == null ? "" : x)) : [];
  return {
    description: String((c && c.description) || ""),
    messageFlow: String((c && c.messageFlow) || ""),
    messageSamples: s.length >= 2 ? s.slice(0, 5) : ["", ""],
  };
}

/** Nothing typed anywhere. Deliberately untrimmed: one keystroke, even a space, means started. */
function smsCopyEmpty(c) {
  return !(c && c.description) && !(c && c.messageFlow) && !((c && c.messageSamples) || []).some(Boolean);
}

function smsCopySame(a, b) {
  return !!a && !!b && a.description === b.description && a.messageFlow === b.messageFlow
    && JSON.stringify(a.messageSamples || []) === JSON.stringify(b.messageSamples || []);
}

/** What the copy form holds after a status read.
 *
 *  `box` is { copy, suggested, declined }: `suggested` is the wording WE filled in (null when the
 *  boxes are not ours), `declined` that they pressed "Start blank", so it is not filled in again
 *  while the page is open. `d` is the portal-sms status answer.
 *
 *  ⚠️ THE BUILDER'S TYPING WINS, ALWAYS. refresh() runs after every action and on a 60-second
 *  timer while pending, so the form is only (re)filled while it is empty or still holds exactly
 *  our suggestion untouched. That second case is what lets the suggestion follow the facts it is
 *  built from: filled in before the details screen is saved, it gains the policy links once it
 *  is; and if the server stops suggesting (the tick box switched off), an untouched suggestion
 *  is cleared rather than left claiming a box that is no longer there.
 *
 *  Saved wording beats a suggestion (the server only sends one while nothing is saved, and this
 *  checks again). `canSuggest` is false for someone who cannot edit the form: a viewer sees what
 *  is saved, never our wording dressed up as the business's. */
function smsCopySeed(box, d, canSuggest) {
  if (!d || !d.copy) return box;
  const ours = !!box.suggested && smsCopySame(box.copy, box.suggested);
  if (!smsCopyEmpty(box.copy) && !ours) return box;
  const stored = smsCopyFrom(d.copy);
  if (!smsCopyEmpty(stored)) return { ...box, copy: stored, suggested: null };
  const s = (canSuggest && !box.declined && d.suggestedCopy) ? smsCopyFrom(d.suggestedCopy) : null;
  if (s && !smsCopyEmpty(s)) {
    if (ours && smsCopySame(s, box.suggested)) return box;
    return { ...box, copy: s, suggested: s };
  }
  return ours ? { ...box, copy: smsCopyBlank(), suggested: null } : box;
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

/** Same box, given room to breathe. The consent answer is a PARAGRAPH — it has to name who is
 *  texting, what about, that frequency varies, that rates may apply, how to stop, and (since
 *  30924) carry the public opt-in page address, which the “Add this link” button appends to
 *  the end. In a one-line input every one of those sentences scrolls out of sight as it is
 *  typed, and the appended link lands where the builder cannot see it.
 *  The description answer uses it too (2026-09-16): its label says "in a sentence", but what
 *  the carriers accept names the sender, who is texted, what about and how they agreed, which
 *  is three or four sentences that a one-line input cut off mid-word.
 *  And both example messages (2026-10-05): an approved example runs past 100 characters (who it
 *  is from, what it is about, how to stop), so in one line the "Reply STOP" the carriers look for
 *  was always the part scrolled out of sight. */
const SMS_TEXTAREA = {
  ...SMS_INPUT, minHeight: 92, lineHeight: 1.5, resize: "vertical", display: "block",
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
  // The copy form, plus whether what is in it is OUR suggestion (smsCopySeed). One state, so a
  // status read can decide both at once from the same snapshot; `setCopy` keeps the shape the
  // form and the submit buttons have always used.
  const [copyBox, setCopyBox] = useState(() => ({ copy: smsCopyBlank(), suggested: null, declined: false }));
  const copy = copyBox.copy;
  const setCopy = useCallback((next) => setCopyBox((b) => ({ ...b, copy: typeof next === "function" ? next(b.copy) : next })), []);
  const copySuggested = !!copyBox.suggested;
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
        // ⚠️ PRISTINE-ONLY, same reasoning as the copy seed below — these two are editable on
        // the rejection card now, so an unconditional reseed would wipe a URL mid-typing the
        // moment any action's refresh() came back.
        setUrls((u) => (u.privacyPolicyUrl || u.termsUrl)
          ? u
          : { privacyPolicyUrl: d.intake.privacyPolicyUrl || "", termsUrl: d.intake.termsUrl || "" });
      }
      // ⚠️ SEED THE COPY ONLY WHILE THE FORM IS PRISTINE. refresh() runs after every action AND
      // on a 60-second timer while pending, so an unconditional seed would delete a sentence the
      // builder was halfway through typing. Empty-on-all-three is the only safe "they have not
      // started" test — a partially typed form must win over the stored value every time.
      // smsCopySeed keeps that rule and adds the suggested wording (d.suggestedCopy) for a
      // builder with nothing saved; "untouched suggestion" counts as not started.
      setCopyBox((b) => smsCopySeed(b, d, !!canEdit));
    } catch (e) { setErr(e.message); }
  }, [call, clientId, canEdit]);

  // "Start blank": clear the four boxes and do not fill them in again while the page is open.
  // Asks first only when the builder has already changed our wording — that is their work.
  const startBlank = () => {
    if (copyBox.suggested && !smsCopySame(copyBox.copy, copyBox.suggested)
      && !window.confirm("Clear what is in these boxes and start with them empty?")) return;
    setCopyBox({ copy: smsCopyBlank(), suggested: null, declined: true });
  };

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
  //
  // An adoption of a calling-only number that stopped before its last write (number_pending with
  // the row still calling-only, review BE-5) is the builder's move too: the "Finish connecting"
  // card below is the only way on, so the "nothing for you to do" line must not sit above it.
  const adoptUnfinished = !!data && data.status !== "campaign_approved" && SMS_ADOPT_STATES.includes(data.status)
    && !!smsAdoptNumber(data.numbers);
  const waitingOnYou = data && (data.status === "profile_pending" || adoptUnfinished);
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
        {/* The short version. The card below carries the same reasons with what to change —
            two full renderings on one screen would bury the fix under the complaint. */}
        {Array.isArray(data.errors) && data.errors.length > 0 && (
          <ul style={{ marginTop: 10, paddingLeft: 18, fontSize: 12, color: "#B91C1C" }}>
            {data.errors.slice(0, 5).map((e, i) => {
              const help = SMS_ERROR_HELP[String((e && e.error_code) || "")];
              return <li key={i} style={{ marginBottom: 3 }}>{help ? help.title : ((e && (e.description || e.message)) || String(e))}</li>;
            })}
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

      {/* ── What they have to have ready ─────────────────────────────────────
          ⚠️ THIS USED TO BE A HAND-WRITTEN LIST OF PROSE THAT NOTHING VERIFIED — five bullets
          telling a builder what the carriers check, beside a product that then checked none of
          it. It was also WRONG in a way that mattered: it told them to put "Message and data
          rates may apply" in their privacy policy, when that sentence is required beside the
          consent box and in the programme terms, and is explicitly not wanted buried in a
          linked policy. Our own privacy page does not contain it and is right not to. The list
          is now a projection of the same rules that grade it, so the advice and the enforcement
          cannot drift apart again. */}
      {status !== "off" && (
        <SmsComplianceCard
          compliance={data.compliance}
          busy={busy}
          readOnly={readOnly}
          card={card}
          onRun={() => act(() => call("compliance_check"))}
        />
      )}

      {["none", "intake", "aup_pending", "ready", "brand_failed"].includes(status) && (
        <div style={card}>
          <h4 style={{ margin: "0 0 8px", fontSize: 14 }}>Two things we cannot check for you</h4>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: "#334155", lineHeight: 1.7 }}>
            <li><strong>Your business name exactly as the IRS has it</strong> — off your EIN
              letter, not your trading name. Nobody can verify this but you, and a mismatch is
              the most expensive one on the list: it fails the paid step.</li>
            <li><strong>If your EIN was issued in the last 90 days, wait.</strong> It takes that
              long to reach the databases the carriers check, and registering early just fails.</li>
          </ul>
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
          <SmsCopyForm copy={copy} setCopy={setCopy} readOnly={readOnly} optInUrl={data.optInDisclosureUrl}
            suggested={copySuggested} onStartBlank={startBlank} />

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
                // ⚠️ THE CHECKS WARN HERE; THEY DO NOT DISABLE THIS BUTTON, and that is the
                // whole design. Almost every row comes from reading somebody's website, and a
                // page behind bot protection is indistinguishable from a page missing the
                // words — so a builder who IS compliant must never be locked out of buying a
                // registration by our failure to read their site. What they get instead is the
                // last word before the money leaves.
                const bad = ((data.compliance && data.compliance.checks) || [])
                  .filter((c) => c.verdict === "fail" || c.verdict === "warn");
                const lead = bad.length
                  ? `${bad.length} ${bad.length === 1 ? "check has" : "checks have"} not passed, including:\n`
                    + `  • ${bad[0].label}\n\n`
                  : "";
                if (!window.confirm(
                  lead
                  + "Register this business with the phone carriers?\n\n"
                  + "This is the paid step. It cannot be undone or refunded, and it only needs "
                  + "to be done once for this business."
                  + (bad.length ? "\n\nThe items above are the usual reasons a registration is turned down." : ""))) return;
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
          <SmsCopyForm copy={copy} setCopy={setCopy} readOnly={readOnly} optInUrl={data.optInDisclosureUrl}
            suggested={copySuggested} onStartBlank={startBlank} />
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

          <SmsErrorList errors={data.errors} />
          {(data.errors || []).length === 0 && (
            <div style={{ margin: "0 0 12px", fontSize: 12.5, color: "#64748B", lineHeight: 1.5 }}>
              We are fetching the reasons from the carriers — press Refresh in a moment. If they
              still do not appear, the wording below is what was submitted, and the two most
              common refusals are the description and the opt-in.
            </div>
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
              <SmsCopyForm copy={copy} setCopy={setCopy} readOnly={false} optInUrl={data.optInDisclosureUrl}
                suggested={copySuggested} onStartBlank={startBlank} />
              {/* ⚠️ AND THE TWO URLS, HERE, ON THIS CARD. They are judged by the carriers as
                  hard as the wording is (30908/30882/30932 all point at them), they are
                  re-sent from the row on every resubmit — and until 2026-09-03 this screen
                  had no control that could change them. A campaign refused FOR its privacy
                  policy could be resent forever with the same failing address. */}
              <div style={{ marginTop: 4, paddingTop: 12, borderTop: "1px solid #E2E8F0" }}>
                <h4 style={{ margin: "0 0 8px", fontSize: 13 }}>The pages they check</h4>
                <SmsField label="Privacy policy address" hint="Has to open without signing in, and say you never share or sell phone numbers.">
                  <input style={SMS_INPUT} value={urls.privacyPolicyUrl} placeholder="https://"
                    onChange={(e) => setUrls({ ...urls, privacyPolicyUrl: e.target.value })} />
                </SmsField>
                <SmsField label="Terms page address" hint="Should cover texting: what you send, that frequency varies, that rates may apply, and how to stop.">
                  <input style={SMS_INPUT} value={urls.termsUrl} placeholder="https://"
                    onChange={(e) => setUrls({ ...urls, termsUrl: e.target.value })} />
                </SmsField>
              </div>
              {smsCopyProblems(copy).length > 0 && (
                <ul style={{ margin: "0 0 10px", paddingLeft: 18, fontSize: 13, color: "#B91C1C", lineHeight: 1.6 }}>
                  {smsCopyProblems(copy).map((pr, i) => <li key={i}>{pr}</li>)}
                </ul>
              )}
              <button type="button" disabled={busy || smsCopyProblems(copy).length > 0}
                onClick={() => act(async () => {
                  await call("save_policy_urls", { privacyPolicyUrl: urls.privacyPolicyUrl, termsUrl: urls.termsUrl });
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
      {/* My Synergy Phone plan phase 6: a number already bought for CALLS (Settings → Phone) is the
          business's one number, so texting takes it over instead of buying a second one. The
          server adopts it on buy_number with no number picked, and takes no second charge (the
          first month was taken when it was bought). */}
      {SMS_ADOPT_STATES.includes(status) && !readOnly && smsAdoptNumber(data.numbers) && (
        <div style={card} data-ss-sms-adopt={status === "campaign_approved" ? "offer" : "finish"}>
          {status === "campaign_approved" ? (
            <>
              <h4 style={{ margin: "0 0 10px", fontSize: 14 }}>Use your business number for texting</h4>
              <p style={{ margin: "0 0 12px", fontSize: 13, color: "#475569", lineHeight: 1.55 }}>
                You already have <strong>{smsAdoptNumber(data.numbers).phoneNumber}</strong> for calls.
                Texting uses the same number, so your customers see one number for both. No second number is bought.
              </p>
            </>
          ) : (
            <>
              <h4 style={{ margin: "0 0 10px", fontSize: 14 }}>Finish connecting your number for texting</h4>
              <p style={{ margin: "0 0 12px", fontSize: 13, color: "#475569", lineHeight: 1.55 }}>
                Texting was being switched on for <strong>{smsAdoptNumber(data.numbers).phoneNumber}</strong>,
                but the last step didn&rsquo;t finish. Press below to finish it. No second number is bought and nothing is charged.
              </p>
            </>
          )}
          <button type="button" disabled={busy} data-ss-sms-adopt-button
            onClick={() => act(() => call("buy_number", {}))}
            style={{ background: ACCENT, color: "#fff", border: "none", borderRadius: 8, padding: "9px 18px", cursor: "pointer", fontWeight: 800, fontSize: 13, fontFamily: "inherit" }}>
            {busy ? "Connecting…" : status === "campaign_approved" ? "Use this number for texting" : "Finish connecting"}
          </button>
        </div>
      )}
      {status === "campaign_approved" && !readOnly && !smsAdoptNumber(data.numbers) && (
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
                {n.registrationStatus === "registered" ? "Ready to use" : n.callingOnly ? "Calls only for now" : "Being connected…"}
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

/* ═════════════════════════════════════════════════════════════════════════════
   MY SYNERGY PHONE — calling setup, install links and the Calls report (2026-09-29)

   Plan sections 6 and 12, SPEC section 5. CALLING ONLY: the number is bought and
   registered on the Text Messaging tab above, and nothing here buys, registers or
   texts. What lives here is the owner's ONE-TIME SETUP (Ahsan, 09-29: "owner sets
   up the phone once, and the users assigned to that number get the calls
   automatically"), the switch, "Sign out all devices", and the report.

   In this part rather than a new one, deliberately: a new part renumbers the shell
   and every test that names it, for three components that belong beside texting —
   the same number, the same customers, the same audience.
   ───────────────────────────────────────────────────────────────────────────── */

const PHONE_CARD = {
  background: "#fff", border: "1px solid #E2E8F0", borderRadius: 12, padding: 18, marginBottom: 14,
};
const PHONE_DAYS = [
  ["mon", "Monday"], ["tue", "Tuesday"], ["wed", "Wednesday"], ["thu", "Thursday"],
  ["fri", "Friday"], ["sat", "Saturday"], ["sun", "Sunday"],
];
// The builder's time zone decides what "after hours" means (plan section 6). US and Canadian
// zones only — the lines ring in North America (plan section 14's geo permissions).
const PHONE_TIME_ZONES = [
  ["America/New_York", "Eastern"], ["America/Chicago", "Central"], ["America/Denver", "Mountain"],
  ["America/Phoenix", "Arizona (no daylight saving)"], ["America/Los_Angeles", "Pacific"],
  ["America/Anchorage", "Alaska"], ["Pacific/Honolulu", "Hawaii"], ["America/Halifax", "Atlantic (Canada)"],
  ["America/St_Johns", "Newfoundland"], ["America/Regina", "Saskatchewan"],
];
const PHONE_LEVEL_LABEL = { none: "No phone access", own: "Own calls", view: "Team calls", edit: "Team calls + settings" };
// Caller ID (plan §14): Twilio's TrustProduct statuses in the builder's words. The keys are
// Twilio's enum verbatim (_shared/twilioTrustHub.ts TRUST_PRODUCT_STATUSES); a status outside it
// reaches the page as null and reads "Status unknown".
const PHONE_TRUST_WORDS = {
  "draft": "Started, not submitted",
  "pending-review": "Waiting for Twilio",
  "in-review": "Twilio is reviewing it",
  "twilio-rejected": "Rejected by Twilio",
  "twilio-approved": "Approved",
};
// Voice Integrity's "what the business uses calls for", the ones a shed builder's calls are. Each
// is one of Twilio's own values (_shared/twilioTrustHub.ts VOICE_INTEGRITY_USE_CASES, which the
// server checks against; tests/phone/phoneTrust_test.ts pins that every one here is in it).
const PHONE_VI_USE_CASES = [
  "Customer Support", "Phone System", "Appointment Scheduling", "Order Notifications",
  "Delivery Notifications", "Lead Management", "Click to Call", "Outbound Dialer",
];

async function phoneAction(action, body) {
  const { data: d, error } = await sb.functions.invoke("portal-settings", { body: { action, ...(body || {}) } });
  if (error) throw new Error(await fnError(error));
  if (d && d.error) throw new Error(d.error);
  return d || {};
}

// "+18165550100" → "(816) 555-0100". Anything else is shown as stored.
function phoneDisplay(e164) {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(String(e164 || ""));
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : String(e164 || "");
}
// 42 → "0:42", 192 → "3:12", 3720 → "1:02:00". A table column, so the compact form.
function phoneClock(s) {
  if (s == null) return "—";
  const t = Math.max(0, Math.round(Number(s) || 0));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), r = t % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}
function phoneWhen(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return null;
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}

// ── Where to get My Synergy Phone ───────────────────────────────────────────────────────
// Shown by the contact page when Call finds no extension, by the SMS tab (compact), by the
// Phone settings tab and by the Calls page. A link still marked PLACEHOLDER (01-core's
// SS_PHONE_LINKS) reads "coming soon" rather than sending a builder to a page that is not there.
// `fromRecord`: shown on a contact page after Call / SMS found nothing, where "press Call again"
// is an instruction the reader can follow. Elsewhere there is no Call button to press.
function SsPhoneInstallCard({ what = "call", compact = false, mobile = false, fromRecord = false }) {
  const all = [
    ["chrome", "Chrome extension", SS_PHONE_LINKS.chrome, "On your computer: calls and texts in a panel beside Structure Studio."],
    ["ios", "iPhone app", SS_PHONE_LINKS.ios, "Rings like a second line, even with the phone locked."],
    ["android", "Android app", SS_PHONE_LINKS.android, "Rings like a second line, even with the phone locked."],
  ];
  const links = mobile ? all.filter((l) => l[0] !== "chrome") : compact ? all.filter((l) => l[0] === "chrome") : all;
  const linkEl = ([key, label, url]) => (ssPhoneLinkReady(url) ? (
    <a key={key} href={url} target="_blank" rel="noopener noreferrer"
      style={{ ...S.btn(compact ? "#FFF" : ACCENT, compact ? ACCENT : "#FFF"), border: compact ? `1px solid ${ACCENT}` : "none", textDecoration: "none", display: "inline-block", padding: compact ? "5px 11px" : "8px 14px", fontSize: compact ? 12 : 13 }}>
      Get the {label}
    </a>
  ) : (
    <span key={key} style={{ display: "inline-block", fontSize: 12, fontWeight: 700, color: "#64748B", background: "#F1F5F9", borderRadius: 8, padding: compact ? "5px 11px" : "8px 14px" }}>
      {label}: link coming soon
    </span>
  ));
  if (compact) {
    return (
      <div data-ss-phone-install="compact" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 12, color: "#475569", background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 8, padding: "8px 10px", marginBottom: 8 }}>
        <span>With <strong>My Synergy Phone</strong> installed, {what === "text" ? "texts open in its panel beside this page" : "Call rings the customer from your business number"}.</span>
        {links.map(linkEl)}
      </div>
    );
  }
  return (
    <div data-ss-phone-install={mobile ? "mobile" : "full"} style={{ border: "1px solid #C7D2FE", background: "#EEF2FF", borderRadius: 10, padding: "13px 15px" }}>
      <div style={{ fontSize: 14, fontWeight: 800, color: "#312E81", marginBottom: 4 }}>
        {mobile ? "Get the My Synergy Phone app" : what === "text" ? "Install My Synergy Phone to text from Structure Studio" : "Install My Synergy Phone to call from Structure Studio"}
      </div>
      <div style={{ fontSize: 12.5, color: "#3730A3", lineHeight: 1.55, marginBottom: 10 }}>
        My Synergy Phone is Structure Studio&rsquo;s calling app. Sign in with your Structure Studio login and
        {what === "text" ? " texts" : " calls"} go out from your business number, without leaving the page you&rsquo;re on.
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {links.map((l) => (
          <div key={l[0]} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            {linkEl(l)}
            <span style={{ fontSize: 12, color: "#4338CA" }}>{l[3]}</span>
          </div>
        ))}
      </div>
      {fromRecord && !mobile && (
        <div style={{ fontSize: 11.5, color: "#4338CA", marginTop: 10 }}>
          Already installed it? Reload this page, then press {what === "text" ? "SMS" : "Call"} again.
        </div>
      )}
    </div>
  );
}

// ── Settings → Phone ────────────────────────────────────────────────────────────────────
const PHONE_DEFAULT_HOURS = {
  mon: [["08:00", "17:00"]], tue: [["08:00", "17:00"]], wed: [["08:00", "17:00"]],
  thu: [["08:00", "17:00"]], fri: [["08:00", "17:00"]],
};

// The weekly hours editor, a time zone and each day's times, shared by the business's hours (the
// owner's, below) and each person's own (the Your calls card, migration 264). The parent owns
// the state: `onDay(day, periods)` replaces one day's times (none = that day off), `onTimeZone`
// the zone. `dayAttr` is the data- attribute each day's row carries; `offWord` is what an empty
// day says and `addWord` the first "+" button.
function phoneHoursWithDay(hours, day, periods) {
  const out = { ...(hours || {}) };
  if (periods.length) out[day] = periods; else delete out[day];
  return out;
}
function PhoneHoursEditor({
  hours, timeZone, ro = false, onDay, onTimeZone,
  dayAttr = "data-ss-phone-day", offWord = "Closed", addWord = "+ open", zoneWord = "Time zone",
}) {
  return (
    <>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginBottom: 10 }}>
        {zoneWord}
        <select value={timeZone} disabled={ro} onChange={(e) => onTimeZone(e.target.value)}
          style={{ ...S.input, width: "auto", padding: "5px 8px" }}>
          {!PHONE_TIME_ZONES.some((z) => z[0] === timeZone) && <option value={timeZone}>{timeZone}</option>}
          {PHONE_TIME_ZONES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </label>
      <div style={{ display: "grid", gap: 6, marginBottom: 12 }}>
        {PHONE_DAYS.map(([key, label]) => {
          const periods = (hours || {})[key] || [];
          return (
            <div key={key} {...{ [dayAttr]: key }} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ width: 92, fontSize: 13, fontWeight: 700, color: "#334155" }}>{label}</span>
              {periods.length === 0 && <span style={{ fontSize: 12.5, color: "#94A3B8" }}>{offWord}</span>}
              {periods.map((p, i) => (
                <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <input type="time" value={p[0]} disabled={ro}
                    onChange={(e) => onDay(key, periods.map((q, k) => (k === i ? [e.target.value, q[1]] : q)))}
                    style={{ ...S.input, width: 110, padding: "4px 6px" }} />
                  <span style={{ fontSize: 12, color: "#64748B" }}>to</span>
                  <input type="time" value={p[1]} disabled={ro}
                    onChange={(e) => onDay(key, periods.map((q, k) => (k === i ? [q[0], e.target.value] : q)))}
                    style={{ ...S.input, width: 110, padding: "4px 6px" }} />
                  {!ro && (
                    <button type="button" title="Remove these hours" onClick={() => onDay(key, periods.filter((_q, k) => k !== i))}
                      style={{ background: "none", border: "none", color: "#94A3B8", cursor: "pointer", fontWeight: 800, fontSize: 14 }}>×</button>
                  )}
                </span>
              ))}
              {!ro && periods.length < 4 && (
                <button type="button" onClick={() => onDay(key, [...periods, periods.length ? ["13:00", "17:00"] : ["08:00", "17:00"]])}
                  style={{ background: "none", border: "none", color: ACCENT, cursor: "pointer", fontWeight: 700, fontSize: 12, fontFamily: "inherit" }}>
                  {periods.length ? "+ more hours" : addWord}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

function phoneFormFrom(d, teamList) {
  const r = d && d.route;
  let tz = r && r.timeZone;
  if (!tz) {
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (_e) { tz = null; }
    if (!PHONE_TIME_ZONES.some((z) => z[0] === tz)) tz = "America/Chicago";
  }
  // A saved route can still name someone who has since LEFT the team: nothing prunes
  // phone_routes.members when a person is removed (the Worker just skips them at ring time). They
  // are not in `team`, so the list below cannot show them or untick them, yet Save would send them
  // and phone_settings_save refuses any member who is not on the team, so every save failed with
  // a sentence naming nobody. Seeded from the team, they drop out on the next Save. (Someone still
  // on the team without Phone access stays: they are listed, ticked, and the server names them.)
  // `teamList` is the page's team: a per-number entry (phoneNumbersOf, migration 266) carries no
  // `team` of its own, and without it this filter never ran for any number.
  const team = Array.isArray(teamList) ? teamList : (d && Array.isArray(d.team) ? d.team : null);
  const onTeam = (id) => !team || team.some((t) => t.userId === id);
  return {
    mode: (r && r.mode) || "all_at_once",
    members: r ? (r.members || []).filter(onTeam) : ((d && d.suggestedMembers) || []),
    ringSeconds: (r && r.ringSeconds) || 20,
    noAnswer: (r && r.noAnswer) || "voicemail",
    forwardTo: r && r.forwardTo ? phoneDisplay(r.forwardTo) : "",
    hoursOn: !!(r && r.businessHours),
    hours: (r && r.businessHours) || PHONE_DEFAULT_HOURS,
    timeZone: tz,
    afterHours: (r && r.afterHours) || "voicemail",
    greetingUrl: (r && r.greetingUrl) || "",
    // Migration 266: the number's own name and whose it is ("" = a team line).
    label: (d && d.label) || "",
    assignedUserId: (d && d.assignedUserId) || "",
  };
}

// ── More than one number (migration 266) ────────────────────────────────────────────────
// Carolyn, 09-30: "What if they want more than one number?" and "all of these settings ... needs
// to be for that individual number." phone_settings_get sends `numbers`: every live number,
// oldest first, each with its own name, person, caller ID and answer list. A server from before
// sends only `number` and `route`, which is one number, read the same way here.
function phoneNumbersOf(d) {
  if (d && Array.isArray(d.numbers)) return d.numbers;
  if (d && d.number) {
    return [{ ...d.number, label: d.number.label || null, assignedUserId: null, callerId: d.callerId || null,
      route: d.route || null, suggestedMembers: d.suggestedMembers || null }];
  }
  return [];
}
// Which number is the business's MAIN one: the number texting sends from (the server's `main`,
// client_settings.sms_number), else one already in the texting setup, else the one texting WILL
// take over when the carriers approve the business (portal-sms buyPlan, smsAdoptNumber above: the
// oldest team line, else the oldest number). Not simply the first: a business that gives its first
// number to a person keeps a team line as its main number.
function phoneMainNumberId(list) {
  const nums = (list || []).filter(Boolean);
  const m = nums.find((n) => n.main) || nums.find((n) => n.callingOnly === false) || nums.find((n) => !n.assignedUserId) || nums[0];
  return m ? m.id : null;
}
// Its name, or "Main number" (phoneMainNumberId) / "Number 2" for one nobody named.
function phoneNumberName(n, i, mainId) {
  return (n && n.label) || (n && mainId != null && n.id === mainId ? "Main number" : `Number ${i + 1}`);
}
// "Team line", or the person it belongs to.
function phoneNumberOwner(n, team) {
  if (!n || !n.assignedUserId) return "Team line";
  const t = (team || []).find((x) => x.userId === n.assignedUserId);
  return t ? (t.name || "Unnamed team member") : "Someone no longer on the team";
}

// ── Call recording (migration 263) ──────────────────────────────────────────────────────
// On by default since migration 287. The standard announcement (Carolyn's wording, 2026-10-06),
// word for word portal-settings/phone.ts STANDARD_NOTICE and STANDARD_NOTICE_TRANSCRIBED and the
// phone-api Worker's (tests/phone/callRecordingUi_test.ts pins the three copies). Shown so the
// owner knows what callers hear when the wording box is left empty; the server stores an empty
// box as "the standard wording", which follows the transcripts switch.
const PHONE_REC_STANDARD = "This call may be recorded.";
const PHONE_REC_STANDARD_TRANSCRIBED = "This call may be recorded and transcribed.";
// How long recordings are kept: client_settings_phone_recording_retention_chk's five lengths.
const PHONE_REC_KEEP_WORDS = { 30: "30 days", 90: "90 days", 180: "6 months", 365: "1 year", 730: "2 years" };

function phoneRecFormFrom(r) {
  return {
    on: !!(r && r.on),
    noticeText: (r && r.noticeText) || "",
    transcribe: !(r && r.transcribe === false),
    retentionDays: (r && r.retentionDays) || 365,
  };
}
// The wording box as the server will tidy it (one line, single spaces), and the first thing
// wrong with it, or null. The server checks the same (phone.ts parseRecording) and has the
// last word; this only lets the owner see it before pressing Save. The two patterns are
// supabase/functions/_shared/recordingNotice.ts's, word for word: "recorded" as a word of its
// own, and no "not" / "never" / "no" / "n't" just before it.
const PHONE_REC_SAYS = /\brecord(?:s|ed|ings?)?\b(?!-)/i;
const PHONE_REC_DENIES = /(?:\b(?:not|never|no)|n't)\s+(?:[\w']+\s+){0,2}record/i;
function phoneRecNoticeProblem(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t || t === PHONE_REC_STANDARD || t === PHONE_REC_STANDARD_TRANSCRIBED) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(t)) return "The announcement has a character that can't be spoken.";
  if (t.length < 10) return "The announcement has to be at least 10 characters.";
  if (t.length > 300) return "The announcement can be at most 300 characters.";
  if (!PHONE_REC_SAYS.test(t) || PHONE_REC_DENIES.test(t)) return "The announcement has to tell callers the call is recorded.";
  return null;
}

function PhoneSettingsView({ clientId, viewingLabel = null, canEdit = false, onOpenTexting = null }) {
  // ⚠️ HOOKS FIRST, ALL OF THEM, ABOVE EVERY EARLY RETURN — the React #310 rule every screen in
  // this file follows.
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  // Migration 266: one form per number (keyed by its id, "none" before there is one), so moving
  // between numbers never loses what somebody is halfway through choosing, and which is open.
  const [forms, setForms] = useState({});
  const [selId, setSelId] = useState(null);
  const [adding, setAdding] = useState(false);     // "Add another number" opened
  const [note, setNote] = useState(null);          // { ok } | { err } after a save
  const [swNote, setSwNote] = useState(null);      // { ok } | { err } after the on/off switch, shown in the header only
  const [outNote, setOutNote] = useState(null);    // { userId, ok | err } after a sign-out
  // Plan phase 6, the number card: the area-code search, its results, and what the last
  // search / purchase / connect said.
  const [numQ, setNumQ] = useState("");
  const [numResults, setNumResults] = useState(null);  // null = not searched yet
  const [numNote, setNumNote] = useState(null);        // { ok } | { err }
  // Plan phase 6, caller ID (plan §14): what the last register / check said, and the Voice
  // Integrity answers an operator fills in (opened by its button).
  const [trustNote, setTrustNote] = useState(null);    // { ok } | { err }
  const [viOpen, setViOpen] = useState(false);
  const [viForm, setViForm] = useState({ useCase: "Customer Support", employeeCount: "", averageDailyCalls: "", notes: "" });
  // Call recording (migration 263): its own small form, saved on its own (phone_recording_save),
  // and what the last save said.
  const [recForm, setRecForm] = useState(null);
  const [recNote, setRecNote] = useState(null);      // { ok } | { err }

  const load = useCallback(async () => {
    try {
      const d = await phoneAction("phone_settings_get");
      setData(d);
      setErr(null);
      // Seeded from the server only for a number with no form yet, so a refresh never wipes what
      // somebody is halfway through choosing.
      if (d && d.scope === "team") {
        const list = phoneNumbersOf(d);
        setForms((m) => {
          const out = { ...m };
          if (!list.length && !out.none) out.none = phoneFormFrom(d, d.team);
          for (const n of list) if (!out[n.id]) out[n.id] = phoneFormFrom(n, d.team);
          return out;
        });
        setSelId((cur) => (cur && list.some((n) => n.id === cur) ? cur : (list[0] ? list[0].id : null)));
      }
      setRecForm((f) => f || (d && d.scope === "team" && d.recording ? phoneRecFormFrom(d.recording) : null));
    } catch (e) { setErr(e.message); }
  }, [clientId]);
  useEffect(() => { load(); }, [load]);

  if (err && !data) return <div style={S.err}>{err}</div>;
  if (!data) return <SkelRows cols={2} rows={5} />;

  if (data.available === false) {
    return (
      <div style={PHONE_CARD} data-ss-phone-settings="unavailable">
        <h3 style={{ margin: "0 0 6px", fontSize: 16 }}>Phone</h3>
        <p style={{ margin: 0, fontSize: 13, color: "#475569" }}>
          My Synergy Phone isn&rsquo;t set up on this account yet. Once it is, you&rsquo;ll choose who answers your
          business number here.
        </p>
      </div>
    );
  }

  const on = data.phoneStatus === "on";
  const team = data.team || [];
  // The numbers, and the one open below (migration 266). Everything under the list is about it.
  const numbers = phoneNumbersOf(data);
  const many = numbers.length > 1;
  const selIdx = Math.max(0, numbers.findIndex((n) => n.id === selId));
  const sel = numbers[selIdx] || null;
  const mainId = phoneMainNumberId(numbers);
  const selName = sel ? phoneNumberName(sel, selIdx, mainId) : null;
  const formKey = sel ? sel.id : "none";
  // A number the last load didn't seed (it can't, normally) starts from what the server sent.
  const formSeed = data.scope === "team" ? phoneFormFrom(sel || data, data.team) : null;
  const form = forms[formKey] || formSeed;
  const setForm = (fn) => setForms((m) => {
    const cur = m[formKey] || formSeed;
    return { ...m, [formKey]: typeof fn === "function" ? fn(cur) : fn };
  });
  const setF = (patch) => setForm((f) => ({ ...f, ...patch }));
  // One number's facts changed (connected, its caller ID, saved). A server before 266 keeps them
  // on `number` / `callerId` / `route`, so those follow the first number.
  const patchNumber = (id, patch) => setData((x) => {
    if (!Array.isArray(x.numbers)) {
      const { callerId: cidPatch, route: routePatch, ...rest } = patch;
      return { ...x, number: x.number ? { ...x.number, ...rest } : x.number,
        ...(cidPatch !== undefined ? { callerId: cidPatch } : {}), ...(routePatch !== undefined ? { route: routePatch, suggestedMembers: null } : {}) };
    }
    const nums = x.numbers.map((n) => (n.id === id ? { ...n, ...patch } : n));
    const first = nums[0] && nums[0].id === id;
    return { ...x, numbers: nums,
      ...(first && x.number ? { number: { ...x.number, ...(patch.voiceReady !== undefined ? { voiceReady: patch.voiceReady } : {}), ...(patch.callingOnly !== undefined ? { callingOnly: patch.callingOnly } : {}) } } : {}),
      ...(first && patch.route !== undefined ? { route: patch.route, suggestedMembers: null } : {}),
      ...(first && patch.callerId !== undefined ? { callerId: patch.callerId } : {}) };
  });

  // The switch. Turning it OFF also moves a connected number to voicemail (the server does it,
  // review SSB-2), so the confirm says what callers will get; turning it back ON reconnects a
  // number the switch moved. `wantOn` lets "Send calls to voicemail" retry the move while off.
  const flip = async (wantOn = !on) => {
    // Only a CONNECTED number is moved to voicemail; one that never pointed at My Synergy Phone keeps
    // whatever it did before, so the words are only said where they are true.
    const moving = numbers.filter((n) => n.voiceReady);
    const moves = moving.length > 0;
    if (!wantOn && on && !window.confirm(moves
      ? `Turn calling off? My Synergy Phone won't ring for anyone, and nobody can call out, until it's turned back on. Callers to ${moving.length > 1 ? "your numbers" : phoneDisplay(moving[0].e164)} go straight to voicemail instead.`
      : "Turn calling off? My Synergy Phone won't ring for anyone, and nobody can call out, until it's turned back on.")) return;
    setBusy(true); setSwNote(null);
    try {
      const d = await phoneAction("phone_status_set", { on: wantOn });
      // Every number follows the switch (migration 266): `numbers` says where each one's calls go.
      const ready = new Map((Array.isArray(d.numbers) ? d.numbers : []).map((n) => [n.id, !!n.voiceReady]));
      setData((x) => ({
        ...x, phoneStatus: d.phoneStatus,
        number: x.number && d.number ? { ...x.number, voiceReady: !!d.number.voiceReady } : x.number,
        ...(Array.isArray(x.numbers) ? { numbers: x.numbers.map((n) => (ready.has(n.id) ? { ...n, voiceReady: ready.get(n.id) } : n)) } : {}),
      }));
      setSwNote(d.warning ? { err: d.warning }
        : { ok: d.phoneStatus === "on" ? "Calling is on." : moves ? `Calling is off. Calls to your ${moving.length > 1 ? "numbers" : "number"} go to voicemail.` : "Calling is off." });
    } catch (e) { setSwNote({ err: e.message }); }
    finally { setBusy(false); }
  };

  const save = async () => {
    setBusy(true); setNote(null);
    try {
      const d = await phoneAction("phone_settings_save", {
        // Which number, and (migration 266, where the server keeps them) its name and person.
        ...(sel && sel.id ? { numberId: sel.id } : {}),
        ...(data.perNumber && sel ? { label: form.label, assignedUserId: form.assignedUserId || null } : {}),
        mode: form.mode,
        members: form.members,
        ringSeconds: Number(form.ringSeconds),
        noAnswer: form.noAnswer,
        forwardTo: form.forwardTo,
        businessHours: form.hoursOn ? form.hours : null,
        timeZone: form.timeZone,
        afterHours: form.afterHours,
        greetingUrl: form.greetingUrl,
      });
      const saved = { route: d.route, ...(d.numberId ? { label: d.label || null, assignedUserId: d.assignedUserId || null } : {}) };
      if (sel) patchNumber(sel.id, { ...saved, suggestedMembers: null });
      else setData((x) => ({ ...x, route: d.route, suggestedMembers: null }));
      setForm(phoneFormFrom({ ...(sel || {}), ...saved }));
      setNote({ ok: many ? `Saved. Calls to ${selName} follow these settings from now on.` : "Saved. Calls to your number follow these settings from now on." });
    } catch (e) { setNote({ err: e.message }); }
    finally { setBusy(false); }
  };

  const signOut = async (m) => {
    const who = m.name || "this person";
    // It ends their Structure Studio sign-ins too (254's phone_end_user_sessions), so the
    // confirm says so: a person pressing it for a lost phone should know their colleague will
    // have to sign in again at their desk as well.
    if (!window.confirm(`Sign ${who} out on every computer and phone? Use this for a lost phone or someone leaving. They'll have to sign in again to My Synergy Phone and to Structure Studio.`)) return;
    setBusy(true); setOutNote(null);
    try {
      const d = await phoneAction("phone_signout_user", { userId: m.userId });
      setOutNote({
        userId: m.userId,
        ok: d.sessionsEnded
          ? `${who} is signed out everywhere and has to sign in again.`
          // A CSM Synergy support person on this team: their My Synergy Phone devices here are retired,
          // but their Structure Studio sign-ins cover the other accounts they support, so only
          // Structure Studio can end those (the server kept them, review SSB-9).
          : d.sessionsKept === "operator"
            ? `${who}'s devices were disconnected from calls in My Synergy Phone on this account. ${who} is on the Structure Studio support team, so their Structure Studio sign-ins were left alone; ask Structure Studio if those need ending too.`
            : `${who}'s devices were disconnected from calls. A device that is still signed in reconnects on its own, so for a lost phone also change their Structure Studio password.`,
      });
      load();
    } catch (e) { setOutNote({ userId: m.userId, err: e.message }); }
    finally { setBusy(false); }
  };

  // ── Plan phase 6: the number, from this tab ───────────────────────────────────────────
  // Connect: point the number's calls at My Synergy Phone (phone_enable_number). Search and buy: a
  // CALLING-ONLY number for a builder with none, which texting reuses once its registration
  // clears. The server decides who may buy (canBuyNumber); this only offers what will work.
  const connect = async () => {
    if (!sel) return;
    setBusy(true); setNumNote(null);
    try {
      await phoneAction("phone_enable_number", { numberId: sel.id });
      patchNumber(sel.id, { voiceReady: true });
      setNumNote({ ok: "Connected. Calls to this number ring My Synergy Phone now." });
    } catch (e) { setNumNote({ err: e.message }); }
    finally { setBusy(false); }
  };
  // Migration 266: a calling-only number joins the business's texting (phone_number_texting).
  const joinTexting = async () => {
    if (!sel) return;
    setBusy(true); setNumNote(null);
    try {
      await phoneAction("phone_number_texting", { numberId: sel.id });
      patchNumber(sel.id, { callingOnly: false });
      setNumNote({ ok: "Added to your texting. It can text once the carriers approve this number, usually within a few days." });
    } catch (e) { setNumNote({ err: e.message }); }
    finally { setBusy(false); }
  };
  const searchNumbers = async () => {
    setBusy(true); setNumNote(null);
    try {
      const d = await phoneAction("phone_search_numbers", { areaCode: numQ });
      setNumResults(d.numbers || []);
    } catch (e) { setNumNote({ err: e.message }); }
    finally { setBusy(false); }
  };
  const buyNumber = async (e164) => {
    // Before builder launch only an operator reaches this button (the server's rollout check).
    // Texting takes this same number over once the carriers approve the business (portal-sms
    // buy_number adopts a calling-only number, plan phase 6), so there is no caveat to give.
    if (!window.confirm(numbers.length
      ? `Add ${phoneDisplay(e164)} as another business number? It takes calls right away${data.textingActive ? ", and it can text once the carriers approve it" : ""}. You can give it a name and a person after.`
      : `Get ${phoneDisplay(e164)} as your business number? It takes calls right away, and texting uses the same number once the carriers approve your business on the Text Messaging tab.`)) return;
    setBusy(true); setNumNote(null);
    try {
      const d = await phoneAction("phone_buy_number", { phoneNumber: e164 });
      const n = d.number || {};
      // The FIRST number: what was chosen on this screen before there was one (who answers, the
      // order, the hours) becomes its form, so load() below doesn't swap it for the defaults.
      if (!numbers.length && n.id) setForms((m) => (m.none && !m[n.id] ? { ...m, [n.id]: m.none } : m));
      setData((x) => ({ ...x, number: x.number || { id: n.id, e164: n.e164 || e164, textingStatus: "pending_registration", voiceReady: !!n.voiceReady, callingOnly: true } }));
      setNumResults(null);
      setAdding(false);
      // The server's own view of every number (its route, caller ID and form), then open the new one.
      await load();
      if (n.id) setSelId(n.id);
      const done = n.voiceReady ? "Your number is ready and connected for calls." : "Your number is ready. Until calling is on, its callers go to voicemail.";
      // `note`: an earlier try had already got a number, and that one was kept (review SSB-4).
      setNumNote(d.warning ? { err: [d.note, d.warning].filter(Boolean).join(" ") } : { ok: [d.note, done].filter(Boolean).join(" ") });
    } catch (e) { setNumNote({ err: e.message }); }
    finally { setBusy(false); }
  };

  const header = (
    <div style={PHONE_CARD}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 8 }}>
        <h3 style={{ margin: 0, fontSize: 16 }}>Phone{viewingLabel ? ` — ${viewingLabel}` : ""}</h3>
        <span data-ss-phone-status={on ? "on" : "off"} style={{
          display: "inline-flex", alignItems: "center", gap: 7, borderRadius: 999, padding: "5px 12px", fontSize: 12, fontWeight: 800,
          background: on ? "#ECFDF5" : "#F1F5F9", color: on ? "#047857" : "#475569",
        }}>
          <span style={{ width: 7, height: 7, borderRadius: 999, background: on ? "#10B981" : "#94A3B8" }} />
          {on ? "Calling is on" : "Calling is off"}
        </span>
        {/* OFF is always offered to an editor (it is also the safety switch); ON only where the
            server's rollout check will accept it (canSwitchOn: an operator until builder launch). */}
        {canEdit && data.scope === "team" && (on || data.canSwitchOn) && (
          <button type="button" disabled={busy} onClick={() => flip()} data-ss-phone-switch
            style={{ ...S.btn(on ? "#FFF" : ACCENT, on ? "#B91C1C" : "#FFF"), border: on ? "1px solid #FCA5A5" : "none", marginLeft: "auto", padding: "7px 14px" }}>
            {on ? "Turn calling off" : "Turn calling on"}
          </button>
        )}
      </div>
      <p style={{ margin: 0, fontSize: 13, color: "#475569", lineHeight: 1.55 }}>
        {/* The own view has no answer list below it (a sales rep's, say), so it doesn't point at one. */}
        {on
          ? (data.scope === "team"
            ? (many
              ? "Customers who call one of your numbers ring the people chosen for that number below, in My Synergy Phone on their computer and phone."
              : "Customers who call your number ring the people chosen below, in My Synergy Phone on their computer and phone.")
            : "Customers who call your number ring your team in My Synergy Phone, on their computer and phone.")
          : "While calling is off, My Synergy Phone can't ring or call out for anyone on your team."}
      </p>
      {!on && data.scope === "team" && !data.canSwitchOn && (
        <p data-ss-phone-rollout style={{ margin: "8px 0 0", fontSize: 13, color: "#475569", lineHeight: 1.55 }}>
          My Synergy Phone isn&rsquo;t open to every builder yet. Structure Studio switches it on for your account when it&rsquo;s ready.
        </p>
      )}
      {swNote && swNote.ok && <div style={{ ...S.okMsg, margin: "10px 0 0" }}>{swNote.ok}</div>}
      {swNote && swNote.err && <div style={{ ...S.err, margin: "10px 0 0" }}>{swNote.err}</div>}
    </div>
  );

  // ── The numbers (migration 266) ─────────────────────────────────────────────────────────
  // One number: as it always was. More than one: a list at the top, each with its name and whose
  // it is; picking one opens its own settings below (its name, its person, who answers it, its
  // hours, its caller ID). Connect and "Use this number for texting too" act on the open one.
  const textingWords = (n) => {
    if (n.textingStatus === "registered") return "Texting is set up on this number too.";
    if (n.textingStatus === "failed") return "The carriers turned down texting on this number; it still takes calls.";
    if (!n.callingOnly) return "Calls work now; texting follows once the carriers approve it.";
    if (data.textingActive) {
      return canEdit && data.canJoinTexting
        ? "Calls only for now. Add it to your texting below and it can text too, once the carriers approve it."
        : "Calls only for now. The account owner, or someone with Billing access, can add it to your texting.";
    }
    return n.id === mainId ? "Calls only for now. Texting uses this same number once the carriers approve your business on the Text Messaging tab." : "Calls only for now.";
  };
  const ownerBadge = (n) => (
    <span data-ss-phone-number-owner={n.assignedUserId || "team"} style={{
      fontSize: 11.5, fontWeight: 800, borderRadius: 999, padding: "2px 9px", whiteSpace: "nowrap",
      background: n.assignedUserId ? "#EEF2FF" : "#F1F5F9", color: n.assignedUserId ? "#3730A3" : "#475569",
    }}>
      {phoneNumberOwner(n, team)}
    </span>
  );
  // Another number, for someone the purchase accepts, up to the server's limit (a server before
  // 266 sends no maxNumbers: one number, as it allowed).
  const canAdd = data.scope === "team" && !!data.canBuyNumber && !!data.numbersForSale && numbers.length > 0
    && numbers.length < (data.maxNumbers || 1);
  const searchBlock = (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <input value={numQ} inputMode="numeric" maxLength={3} placeholder="Area code, e.g. 816"
          onChange={(e) => setNumQ(e.target.value.replace(/\D/g, "").slice(0, 3))}
          style={{ ...S.input, width: 170 }} data-ss-phone-areacode />
        <button type="button" disabled={busy} onClick={searchNumbers} data-ss-phone-search
          style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0", padding: "7px 14px" }}>
          {busy && !numResults ? "Searching…" : "Search"}
        </button>
      </div>
      {numResults && numResults.length === 0 && (
        <div style={{ fontSize: 12.5, color: "#64748B", marginTop: 8 }}>No numbers available there right now. Try a nearby area code, or leave it empty.</div>
      )}
      {numResults && numResults.length > 0 && (
        <div style={{ display: "grid", gap: 6, marginTop: 10 }}>
          {numResults.map((r) => (
            <div key={r.e164} data-ss-phone-result={r.e164} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontSize: 14, fontWeight: 800, minWidth: 130 }}>{phoneDisplay(r.e164)}</span>
              <span style={{ fontSize: 12, color: "#64748B", flex: "1 1 120px" }}>{[r.locality, r.region].filter(Boolean).join(", ")}</span>
              <button type="button" disabled={busy} onClick={() => buyNumber(r.e164)}
                style={{ ...S.btn(ACCENT, "#FFF"), padding: "5px 12px", fontSize: 12.5 }}>
                Get this number
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );

  const numberCard = (
    <div style={PHONE_CARD} data-ss-phone-numbers={numbers.length}>
      <h4 style={{ margin: "0 0 8px", fontSize: 14 }}>
        {many ? "Your business numbers" : data.scope !== "team" && sel && sel.mine ? "Your number" : "Your business number"}
      </h4>
      {many && (
        <div data-ss-phone-number-list style={{ display: "grid", gap: 6, marginBottom: 12 }}>
          {numbers.map((n, i) => {
            const open = !!sel && n.id === sel.id;
            return (
              <button type="button" key={n.id || i} data-ss-phone-number-row={n.e164} aria-pressed={open}
                onClick={() => { setSelId(n.id); setNote(null); setNumNote(null); setTrustNote(null); setViOpen(false); }}
                style={{
                  display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", width: "100%", textAlign: "left",
                  padding: "9px 12px", borderRadius: 10, cursor: "pointer", fontFamily: "inherit",
                  border: open ? `2px solid ${ACCENT}` : "1px solid #E2E8F0", background: open ? "#F8FAFF" : "#FFF",
                }}>
                <span style={{ fontSize: 13, fontWeight: 800, color: "#1E293B", minWidth: 110 }}>{phoneNumberName(n, i, mainId)}</span>
                <span style={{ fontSize: 14, fontWeight: 700, color: "#1E293B" }}>{phoneDisplay(n.e164)}</span>
                {data.scope === "team" && ownerBadge(n)}
                <span style={{ fontSize: 11.5, color: n.voiceReady ? "#047857" : "#94A3B8", marginLeft: "auto" }}>
                  {n.voiceReady ? "Rings My Synergy Phone" : "Not connected for calls"}
                </span>
              </button>
            );
          })}
        </div>
      )}
      {sel ? (
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
          {many && <div style={{ fontSize: 13, fontWeight: 800, color: "#475569" }}>{selName}:</div>}
          <div data-ss-phone-number style={{ fontSize: 18, fontWeight: 800 }}>{phoneDisplay(sel.e164)}</div>
          {!many && sel.label && <span style={{ fontSize: 13, fontWeight: 700, color: "#475569" }}>{sel.label}</span>}
          {!many && data.scope === "team" && data.perNumber && ownerBadge(sel)}
          {data.scope === "team" && (
            <span style={{ fontSize: 12, color: "#64748B" }}>{textingWords(sel)}</span>
          )}
          {data.scope !== "team" && (
            <span style={{ fontSize: 12, color: "#64748B" }}>
              {sel.mine ? "Your own number: customers see it when you call them." : "Customers see this number when you call them."}
            </span>
          )}
        </div>
      ) : (
        <div style={{ fontSize: 13, color: "#475569" }}>
          There&rsquo;s no number on this account yet.{" "}
          {data.scope === "team" && data.canBuyNumber && data.numbersForSale
            ? <>Get one for calls below; texting can use the same number later. Or, to set up texting first, </>
            : null}
          {onOpenTexting ? (
            <button type="button" onClick={onOpenTexting}
              style={{ background: "none", border: "none", padding: 0, color: ACCENT, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", textDecoration: "underline" }}>
              {data.scope === "team" && data.canBuyNumber && data.numbersForSale ? "start on the Text Messaging tab" : "Get one on the Text Messaging tab"}
            </button>
          ) : "Get one on the Text Messaging tab"}{data.scope === "team" && data.canBuyNumber && data.numbersForSale ? "." : ", then come back to choose who answers it."}
        </div>
      )}

      {/* ── Plan phase 6: CONNECT the number for calls ─────────────────────────────────────
          A number texting bought (or one bought while calling was off) does not ring My Synergy Phone
          until its voice webhooks point at the phone-api Worker. The owner does that here,
          once calling is on. With more than one number (migration 266), the open one. */}
      {/* Calling is OFF but the number still points at My Synergy Phone, which tells callers it can't
          take calls: the switch's move to voicemail did not finish (review SSB-2). Pressing
          this asks the switch to move it again (every number). */}
      {data.scope === "team" && sel && sel.voiceReady && !on && (
        <div data-ss-phone-stuck style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid #F1F5F9" }}>
          <div style={{ fontSize: 13, color: "#B45309", marginBottom: canEdit ? 8 : 0 }}>
            Calling is off, but this number still sends its calls to My Synergy Phone, so callers hear that it can&rsquo;t take calls.
          </div>
          {canEdit && (
            <button type="button" data-ss-phone-to-voicemail disabled={busy} onClick={() => flip(false)}
              style={{ ...S.btn(ACCENT, "#FFF"), padding: "7px 14px", opacity: busy ? 0.55 : 1 }}>
              Send calls to voicemail
            </button>
          )}
        </div>
      )}
      {data.scope === "team" && sel && !sel.voiceReady && (
        <div data-ss-phone-connect-card style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid #F1F5F9" }}>
          <div style={{ fontSize: 13, color: "#475569", marginBottom: canEdit && data.canConnect ? 8 : 0 }}>
            Calls to this number don&rsquo;t reach My Synergy Phone yet.
          </div>
          {canEdit && data.canConnect && (
            <button type="button" data-ss-phone-connect disabled={busy || !on || !data.voiceSetup} onClick={connect}
              title={!on ? "Turn calling on first" : !data.voiceSetup ? "Connecting numbers for calls isn't set up on this server yet" : ""}
              style={{ ...S.btn(ACCENT, "#FFF"), padding: "7px 14px", opacity: busy || !on || !data.voiceSetup ? 0.55 : 1 }}>
              Connect this number for calls
            </button>
          )}
          {canEdit && data.canConnect && !on && <span style={{ fontSize: 12, color: "#64748B", marginLeft: 10 }}>Turn calling on first.</span>}
        </div>
      )}
      {data.scope === "team" && sel && sel.voiceReady && on && (
        <div data-ss-phone-connected style={{ marginTop: 8, fontSize: 12, color: "#047857", fontWeight: 700 }}>Connected for calls.</div>
      )}
      {/* Migration 266: a calling-only number while the business texts. A number bought after
          texting was on joins it at purchase; this is for one whose join didn't finish, or one
          bought before texting cleared (texting takes over only one: phoneMainNumberId). */}
      {data.scope === "team" && sel && sel.callingOnly && data.textingActive && canEdit && data.canJoinTexting && (
        <div data-ss-phone-texting-join style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid #F1F5F9" }}>
          <div style={{ fontSize: 13, color: "#475569", marginBottom: 8 }}>
            This number takes calls. Add it to your texting and customers can text it too, once the carriers approve it.
          </div>
          <button type="button" data-ss-phone-texting-join-button disabled={busy} onClick={joinTexting}
            style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0", padding: "7px 14px", opacity: busy ? 0.55 : 1 }}>
            Use this number for texting too
          </button>
        </div>
      )}

      {/* ── Plan phase 6: a CALLING-ONLY number for a builder with none ────────────────────
          Offered only to someone the purchase will accept (the server's canBuyNumber: the
          owner, or an admin they gave Billing). Texting adopts the first number after
          registration instead of buying a second. */}
      {data.scope === "team" && !data.number && data.canBuyNumber && data.numbersForSale && (
        <div data-ss-phone-buy style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid #F1F5F9" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#1E293B", marginBottom: 6 }}>Get a number for calls</div>
          {searchBlock}
        </div>
      )}
      {/* ── Migration 266: ANOTHER number (a team line, or one person's) ──────────────────── */}
      {canAdd && !adding && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid #F1F5F9" }}>
          <button type="button" data-ss-phone-add disabled={busy} onClick={() => { setAdding(true); setNumResults(null); setNumNote(null); }}
            style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0", padding: "7px 14px" }}>
            Add another number
          </button>
          <span style={{ fontSize: 12, color: "#64748B", marginLeft: 10 }}>
            A second line for the team, or someone&rsquo;s own number. Up to {data.maxNumbers} numbers.
          </span>
        </div>
      )}
      {canAdd && adding && (
        <div data-ss-phone-buy="another" style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid #F1F5F9" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#1E293B" }}>Add another number</div>
            <button type="button" onClick={() => { setAdding(false); setNumResults(null); }}
              style={{ background: "none", border: "none", padding: 0, color: "#64748B", fontSize: 12, cursor: "pointer", fontFamily: "inherit", textDecoration: "underline" }}>
              Cancel
            </button>
          </div>
          {searchBlock}
        </div>
      )}
      {numNote && numNote.ok && <div style={{ ...S.okMsg, margin: "10px 0 0" }}>{numNote.ok}</div>}
      {numNote && numNote.err && <div style={{ ...S.err, margin: "10px 0 0" }}>{numNote.err}</div>}
    </div>
  );

  // ── This number's name and person (migration 266) ─────────────────────────────────────────
  // Saved with the rest of this number's settings (Save below). A person can have one number of
  // their own: someone who already has one is shown, not offered.
  const thisNumberCard = data.scope === "team" && data.perNumber && sel && form ? (() => {
    const locked = !canEdit;
    const takenBy = new Set(numbers.filter((n) => n.id !== sel.id && n.assignedUserId).map((n) => n.assignedUserId));
    const people = team.filter((t) => t.phoneLevel && t.phoneLevel !== "none");
    const gone = form.assignedUserId && !people.some((t) => t.userId === form.assignedUserId);
    // Whose number it is. A number nobody answers yet starts out ringing its person (or the owner
    // again for a team line); a number already set up keeps its answer list.
    const pickOwner = (v) => setForm((f) => ({
      ...f, assignedUserId: v,
      ...(!sel.route ? { members: v ? [v] : team.filter((t) => t.role === "owner" && t.phoneLevel !== "none").map((t) => t.userId) } : {}),
    }));
    return (
      <div style={PHONE_CARD} data-ss-phone-this-number>
        <h4 style={{ margin: "0 0 10px", fontSize: 14 }}>{many ? `${selName}: name and owner` : "This number"}</h4>
        <div style={{ display: "grid", gap: 10 }}>
          <label style={{ display: "block" }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#334155", marginBottom: 4 }}>Name (optional)</div>
            <input value={form.label} disabled={locked} maxLength={40} placeholder={sel && sel.id === mainId ? "Main number" : "e.g. Sales line"}
              onChange={(e) => setF({ label: e.target.value })} style={{ ...S.input, maxWidth: 280 }} data-ss-phone-number-label />
            <div style={{ fontSize: 11.5, color: "#64748B", marginTop: 4 }}>So you can tell your numbers apart. Up to 40 characters.</div>
          </label>
          <label style={{ display: "block" }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#334155", marginBottom: 4 }}>Whose number</div>
            <select value={form.assignedUserId || ""} disabled={locked} onChange={(e) => pickOwner(e.target.value)}
              style={{ ...S.input, width: "auto", minWidth: 220, padding: "5px 8px" }} data-ss-phone-number-owner-select>
              <option value="">Team line</option>
              {gone && <option value={form.assignedUserId}>Someone no longer on the team</option>}
              {people.map((t) => (
                <option key={t.userId} value={t.userId} disabled={takenBy.has(t.userId)}>
                  {(t.name || "Unnamed team member") + (takenBy.has(t.userId) ? " (has their own number)" : "")}
                </option>
              ))}
            </select>
            <div style={{ fontSize: 11.5, color: "#64748B", marginTop: 4, lineHeight: 1.45 }}>
              {form.assignedUserId
                ? "Their calls out show this number, and it rings the people ticked below (just them, to start). Everyone else keeps calling out from a team line."
                : "A team line rings the people ticked below. Anyone without a number of their own calls out from a team line."}
            </div>
          </label>
        </div>
      </div>
    );
  })() : null;

  // Your own Do Not Disturb cover (migration 264), saved on the Worker for the SIGNED-IN person's
  // own business: so never while an operator views someone else's, and only while calling is on
  // (the Worker's team list needs it on).
  const yourCallsCard = on && !viewingLabel ? <PhoneYourCallsCard /> : null;

  const installCard = (
    <div style={PHONE_CARD}>
      <h4 style={{ margin: "0 0 10px", fontSize: 14 }}>Get My Synergy Phone</h4>
      <SsPhoneInstallCard what="call" />
    </div>
  );

  // ── Plan phase 6: caller ID (plan §14, "Caller ID reputation") ─────────────────────────
  // Where the number's two registrations stand, for everyone on the team screen; registering
  // and checking are a CSM Synergy operator's only (the server's phone_trust_* gate, reported as
  // canManageCallerId). Nothing here runs on its own: each press is one request.
  // Per number (migration 266): the open one's registrations, and each press names it.
  const cid = (sel && sel.callerId) || null;
  const trustSetup = async (product) => {
    const what = product === "voice_integrity" ? "carrier spam-label protection (Voice Integrity)" : "verified caller ID (SHAKEN/STIR)";
    if (!window.confirm(`Register ${phoneDisplay(sel.e164)} for ${what}? This sends the business details on its Twilio business profile for Twilio's review.`)) return;
    setBusy(true); setTrustNote(null);
    try {
      const d = await phoneAction("phone_trust_setup", { product, numberId: sel.id, ...(product === "voice_integrity" ? { voiceIntegrity: viForm } : {}) });
      if (d.callerId) patchNumber(sel.id, { callerId: d.callerId });
      if (product === "voice_integrity") setViOpen(false);
      setTrustNote({ ok: d.submitted ? "Submitted. Twilio usually reviews it within one to two business days." : "It's already with Twilio, so nothing was sent again." });
    } catch (e) { setTrustNote({ err: e.message }); }
    finally { setBusy(false); }
  };
  const trustCheck = async () => {
    setBusy(true); setTrustNote(null);
    try {
      const d = await phoneAction("phone_trust_status", { numberId: sel.id });
      if (d.callerId) patchNumber(sel.id, { callerId: d.callerId });
      const codes = [...((d.errorCodes && d.errorCodes.shakenStir) || []), ...((d.errorCodes && d.errorCodes.voiceIntegrity) || [])];
      setTrustNote({ ok: codes.length ? `Checked. Twilio's rejection codes: ${codes.join(", ")}.` : "Checked with Twilio just now." });
    } catch (e) { setTrustNote({ err: e.message }); }
    finally { setBusy(false); }
  };
  const trustRow = (key, label, blurb, product) => {
    const st = cid && cid[key] ? cid[key].status : null;
    const registered = !!(cid && cid[key] && cid[key].registered);
    // Offered while there is something to send: never registered, a draft, or a rejection to
    // resubmit. Under review or approved, "Check status" is the only thing to press.
    const canSend = !st || st === "draft" || st === "twilio-rejected";
    return (
      <div data-ss-phone-trust={product} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "8px 0", borderTop: "1px solid #F1F5F9" }}>
        <div style={{ flex: "1 1 240px", minWidth: 200 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#1E293B" }}>{label}</div>
          <div style={{ fontSize: 12, color: "#64748B" }}>{blurb}</div>
        </div>
        <span data-ss-phone-trust-status={st || (registered ? "unknown" : "none")} style={{
          fontSize: 12, fontWeight: 800, borderRadius: 999, padding: "4px 10px",
          background: st === "twilio-approved" ? "#ECFDF5" : st === "twilio-rejected" ? "#FEF2F2" : "#F1F5F9",
          color: st === "twilio-approved" ? "#047857" : st === "twilio-rejected" ? "#B91C1C" : "#475569",
        }}>
          {PHONE_TRUST_WORDS[st] || (registered ? "Status unknown" : "Not registered")}
        </span>
        {data.canManageCallerId && canSend && (
          <button type="button" disabled={busy} data-ss-phone-trust-register={product}
            onClick={() => (product === "voice_integrity" ? setViOpen((v) => !v) : trustSetup(product))}
            style={{ ...S.btn(ACCENT, "#FFF"), padding: "6px 12px", fontSize: 12.5, opacity: busy ? 0.55 : 1 }}>
            {st === "twilio-rejected" ? "Submit again" : st === "draft" ? "Submit" : "Register"}
          </button>
        )}
      </div>
    );
  };
  const viValid = !!viForm.useCase && /^\d+$/.test(String(viForm.employeeCount).trim()) && Number(viForm.employeeCount) >= 1
    && /^\d+$/.test(String(viForm.averageDailyCalls).trim()) && Number(viForm.averageDailyCalls) >= 1;
  const callerIdCard = data.scope === "team" && sel ? (
    <div style={PHONE_CARD} data-ss-phone-callerid>
      <h4 style={{ margin: "0 0 4px", fontSize: 14 }}>{many ? `Caller ID for ${selName}` : "Caller ID"}</h4>
      <p style={{ margin: "0 0 6px", fontSize: 12.5, color: "#475569", lineHeight: 1.5 }}>
        Registering {phoneDisplay(sel.e164)} helps customers pick up: carriers show it as verified, and it is
        less likely to be labelled &ldquo;Spam Likely&rdquo;.
      </p>
      {!cid || !cid.available ? (
        <div style={{ fontSize: 13, color: "#64748B" }}>Caller ID registration isn&rsquo;t available on this account yet.</div>
      ) : (
        <>
          {trustRow("shakenStir", "Verified caller ID (SHAKEN/STIR)", "Your calls are signed at the highest trust level once Twilio approves it.", "shaken_stir")}
          {trustRow("voiceIntegrity", "Spam-label protection (Voice Integrity)", "Registers the number with the carriers' spam filters.", "voice_integrity")}
          {data.canManageCallerId && viOpen && (
            <div data-ss-phone-vi-form style={{ display: "grid", gap: 8, padding: "10px 12px", margin: "6px 0", background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 8 }}>
              <div style={{ fontSize: 12.5, color: "#475569" }}>
                {cid.voiceIntegrity.registered
                  ? "Twilio asks these about the business for Voice Integrity. Sending again replaces the answers it has with these."
                  : "Twilio asks these about the business for Voice Integrity."}
              </div>
              <label style={{ fontSize: 12.5, color: "#1E293B" }}>What the business uses calls for{" "}
                <select value={viForm.useCase} onChange={(e) => setViForm((f) => ({ ...f, useCase: e.target.value }))} style={{ ...S.input, width: 220 }} data-ss-phone-vi-usecase>
                  {PHONE_VI_USE_CASES.map((u) => <option key={u} value={u}>{u}</option>)}
                </select>
              </label>
              <label style={{ fontSize: 12.5, color: "#1E293B" }}>People who work there{" "}
                <input value={viForm.employeeCount} inputMode="numeric" data-ss-phone-vi-employees
                  onChange={(e) => setViForm((f) => ({ ...f, employeeCount: e.target.value.replace(/\D/g, "").slice(0, 7) }))} style={{ ...S.input, width: 110 }} />
              </label>
              <label style={{ fontSize: 12.5, color: "#1E293B" }}>Calls on a typical working day{" "}
                <input value={viForm.averageDailyCalls} inputMode="numeric" data-ss-phone-vi-calls
                  onChange={(e) => setViForm((f) => ({ ...f, averageDailyCalls: e.target.value.replace(/\D/g, "").slice(0, 7) }))} style={{ ...S.input, width: 110 }} />
              </label>
              <label style={{ fontSize: 12.5, color: "#1E293B" }}>Notes (optional){" "}
                <input value={viForm.notes} maxLength={500} placeholder="What the calls are about"
                  onChange={(e) => setViForm((f) => ({ ...f, notes: e.target.value }))} style={{ ...S.input, width: 320 }} />
              </label>
              <div>
                <button type="button" disabled={busy || !viValid} data-ss-phone-vi-submit onClick={() => trustSetup("voice_integrity")}
                  style={{ ...S.btn(ACCENT, "#FFF"), padding: "6px 12px", fontSize: 12.5, opacity: busy || !viValid ? 0.55 : 1 }}>
                  {cid.voiceIntegrity.registered ? "Send again with these answers" : "Register for Voice Integrity"}
                </button>
              </div>
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", paddingTop: 8, borderTop: "1px solid #F1F5F9" }}>
            <span style={{ fontSize: 12, color: "#64748B", flex: "1 1 200px" }}>
              {data.canManageCallerId
                ? (cid.checkedAt ? `Last checked with Twilio ${phoneWhen(cid.checkedAt) || "recently"}.` : "Not checked with Twilio yet.")
                : "Structure Studio registers your number. Ask us if you'd like it done."}
            </span>
            {data.canManageCallerId && (cid.shakenStir.registered || cid.voiceIntegrity.registered) && (
              <button type="button" disabled={busy} onClick={trustCheck} data-ss-phone-trust-check
                style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0", padding: "6px 12px", fontSize: 12.5 }}>
                Check status
              </button>
            )}
          </div>
        </>
      )}
      {trustNote && trustNote.ok && <div style={{ ...S.okMsg, margin: "10px 0 0" }}>{trustNote.ok}</div>}
      {trustNote && trustNote.err && <div style={{ ...S.err, margin: "10px 0 0" }}>{trustNote.err}</div>}
    </div>
  ) : null;

  // ── Call recording (migration 263) ─────────────────────────────────────────────────────
  // Shown to everyone on the team screen; only the business OWNER can change it (the server's
  // phone_recording_save rule, reported as canChangeRecording), because recording customers is
  // the business's own legal decision. The announcement is locked on. It saves on its own, with
  // its own button, so the routing form's Save never touches it. `recording` is null on a
  // database before 263: the card says so and offers nothing.
  // Calls are recorded only while the owner's `on` AND the server's switch (`serverOn`, the
  // phone-api Worker's CALL_RECORDING rail as portal-settings sees it) are both true. With the
  // owner's on and the server's off, the card says recording hasn't started yet: never that calls
  // are recorded while nothing records. Transcripts the same: the owner's choice AND the server's
  // (`transcribeServerOn`, the CALL_TRANSCRIBE rail). Until both, the standard sentence leaves out
  // "and transcribed" (as the Worker does) and nothing promises a transcript.
  // Recording is ON by default (migration 287, Carolyn 2026-10-06): a business whose owner never
  // saved this card is on, and the card says that is the default rather than who changed it. The
  // first save of such a business (no updatedAt yet) asks "Record calls?" too, even when only the
  // retention changed: the save stamps the owner as having chosen recording, so that choice always
  // went past the same words as turning it on.
  const rec = data.recording || null;
  const recLive = !!(rec && rec.on && rec.serverOn);
  const recEdit = !!data.canChangeRecording && canEdit && !!recForm;
  const recProblem = recForm ? phoneRecNoticeProblem(recForm.noticeText) : null;
  const recDirty = !!(rec && recForm) && (recForm.on !== rec.on || recForm.transcribe !== rec.transcribe
    || Number(recForm.retentionDays) !== Number(rec.retentionDays)
    || recForm.noticeText.replace(/\s+/g, " ").trim() !== String(rec.noticeText || ""));
  const saveRecording = async () => {
    const keep = Number(recForm.retentionDays);
    const keepWords = PHONE_REC_KEEP_WORDS[keep] || `${keep} days`;
    const recWho = `The people who can see a call can play its recording${recForm.transcribe && rec.transcribeServerOn ? " and read its transcript and summary" : ""}.`;
    if (recForm.on && (!rec.on || !rec.updatedAt) && !window.confirm(rec.serverOn
      ? `Record calls? From your next call on, every call to and from your business number is announced and then recorded. ${recWho}`
      : `Record calls? Call recording hasn't started on this account yet. Once it does, every call to and from your business number is announced and then recorded. ${recWho}`)) return;
    if (keep < Number(rec.retentionDays) && !window.confirm(`Keep recordings for ${keepWords}? Recordings older than that, and their transcripts, are deleted at the next daily clean-up. Their summaries stay with the calls.`)) return;
    setBusy(true); setRecNote(null);
    try {
      const d = await phoneAction("phone_recording_save", {
        on: recForm.on,
        noticeText: recForm.noticeText,
        transcribe: recForm.transcribe,
        retentionDays: keep,
      });
      setData((x) => ({ ...x, recording: d.recording }));
      setRecForm(phoneRecFormFrom(d.recording));
      setRecNote({ ok: !(d.recording && d.recording.on) ? "Saved. Calls aren't recorded."
        : d.recording.serverOn ? "Saved. Calls are announced and recorded from the next call on."
        : "Saved. Calls will be announced and recorded once call recording starts on this account." });
    } catch (e) { setRecNote({ err: e.message }); }
    finally { setBusy(false); }
  };
  const recCard = data.scope !== "team" ? null : !rec || !recForm ? (
    <div style={PHONE_CARD} data-ss-phone-recording="unavailable">
      <h4 style={{ margin: "0 0 4px", fontSize: 14 }}>Call recording</h4>
      <div style={{ fontSize: 13, color: "#64748B" }}>Call recording isn&rsquo;t available on this account yet.</div>
    </div>
  ) : (() => {
    const standard = recForm.transcribe && rec.transcribeServerOn ? PHONE_REC_STANDARD_TRANSCRIBED : PHONE_REC_STANDARD;
    const who = rec.updatedBy ? ((team.find((t) => t.userId === rec.updatedBy) || {}).name || null) : null;
    const when = phoneWhen(rec.updatedAt);
    const check = (checked, disabled, onChange, label, sub, key) => (
      <label key={key} style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13, color: "#1E293B", cursor: disabled ? "default" : "pointer" }}>
        <input type="checkbox" checked={checked} disabled={disabled} onChange={onChange} style={{ marginTop: 3 }} data-ss-phone-recording-check={key} />
        <span>
          <span style={{ fontWeight: 700 }}>{label}</span>
          {sub && <span style={{ display: "block", fontSize: 12, color: "#64748B", lineHeight: 1.45 }}>{sub}</span>}
        </span>
      </label>
    );
    return (
      <div style={PHONE_CARD} data-ss-phone-recording={rec.on ? "on" : "off"}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 4 }}>
          <h4 style={{ margin: 0, fontSize: 14 }}>Call recording</h4>
          <span data-ss-phone-recording-status={recLive ? "on" : rec.on ? "waiting" : "off"} style={{
            fontSize: 12, fontWeight: 800, borderRadius: 999, padding: "3px 10px",
            background: recLive ? "#FEF2F2" : rec.on ? "#FFFBEB" : "#F1F5F9", color: recLive ? "#B91C1C" : rec.on ? "#92400E" : "#475569",
          }}>
            {recLive ? "Calls are recorded" : rec.on ? "On, not started yet" : "Off"}
          </span>
        </div>
        {!rec.serverOn && (
          <p data-ss-phone-recording-waiting style={{ margin: "0 0 8px", fontSize: 12.5, color: "#92400E", lineHeight: 1.5 }}>
            Call recording hasn&rsquo;t started on this account yet, so no call is announced or recorded. Settings saved here
            take effect once it starts.
          </p>
        )}
        <p style={{ margin: "0 0 10px", fontSize: 12.5, color: "#64748B", lineHeight: 1.5 }}>
          When it&rsquo;s on, calls to and from your business number are recorded from the moment someone answers. Callers
          hear the announcement below before the call rings your team, and on calls your team places, the customer hears it
          when they pick up. Recording pauses while a customer is on hold, except while the call is being passed to a
          teammate. Recordings play on the contact&rsquo;s page here and in My Synergy Phone,
          for the people who can see that call.
        </p>
        <div style={{ display: "grid", gap: 10 }}>
          {check(recForm.on, !recEdit, (e) => setRecForm((f) => ({ ...f, on: e.target.checked })), "Record calls", null, "on")}
          {check(true, true, () => {}, "Announce it to callers",
            "Always on: callers are told before anything is recorded.", "notice")}
          <label style={{ display: "block" }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#334155", marginBottom: 4 }}>What callers hear (optional)</div>
            <input value={recForm.noticeText} disabled={!recEdit} maxLength={300} placeholder={standard}
              onChange={(e) => setRecForm((f) => ({ ...f, noticeText: e.target.value }))}
              style={S.input} data-ss-phone-recording-notice />
            <div style={{ fontSize: 11.5, color: recProblem ? "#B91C1C" : "#64748B", marginTop: 4, lineHeight: 1.45 }}>
              {recProblem || <>Leave it empty for the standard sentence: &ldquo;{standard}&rdquo; Your own wording has to say the call is recorded (10 to 300 characters).</>}
            </div>
          </label>
          {check(recForm.transcribe, !recEdit, (e) => setRecForm((f) => ({ ...f, transcribe: e.target.checked })),
            "Transcripts and summaries",
            <>
              A written transcript of each recorded call, and a short summary with any action items, a minute or two after the
              call ends. Cloudflare writes the transcript and Anthropic&rsquo;s Claude writes the summary.
              {!rec.transcribeServerOn && (
                <span data-ss-phone-recording-transcripts-waiting style={{ display: "block", marginTop: 3, color: "#92400E" }}>
                  Transcripts haven&rsquo;t started on this account yet. Your choice is saved and takes effect once they do.
                </span>
              )}
            </>,
            "transcribe")}
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#1E293B", flexWrap: "wrap" }}>
            Keep recordings for
            <select value={String(recForm.retentionDays)} disabled={!recEdit} data-ss-phone-recording-keep
              onChange={(e) => setRecForm((f) => ({ ...f, retentionDays: Number(e.target.value) }))}
              style={{ ...S.input, width: "auto", padding: "5px 8px" }}>
              {(rec.retentionChoices || [30, 90, 180, 365, 730]).map((d) => <option key={d} value={d}>{PHONE_REC_KEEP_WORDS[d] || `${d} days`}</option>)}
            </select>
            <span style={{ fontSize: 12, color: "#64748B" }}>The recording and its transcript are deleted after that. The summary stays with the call.</span>
          </label>
        </div>
        <div data-ss-phone-recording-legal style={{ fontSize: 12, color: "#92400E", background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 8, padding: "8px 10px", marginTop: 12, lineHeight: 1.5 }}>
          Some states require everyone on a call to agree before it&rsquo;s recorded. The announcement tells every caller, but the
          rules are yours to follow: check them with your lawyer for the states you and your customers are in.
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 12 }}>
          {recEdit && (
            <button type="button" disabled={busy || !recDirty || !!recProblem} onClick={saveRecording} data-ss-phone-recording-save
              style={{ ...S.btn(ACCENT, "#FFF"), padding: "7px 14px", opacity: busy || !recDirty || recProblem ? 0.55 : 1 }}>
              {busy ? "Saving…" : "Save call recording"}
            </button>
          )}
          {!recEdit && (
            <span style={{ fontSize: 12, color: "#64748B" }}>Only the business owner can change call recording.</span>
          )}
          {when && (
            <span style={{ fontSize: 12, color: "#64748B" }}>Last changed {when}{who ? ` by ${who}` : ""}.</span>
          )}
          {!when && rec.on && (
            <span data-ss-phone-recording-default style={{ fontSize: 12, color: "#64748B" }}>
              On by default for every business. The business owner can turn it off.
            </span>
          )}
          {recNote && recNote.err && <span style={{ fontSize: 12.5, color: "#B91C1C", fontWeight: 700 }}>{recNote.err}</span>}
          {recNote && recNote.ok && <span style={{ fontSize: 12.5, color: "#047857", fontWeight: 700 }}>{recNote.ok}</span>}
        </div>
      </div>
    );
  })();

  // Someone with their OWN calls only: whether it is on, which number customers see, and where
  // to get the apps. The setup is the team's business (the server did not send it), but whether
  // their calls are recorded is theirs to know (recording {on, serverOn}: said only when both are
  // true, which is when calls really are recorded).
  if (data.scope !== "team" || !form) {
    return (
      <div data-ss-phone-settings="own">
        {header}
        {numberCard}
        <div style={{ ...PHONE_CARD, fontSize: 13, color: "#475569" }}>
          Your owner chooses who answers the business number. Calls you place and take show on the Calls page.
          {data.recording && data.recording.on && data.recording.serverOn && (
            <span data-ss-phone-recording="own" style={{ display: "block", marginTop: 6 }}>
              Calls on your business number are recorded. Callers hear an announcement first, and recordings play on the
              contact&rsquo;s page and in My Synergy Phone.
            </span>
          )}
        </div>
        {yourCallsCard}
        {installCard}
      </div>
    );
  }

  const ro = !canEdit;
  const chosen = form.members.filter((id) => team.some((t) => t.userId === id));
  const others = team.filter((t) => !chosen.includes(t.userId));
  const move = (id, by) => setForm((f) => {
    const list = [...f.members];
    const i = list.indexOf(id), j = i + by;
    if (i < 0 || j < 0 || j >= list.length) return f;
    [list[i], list[j]] = [list[j], list[i]];
    return { ...f, members: list };
  });
  const toggle = (id) => setForm((f) => ({ ...f, members: f.members.includes(id) ? f.members.filter((x) => x !== id) : [...f.members, id] }));
  const wantsForward = form.noAnswer === "forward" || (form.hoursOn && form.afterHours === "forward");
  const radio = (name, value, current, label, onPick) => (
    <label key={value} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 13, color: "#1E293B", cursor: ro ? "default" : "pointer" }}>
      <input type="radio" name={name} checked={current === value} disabled={ro} onChange={() => onPick(value)} />
      {label}
    </label>
  );
  const deviceWord = (p) => (p === "chrome" ? "Chrome" : p === "ios" ? "iPhone" : "Android");
  const memberRow = (t, idx) => {
    const checked = chosen.includes(t.userId);
    const eligible = t.phoneLevel && t.phoneLevel !== "none";
    return (
      <div key={t.userId} data-ss-phone-member={t.userId}
        style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderTop: "1px solid #F1F5F9", flexWrap: "wrap" }}>
        <input type="checkbox" checked={checked} disabled={ro || (!eligible && !checked)} onChange={() => toggle(t.userId)}
          title={eligible ? "" : "No Phone access — change it on the Team tab first"} />
        <div style={{ flex: "1 1 180px", minWidth: 160 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: eligible ? "#1E293B" : "#94A3B8" }}>
            {checked && form.mode === "in_order" ? `${idx + 1}. ` : ""}{t.name || "Unnamed team member"}
          </div>
          <div style={{ fontSize: 11.5, color: "#64748B" }}>
            {PHONE_LEVEL_LABEL[t.phoneLevel] || "No phone access"}
            {(t.devices || []).length > 0 && (
              <> · {(t.devices || []).map((d) => `${deviceWord(d.platform)}${phoneWhen(d.lastSeenAt) ? ` (${phoneWhen(d.lastSeenAt)})` : ""}`).join(", ")}</>
            )}
          </div>
          {/* Their own hours (migration 264): set by them, shown here so the owner knows why they
              didn't ring. A zone they didn't save reads as the number's. */}
          {t.ringHours && (
            <div data-ss-phone-member-hours style={{ fontSize: 11.5, color: "#64748B" }}>
              Their hours: {phoneHoursSummary(t.ringHours)} ({phoneZoneWord(t.ringHoursTz || (sel && sel.route && sel.route.timeZone) || form.timeZone, PHONE_TIME_ZONES)})
            </div>
          )}
          {outNote && outNote.userId === t.userId && (
            <div style={{ fontSize: 12, marginTop: 4, color: outNote.err ? "#B91C1C" : "#047857", fontWeight: 600 }}>{outNote.err || outNote.ok}</div>
          )}
        </div>
        {checked && !ro && (
          <span style={{ display: "inline-flex", gap: 4 }}>
            <button type="button" title="Ring earlier" disabled={idx === 0} onClick={() => move(t.userId, -1)}
              style={{ ...S.btn("#F1F5F9", "#334155"), padding: "3px 8px", fontSize: 12 }}>↑</button>
            <button type="button" title="Ring later" disabled={idx === chosen.length - 1} onClick={() => move(t.userId, 1)}
              style={{ ...S.btn("#F1F5F9", "#334155"), padding: "3px 8px", fontSize: 12 }}>↓</button>
          </span>
        )}
        {!ro && eligible && (
          <button type="button" disabled={busy} onClick={() => signOut(t)} data-ss-phone-signout={t.userId}
            style={{ ...S.btn("#FFF", "#B91C1C"), border: "1px solid #FECACA", padding: "4px 10px", fontSize: 12 }}>
            Sign out all devices
          </button>
        )}
      </div>
    );
  };
  const setDay = (day, periods) => setForm((f) => ({ ...f, hours: phoneHoursWithDay(f.hours, day, periods) }));

  return (
    <div data-ss-phone-settings="team">
      {header}
      {numberCard}
      {thisNumberCard}
      {callerIdCard}

      <div style={PHONE_CARD}>
        <h4 style={{ margin: "0 0 4px", fontSize: 14 }}>Who answers</h4>
        <p style={{ margin: "0 0 10px", fontSize: 12.5, color: "#64748B", lineHeight: 1.5 }}>
          The people ticked here ring on every call to {many ? selName : "your number"}, in My Synergy Phone on their computer and
          phone. They don&rsquo;t need to set anything up beyond signing in. Up to 10 people.
        </p>
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginBottom: 10 }}>
          {radio("ss-phone-mode", "all_at_once", form.mode, "Ring everyone at once", (v) => setF({ mode: v }))}
          {radio("ss-phone-mode", "in_order", form.mode, "Ring one after another, in this order", (v) => setF({ mode: v }))}
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#1E293B", marginBottom: 6 }}>
          Ring for
          <select value={String(form.ringSeconds)} disabled={ro} onChange={(e) => setF({ ringSeconds: Number(e.target.value) })}
            style={{ ...S.input, width: "auto", padding: "5px 8px" }}>
            {(([10, 15, 20, 25, 30, 45, 60].includes(Number(form.ringSeconds)) ? [] : [Number(form.ringSeconds)])
              .concat([10, 15, 20, 25, 30, 45, 60]))
              .map((s) => <option key={s} value={s}>{s} seconds</option>)}
          </select>
          {form.mode === "in_order" ? "each" : "before the call moves on"}
        </label>
        <div>
          {chosen.map((id, i) => memberRow(team.find((t) => t.userId === id), i))}
          {others.map((t) => memberRow(t, -1))}
        </div>
        {chosen.length === 0 && (
          <div style={{ fontSize: 12.5, color: "#B45309", marginTop: 8 }}>
            Nobody is ticked, so every call goes straight to {form.noAnswer === "forward" ? "the forwarding number" : "voicemail"}.
          </div>
        )}
      </div>

      <div style={PHONE_CARD}>
        <h4 style={{ margin: "0 0 10px", fontSize: 14 }}>When nobody answers</h4>
        <div style={{ display: "grid", gap: 6, marginBottom: 10 }}>
          {radio("ss-phone-noanswer", "voicemail", form.noAnswer, "Take a voicemail", (v) => setF({ noAnswer: v }))}
          {radio("ss-phone-noanswer", "forward", form.noAnswer, "Forward to a cell phone", (v) => setF({ noAnswer: v }))}
        </div>
        {wantsForward && (
          <label style={{ display: "block", marginBottom: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#334155", marginBottom: 4 }}>Forward to</div>
            <input value={form.forwardTo} disabled={ro} placeholder="(816) 555-0100" inputMode="tel"
              onChange={(e) => setF({ forwardTo: formatPhone(e.target.value) })}
              style={{ ...S.input, maxWidth: 240 }} />
            <div style={{ fontSize: 11.5, color: "#64748B", marginTop: 4, lineHeight: 1.45 }}>
              The cell hears &ldquo;My Synergy Phone call, press 1 to answer&rdquo; first, so a switched-off phone&rsquo;s own
              voicemail never takes your customer&rsquo;s message — it lands in yours.
            </div>
          </label>
        )}
        <label style={{ display: "block" }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#334155", marginBottom: 4 }}>Voicemail greeting (optional)</div>
          <input value={form.greetingUrl} disabled={ro} placeholder="https://… link to an audio file"
            onChange={(e) => setF({ greetingUrl: e.target.value })} style={S.input} />
          <div style={{ fontSize: 11.5, color: "#64748B", marginTop: 4 }}>
            Plays on calls to the shared number that aren&rsquo;t for one person. Leave it empty for the standard greeting:
            &ldquo;You&rsquo;ve reached [your business]. We can&rsquo;t take your call right now. Please leave your name, number
            and a short message after the tone.&rdquo; Everyone can record their own greeting under Your calls.
          </div>
        </label>
      </div>

      <div style={PHONE_CARD}>
        <h4 style={{ margin: "0 0 10px", fontSize: 14 }}>Business hours</h4>
        <div style={{ display: "grid", gap: 6, marginBottom: 10 }}>
          {radio("ss-phone-hours", "always", form.hoursOn ? "set" : "always", "Always open — ring the team at any hour", () => setF({ hoursOn: false }))}
          {radio("ss-phone-hours", "set", form.hoursOn ? "set" : "always", "Only during these hours", () => setF({ hoursOn: true }))}
        </div>
        {form.hoursOn && (
          <>
            <PhoneHoursEditor hours={form.hours} timeZone={form.timeZone} ro={ro}
              onDay={setDay} onTimeZone={(tz) => setF({ timeZone: tz })} />
            <div style={{ fontSize: 12, fontWeight: 700, color: "#334155", marginBottom: 6 }}>Outside these hours</div>
            <div style={{ display: "grid", gap: 6 }}>
              {radio("ss-phone-after", "voicemail", form.afterHours, "Take a voicemail", (v) => setF({ afterHours: v }))}
              {radio("ss-phone-after", "forward", form.afterHours, "Forward to the cell phone above", (v) => setF({ afterHours: v }))}
            </div>
          </>
        )}
      </div>

      {!ro && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
          <button type="button" disabled={busy || !sel} onClick={save} data-ss-phone-save
            title={sel ? "" : "Get a number on the Text Messaging tab first"}
            style={{ ...S.btn(ACCENT, "#FFF"), opacity: busy || !sel ? 0.6 : 1 }}>
            {busy ? "Saving…" : sel && sel.route ? (many ? `Save ${selName}` : "Save phone settings") : "Save and finish setup"}
          </button>
          {note && note.err && <span style={{ fontSize: 12.5, color: "#B91C1C", fontWeight: 700 }}>{note.err}</span>}
          {note && note.ok && <span style={{ fontSize: 12.5, color: "#047857", fontWeight: 700 }}>{note.ok}</span>}
        </div>
      )}

      {/* Below the routing form's Save, not between its cards: it has a Save of its own. */}
      {recCard}

      {yourCallsCard}

      {installCard}
    </div>
  );
}

// ── Your voicemail greeting (migration 264) ──────────────────────────────────────────────
// Each person records their own BY PHONE. Record asks
// the Worker to ring their own My Synergy Phone (in Chrome or on their phone; 01-core
// ssPhoneRecordGreeting), they answer and speak after the tone, and the Worker keeps the
// recording. No file upload: browsers record a format phone calls can't play. Nobody else can
// record or clear it. It plays when a call meant for them goes to voicemail: a call transferred
// to them, or a number that rings only them; a shared number keeps the business's greeting (the
// owner's link below, or the standard sentence). The words are My Synergy Phone's own (phone-core
// greeting.ts), pinned to the same answers by tests/phone/greeting_test.ts.
const PHONE_GREETING_WORDS = {
  where: "It plays when a call meant for you goes to voicemail: a call transferred to you, or a number that rings only you. Calls to the shared business number keep the business's greeting.",
  ringing: "My Synergy Phone will ring now. Answer it and speak after the tone.",
  saved: "Your new greeting is saved.",
  noRing: "No new greeting came through. If My Synergy Phone didn't ring, check it's signed in, then try again.",
  standardDone: "Done. Callers hear the business's greeting.",
  confirmStandard: "Delete your greeting? Callers will hear the business's greeting instead.",
};
// How long the card watches for the new greeting after Record (the ring, up to a minute of
// speaking, and the save), and how often it looks.
const PHONE_GREETING_WAIT_MS = 3 * 60_000;
const PHONE_GREETING_POLL_MS = 5_000;
// Is this Worker one that keeps greetings? It sends `greeting` ({set, updated_at}) with the settings.
function phoneGreetingSupported(settings) {
  return !!settings && !!settings.greeting && typeof settings.greeting === "object";
}
// "Oct 5", in this browser's own calendar.
function phoneGreetingDay(iso) {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
}
// The card's line: whose greeting callers hear now.
function phoneGreetingText(g) {
  if (!g || !g.set) return "You haven't recorded one, so callers hear the business's greeting.";
  const day = phoneGreetingDay(g.updated_at);
  return day ? `Your own greeting, recorded ${day}.` : "Your own greeting.";
}
// Did a new greeting land since Record was pressed (`before` is the updated_at seen then)?
function phoneGreetingChanged(before, after) {
  return !!after && after.set === true && !!after.updated_at && after.updated_at !== (before || null);
}

function PhoneGreetingSection({ greeting, onSettings }) {
  // ⚠️ HOOKS FIRST, ALL OF THEM, ABOVE EVERY EARLY RETURN (React #310).
  const [busy, setBusy] = useState(null);   // "record" | "play" | "clear" | null
  const [note, setNote] = useState(null);   // { ok } | { err } | { info }
  const [wait, setWait] = useState(null);   // { before, until } while the ring is on its way
  const [src, setSrc] = useState(null);     // the greeting's blob: URL once Play was pressed
  const token = async () => {
    const { data } = await sb.auth.getSession();
    return data && data.session ? data.session.access_token : null;
  };
  // The blob lives in this tab's memory until it is let go.
  useEffect(() => () => { if (src) { try { URL.revokeObjectURL(src); } catch (_e) { /* already gone */ } } }, [src]);
  // After Record: look for the new greeting every few seconds until it lands, or give up.
  useEffect(() => {
    if (!wait) return undefined;
    let live = true;
    const tick = async () => {
      if (Date.now() > wait.until) {
        if (live) { setWait(null); setNote({ err: PHONE_GREETING_WORDS.noRing }); }
        return;
      }
      try {
        const s = await ssPhoneMySettings(await token());
        if (live && s && phoneGreetingChanged(wait.before, s.greeting)) {
          onSettings(s);
          setWait(null);
          setSrc(null);
          setNote({ ok: PHONE_GREETING_WORDS.saved });
        }
      } catch (_e) { /* a missed look; the next one tries again */ }
    };
    const t = setInterval(tick, PHONE_GREETING_POLL_MS);
    return () => { live = false; clearInterval(t); };
  }, [wait]);

  const g = greeting || { set: false, updated_at: null };
  const record = async () => {
    setBusy("record"); setNote(null);
    try {
      await ssPhoneRecordGreeting(await token());
      setWait({ before: g.updated_at || null, until: Date.now() + PHONE_GREETING_WAIT_MS });
      setNote({ info: PHONE_GREETING_WORDS.ringing });
    } catch (e) { setNote({ err: e.message }); }
    finally { setBusy(null); }
  };
  const play = async () => {
    setBusy("play"); setNote(null);
    try { setSrc(await ssPhoneFetchGreeting(await token())); }
    catch (e) { setNote({ err: e.message }); }
    finally { setBusy(null); }
  };
  const standard = async () => {
    if (!window.confirm(PHONE_GREETING_WORDS.confirmStandard)) return;
    setBusy("clear"); setNote(null);
    try {
      const saved = await ssPhoneClearGreeting(await token());
      if (saved) onSettings(saved);
      setSrc(null);
      setNote({ ok: PHONE_GREETING_WORDS.standardDone });
    } catch (e) { setNote({ err: e.message }); }
    finally { setBusy(null); }
  };
  const btn = (primary) => ({ ...S.btn(primary ? ACCENT : "#F1F5F9", primary ? "#FFF" : "#334155"), opacity: busy ? 0.6 : 1 });

  return (
    <div data-ss-phone-greeting style={{ borderTop: "1px solid #F1F5F9", marginTop: 14, paddingTop: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: "#334155", marginBottom: 4 }}>Voicemail greeting</div>
      <div data-ss-phone-greeting-state style={{ fontSize: 12.5, color: "#1E293B", marginBottom: 4 }}>{phoneGreetingText(g)}</div>
      <div style={{ fontSize: 12, color: "#64748B", lineHeight: 1.5, marginBottom: 10 }}>{PHONE_GREETING_WORDS.where}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <button type="button" disabled={!!busy || !!wait} onClick={record} data-ss-phone-greeting-record style={btn(true)}>
          {busy === "record" ? "Ringing…" : wait ? "Waiting for your greeting…" : g.set ? "Record a new greeting" : "Record my greeting"}
        </button>
        {g.set && (
          <button type="button" disabled={!!busy} onClick={play} data-ss-phone-greeting-play style={btn(false)}>
            {busy === "play" ? "Loading…" : "▶ Play"}
          </button>
        )}
        {g.set && (
          <button type="button" disabled={!!busy || !!wait} onClick={standard} data-ss-phone-greeting-clear style={btn(false)}>
            {busy === "clear" ? "Saving…" : "Use the standard greeting"}
          </button>
        )}
      </div>
      {src && (
        <audio controls autoPlay src={src} data-ss-phone-greeting-audio
          style={{ display: "block", width: "100%", maxWidth: 340, height: 34, marginTop: 8 }} />
      )}
      {note && note.info && <div data-ss-phone-greeting-note style={{ fontSize: 12.5, color: "#1D4ED8", fontWeight: 700, marginTop: 8 }}>{note.info}</div>}
      {note && note.ok && <div data-ss-phone-greeting-note style={{ fontSize: 12.5, color: "#047857", fontWeight: 700, marginTop: 8 }}>{note.ok}</div>}
      {note && note.err && <div data-ss-phone-greeting-note style={{ fontSize: 12.5, color: "#B91C1C", fontWeight: 700, marginTop: 8 }}>{note.err}</div>}
    </div>
  );
}

// ── Your calls (migration 264) ──────────────────────────────────────────────────────────
// The signed-in person's OWN phone settings, on Settings › Phone for everyone with phone access
// (the own view and the team view alike): who rings in their place while they're on Do Not
// Disturb, the hours their phone rings (below), and their own voicemail greeting
// (PhoneGreetingSection, above). Read and saved on the phone-api Worker
// (01-core ssPhoneMySettings / ssPhoneSaveMySettings, the same call My Synergy Phone makes), so
// the choice ships with this page and needs no app update; the Worker checks it (a teammate on
// this business with phone access, never yourself) and says "That teammate can't take calls."
// otherwise. The words are My Synergy Phone's own (its phone-core away.ts and ringHours.ts), so
// the portal and the apps say the same thing. Pure helpers first (tests/phone/awayCover_test.ts
// and ringHours_test.ts run them), then the card.
function phoneCoverState(coverId, team) {
  if (!coverId) return { kind: "none" };
  if (!Array.isArray(team)) return { kind: "unknown", userId: coverId };
  const m = team.find((t) => t && t.user_id === coverId);
  return m ? { kind: "teammate", userId: coverId, name: m.full_name || "Your teammate" } : { kind: "gone", userId: coverId };
}
// The box: No one (""), the saved cover when the team list can't name them, then teammates by name.
function phoneCoverOptions(coverId, team, myUserId) {
  const c = phoneCoverState(coverId, team);
  const out = [{ value: "", label: "No one" }];
  if (c.kind === "gone") out.push({ value: c.userId, label: "Someone who can't take calls now" });
  if (c.kind === "unknown") out.push({ value: c.userId, label: "The teammate you chose" });
  const mates = (Array.isArray(team) ? team : []).filter((t) => t && t.user_id && t.user_id !== myUserId)
    .sort((a, b) => String(a.full_name || "").localeCompare(String(b.full_name || "")));
  for (const t of mates) out.push({ value: t.user_id, label: t.full_name || "Teammate" });
  return out;
}
function phoneAwayText(c) {
  if (c.kind === "teammate") return `While you're on Do Not Disturb, calls skip you and ring ${c.name} in your place.`;
  if (c.kind === "unknown") return "While you're on Do Not Disturb, calls skip you and ring the teammate you chose in your place.";
  if (c.kind === "gone") return "While you're on Do Not Disturb, calls skip you. The teammate you chose can't take calls any more, so pick someone else.";
  return "While you're on Do Not Disturb, calls skip you and ring your teammates, or go to voicemail.";
}
function phoneCoverSavedText(c) {
  if (c.kind === "teammate") return `Saved. While you're away, your calls ring ${c.name}.`;
  if (c.kind === "none") return "Saved. While you're away, calls skip you and ring your teammates, or go to voicemail.";
  return "Saved. While you're away, your calls ring the teammate you chose.";
}

// When my phone rings (migration 264): each person's own hours, business hours' weekly shape
// ({"mon":[["08:00","17:00"]], ...}; null = always), in the time zone they set them in. Outside
// them the Worker treats them as away, like Do Not Disturb: their cover rings, or nobody does.
// They only narrow the business's hours, never widen them. The Worker checks a save with the rule
// the owner's hours pass (_shared/phoneHours.ts) and needs at least one day and a zone; the card
// says the "no day" one before it asks. The summary is My Synergy Phone's own (phone-core
// ringHours.ts ringHoursSummary), so Settings in the apps reads the same.
const PHONE_DAY_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const PHONE_DAY_SHORT = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
// "08:00" → "8 AM", "13:30" → "1:30 PM", "00:00" → "12 AM".
function phoneClockWord(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ""));
  if (!m) return String(hhmm || "");
  const h = Number(m[1]) % 24;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${m[2] === "00" ? "" : `:${m[2]}`} ${h < 12 ? "AM" : "PM"}`;
}
// {mon..fri: 8-5, sat: 9-12} → "Mon–Fri 8 AM–5 PM; Sat 9 AM–12 PM". Days in a row with the same
// times are one group. null → "Any time"; no day at all → "No days".
function phoneHoursSummary(hours) {
  if (!hours || typeof hours !== "object") return "Any time";
  const key = (d) => JSON.stringify(Array.isArray(hours[d]) ? hours[d] : []);
  const groups = [];
  for (const d of PHONE_DAY_ORDER) {
    if (!Array.isArray(hours[d]) || !hours[d].length) continue;
    const last = groups[groups.length - 1];
    const prev = PHONE_DAY_ORDER[PHONE_DAY_ORDER.indexOf(d) - 1];
    if (last && last.to === prev && key(last.to) === key(d)) last.to = d;
    else groups.push({ from: d, to: d });
  }
  if (!groups.length) return "No days";
  return groups.map((g) => {
    const days = g.from === g.to ? PHONE_DAY_SHORT[g.from] : `${PHONE_DAY_SHORT[g.from]}–${PHONE_DAY_SHORT[g.to]}`;
    return `${days} ${hours[g.from].map((p) => `${phoneClockWord(p[0])}–${phoneClockWord(p[1])}`).join(", ")}`;
  }).join("; ");
}
// "America/Chicago" → "Central time"; a zone off the list → its city ("Asia/Karachi" → "Karachi time").
function phoneZoneWord(tz, zones) {
  const z = (zones || []).find((x) => x[0] === tz);
  if (z) return `${z[1].replace(/ \(.*\)$/, "")} time`;
  const city = String(tz || "").split("/").pop().replace(/_/g, " ");
  return city ? `${city} time` : "the business's time";
}
// Is this Worker one that keeps hours? It sends `ring_hours` (null or an object) with the settings.
function phoneRingHoursSupported(settings) {
  return !!settings && settings.ring_hours !== undefined;
}
// The saved settings → the card's form. A zone of their own, else this browser's, else Central.
function phoneRingHoursForm(settings, deviceTz, defaults) {
  const h = settings && settings.ring_hours && typeof settings.ring_hours === "object" ? settings.ring_hours : null;
  return {
    on: !!h,
    hours: h || defaults || {},
    timeZone: (settings && settings.ring_hours_tz) || deviceTz || "America/Chicago",
  };
}
// The form → POST /settings/me's body. Always: hours null (the zone is left as it was).
function phoneRingHoursPatch(form) {
  return form.on ? { ring_hours: form.hours, ring_hours_tz: form.timeZone } : { ring_hours: null };
}
// What the Worker would refuse that the card can see first: hours on, but no day has any.
function phoneRingHoursProblem(form) {
  if (!form.on) return null;
  return PHONE_DAY_ORDER.some((d) => Array.isArray(form.hours[d]) && form.hours[d].length) ? null
    : "Add hours to at least one day, or choose Always.";
}
// Outside your hours, as a sentence: who rings in your place (the cover, read like phoneAwayText).
function phoneOffHoursText(c) {
  if (c.kind === "teammate") return `Outside your hours, calls skip you and ring ${c.name} in your place.`;
  if (c.kind === "unknown") return "Outside your hours, calls skip you and ring the teammate you chose in your place.";
  if (c.kind === "gone") return "Outside your hours, calls skip you.";
  return "Outside your hours, calls skip you and ring your teammates, or go to voicemail.";
}
function phoneRingHoursSavedText(form, zones) {
  if (!form.on) return "Saved. Your phone rings whenever the business is open.";
  return `Saved. Your phone rings ${phoneHoursSummary(form.hours)} (${phoneZoneWord(form.timeZone, zones)}).`;
}
function phoneDeviceZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch (_e) { return null; }
}

function PhoneYourCallsCard() {
  // ⚠️ HOOKS FIRST, ALL OF THEM, ABOVE EVERY EARLY RETURN (React #310).
  const [st, setSt] = useState(null);      // { settings, team, me } | { unavailable: true }
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);  // { ok } | { err } after a save
  // When my phone rings (migration 264): the form while it has unsaved changes (null = as saved),
  // its save, and what the save said.
  const [hoursEdit, setHoursEdit] = useState(null);   // { on, hours, timeZone } | null
  const [hoursBusy, setHoursBusy] = useState(false);
  const [hoursNote, setHoursNote] = useState(null);   // { ok } | { err }
  const session = async () => {
    const { data: d } = await sb.auth.getSession();
    return d && d.session ? d.session : null;
  };
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const s = await session();
        const token = s ? s.access_token : null;
        const [settings, team] = await Promise.all([ssPhoneMySettings(token), ssPhoneTeam(token)]);
        if (live) setSt({ settings: settings || {}, team, me: s && s.user ? s.user.id : null });
      } catch (e) {
        if (!live) return;
        // A Worker from before 264 has no GET /settings/me: show nothing rather than a fault. It
        // answers 405, not 404 — POST /settings/me is already routed there, and a path that
        // matched with the wrong method is "That method isn't allowed here." 404 stays for a
        // Worker without the path at all.
        if (e && (e.status === 404 || e.status === 405)) setSt({ unavailable: true });
        else setErr(e.message);
      }
    })();
    return () => { live = false; };
  }, []);

  if (st && st.unavailable) return null;
  if (!st && !err) return <div style={PHONE_CARD}><SkelRows cols={1} rows={2} /></div>;

  const coverId = (st && st.settings && st.settings.dnd_cover_user_id) || "";
  const cover = phoneCoverState(coverId, st ? st.team : null);
  const pick = async (value) => {
    setBusy(true); setNote(null);
    try {
      const s = await session();
      const saved = await ssPhoneSaveMySettings({ dnd_cover_user_id: value || null }, s ? s.access_token : null);
      setSt((x) => ({ ...x, settings: saved || x.settings }));
      setNote({ ok: phoneCoverSavedText(phoneCoverState(saved ? saved.dnd_cover_user_id : value, st.team)) });
    } catch (e) { setNote({ err: e.message }); }
    finally { setBusy(false); }
  };

  // When my phone rings: offered only by a Worker that keeps hours (it sends ring_hours).
  const hoursOk = !!(st && st.settings && phoneRingHoursSupported(st.settings));
  const savedHours = hoursOk ? phoneRingHoursForm(st.settings, phoneDeviceZone(), PHONE_DEFAULT_HOURS) : null;
  const hours = hoursEdit || savedHours;
  const editHours = (patch) => { setHoursNote(null); setHoursEdit((f) => ({ ...(f || savedHours), ...patch })); };
  const setMyDay = (day, periods) => {
    setHoursNote(null);
    setHoursEdit((f) => { const base = f || savedHours; return { ...base, hours: phoneHoursWithDay(base.hours, day, periods) }; });
  };
  const saveHours = async () => {
    const problem = phoneRingHoursProblem(hours);
    if (problem) { setHoursNote({ err: problem }); return; }
    setHoursBusy(true); setHoursNote(null);
    try {
      const s = await session();
      const saved = await ssPhoneSaveMySettings(phoneRingHoursPatch(hours), s ? s.access_token : null);
      setSt((x) => ({ ...x, settings: saved || x.settings }));
      setHoursEdit(null);
      setHoursNote({ ok: phoneRingHoursSavedText(saved ? phoneRingHoursForm(saved, phoneDeviceZone(), PHONE_DEFAULT_HOURS) : hours, PHONE_TIME_ZONES) });
    } catch (e) { setHoursNote({ err: e.message }); }
    finally { setHoursBusy(false); }
  };
  const hoursRadio = (value, label) => (
    <label key={value} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 13, color: "#1E293B", cursor: "pointer" }}>
      <input type="radio" name="ss-phone-my-hours" checked={(hours.on ? "set" : "always") === value} disabled={hoursBusy}
        onChange={() => editHours({ on: value === "set" })} />
      {label}
    </label>
  );

  return (
    <div style={PHONE_CARD} data-ss-phone-yours>
      <h4 style={{ margin: "0 0 4px", fontSize: 14 }}>Your calls</h4>
      <p style={{ margin: "0 0 10px", fontSize: 12.5, color: "#64748B", lineHeight: 1.5 }}>
        Just for you: everyone on the team picks their own, here or in My Synergy Phone&rsquo;s Settings.
      </p>
      {err ? <div style={{ ...S.err, marginBottom: 0 }}>{err}</div> : (
        <>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#1E293B", flexWrap: "wrap" }}>
            While I&rsquo;m on Do Not Disturb, ring
            <select value={coverId} disabled={busy} data-ss-phone-cover onChange={(e) => pick(e.target.value)}
              style={{ ...S.input, width: "auto", padding: "5px 8px" }}>
              {phoneCoverOptions(coverId, st.team, st.me).map((o) => <option key={o.value || "none"} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          <div style={{ fontSize: 12, color: "#64748B", marginTop: 6, lineHeight: 1.5 }}>
            {phoneAwayText(cover)} A teammate you pick rings even if they aren&rsquo;t on the answer list, unless they&rsquo;re on a call,
            on Do Not Disturb too{hoursOk ? <>, or outside their own hours</> : null}.
          </div>
          {st.settings.dnd && (
            <div data-ss-phone-dnd-now style={{ fontSize: 12.5, color: "#B45309", fontWeight: 700, marginTop: 8 }}>
              You&rsquo;re on Do Not Disturb right now. Turn it off in My Synergy Phone.
            </div>
          )}
          {note && note.ok && <div style={{ fontSize: 12.5, color: "#047857", fontWeight: 700, marginTop: 8 }}>{note.ok}</div>}
          {note && note.err && <div style={{ fontSize: 12.5, color: "#B91C1C", fontWeight: 700, marginTop: 8 }}>{note.err}</div>}

          {hoursOk && (
            <div data-ss-phone-my-hours style={{ borderTop: "1px solid #F1F5F9", marginTop: 14, paddingTop: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#334155", marginBottom: 6 }}>When my phone rings</div>
              <div style={{ display: "grid", gap: 6, marginBottom: 10 }}>
                {hoursRadio("always", "Always, whenever the business is open")}
                {hoursRadio("set", "Only during my hours")}
              </div>
              {hours.on && (
                <PhoneHoursEditor hours={hours.hours} timeZone={hours.timeZone} ro={hoursBusy}
                  onDay={setMyDay} onTimeZone={(tz) => editHours({ timeZone: tz })}
                  dayAttr="data-ss-phone-my-day" offWord="Off" addWord="+ add hours" zoneWord="My time zone" />
              )}
              <div style={{ fontSize: 12, color: "#64748B", lineHeight: 1.5 }}>
                {hours.on
                  ? <>{phoneOffHoursText(cover)} Your hours never go past the business&rsquo;s: when the business is closed, nobody&rsquo;s phone rings.</>
                  : <>Your phone rings whenever the business is open, unless you&rsquo;re on Do Not Disturb.</>}
              </div>
              {hoursEdit && (
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
                  <button type="button" disabled={hoursBusy} onClick={saveHours} data-ss-phone-my-hours-save
                    style={{ ...S.btn(ACCENT, "#FFF"), opacity: hoursBusy ? 0.6 : 1 }}>
                    {hoursBusy ? "Saving…" : "Save my hours"}
                  </button>
                  <button type="button" disabled={hoursBusy} onClick={() => { setHoursEdit(null); setHoursNote(null); }}
                    style={{ ...S.btn("#F1F5F9", "#334155") }}>
                    Cancel
                  </button>
                </div>
              )}
              {hoursNote && hoursNote.ok && <div style={{ fontSize: 12.5, color: "#047857", fontWeight: 700, marginTop: 8 }}>{hoursNote.ok}</div>}
              {hoursNote && hoursNote.err && <div style={{ fontSize: 12.5, color: "#B91C1C", fontWeight: 700, marginTop: 8 }}>{hoursNote.err}</div>}
            </div>
          )}

          {/* Your voicemail greeting: offered only by a Worker that keeps one (it sends `greeting`). */}
          {phoneGreetingSupported(st.settings) && (
            <PhoneGreetingSection greeting={st.settings.greeting}
              onSettings={(saved) => setSt((x) => ({ ...x, settings: saved || x.settings }))} />
          )}
        </>
      )}
    </div>
  );
}

// ── The Calls page ──────────────────────────────────────────────────────────────────────
// Per person: calls in and out, answered, missed (against everyone the call rang), average
// length, voicemails, texts sent and received. MY calls by default — Carolyn's own complaint
// about GHL was that you "can't see just your calls" — and Team for literal view/edit.
function CallsReport({ clientId, viewingLabel = null, canTeam = false, phoneOn = false }) {
  // An operator viewing a builder has no calls of their own there, so Team is where they start.
  const [scope, setScope] = useState(viewingLabel && canTeam ? "team" : "mine");
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setErr(null);
    phoneAction("phone_calls_report", { scope, days })
      .then((d) => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch((e) => { if (!cancelled) { setErr(e.message); setLoading(false); } });
    return () => { cancelled = true; };
  }, [scope, days, clientId]);

  const cols = [
    ["callsIn", "Calls in"], ["callsOut", "Calls out"], ["answered", "Answered"], ["missed", "Missed"],
    ["avgSeconds", "Avg length"], ["voicemails", "Voicemails"], ["textsSent", "Texts sent"], ["textsReceived", "Texts received"],
  ];
  const cell = (l, k) => (k === "avgSeconds" ? phoneClock(l[k]) : String(l[k] || 0));
  const toggleBtn = (value, label, disabled, title) => (
    <button type="button" disabled={disabled} title={title || ""} onClick={() => setScope(value)} data-ss-calls-scope={value}
      style={{
        border: "none", borderRadius: 999, padding: "6px 14px", fontSize: 12.5, fontWeight: 800, cursor: disabled ? "not-allowed" : "pointer",
        background: scope === value ? ACCENT : "#F1F5F9", color: scope === value ? "#FFF" : disabled ? "#CBD5E1" : "#475569",
      }}>{label}</button>
  );
  const lines = (data && data.lines) || [];
  const empty = !loading && data && data.available !== false && lines.every((l) => !(l.callsIn || l.callsOut || l.textsSent || l.textsReceived));

  return (
    <div data-ss-calls-report>
      <div style={{ ...PHONE_CARD, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ display: "inline-flex", gap: 4, background: "#F8FAFC", borderRadius: 999, padding: 3 }}>
          {toggleBtn("mine", "My calls", false)}
          {toggleBtn("team", "Team", !canTeam, canTeam ? "" : "Your phone access covers your own calls.")}
        </div>
        <select value={String(days)} onChange={(e) => setDays(Number(e.target.value))}
          style={{ ...S.input, width: "auto", padding: "6px 9px" }}>
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
        </select>
        {viewingLabel && <span style={{ fontSize: 12, color: "#64748B" }}>{viewingLabel}</span>}
        {!phoneOn && (
          <span style={{ fontSize: 12, color: "#64748B", marginLeft: "auto" }}>
            Calling is switched off for this account, so only past calls show here.
          </span>
        )}
      </div>

      <div style={PHONE_CARD}>
        {err ? <div style={{ ...S.err, marginBottom: 0 }}>{err}</div>
          : loading && !data ? <SkelRows cols={9} rows={4} />
          : data && data.available === false ? (
            <div style={{ fontSize: 13, color: "#475569" }}>Calls show here once My Synergy Phone is set up on this account.</div>
          ) : (
            <>
              <div style={{ overflowX: "auto", opacity: loading ? 0.55 : 1 }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      <th style={S.th}>Person</th>
                      {cols.map(([k, l]) => <th key={k} style={{ ...S.th, textAlign: "right" }}>{l}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l) => (
                      <tr key={l.userId || l.name} data-ss-calls-line={l.userId || ""}>
                        <td style={{ ...S.td, fontWeight: 700 }}>{l.name}</td>
                        {cols.map(([k]) => <td key={k} style={{ ...S.td, textAlign: "right", color: k === "missed" && l.missed ? "#B91C1C" : "#1E293B" }}>{cell(l, k)}</td>)}
                      </tr>
                    ))}
                    {data && data.scope === "team" && data.totals && (
                      <tr data-ss-calls-line="totals">
                        <td style={{ ...S.td, fontWeight: 800, borderTop: "2px solid #E2E8F0" }}>Whole business</td>
                        {cols.map(([k]) => <td key={k} style={{ ...S.td, textAlign: "right", fontWeight: 800, borderTop: "2px solid #E2E8F0" }}>{cell(data.totals, k)}</td>)}
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              {empty && <div style={{ fontSize: 12.5, color: "#94A3B8", marginTop: 10 }}>No calls or texts in the last {days} days.</div>}
              <div style={{ fontSize: 11.5, color: "#64748B", marginTop: 10, lineHeight: 1.5 }}>
                A missed call counts against everyone it rang. Texts received count for the person the customer is assigned to;
                texts from customers assigned to nobody count only in the whole-business line.
                {data && data.narrowed ? " Only customers assigned to you or that you follow are counted." : ""}
                {data && data.truncated ? " This period has more activity than one report reads, so the numbers are partial — pick a shorter period." : ""}
              </div>
            </>
          )}
      </div>

      <div style={PHONE_CARD}>
        <h4 style={{ margin: "0 0 10px", fontSize: 14 }}>Get My Synergy Phone</h4>
        <SsPhoneInstallCard what="call" />
      </div>
    </div>
  );
}
