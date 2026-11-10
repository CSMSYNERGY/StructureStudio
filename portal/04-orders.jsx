// ─── QR: the sign-link, on the customer's own phone ───
//
// Carolyn 2026-09-01: "when we are sitting with a customer we want to be able to send them
// a text message and they click on the link, for them to sign on their phone." SMS is not
// available yet (no tenant has an active A2P campaign), so the same link is offered as a
// QR the customer scans off the rep's screen — which for the sitting-across-the-table case
// needs no carrier, no number and no A2P at all.
//
// WHY THIS IS HAND-ROLLED RATHER THAN A LIBRARY. preflight enforces that index.html,
// portal.html and admin.html reference the SAME three /vendor/ files, so a fourth browser
// dependency cannot be added without breaking that lock, and a CDN script is the exact
// blank-page failure mode vendor/README.md exists to document. So it is app code.
//
// IT IS NOT TRUSTED BLIND. It was verified bit-for-bit against the `qrcode` npm package
// (11/11 cases: both real link shapes, a long tenant slug, UTF-8, and lengths spanning
// versions 1-9). Two bugs were found and fixed that way, and the second is the one worth
// knowing: the format word is written MSB-FIRST along row 8 — (8,0) carries bit 14, not
// bit 0 — which is an 8-module error that still LOOKS like a QR code and still fails to
// scan. Re-verify the same way before changing anything below.
//
// Byte mode only, EC level M, versions 1-10 (up to 213 bytes; a sign link is ~90). The
// reference optimises numeric/alphanumeric segments and we deliberately do not: byte mode
// is always valid, occasionally one version larger, and a great deal simpler to keep right.
// Returns boolean[][] (true = dark), or null when the text does not fit.
function ssQrMatrix(text) {
  var CAP = [0, 14, 26, 42, 62, 84, 106, 122, 152, 180, 213];
  var EC = {
    1: [10, [[1, 16]]], 2: [16, [[1, 28]]], 3: [26, [[1, 44]]], 4: [18, [[2, 32]]],
    5: [24, [[2, 43]]], 6: [16, [[4, 27]]], 7: [18, [[4, 31]]],
    8: [22, [[2, 38], [2, 39]]], 9: [22, [[3, 36], [2, 37]]], 10: [26, [[4, 43], [1, 44]]],
  };
  var ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
    7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  };
  var i, j, k, q, r, c;

  var data = [];
  for (i = 0; i < text.length; i++) {
    var cp = text.charCodeAt(i);
    if (cp < 128) data.push(cp);
    else {
      var u = unescape(encodeURIComponent(text.charAt(i)));
      for (j = 0; j < u.length; j++) data.push(u.charCodeAt(j));
    }
  }
  var ver = 0;
  for (i = 1; i <= 10; i++) if (data.length <= CAP[i]) { ver = i; break; }
  if (!ver) return null;

  var EXP = new Array(512), LOG = new Array(256), xv = 1;
  for (i = 0; i < 255; i++) { EXP[i] = xv; LOG[xv] = i; xv <<= 1; if (xv & 256) xv ^= 0x11D; }
  for (i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  function mul(a, b) { return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]; }
  function gen(n) {
    var p = [1];
    for (var g = 0; g < n; g++) {
      var np = [];
      for (k = 0; k <= p.length; k++) np.push(0);
      for (k = 0; k < p.length; k++) { np[k] ^= p[k]; np[k + 1] ^= mul(p[k], EXP[g]); }
      p = np;
    }
    return p;
  }
  function ecOf(block, n) {
    var g = gen(n), res = block.slice();
    for (k = 0; k < n; k++) res.push(0);
    for (k = 0; k < block.length; k++) {
      var f = res[k];
      if (!f) continue;
      for (var w = 0; w < g.length; w++) res[k + w] ^= mul(g[w], f);
    }
    return res.slice(block.length);
  }

  var info = EC[ver], ecLen = info[0], groups = info[1], totalData = 0;
  for (i = 0; i < groups.length; i++) totalData += groups[i][0] * groups[i][1];

  var bits = [];
  function put(v, n) { for (var w = n - 1; w >= 0; w--) bits.push((v >> w) & 1); }
  put(4, 4);
  put(data.length, ver < 10 ? 8 : 16);
  for (i = 0; i < data.length; i++) put(data[i], 8);
  for (i = 0; i < 4 && bits.length < totalData * 8; i++) bits.push(0);
  while (bits.length % 8) bits.push(0);
  var cw = [];
  for (i = 0; i < bits.length; i += 8) {
    var b = 0;
    for (j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    cw.push(b);
  }
  var padv = [0xEC, 0x11], pi = 0;
  while (cw.length < totalData) cw.push(padv[pi++ % 2]);

  var blocks = [], eccs = [], off = 0;
  for (i = 0; i < groups.length; i++) {
    for (j = 0; j < groups[i][0]; j++) {
      var blk = cw.slice(off, off + groups[i][1]);
      off += groups[i][1];
      blocks.push(blk);
      eccs.push(ecOf(blk, ecLen));
    }
  }
  var maxD = 0;
  for (i = 0; i < blocks.length; i++) if (blocks[i].length > maxD) maxD = blocks[i].length;
  var out = [];
  for (i = 0; i < maxD; i++) for (j = 0; j < blocks.length; j++) if (i < blocks[j].length) out.push(blocks[j][i]);
  for (i = 0; i < ecLen; i++) for (j = 0; j < eccs.length; j++) out.push(eccs[j][i]);

  var size = 17 + ver * 4;
  var m = [], rz = [];
  for (i = 0; i < size; i++) {
    var ra = [], rb = [];
    for (j = 0; j < size; j++) { ra.push(0); rb.push(0); }
    m.push(ra); rz.push(rb);
  }
  function setF(rr, cc, v) {
    if (rr < 0 || cc < 0 || rr >= size || cc >= size) return;
    m[rr][cc] = v; rz[rr][cc] = 1;
  }
  function finder(r0, c0) {
    for (var dr = -1; dr <= 7; dr++) for (var dc = -1; dc <= 7; dc++) {
      var on = (dr >= 0 && dr <= 6 && (dc === 0 || dc === 6)) ||
        (dc >= 0 && dc <= 6 && (dr === 0 || dr === 6)) ||
        (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4);
      setF(r0 + dr, c0 + dc, on ? 1 : 0);
    }
  }
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
  for (i = 8; i < size - 8; i++) {
    setF(6, i, i % 2 === 0 ? 1 : 0);
    setF(i, 6, i % 2 === 0 ? 1 : 0);
  }
  var ap = ALIGN[ver];
  for (i = 0; i < ap.length; i++) for (j = 0; j < ap.length; j++) {
    r = ap[i]; c = ap[j];
    if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue;
    for (var dr2 = -2; dr2 <= 2; dr2++) for (var dc2 = -2; dc2 <= 2; dc2++) {
      setF(r + dr2, c + dc2, (Math.abs(dr2) === 2 || Math.abs(dc2) === 2 || (dr2 === 0 && dc2 === 0)) ? 1 : 0);
    }
  }
  for (i = 0; i <= 8; i++) { if (i !== 6) { rz[8][i] = 1; rz[i][8] = 1; } }
  for (i = 0; i < 8; i++) { rz[8][size - 1 - i] = 1; rz[size - 1 - i][8] = 1; }
  setF(size - 8, 8, 1);
  if (ver >= 7) {
    for (i = 0; i < 6; i++) for (j = 0; j < 3; j++) {
      rz[i][size - 11 + j] = 1;
      rz[size - 11 + j][i] = 1;
    }
  }

  var bi = 0, up = true;
  for (var col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (var n = 0; n < size; n++) {
      var row = up ? size - 1 - n : n;
      for (k = 0; k < 2; k++) {
        var cc2 = col - k;
        if (rz[row][cc2]) continue;
        var bit = 0;
        if ((bi >> 3) < out.length) bit = (out[bi >> 3] >> (7 - (bi & 7))) & 1;
        bi++;
        m[row][cc2] = bit;
      }
    }
    up = !up;
  }

  function maskAt(kk, rr, cc) {
    switch (kk) {
      case 0: return (rr + cc) % 2 === 0;
      case 1: return rr % 2 === 0;
      case 2: return cc % 3 === 0;
      case 3: return (rr + cc) % 3 === 0;
      case 4: return (Math.floor(rr / 2) + Math.floor(cc / 3)) % 2 === 0;
      case 5: return ((rr * cc) % 2) + ((rr * cc) % 3) === 0;
      case 6: return (((rr * cc) % 2) + ((rr * cc) % 3)) % 2 === 0;
      default: return (((rr + cc) % 2) + ((rr * cc) % 3)) % 2 === 0;
    }
  }
  function stampFormat(g, mask) {
    var d = (0 << 3) | mask, rem = d << 10;
    for (q = 14; q >= 10; q--) if (rem & (1 << q)) rem ^= 0x537 << (q - 10);
    var fmt = (((d << 10) | rem) ^ 0x5412) & 0x7FFF;
    function fb(w) { return (fmt >> w) & 1; }
    // The format word is written MSB-FIRST along row 8: (8,0) carries bit 14, not bit 0.
    for (q = 0; q <= 5; q++) g[8][q] = fb(14 - q);
    g[8][7] = fb(8); g[8][8] = fb(7); g[7][8] = fb(6);
    for (q = 9; q <= 14; q++) g[14 - q][8] = fb(14 - q);
    for (q = 0; q <= 6; q++) g[size - 1 - q][8] = fb(14 - q);
    for (q = 7; q <= 14; q++) g[8][size - 15 + q] = fb(14 - q);
    g[size - 8][8] = 1;
    if (ver >= 7) {
      var vrem = ver << 12;
      for (q = 17; q >= 12; q--) if (vrem & (1 << q)) vrem ^= 0x1F25 << (q - 12);
      var vi = ((ver << 12) | vrem) & 0x3FFFF;
      for (q = 0; q < 18; q++) {
        var vb = (vi >> q) & 1;
        g[Math.floor(q / 3)][size - 11 + (q % 3)] = vb;
        g[size - 11 + (q % 3)][Math.floor(q / 3)] = vb;
      }
    }
  }
  function penalty(g) {
    var p = 0, run, prev, a, b2;
    for (a = 0; a < size; a++) {
      run = 1; prev = g[a][0];
      for (b2 = 1; b2 < size; b2++) {
        if (g[a][b2] === prev) run++;
        else { if (run >= 5) p += 3 + (run - 5); run = 1; prev = g[a][b2]; }
      }
      if (run >= 5) p += 3 + (run - 5);
    }
    for (b2 = 0; b2 < size; b2++) {
      run = 1; prev = g[0][b2];
      for (a = 1; a < size; a++) {
        if (g[a][b2] === prev) run++;
        else { if (run >= 5) p += 3 + (run - 5); run = 1; prev = g[a][b2]; }
      }
      if (run >= 5) p += 3 + (run - 5);
    }
    for (a = 0; a < size - 1; a++) for (b2 = 0; b2 < size - 1; b2++) {
      var s = g[a][b2] + g[a][b2 + 1] + g[a + 1][b2] + g[a + 1][b2 + 1];
      if (s === 0 || s === 4) p += 3;
    }
    var P1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], P2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    function scan(arr) {
      var hits = 0;
      for (var w = 0; w + 11 <= arr.length; w++) {
        var ok1 = true, ok2 = true;
        for (var z = 0; z < 11; z++) {
          if (arr[w + z] !== P1[z]) ok1 = false;
          if (arr[w + z] !== P2[z]) ok2 = false;
        }
        if (ok1 || ok2) hits++;
      }
      return hits;
    }
    for (a = 0; a < size; a++) p += 40 * scan(g[a]);
    for (b2 = 0; b2 < size; b2++) {
      var colA = [];
      for (a = 0; a < size; a++) colA.push(g[a][b2]);
      p += 40 * scan(colA);
    }
    var dark = 0;
    for (a = 0; a < size; a++) for (b2 = 0; b2 < size; b2++) dark += g[a][b2];
    p += 10 * Math.floor(Math.abs(dark * 100 / (size * size) - 50) / 5);
    return p;
  }

  var best = null, bestP = Infinity;
  for (var mk = 0; mk < 8; mk++) {
    var g4 = [];
    for (i = 0; i < size; i++) g4.push(m[i].slice());
    for (i = 0; i < size; i++) for (j = 0; j < size; j++) if (!rz[i][j] && maskAt(mk, i, j)) g4[i][j] ^= 1;
    stampFormat(g4, mk);
    var sc = penalty(g4);
    if (sc < bestP) { bestP = sc; best = g4; }
  }
  var res = [];
  for (i = 0; i < size; i++) {
    var rowo = [];
    for (j = 0; j < size; j++) rowo.push(!!best[i][j]);
    res.push(rowo);
  }
  return res;
}

// ─── Feedback: bug reports + feature requests ───
// Submissions are filed into Monday (Bugs Queue / Feature Requests (Intake)) by the
// `portal-feedback` edge function, which ALSO records them in `feedback_submissions`
// so the submitter can see the thing they sent instead of it vanishing into Monday.
// Status and team replies come back via the `feedback-monday-webhook` function.
//
// This lives in the PORTAL only — never on the public designer. A submission is
// attributed to the signed-in user and their tenant, both resolved server-side from
// the JWT, which is what makes "who filed this, from which client portal" reliable.

// The client-facing status ladder (see migration 054). Monday's internal labels are
// mapped down to these by the sync function — never rendered raw.
const FB_STATUS = {
  submitted:   { label: "Submitted",       bg: "#F1F5F9", fg: "#475569" },
  in_review:   { label: "In review",       bg: "#FEF3C7", fg: "#B45309" },
  planned:     { label: "Planned",         bg: "#EEF2FF", fg: "#4F46E5" },
  in_progress: { label: "In progress",     bg: "#DBEAFE", fg: "#1D4ED8" },
  needs_info:  { label: "Needs your info", bg: "#FEE2E2", fg: "#B91C1C" },
  // The KEY is the stored value (migration 054's check constraint + both sync
  // functions) and must stay "shipped"; only this label is client-facing. Renamed to
  // "Completed" on 2026-07-27 to match what the team now calls it on the Monday board.
  shipped:     { label: "Completed",       bg: "#DCFCE7", fg: "#15803D" },
  declined:    { label: "Not planned",     bg: "#F1F5F9", fg: "#64748B" },
  duplicate:   { label: "Already tracked", bg: "#F3E8FF", fg: "#7E22CE" },
};
// Sort order for the Status column. Deliberately NOT alphabetical — sorting
// "Already tracked / In progress / In review / Not planned / Planned" by name is
// noise. Ascending walks the pipeline, with "Needs your info" pulled to the very top
// because it's the one state that's waiting on the CLIENT rather than on us.
const FB_STATUS_ORDER = ["needs_info", "submitted", "in_review", "planned", "in_progress", "shipped", "declined", "duplicate"];
const FB_STATUS_RANK = FB_STATUS_ORDER.reduce((m, k, i) => { m[k] = i; return m; }, {});

const fbBadge = (status) => {
  const m = FB_STATUS[status] || FB_STATUS.submitted;
  return <span style={{ background: m.bg, color: m.fg, fontSize: 10, fontWeight: 800, borderRadius: 999, padding: "3px 9px", textTransform: "uppercase", letterSpacing: 0.4, whiteSpace: "nowrap" }}>{m.label}</span>;
};

// Severity choices must match the Monday status labels exactly — portal-feedback
// drops any value the board doesn't know rather than erroring the whole push.
const FB_KINDS = {
  bug: {
    icon: "🐛", label: "Report an Issue", blurb: "Something broken or not working as expected",
    titleHint: "What went wrong?", detailHint: "What did you do, what did you expect, and what happened instead?",
    sevLabel: "How badly is this hurting you?",
    severities: ["Critical", "High", "Medium", "Low"], sevDefault: "Medium",
  },
  feature: {
    icon: "✨", label: "Request a Feature", blurb: "An idea or improvement you'd like to see",
    titleHint: "What would you like to be able to do?", detailHint: "Describe the feature and what it would let you get done.",
    sevLabel: "How important is this to you?",
    severities: ["Nice to have", "Would really help", "Critical for me"], sevDefault: "Would really help",
  },
  // A question, a request, anything a person should pick up (migration 340, 2026-10-27). Lands on
  // the Projects board and never goes to Monday; portal-feedback refuses nothing else about it.
  ticket: {
    icon: "🎫", label: "Submit a Ticket", blurb: "A question, or anything you need a person for",
    titleHint: "What do you need help with?", detailHint: "Tell us what you were doing and what you need.",
    sevLabel: null, severities: null, sevDefault: null,
  },
};

// Ahsan 10-27, from Carolyn's 10-26 call ("like 24 hour turnaround time"). The support assistant
// says the same words (support-agent's REPLY_PROMISE); change both together.
const SS_REPLY_PROMISE = "A person on our team replies within 24 hours.";

const MAX_ATTACH_BYTES = 25 * 1024 * 1024;   // matches the bucket's file_size_limit

// `prefill` and `supportConversationId` come from the support assistant's "Send this to our team"
// card: the ticket opens already written, and the server attaches the chat to it (portal-feedback
// checks the chat is this person's own).
function FeedbackForm({ kind, clientId, onSubmitted, onBack, prefill = null, supportConversationId = null }) {
  const cfg = FB_KINDS[kind];
  const [title, setTitle] = useState((prefill && prefill.title) || "");
  const [detail, setDetail] = useState((prefill && prefill.summary) || "");
  const [severity, setSeverity] = useState(cfg.sevDefault);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  // The screenshot is usually sitting in the clipboard (Win+Shift+S / Cmd+Shift+4), so
  // pasting anywhere on the form attaches it — the picker below is the fallback. ONE
  // file by design: the whole pipeline (feedback_submissions.attachment_path, the
  // Projects mirror, the old Monday leg) carries a single attachment, and a paste
  // replaces the staged one rather than growing a list the server would ignore.
  const onPaste = (e) => {
    const img = [...(e.clipboardData?.files || [])].find((f) => f && f.size);
    if (img) { e.preventDefault(); setFile(img); }
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!title.trim()) { setErr("Please give this a short title."); return; }
    if (file && file.size > MAX_ATTACH_BYTES) { setErr("That file is larger than 25 MB — please attach a smaller one."); return; }
    setBusy(true); setErr(null);
    try {
      // Upload first: the storage policy pins the object under this tenant's own
      // prefix, and the edge function re-checks the prefix before trusting the path.
      let attachmentPath = null;
      if (file) {
        const safe = file.name.replace(/[^\w.\-]+/g, "_").slice(-80);
        const path = clientId + "/" + crypto.randomUUID() + "-" + safe;
        const up = await sb.storage.from("feedback-attachments").upload(path, file, { contentType: file.type || undefined });
        if (up.error) throw new Error("Attachment upload failed: " + up.error.message);
        attachmentPath = path;
      }
      const { data, error } = await sb.functions.invoke("portal-feedback", {
        body: {
          action: "submit", kind, title: title.trim(), detail: detail.trim(), attachmentPath,
          ...(cfg.severities ? { severity } : {}),
          ...(supportConversationId ? { supportConversationId } : {}),
        },
      });
      if (error) throw error;
      if (data && data.error) throw new Error(data.error);
      onSubmitted(data && data.submission, data && data.pushed);
    } catch (e2) {
      setErr(e2.message || "Something went wrong — please try again.");
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} onPaste={onPaste} style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
      {err && <div style={S.err}>{err}</div>}
      <div>
        <label style={S.lbl}>{cfg.titleHint}</label>
        <input style={S.input} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={250} autoFocus placeholder="A one-line summary" />
      </div>
      <div>
        <label style={S.lbl}>Details</label>
        <textarea style={{ ...S.input, minHeight: 110, fontWeight: 500, resize: "vertical" }}
          value={detail} onChange={(e) => setDetail(e.target.value)} placeholder={cfg.detailHint} />
      </div>
      {cfg.severities && (
        <div>
          <label style={S.lbl}>{cfg.sevLabel}</label>
          <select style={S.input} value={severity} onChange={(e) => setSeverity(e.target.value)}>
            {cfg.severities.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      )}
      {kind === "ticket" && (
        <div style={{ fontSize: 12, color: "#64748B", lineHeight: 1.5 }}>
          {SS_REPLY_PROMISE}{supportConversationId ? " Your chat with the assistant is attached, so you don't need to repeat it." : ""}
        </div>
      )}
      <div>
        <label style={S.lbl}>Screenshot or video (optional)</label>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {file ? (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 700, color: "#334155", background: "#F1F5F9", border: "1px solid #E2E8F0", borderRadius: 999, padding: "5px 11px", maxWidth: 240 }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>🖼 {file.name}</span>
              <button type="button" aria-label={"Remove " + file.name} onClick={() => setFile(null)}
                style={{ background: "none", border: "none", color: "#94A3B8", cursor: "pointer", padding: 0, fontSize: 13, lineHeight: 1 }}>✕</button>
            </span>
          ) : (
            <label style={{ fontSize: 12.5, fontWeight: 700, color: "#1B7895", cursor: "pointer" }}>
              📎 Attach a screenshot
              <input type="file" accept="image/png,image/jpeg,image/gif,image/webp,video/mp4,video/quicktime,video/webm"
                style={{ display: "none" }}
                onChange={(e) => { setFile(e.target.files && e.target.files[0] ? e.target.files[0] : null); e.target.value = ""; }} />
            </label>
          )}
          <span style={{ fontSize: 11.5, color: "#94A3B8" }}>{file ? "Pasting or picking again replaces it." : "or just paste one here"}</span>
        </div>
        <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 4 }}>A picture of the problem helps us fix it much faster. Max 25 MB.</div>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
        <button type="button" onClick={onBack} disabled={busy} style={{ ...S.btn("#FFF", "#475569"), border: "1px solid #CBD5E1" }}>Back</button>
        <button type="submit" disabled={busy} style={{ ...S.btn(ACCENT, "#FFF"), flex: 1, opacity: busy ? 0.6 : 1, cursor: busy ? "default" : "pointer" }}>
          {busy ? "Sending…" : "Send it"}
        </button>
      </div>
    </form>
  );
}

// ── Support button, or the old Feedback pill? (migration 346, 2026-10-27) ─────────────────────
// The Support button SHIPS DARK: client_settings.support_ai_beta, per builder, off by default, turned
// on by an operator in SQL. support-agent's `enabled` answers it (and fails closed), so until it
// says yes the shell draws FeedbackWidget below, the pill every builder had before, unchanged.
// The answer is remembered per builder, so a switched-on builder sees the Support button from the
// first paint instead of the pill and then a swap. Asked once per page load, behind the boot waves
// (1.5 s / 3 s), and not at all while an operator views another account (both are hidden then).
const SS_SUPPORT_ON_KEY = "ss:supportOn:";

function useSupportOn(clientId, active) {
  const [answer, setAnswer] = useState(null);   // { clientId, on } once support-agent answers
  useEffect(() => {
    if (!active || !clientId) return undefined;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const { data } = await sb.functions.invoke("support-agent", { body: { action: "enabled" } });
        // An error, a 403 or an old server that knows no `enabled` leaves what we had.
        if (cancelled || !data || typeof data.on !== "boolean") return;
        setAnswer({ clientId, on: data.on });
        try { localStorage.setItem(SS_SUPPORT_ON_KEY + clientId, data.on ? "1" : "0"); } catch (_e) {}
      } catch (_e) { /* the pill stays: it is the safe default */ }
    }, 3500);
    return () => { cancelled = true; clearTimeout(t); };
  }, [clientId, active]);
  if (!clientId) return false;
  if (answer && answer.clientId === clientId) return answer.on;
  try { return localStorage.getItem(SS_SUPPORT_ON_KEY + clientId) === "1"; } catch (_e) { return false; }
}

// KEPT (346): the pill for every builder whose Support switch is off (useSupportOn above). Below
// this note it is beta's FeedbackWidget as it was, so their bug and feature reports are unchanged.
// Floating launcher + modal. Mounted once by PortalApp; hidden while an operator is
// viewing someone else's account (the submission would be attributed to the operator's
// own tenant, not the one on screen, which would be misleading in both places).
function FeedbackWidget({ clientId, onSubmitted }) {
  const [view, setView] = useState(null);   // null | "menu" | "bug" | "feature" | "done"
  const [pushed, setPushed] = useState(true);

  useEffect(() => {
    if (!view) return;
    const onKey = (e) => { if (e.key === "Escape") setView(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view]);

  if (!view) {
    return (
      <button onClick={() => setView("menu")} aria-label="Send feedback"
        style={{
          position: "fixed", right: 20, bottom: 20, zIndex: 900,
          background: ACCENT, color: "#FFF", border: "none", borderRadius: 999,
          padding: "10px 16px", fontSize: 13.5, fontWeight: 700, cursor: "pointer",
          boxShadow: "0 4px 14px rgba(0,0,0,0.25)", fontFamily: "inherit",
        }}>
        💬 Feedback
      </button>
    );
  }

  const cfg = FB_KINDS[view] || null;
  const heading = view === "done" ? "✅ Thanks — we've got it"
    : cfg ? cfg.icon + " " + cfg.label : "💬 Send us feedback";

  return (
    <div onClick={() => setView(null)} role="dialog" aria-modal="true" aria-label="Send feedback"
      style={{ position: "fixed", inset: 0, zIndex: 999, background: "rgba(15,23,42,0.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ background: "#FFF", borderRadius: 12, overflow: "hidden", width: cfg ? "min(560px, 100%)" : "min(420px, 100%)", maxHeight: "calc(100vh - 32px)", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.35)" }}>
        <div style={{ background: ACCENT, color: "#FFF", padding: "12px 16px", display: "flex", alignItems: "center", gap: 8 }}>
          {cfg && <button onClick={() => setView("menu")} aria-label="Back" style={{ background: "none", border: "none", color: "#FFF", cursor: "pointer", fontSize: 16, padding: 0, lineHeight: 1 }}>←</button>}
          <div style={{ fontSize: 14, fontWeight: 700, flex: 1 }}>{heading}</div>
          <button onClick={() => setView(null)} aria-label="Close" style={{ background: "none", border: "none", color: "#FFF", cursor: "pointer", fontSize: 18, padding: 0, lineHeight: 1 }}>×</button>
        </div>

        {view === "menu" && (
          <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
            {["bug", "feature"].map((k) => (
              <button key={k} onClick={() => setView(k)}
                style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 10, cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}>
                <span style={{ fontSize: 22 }}>{FB_KINDS[k].icon}</span>
                <span>
                  <span style={{ display: "block", fontSize: 14, fontWeight: 700, color: "#0F172A" }}>{FB_KINDS[k].label}</span>
                  <span style={{ display: "block", fontSize: 12, color: "#64748B", marginTop: 2 }}>{FB_KINDS[k].blurb}</span>
                </span>
              </button>
            ))}
            <div style={{ fontSize: 12, color: "#94A3B8", lineHeight: 1.5, marginTop: 2 }}>
              Everything you send shows up under <b>Support → My Requests</b>, so you can track where it got to.
            </div>
          </div>
        )}

        {cfg && (
          <FeedbackForm kind={view} clientId={clientId} onBack={() => setView("menu")}
            onSubmitted={(row, wasPushed) => { setPushed(wasPushed !== false); setView("done"); if (onSubmitted) onSubmitted(row); }} />
        )}

        {view === "done" && (
          <div style={{ padding: 20, fontSize: 13.5, color: "#334155", lineHeight: 1.6 }}>
            Your request is logged and on our board. You can follow it under{" "}
            <b>Support → My Requests</b> — the status updates there as we work on it,
            and any reply we post shows up alongside it.
            {!pushed && (
              <div style={{ ...S.err, marginTop: 12, marginBottom: 0 }}>
                Saved — but syncing it to our tracker didn't go through. It's recorded and we'll pick it up; nothing is lost.
              </div>
            )}
            <button onClick={() => setView(null)} style={{ ...S.btn(ACCENT, "#FFF"), marginTop: 16, width: "100%" }}>Done</button>
          </div>
        )}
      </div>
    </div>
  );
}

// The report / request / ticket form in a modal, for a builder with the Support button (346). Their
// floating "💬 Feedback" pill is gone (Carolyn, 10-26: "I would take this feedback button down at
// the below. We'll have a support button up here"), and the top bar's SupportMenu opens this on a
// chosen kind. Rendered only while an operator is NOT viewing someone else's account: the
// submission would be attributed to the operator's own tenant, not the one on screen.
function FeedbackDialog({ kind, clientId, onClose, onSubmitted, prefill = null, supportConversationId = null }) {
  const [done, setDone] = useState(false);
  const [pushed, setPushed] = useState(true);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const cfg = FB_KINDS[kind] || FB_KINDS.ticket;
  const heading = done ? "✅ Thanks — we've got it" : cfg.icon + " " + cfg.label;

  return (
    <div onClick={onClose} role="dialog" aria-modal="true" aria-label={cfg.label}
      style={{ position: "fixed", inset: 0, zIndex: 999, background: "rgba(15,23,42,0.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ background: "#FFF", borderRadius: 12, overflow: "hidden", width: "min(560px, 100%)", maxHeight: "calc(100vh - 32px)", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.35)" }}>
        <div style={{ background: ACCENT, color: "#FFF", padding: "12px 16px", display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ fontSize: 14, fontWeight: 700, flex: 1 }}>{heading}</div>
          <button onClick={onClose} aria-label="Close" style={{ background: "none", border: "none", color: "#FFF", cursor: "pointer", fontSize: 18, padding: 0, lineHeight: 1 }}>×</button>
        </div>

        {!done && (
          <FeedbackForm kind={kind} clientId={clientId} onBack={onClose} prefill={prefill} supportConversationId={supportConversationId}
            onSubmitted={(row, wasPushed) => { setPushed(wasPushed !== false); setDone(true); if (onSubmitted) onSubmitted(row); }} />
        )}

        {done && (
          <div style={{ padding: 20, fontSize: 13.5, color: "#334155", lineHeight: 1.6 }}>
            Your {kind === "ticket" ? "ticket" : "request"} is logged and on our board. {SS_REPLY_PROMISE} You can follow it under{" "}
            <b>Support → My Requests</b> — the status updates there as we work on it,
            and any reply we post shows up alongside it.
            {!pushed && (
              <div style={{ ...S.err, marginTop: 12, marginBottom: 0 }}>
                Saved — but syncing it to our tracker didn't go through. It's recorded and we'll pick it up; nothing is lost.
              </div>
            )}
            <button onClick={onClose} style={{ ...S.btn(ACCENT, "#FFF"), marginTop: 16, width: "100%" }}>Done</button>
          </div>
        )}
      </div>
    </div>
  );
}

// Portal addresses the assistant may hand out, e.g. "/settings/branding" or "/support/mine". Only a
// first segment the portal itself routes is turned into a link, and it navigates IN the portal:
// the assistant can never send anyone off-site (support-agent's rules forbid other links, and this
// is the half that holds even if it wrote one anyway).
const SS_SUPPORT_LINK_PAGES = ["settings", "support", "designer", "contacts", "conversations", "orders", "inventory",
  "build-schedule", "delivery-schedule", "repairs", "calls", "view-3d", "on-demand-pricing"];
const SS_SUPPORT_LINK_RE = /(^|[\s(])(\/([a-z][a-z0-9-]*)(?:\/([a-z0-9-]+))?)(?=$|[\s.,;:!?)])/g;

function ssSupportText(text, onLink) {
  const out = [];
  let last = 0;
  let m;
  SS_SUPPORT_LINK_RE.lastIndex = 0;
  while ((m = SS_SUPPORT_LINK_RE.exec(text))) {
    const page = m[3];
    if (SS_SUPPORT_LINK_PAGES.indexOf(page) === -1) continue;
    const start = m.index + m[1].length;
    if (start > last) out.push(text.slice(last, start));
    const sub = m[4] || null;
    out.push(
      <a key={start} href={ssPagePath(page, sub)} className="ss-sup-link"
        onClick={(e) => { e.preventDefault(); onLink(page, sub); }}>{m[2]}</a>,
    );
    last = start + m[2].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// 👍 / 👎 under one answer (migration 348; Carolyn 10-27: "see how it's responding, how the users
// are responding"). It is for the team's tracking: an operator reads the ratings in Admin → Support
// chats. One tap saves; a 👎 is saved at once and then asks "What was wrong?" with one optional
// line. The same thumb again clears it. Only an answer the server stored can be rated (its id is a
// uuid): a cap's sentence and the "pending" copy of a question are not stored.
function SupportRate({ m, onRated }) {
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState("");     // "Thanks!" or why it didn't save
  const save = async (rating, why) => {
    setBusy(true); setSaid("");
    const prev = m.rating === 1 || m.rating === -1 ? m.rating : null;
    onRated(m.id, rating === 0 ? null : rating);   // shown at once, put back if it fails
    let saved = false;
    try {
      const { data, error } = await sb.functions.invoke("support-agent", { body: { action: "rate", messageId: m.id, rating, ...(why ? { note: why } : {}) } });
      if (error || !data || data.error) throw new Error("rate failed");
      saved = true;
      setSaid(rating === 0 ? "" : "Thanks!");
    } catch (_e) {
      onRated(m.id, prev);
      setSaid("That didn't save. Please try again.");
    }
    setBusy(false);
    return saved;
  };
  const up = () => { if (busy) return; setAsking(false); save(m.rating === 1 ? 0 : 1); };
  const down = async () => {
    if (busy) return;
    if (m.rating === -1) { setAsking(false); save(0); return; }
    if (await save(-1)) { setAsking(true); setSaid(""); }
  };
  const sendWhy = async (e) => {
    e.preventDefault();
    const why = note.trim();
    if (!why) { setAsking(false); setSaid("Thanks!"); return; }
    if (await save(-1, why)) { setAsking(false); setNote(""); }
  };
  return (
    <>
      <div className="ss-sup-rate" data-ss-sup-rate={m.rating === 1 ? "up" : m.rating === -1 ? "down" : "none"}>
        <button type="button" onClick={up} disabled={busy} aria-pressed={m.rating === 1} aria-label="Helpful" title="Helpful">👍</button>
        <button type="button" onClick={down} disabled={busy} aria-pressed={m.rating === -1} aria-label="Not helpful" title="Not helpful">👎</button>
        {said && <span role="status">{said}</span>}
      </div>
      {asking && (
        <form className="ss-sup-why" onSubmit={sendWhy}>
          <input value={note} maxLength={300} autoFocus placeholder="What was wrong? (optional)" aria-label="What was wrong?"
            onChange={(e) => setNote(e.target.value)} />
          <button type="submit" disabled={busy}>Send</button>
        </form>
      )}
    </>
  );
}

// The assistant's chat panel, under the Support button (about 400 × 620 at desktop, a full-screen
// sheet on a phone). Plain text in and out; a "Thinking…" line while support-agent answers; the
// hand-off card opens the ticket form already written. Chats are saved (migration 340) and the
// panel says so, every time.
function SupportChat({ onClose, onTicket, onNavigate }) {
  const [status, setStatus] = useState(null);     // null = loading; support-agent's status answer
  const [loadErr, setLoadErr] = useState("");
  const [messages, setMessages] = useState([]);
  const [convId, setConvId] = useState(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [handoff, setHandoff] = useState(null);   // { title, summary } from offer_handoff
  const listRef = useRef(null);
  const inputRef = useRef(null);
  const panelRef = useRef(null);

  // On a phone the sheet is pinned to the VISIBLE viewport, not the layout one. A page wider than
  // the phone (the design list's table) grows the layout viewport past the screen, and focusing the
  // text box then scrolls the visible part down inside it: found 10-27 with the header cut off by
  // 29 px at 375 px. The on-screen keyboard shrinks the visible part the same way. Above 640 px the
  // CSS position stands and these inline values are cleared.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return undefined;
    const fit = () => {
      const el = panelRef.current;
      if (!el) return;
      const phone = window.matchMedia && window.matchMedia("(max-width:640px)").matches;
      el.style.top = phone ? vv.offsetTop + "px" : "";
      el.style.left = phone ? vv.offsetLeft + "px" : "";
      el.style.width = phone ? vv.width + "px" : "";
      el.style.height = phone ? vv.height + "px" : "";
      el.style.right = phone ? "auto" : "";
      el.style.bottom = phone ? "auto" : "";
    };
    fit();
    vv.addEventListener("resize", fit);
    vv.addEventListener("scroll", fit);
    return () => { vv.removeEventListener("resize", fit); vv.removeEventListener("scroll", fit); };
  }, []);

  const load = useCallback(async () => {
    setLoadErr("");
    try {
      const { data, error } = await sb.functions.invoke("support-agent", { body: { action: "status" } });
      if (error) throw new Error(error.message);
      if (!data || data.error) throw new Error((data && data.error) || "no answer");
      setStatus(data);
      setMessages((data.conversation && data.conversation.messages) || []);
      setConvId((data.conversation && data.conversation.id) || null);
    } catch (_e) {
      setLoadErr("The assistant couldn't be reached. You can still send us a ticket.");
      setStatus({ available: false });
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    // Escape belongs to the ticket dialog while it is open over the chat (it is aria-modal; the
    // chat is not): closing both at once threw away the chat the builder was handing off.
    const onKey = (e) => { if (e.key === "Escape" && !document.querySelector('[aria-modal="true"]')) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Newest message in view, including the "Thinking…" line.
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, busy, handoff]);

  const send = async (e) => {
    if (e) e.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true); setErr(""); setHandoff(null);
    setDraft("");
    // Shown at once; replaced by the stored row when the answer arrives.
    const temp = { id: "pending-" + Date.now(), role: "user", body: text, created_at: new Date().toISOString() };
    setMessages((m) => [...m, temp]);
    try {
      const { data, error } = await sb.functions.invoke("support-agent", { body: { action: "send", text, conversationId: convId } });
      if (error) throw new Error(error.message || "send failed");
      if (data && data.error) throw new Error(data.error);
      if (data && data.capped) {
        // A cap: the builder's words were not sent to the assistant. Say so, and offer the ticket.
        setMessages((m) => [...m, { id: "cap-" + Date.now(), role: "assistant", body: data.reply.body, created_at: new Date().toISOString(), cap: true }]);
        setHandoff({ title: text.slice(0, 100), summary: text });
      } else {
        setConvId(data.conversationId);
        setMessages((m) => [...m.filter((x) => x.id !== temp.id), ...(data.messages || [])]);
        if (data.handoff) setHandoff(data.handoff);
      }
    } catch (e2) {
      setMessages((m) => m.filter((x) => x.id !== temp.id));
      setDraft(text);
      setErr(e2.message && !/non-2xx|Failed to fetch/i.test(e2.message) ? e2.message : "That didn't go through. Please try again.");
    }
    setBusy(false);
    if (inputRef.current) inputRef.current.focus();
  };

  const startOver = async () => {
    if (busy) return;
    try { await sb.functions.invoke("support-agent", { body: { action: "new" } }); } catch (_e) { /* the next send starts fresh anyway */ }
    setMessages([]); setConvId(null); setHandoff(null); setErr("");
  };

  const rated = useCallback((id, rating) => setMessages((ms) => ms.map((x) => (x.id === id ? { ...x, rating } : x))), []);
  const name = (status && status.name) || "Studio Assistant";
  const available = !!(status && status.available);
  const goTo = (page, sub) => { onNavigate(page, sub); if (window.innerWidth < 640) onClose(); };

  return (
    <div className="ss-sup-chat" role="dialog" aria-label={name} ref={panelRef}>
      <div className="ss-sup-head">
        <div className="ss-sup-title">
          <span>{name}</span>
          <span className="ss-sup-sub">AI assistant · tickets answered within 24 hours</span>
        </div>
        {messages.length > 0 && <button type="button" className="ss-sup-ghost" onClick={startOver} disabled={busy}>New chat</button>}
        <button type="button" className="ss-sup-x" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="ss-sup-note">You are chatting with an AI assistant. Chats are saved so our team can follow up.</div>

      <div className="ss-sup-list" ref={listRef} aria-live="polite">
        {status === null && <div className="ss-sup-muted">Loading…</div>}
        {status !== null && messages.length === 0 && available && (
          <div className="ss-sup-bot">
            Hi! Ask me anything about Structure Studio — how to set something up, where a setting lives, or what's on
            your account. If I can't sort it out, I'll pass it to a person on our team.
          </div>
        )}
        {status !== null && !available && (
          <div className="ss-sup-bot">{loadErr || status.unavailable || "The assistant isn't available right now."} {SS_REPLY_PROMISE}</div>
        )}
        {messages.map((m) => (
          <React.Fragment key={m.id}>
            <div className={m.role === "user" ? "ss-sup-me" : "ss-sup-bot"}>
              {m.role === "user" ? m.body : ssSupportText(m.body, goTo)}
            </div>
            {m.role === "assistant" && !m.cap && SS_UUID_RE.test(String(m.id)) && <SupportRate m={m} onRated={rated} />}
          </React.Fragment>
        ))}
        {busy && <div className="ss-sup-muted">Thinking…</div>}
        {handoff && !busy && (
          <div className="ss-sup-card">
            <div className="ss-sup-card-t">Send this to our team?</div>
            <div className="ss-sup-card-b">{handoff.title}</div>
            <button type="button" onClick={() => onTicket(handoff, convId)} style={{ ...S.btn(ACCENT, "#FFF"), width: "100%", marginTop: 8 }}>
              Send this to our team
            </button>
          </div>
        )}
      </div>

      {err && <div style={{ ...S.err, margin: "0 12px 8px" }}>{err}</div>}
      {available ? (
        <form className="ss-sup-form" onSubmit={send}>
          <textarea ref={inputRef} rows={2} value={draft} maxLength={2000} autoFocus
            placeholder="Ask a question…" aria-label="Your question"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} />
          <button type="submit" disabled={busy || !draft.trim()} style={{ ...S.btn(ACCENT, "#FFF"), opacity: busy || !draft.trim() ? 0.6 : 1 }}>Send</button>
        </form>
      ) : status !== null && (
        <div className="ss-sup-form">
          {/* The assistant is off (no key, or over the month's cap), but the builder may have been
              chatting until it went off: status still returns the open chat. The ticket carries it,
              so the team gets the last messages and the "Full chat" link in exactly this case
              (Carolyn, 10-29). An empty chat is not sent: there is nothing to link to. */}
          <button type="button" onClick={() => onTicket(null, messages.length ? convId : null)} style={{ ...S.btn(ACCENT, "#FFF"), width: "100%" }}>Submit a ticket</button>
        </div>
      )}
    </div>
  );
}

// ── JACK (migration 375) ────────────────────────────────────────────────────────────────────────
// The AI agent's tab. Support tells a builder what to do; Jack does the work, and a person presses
// Approve first. Everything that decides anything is on the server (supabase/functions/jack-agent):
// this draws what it answers and sends the presses. The card's Approve sends back the hash of what was
// drawn, so a preview that changed since can't be approved by accident.

// null while the question is out, then whether this person may use Jack on this builder. A failure isn't
// a no: it asks twice more. With no real answer by the end, or after 8 seconds, it reads as off, so /jack
// never sits on "Checking…" for good, and a late yes still wins.
function useJackOn(clientId) {
  const [answer, setAnswer] = useState(null);   // { clientId, on }
  useEffect(() => {
    if (!clientId || SS_POPOUT) return undefined;
    let dead = false;
    const timers = [];
    const giveUp = () => { if (!dead) setAnswer((a) => (a && a.clientId === clientId ? a : { clientId, on: false })); };
    const ask = async (waits) => {
      let on = null;
      try {
        const { data, error } = await sb.functions.invoke("jack-agent", { body: { action: "enabled" } });
        if (!error && data && typeof data.on === "boolean") on = data.on;
      } catch (_e) { /* no answer */ }
      if (dead) return;
      if (on !== null) setAnswer({ clientId, on });
      else if (waits.length) timers.push(setTimeout(() => ask(waits.slice(1)), waits[0]));
      else giveUp();
    };
    timers.push(setTimeout(giveUp, 8000));
    ask([2000, 5000]);
    return () => { dead = true; timers.forEach(clearTimeout); };
  }, [clientId]);
  return answer && answer.clientId === clientId ? answer.on : null;
}

const JACK_FLAGS = {
  below_smaller: "Cheaper than a smaller size",
  above_bigger: "Costs more than a bigger size",
  far_from_neighbors: "Far from the sizes around it",
  zero: "Free in the designer",
  not_offered: "Won't be offered",
  same_size_twice: "On the sheet twice: the later row wins wherever it has a value",
  reversed_size: "Looks reversed: check width and length",
  goes_on_sale: "Had no price, so this puts it on sale",
  // preview.ts BIG_CHANGE_SHARE: a price a sentence moved by more than a quarter either way. A flag, never a stop.
  big_change: "Changes the price by more than 25%",
};
// The sizes table's own formatter, so the card draws the digits Approve writes.
const jackMoney = (n) => (n === null || n === undefined ? "none" : ssPgFmtPrice(n));
const jackPlural = (n, one, many) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const JACK_ERR = "That didn't go through. Please try again.";

// A price list file → what the server reads. Spreadsheets are read here, so the digits the server gets
// are the digits in the cells; a PDF or a photo goes as it is, and a big photo is shrunk first.
async function jackReadFile(file) {
  const name = String(file.name || "price list");
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (ext === "xlsx") {
    const ExcelJS = await loadExcelJS();
    // A date cell is usually a size Excel "helped" with. Named, it reaches the list of what was skipped.
    const book = await readXlsxWorkbook(file, ExcelJS, (v) => (v instanceof Date ? "date " + v.toISOString().slice(0, 10) : xlsxCellText(v)));
    // A hidden sheet is usually last year's prices. It isn't read, and the card says so.
    const seen = book.filter((s) => !s.state || s.state === "visible");
    return {
      fileName: name,
      hiddenSheets: book.filter((s) => !seen.includes(s)).map((s) => s.name),
      sheets: seen.map((s) => ({ name: s.name, rows: s.matrix.map((r) => Array.from(r, (c) => (c === null || c === undefined ? "" : String(c)))) })),
    };
  }
  if (ext === "csv") {
    const text = await file.text();
    const rows = parseCSVRows(text);
    // $4,200 with no quotes splits into two cells, and an inch mark swallows the lines after it. Either
    // one would be a wrong number on the card, so it's refused here, before any paid read: an odd number
    // of quote marks, a row wider than the header, an unquoted $ amount with a thousands comma (that
    // still fits under a header with a spare column), or a cell holding a line break (two inch marks on
    // different lines pair up and swallow every line between). Trailing blanks don't count: a stray comma
    // at the end of a row loses nothing.
    const filled = (r) => { let n = r.length; while (n && !String(r[n - 1]).trim()) n--; return n; };
    const head = rows.find((r) => r.length >= 2);
    if ((text.match(/"/g) || []).length % 2 || (head && rows.some((r) => filled(r) > head.length))
        || /(^|,)\s*\$\d{1,3},\d{3}\b/m.test(text) || rows.some((r) => r.some((c) => /[\r\n]/.test(String(c))))) {
      throw new Error("Some rows in that file don't line up, often from a price like $4,200 without quotation marks or an inch mark. In Excel, save it as .xlsx and send me that one.");
    }
    return { fileName: name, sheets: [{ name, rows }] };
  }
  if (ext === "xls") throw new Error("That's the old Excel format. In Excel, choose Save As, pick .xlsx, and send me that one.");
  const toBase64 = (blob) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1] || "");
    r.onerror = () => rej(new Error("I couldn't read that file."));
    r.readAsDataURL(blob);
  });
  if (ext === "pdf" || file.type === "application/pdf") {
    if (file.size > 20_000_000) throw new Error("That PDF is too big for me. Please send one under 20 MB.");
    return { fileName: name, file: { mediaType: "application/pdf", base64: await toBase64(file) } };
  }
  if (/^image\/(png|jpeg|webp)$/.test(file.type) || /^(png|jpe?g|webp)$/.test(ext)) {
    // Claude takes an image up to about 5 MB. 2600 px keeps a phone photo of a price sheet readable.
    const fitted = await ssFitImageForUpload(file, 3_500_000, 2600);
    return { fileName: name, file: { mediaType: fitted.type || file.type || "image/jpeg", base64: await toBase64(fitted) } };
  }
  throw new Error("I can read Excel (.xlsx), CSV, PDF or a photo.");
}

function JackPreviewTable({ preview }) {
  const styles = preview.styles || [];
  // Held by id: an answer can reorder the list, and the table shouldn't jump to another style.
  const [tabId, setTabId] = useState(null);
  const style = styles.find((s) => s.id === tabId) || styles[0];
  if (!style) return null;
  const columns = preview.columns || [];
  const th = { textAlign: "left", padding: "6px 10px", fontSize: 11, fontWeight: 700, color: "#64748B", borderBottom: "1px solid #E2E8F0", whiteSpace: "nowrap", background: "#F8FAFC" };
  const td = { padding: "6px 10px", fontSize: 13, borderBottom: "1px solid #F1F5F9", verticalAlign: "top", whiteSpace: "nowrap" };
  const change = (from, to, fmt) => (
    <span><b style={{ color: "#1E293B" }}>{fmt(to)}</b>{from !== undefined && <span style={{ color: "#94A3B8", textDecoration: "line-through", marginLeft: 6 }}>{fmt(from)}</span>}</span>
  );
  return (
    <div style={{ marginTop: 10 }}>
      {/* One style still says which, so a hidden one is never a surprise. */}
      {styles.length === 1 && <div style={{ fontSize: 12, fontWeight: 600, color: "#475569", marginBottom: 6 }}>{style.label}</div>}
      {styles.length > 1 && (
        <div role="tablist" style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
          {styles.map((s) => (
            <button key={s.id} type="button" role="tab" aria-selected={s.id === style.id} onClick={() => setTabId(s.id)}
              style={{ border: "1px solid " + (s.id === style.id ? ACCENT : "#CBD5E1"), background: s.id === style.id ? ACCENT : "#FFF", color: s.id === style.id ? "#FFF" : "#334155", borderRadius: 999, padding: "4px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
              {s.label} ({s.rows.length})
            </button>
          ))}
        </div>
      )}
      <div style={{ overflowX: "auto", border: "1px solid #E2E8F0", borderRadius: 8, maxHeight: 420, overflowY: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead><tr>
            <th style={th}>Size</th><th style={th}>Price</th>
            {columns.map((c) => <th key={c.key} style={th}>{c.label}</th>)}
            <th style={th}>Check</th>
          </tr></thead>
          <tbody>
            {style.rows.map((r) => (
              <tr key={r.sizeId}>
                <td style={td}>{r.label}{r.isNew && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, color: "#0F766E", background: "#CCFBF1", borderRadius: 4, padding: "1px 5px" }}>NEW</span>}</td>
                <td style={td}>{r.price ? change(r.isNew ? undefined : r.price.from, r.price.to, jackMoney) : <span style={{ color: "#CBD5E1" }}>no change</span>}</td>
                {columns.map((c) => (
                  <td key={c.key} style={td}>{r.cells && r.cells[c.key] ? change(r.isNew ? undefined : r.cells[c.key].from, r.cells[c.key].to, (n) => String(n)) : ""}</td>
                ))}
                <td style={{ ...td, whiteSpace: "normal", minWidth: 140 }}>
                  {(r.flags || []).map((f) => <div key={f} style={{ color: f === "not_offered" || f === "goes_on_sale" ? "#64748B" : "#B45309", fontSize: 12 }}>{JACK_FLAGS[f] || f}</div>)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function JackCard({ proposal, viewingName, onChanged, onNavigate }) {
  const p = proposal;
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const titleRef = useRef(null);
  // A sentence about the card as it was doesn't outlive that state.
  useEffect(() => { setErr(""); }, [p.status]);
  const call = async (action, body) => {
    setBusy(action); setErr("");
    try {
      const { data, error } = await sb.functions.invoke("jack-agent", { body: { action, id: p.id, ...body } });
      // Jack's saves run server to server, so nothing in this browser saw them. An open designer reads
      // its prices again on this. On every answer, because a dropped connection can follow a real save,
      // and when nothing changed the designer finds the same config and says nothing.
      if (action === "proposal_approve" || action === "proposal_undo") ssSettingsSaved(ssResolvedClientId || null);
      // A refusal comes back on error's context; its sentence is on the body when there is one.
      let said = data;
      if (error && error.context && typeof error.context.json === "function") said = await error.context.json().catch(() => null);
      if (said && said.proposal) onChanged(said.proposal);
      if (error || (said && said.ok === false && !said.proposal)) setErr((said && said.error) || JACK_ERR);
      // The pressed button is about to go, and focus shouldn't fall to the page.
      if (said && said.proposal && action !== "proposal_answer" && titleRef.current) titleRef.current.focus();
    } catch (_e) {
      setErr(JACK_ERR);
    }
    setBusy("");
  };
  const pv = p.preview || {};
  const c = pv.counts;
  const open = p.status === "ready" || p.status === "needs_answers";
  const done = p.status === "applied" || p.status === "partly_applied";
  const line = c ? [
    c.changed ? `${jackPlural(c.changed, "size", "sizes")} changing` : null,
    c.added ? `${jackPlural(c.added, "new size", "new sizes")}` : null,
    c.same ? `${jackPlural(c.same, "already matches", "already match")}` : null,
    c.flagged ? `${jackPlural(c.flagged, "to check", "to check")}` : null,
    c.skipped ? `${c.skipped.toLocaleString("en-US")} left out, listed below` : null,
  ].filter(Boolean).join(" · ") : "";
  const res = p.result || {};
  const undoInfo = res.undo || null;
  const undoReports = (undoInfo && undoInfo.reports) || [];
  const reports = (undoReports.length ? undoReports : res.reports) || [];
  const reportTotal = undoReports.length ? undoReports.length : (res.reportCount ?? reports.length);
  const undoBack = undoInfo ? (undoInfo.restored || 0) + (undoInfo.removed || 0) : 0;
  const btn = (bg, fg, border) => ({ ...S.btn(bg, fg), padding: "8px 14px", ...(border ? { border: "1px solid " + border } : {}) });
  const nothing = c && !c.changed && !c.added;
  const skippedList = pv.skipped || [], leftList = pv.leftAlone || [];
  return (
    <div data-jack-card={p.id} data-status={p.status} style={{ border: "1px solid #E2E8F0", borderRadius: 10, padding: 14, background: "#FFF", marginTop: 8, maxWidth: "100%" }}>
      <div ref={titleRef} tabIndex={-1} style={{ fontSize: 14, fontWeight: 700, color: "#1E293B", overflowWrap: "anywhere", outline: "none" }}>{p.title}</div>
      <div role="status">
        {p.status === "reading" && <div style={{ fontSize: 13, color: "#64748B", marginTop: 6 }}>Reading it now. A big sheet can take a couple of minutes, and you can keep working in the meantime.</div>}
        {p.status === "failed" && <div style={{ fontSize: 13, color: "#B91C1C", marginTop: 6 }}>{p.failure || "That didn't work. Please try again."}</div>}
        {p.status === "expired" && <div style={{ fontSize: 13, color: "#64748B", marginTop: 6 }}>This approval expired after 24 hours and nothing changed. Ask again and I'll redo it against your current numbers.</div>}
        {p.status === "cancelled" && <div style={{ fontSize: 13, color: "#64748B", marginTop: 6 }}>Cancelled. Nothing changed.</div>}
        {p.status === "applying" && <div style={{ fontSize: 13, color: "#64748B", marginTop: 6 }}>Saving…</div>}
        {p.status === "undoing" && <div style={{ fontSize: 13, color: "#64748B", marginTop: 6 }}>Putting it back…</div>}
      </div>
      {p.status === "failed" && p.canRetry && (
        <button type="button" disabled={!!busy} onClick={() => call("proposal_answer", { answers: {} })} style={{ ...btn("#FFF", "#334155", "#CBD5E1"), marginTop: 8 }}>{busy === "proposal_answer" ? "Trying…" : "Try again"}</button>
      )}

      {pv.fixture && p.status !== "failed" && (
        <div style={{ fontSize: 13, color: "#334155", marginTop: 6 }}>A new door in Settings &gt; Doors: <b>{pv.fixture.name}</b>, {pv.fixture.widthIn} by {pv.fixture.heightIn} inches, {jackMoney(pv.fixture.price)}.{pv.fixture.wayLine ? " " + pv.fixture.wayLine : pv.fixture.swingOut ? " It swings out, with a right hinge." : ""}</div>
      )}
      {line && open && <div style={{ fontSize: 13, color: "#475569", marginTop: 6 }}>{line}</div>}
      {p.kind === "price_sheet" && open && <div style={{ fontSize: 12, color: "#64748B", marginTop: 4 }}>I only read building prices and what comes with each size. Add-on prices, delivery and notes on the sheet aren't read, so those stay as they are.</div>}

      {p.status === "needs_answers" && (pv.questions || []).map((q) => (
        <div key={q.id} style={{ marginTop: 10, padding: 10, background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 8 }}>
          <div style={{ fontSize: 13, color: "#78350F", marginBottom: 8 }}>{q.text}</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {q.options.map((o) => (
              <button key={o.value} type="button" disabled={!!busy}
                onClick={() => call("proposal_answer", { answers: q.kind === "zero" ? { zero: o.value } : { styles: { [q.id.replace(/^style:/, "")]: o.value } } })}
                style={{ ...btn(o.value === q.suggestion ? ACCENT : "#FFF", o.value === q.suggestion ? "#FFF" : "#334155", o.value === q.suggestion ? null : "#CBD5E1"), fontSize: 12, padding: "6px 10px" }}>{o.label}</button>
            ))}
          </div>
        </div>
      ))}

      {open && <JackPreviewTable preview={pv} />}

      {(open || done) && (leftList.length > 0 || skippedList.length > 0) && (
        <details open={!!(c && c.skipped)} style={{ marginTop: 8, fontSize: 12, color: "#475569" }}>
          <summary style={{ cursor: "pointer" }}>What I left alone ({(c ? c.leftAlone + c.skipped : 0).toLocaleString("en-US")})</summary>
          {skippedList.map((s, i) => <div key={"s" + i} style={{ marginTop: 4, overflowWrap: "anywhere" }}>{s.where}: {s.text} ({s.why})</div>)}
          {c && c.skipped > skippedList.length && <div style={{ marginTop: 4 }}>and {(c.skipped - skippedList.length).toLocaleString("en-US")} more.</div>}
          {leftList.length > 0 && <div style={{ marginTop: 6 }}>Nothing new on the sheet for these, so unchanged: {leftList.map((x) => `${x.style} ${x.label}`).join(", ")}{c && c.leftAlone > leftList.length ? `, and ${(c.leftAlone - leftList.length).toLocaleString("en-US")} more` : ""}</div>}
        </details>
      )}

      {p.status === "ready" && !nothing && viewingName && <div style={{ fontSize: 12, color: "#B45309", marginTop: 10 }}>These are <b>{viewingName}</b>'s numbers. Your name goes on the record.</div>}
      {p.status === "ready" && nothing && !pv.fixture && <div style={{ fontSize: 13, color: "#64748B", marginTop: 8 }}>Nothing would change, so there's nothing to approve.</div>}
      {err && <div role="alert" style={{ fontSize: 13, color: "#B91C1C", marginTop: 8 }}>{err}</div>}

      {open && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
          {p.status === "ready" && !nothing && (
            <button type="button" disabled={!!busy} onClick={() => call("proposal_approve", { hash: p.hash })} style={{ ...btn(ACCENT, "#FFF"), opacity: busy ? 0.6 : 1 }}>{busy === "proposal_approve" ? "Saving…" : "Approve"}</button>
          )}
          <button type="button" disabled={!!busy} onClick={() => call("proposal_cancel", {})} style={btn("#FFF", "#334155", "#CBD5E1")}>Cancel</button>
          {/* After a style is added or renamed in Settings: works the stored rows out again, with no new read. */}
          {p.kind === "price_sheet" && (
            <button type="button" disabled={!!busy} onClick={() => call("proposal_answer", { answers: {} })} style={btn("#FFF", "#334155", "#CBD5E1")}>{busy === "proposal_answer" ? "Checking…" : "Check again"}</button>
          )}
        </div>
      )}

      <div role="status">
        {done && (p.kind !== "new_fixture" || p.status === "applied") && (
          <div style={{ fontSize: 13, color: p.status === "applied" ? "#047857" : "#B45309", marginTop: 8 }}>
            {p.kind === "new_fixture" ? "Added." : `Saved ${jackPlural(res.saved || 0, "size", "sizes")}${res.created ? `, ${res.created} of them new` : ""}.`}
          </div>
        )}
        {done && undoInfo && undoInfo.failed > 0 && <div style={{ fontSize: 13, color: "#B45309", marginTop: 8 }}>That didn't all go back. Press Undo to try again.</div>}
        {p.status === "undone" && (
          <div style={{ fontSize: 13, color: undoReports.length ? "#B45309" : "#047857", marginTop: 8 }}>
            {!undoReports.length ? "Put back." : undoBack ? "Put back, except what's listed here." : "That stayed as it is:"}
          </div>
        )}
      </div>
      {reports.length > 0 && (
        <div style={{ marginTop: 6, fontSize: 12, color: "#B45309" }}>
          {reportTotal > 1 && <div style={{ fontWeight: 600, marginBottom: 2 }}>{reportTotal.toLocaleString("en-US")} of these need a look:</div>}
          <div style={{ maxHeight: 240, overflowY: "auto" }}>
            {reports.map((r, i) => <div key={i} style={{ overflowWrap: "anywhere" }}>{r.label}: {r.reason}</div>)}
          </div>
          {reportTotal > reports.length && <div style={{ marginTop: 2 }}>and {(reportTotal - reports.length).toLocaleString("en-US")} more. Upload or ask again to see what's still different.</div>}
        </div>
      )}
      {p.canUndo && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
          <button type="button" disabled={!!busy} onClick={() => call("proposal_undo", {})} style={btn("#FFF", "#334155", "#CBD5E1")}>{busy === "proposal_undo" ? "Putting it back…" : "Undo"}</button>
          {p.kind !== "new_fixture" && <button type="button" onClick={() => onNavigate && onNavigate("settings", "sheds")} style={btn("#FFF", "#334155", "#CBD5E1")}>Open my settings</button>}
        </div>
      )}
    </div>
  );
}

// The cards a new reply or estimate card can replace (jack-agent replaceOlder).
const JACK_REPLY_KINDS = ["reply_send", "reply_draft", "estimate_resend"];
// The other cards a newer one of the same kind replaces in a chat (propose_new_door, propose_insulation_prices,
// propose_option_prices). The server decides which (the same door, cell or price); this only re-reads them.
const JACK_REPLACING_KINDS = ["new_fixture", "insulation_price", "option_price"];

// Revise (Carolyn and Ahsan, 11-09 call): on a card still waiting, say what to change and Jack makes the
// card again. The new card replaces this one (jack-agent handleSend `revise`); with no new card, this one
// stays as it is. Only where the server says the card can be revised (proposalView canRevise).
function JackRevise({ proposal, busy, onRevise }) {
  const [open, setOpen] = useState(false);
  const [words, setWords] = useState("");
  const [sending, setSending] = useState(false);
  const boxRef = useRef(null);
  useEffect(() => { if (open && boxRef.current) boxRef.current.focus(); }, [open]);
  const go = async (e) => {
    if (e) e.preventDefault();
    const t = words.trim();
    if (!t || busy || sending) return;
    setSending(true);
    const done = await onRevise(t);
    setSending(false);
    // A refused press keeps the words, so nothing typed is lost.
    if (done) { setWords(""); setOpen(false); }
  };
  const btn = (bg, fg, border) => ({ ...S.btn(bg, fg), padding: "6px 12px", fontSize: 13, ...(border ? { border: "1px solid " + border } : {}) });
  if (!open) {
    return (
      <button type="button" data-jack-revise={proposal.id} disabled={!!busy} onClick={() => setOpen(true)}
        title="Tell Jack what to change, and he'll make this card again"
        style={{ ...btn("#FFF", "#334155", "#CBD5E1"), marginTop: 6, opacity: busy ? 0.6 : 1 }}>Revise</button>
    );
  }
  return (
    <form onSubmit={go} data-jack-revise-box={proposal.id} style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6, alignItems: "center", maxWidth: "100%" }}>
      <input ref={boxRef} value={words} maxLength={4000} onChange={(e) => setWords(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape") { setOpen(false); setWords(""); } }}
        placeholder="What should change? For example: it swings in"
        aria-label={`What should change on ${proposal.title}`}
        style={{ flex: "1 1 220px", minWidth: 0, border: "1px solid #CBD5E1", borderRadius: 8, padding: "7px 10px", fontSize: 13, fontFamily: "inherit" }} />
      <button type="submit" disabled={!words.trim() || !!busy || sending} style={{ ...btn(ACCENT, "#FFF"), opacity: !words.trim() || busy || sending ? 0.6 : 1 }}>{sending ? "Sending…" : "Send"}</button>
      <button type="button" disabled={sending} onClick={() => { setOpen(false); setWords(""); }} style={btn("#FFF", "#334155", "#CBD5E1")}>Never mind</button>
    </form>
  );
}
/** Under a card a corrected or revised one replaced: the server's sentence (reply cards say it themselves). */
function JackReplacedLine({ proposal }) {
  const f = typeof proposal.failure === "string" ? proposal.failure : "";
  if (proposal.status !== "cancelled" || !/^Replaced by/.test(f) || JACK_REPLY_KINDS.includes(proposal.kind)) return null;
  return <div data-jack-replaced={proposal.id} style={{ fontSize: 12, color: "#64748B", marginTop: 4 }}>{f}</div>;
}
// What Jack did on this account: who asked, who approved and when, what happened, and what changed.
// A card that's shown rather than approved reads as what it is on the activity list. A send card's
// button is Approve like every other card's, so it waits for approval and is approved by someone.
const JACK_KIND_WORDS = {
  reply_draft: { ready: "Drafted", cancelled: "Put away", expired: "Expired" },
  reply_send: { ready: "Waiting for approval", applying: "Sending", applied: "Sent", partly_applied: "Couldn't tell whether it went", failed: "Not sent", cancelled: "Put away", expired: "Expired" },
  estimate_resend: { ready: "Waiting for approval", applying: "Sending", applied: "Sent again", partly_applied: "Couldn't tell whether it went", failed: "Not sent", cancelled: "Put away", expired: "Expired" },
  lookup: { applied: "Shown" },
  setup_guide: { applied: "Shown" },
  memory: { ready: "Asked", applied: "Answered" },
};
function JackActivity({ onBack }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState("");
  const [opened, setOpened] = useState({});   // id → the card's whole preview, "loading" or "failed"
  useEffect(() => {
    let dead = false;
    (async () => {
      const { data, error } = await sb.functions.invoke("jack-agent", { body: { action: "activity" } });
      if (dead) return;
      if (error || !data || !data.activity) setErr("I couldn't load that. Please try again.");
      else setRows(data.activity);
    })();
    return () => { dead = true; };
  }, []);
  const see = async (id) => {
    setOpened((o) => ({ ...o, [id]: "loading" }));
    const { data } = await sb.functions.invoke("jack-agent", { body: { action: "proposal_get", id } });
    setOpened((o) => ({ ...o, [id]: data && data.proposal && data.proposal.preview ? data.proposal.preview : "failed" }));
  };
  const words = { reading: "Reading", needs_answers: "Waiting on an answer", ready: "Waiting for approval", applying: "Saving", applied: "Done", partly_applied: "Partly done", undoing: "Putting back", undone: "Put back", cancelled: "Cancelled", expired: "Expired", failed: "Failed" };
  const when = (t) => new Date(t).toLocaleString();
  return (
    <div style={S.card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ ...S.h2, marginBottom: 0 }}>What Jack did</div>
        <button type="button" onClick={onBack} style={{ ...S.btn("#FFF", "#334155"), border: "1px solid #CBD5E1", padding: "6px 12px" }}>Back to chat</button>
      </div>
      {err && <div role="alert" style={{ fontSize: 13, color: "#B91C1C" }}>{err}</div>}
      {rows === null && !err && <div style={{ fontSize: 13, color: "#64748B" }}>Loading…</div>}
      {rows && !rows.length && <div style={{ fontSize: 13, color: "#64748B" }}>Nothing yet.</div>}
      {rows && rows.map((r) => {
        const res = r.result || {};
        const undoLines = (res.undo && res.undo.reports) || [];
        const lines = (undoLines.length ? undoLines : res.reports) || [];
        const c = r.preview && r.preview.counts;
        const left = (r.preview && r.preview.skipped) || [];
        const view = opened[r.id];
        const nothingBack = r.status === "undone" && res.undo && !(res.undo.restored || res.undo.removed) && undoLines.length > 0;
        const landed = r.status === "applied" || r.status === "partly_applied" || r.status === "undone";
        return (
          <div key={r.id} style={{ padding: "10px 0", borderTop: "1px solid #F1F5F9", fontSize: 13 }}>
            <div style={{ fontWeight: 600, color: "#1E293B", overflowWrap: "anywhere" }}>{r.title}</div>
            <div style={{ color: "#64748B", fontSize: 12, marginTop: 2 }}>
              {when(r.createdAt)} · {nothingBack ? "Couldn't put back" : (JACK_KIND_WORDS[r.kind] || {})[r.status] || words[r.status] || r.status}
              {r.askedBy ? ` · asked by ${r.askedBy}` : ""}
              {r.approvedBy ? ` · approved by ${r.approvedBy}` : ""}{r.approvedAt ? ` on ${when(r.approvedAt)}` : ""}
              {r.undoneAt ? ` · ${nothingBack ? "Undo pressed" : "put back"}${r.undoneBy ? ` by ${r.undoneBy}` : ""} on ${when(r.undoneAt)}` : ""}
              {r.kind === "new_fixture"
                ? (res.saved ? " · door added" : "")
                : r.kind === "price_sheet" || r.kind === "size_rule"
                ? (res.saved || res.created ? ` · ${jackPlural(res.saved || 0, "size", "sizes")} saved` : "")
                : ""}
              {r.private ? " · only the person who asked can open it" : ""}
            </div>
            {r.failure && <div style={{ color: "#B91C1C", fontSize: 12, marginTop: 2 }}>{r.failure}</div>}
            {lines.length > 0 && (
              <div style={{ color: "#B45309", fontSize: 12, marginTop: 2, maxHeight: 160, overflowY: "auto" }}>
                {lines.map((x, i) => <div key={i} style={{ overflowWrap: "anywhere" }}>{x.label}: {x.reason}</div>)}
              </div>
            )}
            {left.length > 0 && (
              <details style={{ fontSize: 12, color: "#475569", marginTop: 2 }}>
                <summary style={{ cursor: "pointer" }}>Not updated ({((c && c.skipped) || left.length).toLocaleString("en-US")})</summary>
                {left.map((s, i) => <div key={i} style={{ marginTop: 2, overflowWrap: "anywhere" }}>{s.where}: {s.text} ({s.why})</div>)}
              </details>
            )}
            {c && (c.changed > 0 || c.added > 0) && !view && (
              <button type="button" onClick={() => see(r.id)} style={{ background: "none", border: "none", padding: "4px 0", color: ACCENT, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>{landed ? "See what changed" : "See what it proposed"}</button>
            )}
            {view === "loading" && <div style={{ fontSize: 12, color: "#64748B", marginTop: 2 }}>Loading…</div>}
            {view === "failed" && <div style={{ fontSize: 12, color: "#B91C1C", marginTop: 2 }}>I couldn't load that one.</div>}
            {view && view !== "loading" && view !== "failed" && <JackPreviewTable preview={view} />}
          </div>
        );
      })}
    </div>
  );
}

// Which card draws which kind. The price list, sentence and door cards are JackCard; each piece of Jack
// brings its own; anything without one gets the plain card, which still shows the title, the state, the
// buttons the server allows and what happened.
function JackAnyCard(props) {
  const k = props.proposal.kind;
  if (props.proposal.private) return (
    <div data-jack-card={props.proposal.id} data-status={props.proposal.status} style={{ border: "1px solid #E2E8F0", borderRadius: 10, padding: 14, background: "#FFF", marginTop: 8 }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: "#1E293B", overflowWrap: "anywhere" }}>{props.proposal.title}</div>
      <div style={{ fontSize: 13, color: "#64748B", marginTop: 4 }}>Your access doesn't open this one any more.</div>
    </div>
  );
  if (k === "price_sheet" || k === "size_rule" || k === "new_fixture") return <JackCard {...props} />;
  if (k === "memory") return <JackMemoryCard {...props} />;
  const Own = JACK_CARDS[k];
  return Own ? <Own {...props} /> : <JackPlainCard {...props} />;
}
// Filled in below by each piece's card (kind -> component).
const JACK_CARDS = {};

// The card for a kind with nothing of its own: title, where it stands, preview lines when it has them
// ({label, from, to}), and the presses the server offers.
function JackPlainCard({ proposal, onChanged }) {
  const p = proposal;
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => { setErr(""); }, [p.status]);
  const call = async (action, body) => {
    setBusy(action); setErr("");
    const { data, error } = await sb.functions.invoke("jack-agent", { body: { action, id: p.id, ...body } });
    let said = data;
    if (error && error.context && typeof error.context.json === "function") said = await error.context.json().catch(() => null);
    if (said && said.proposal) onChanged(said.proposal);
    if (error || (said && said.ok === false && !said.proposal)) setErr((said && said.error) || JACK_ERR);
    setBusy("");
  };
  const pv = p.preview || {};
  const res = p.result || {};
  const reports = ((res.undo && res.undo.reports && res.undo.reports.length) ? res.undo.reports : res.reports) || [];
  const words = { ready: "", applying: "Saving…", applied: "Done.", partly_applied: "Partly done. See below.", undoing: "Putting it back…", undone: "Put back.", cancelled: "Cancelled. Nothing changed.", expired: "This expired after 24 hours and nothing changed.", failed: p.failure || "That didn't work." };
  const btn = (bg, fg, border) => ({ ...S.btn(bg, fg), padding: "8px 14px", ...(border ? { border: "1px solid " + border } : {}) });
  return (
    <div data-jack-card={p.id} data-status={p.status} style={{ border: "1px solid #E2E8F0", borderRadius: 10, padding: 14, background: "#FFF", marginTop: 8, maxWidth: "100%" }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: "#1E293B", overflowWrap: "anywhere" }}>{p.title}</div>
      <div role="status" style={{ fontSize: 13, color: "#64748B", marginTop: 4 }}>{words[p.status] || ""}</div>
      {Array.isArray(pv.lines) && pv.lines.length > 0 && (
        <div style={{ marginTop: 8, fontSize: 13 }}>
          {pv.lines.map((l, i) => (
            <div key={i} style={{ padding: "3px 0", borderTop: i ? "1px solid #F1F5F9" : "none", overflowWrap: "anywhere" }}>
              <b>{l.label}</b>{l.to !== undefined && <>: <span>{String(l.to)}</span></>}{l.from !== undefined && l.from !== null && l.from !== "" && <span style={{ color: "#94A3B8", textDecoration: "line-through", marginLeft: 6 }}>{String(l.from)}</span>}
            </div>
          ))}
        </div>
      )}
      {Array.isArray(pv.notes) && pv.notes.map((n, i) => <div key={i} style={{ fontSize: 12, color: "#B45309", marginTop: 6 }}>{n}</div>)}
      {err && <div role="alert" style={{ fontSize: 13, color: "#B91C1C", marginTop: 8 }}>{err}</div>}
      {reports.length > 0 && <div style={{ marginTop: 6, fontSize: 12, color: "#B45309", maxHeight: 200, overflowY: "auto" }}>{reports.map((r, i) => <div key={i}>{r.label}: {r.reason}</div>)}</div>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
        {p.status === "ready" && p.hash && <button type="button" disabled={!!busy} onClick={() => call("proposal_approve", { hash: p.hash })} style={btn(ACCENT, "#FFF")}>{busy === "proposal_approve" ? "Saving…" : "Approve"}</button>}
        {(p.status === "ready" || p.status === "needs_answers") && <button type="button" disabled={!!busy} onClick={() => call("proposal_cancel", {})} style={btn("#FFF", "#334155", "#CBD5E1")}>Cancel</button>}
        {p.canUndo && <button type="button" disabled={!!busy} onClick={() => call("proposal_undo", {})} style={btn("#FFF", "#334155", "#CBD5E1")}>{busy === "proposal_undo" ? "Putting it back…" : "Undo"}</button>}
      </div>
    </div>
  );
}

// "I want to make sure I understand": a question with options to press. The press is the answer, and it
// goes on as the person's next message. An owner's or admin's answer is kept for the whole builder.
function JackMemoryCard({ proposal, onChanged, onSay, busy: tabBusy }) {
  const p = proposal;
  const pv = p.preview || {};
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [other, setOther] = useState("");
  const pick = async (value) => {
    if (busy || tabBusy) return;
    setBusy(true); setErr("");
    const { data, error } = await sb.functions.invoke("jack-agent", { body: { action: "memory_pick", id: p.id, value } });
    let said = data;
    if (error && error.context && typeof error.context.json === "function") said = await error.context.json().catch(() => null);
    setBusy(false);
    if (said && said.proposal) onChanged(said.proposal);
    if (error || !said || !said.ok) { setErr((said && said.error) || JACK_ERR); return; }
    if (onSay && said.say) onSay(said.say);
  };
  const r = p.result || {};
  const btn = { ...S.btn("#FFF", "#334155"), border: "1px solid #CBD5E1", padding: "6px 12px", fontSize: 13 };
  return (
    <div data-jack-card={p.id} data-status={p.status} style={{ border: "1px solid #FDE68A", background: "#FFFBEB", borderRadius: 10, padding: 12, marginTop: 8, maxWidth: "100%" }}>
      <div style={{ fontSize: 13, color: "#78350F" }}>{pv.ask || p.title}</div>
      {p.status === "ready" && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8, alignItems: "center" }}>
          {(pv.options || []).map((o) => (
            <button key={String(o.value)} type="button" disabled={busy || tabBusy} onClick={() => pick(o.value)} style={btn}>{o.label}</button>
          ))}
          {pv.kind === "days" && (
            <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
              <input type="number" min={pv.min || 1} max={pv.max || 3650} value={other} onChange={(e) => setOther(e.target.value)} aria-label="Something else, in days"
                placeholder="Other" style={{ width: 80, border: "1px solid #CBD5E1", borderRadius: 6, padding: "5px 8px", fontSize: 13 }} />
              <button type="button" disabled={busy || tabBusy || !other} onClick={() => pick(Number(other))} style={btn}>Use</button>
            </span>
          )}
        </div>
      )}
      {p.status === "applied" && (
        <div role="status" style={{ fontSize: 12, color: "#475569", marginTop: 6 }}>
          {r.label}. {r.remembered ? "I'll use that for your team from now on. Change it under What Jack remembers." : r.notKeptWhy === "role" ? "I'll use it this time. An owner or admin can make it stick." : "I'll use it this time."}
        </div>
      )}
      {p.status === "expired" && <div style={{ fontSize: 12, color: "#64748B", marginTop: 6 }}>This question expired. Ask again whenever you like.</div>}
      {err && <div role="alert" style={{ fontSize: 13, color: "#B91C1C", marginTop: 6 }}>{err}</div>}
    </div>
  );
}

// What Jack remembers for this builder: every answer it keeps, who set it, and Change or Forget for an
// owner or admin.
function JackMemoryPanel({ canManage, onBack }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState("");
  const [edit, setEdit] = useState({});
  const [busy, setBusy] = useState("");
  const load = async () => {
    const { data, error } = await sb.functions.invoke("jack-agent", { body: { action: "status" } });
    if (error || !data || !Array.isArray(data.memory)) { setErr("I couldn't load that. Please try again."); return; }
    setRows(data.memory);
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);
  const save = async (row, action, value) => {
    setBusy(row.key); setErr("");
    const { data, error } = await sb.functions.invoke("jack-agent", { body: { action, key: row.key, value, basedOn: row.updatedAt } });
    let said = data;
    if (error && error.context && typeof error.context.json === "function") said = await error.context.json().catch(() => null);
    setBusy("");
    if (said && Array.isArray(said.memory)) setRows(said.memory);
    const refused = error || !said || !said.ok;
    if (refused) setErr((said && said.error) || JACK_ERR);
    // Saved, or refused because someone changed it since (the answer then holds the list as it is now):
    // the box shows what's stored, so a second press can't put this screen's old number over theirs
    // without typing it again. A refusal with no list (a dropped answer) keeps what was typed.
    if (!refused || (said && Array.isArray(said.memory))) setEdit((e) => ({ ...e, [row.key]: undefined }));
  };
  const show = (r) => (r.value === null ? "Not set. I'll ask the first time it comes up." : r.kind === "yesno" ? (r.value ? "Yes" : "No") : `${r.value} days`);
  return (
    <div style={S.card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ ...S.h2, marginBottom: 0 }}>What Jack remembers</div>
        <button type="button" onClick={onBack} style={{ ...S.btn("#FFF", "#334155"), border: "1px solid #CBD5E1", padding: "6px 12px" }}>Back to chat</button>
      </div>
      <div style={{ fontSize: 12, color: "#64748B", marginBottom: 8 }}>These answers are for your whole team.{canManage ? "" : " An owner or admin can change them."}</div>
      {err && <div role="alert" style={{ fontSize: 13, color: "#B91C1C" }}>{err}</div>}
      {rows === null && !err && <div style={{ fontSize: 13, color: "#64748B" }}>Loading…</div>}
      {rows && rows.map((r) => (
        <div key={r.key} style={{ padding: "8px 0", borderTop: "1px solid #F1F5F9", fontSize: 13 }}>
          <div style={{ color: "#1E293B" }}>{r.label}: <b>{show(r)}</b></div>
          {r.setBy && <div style={{ fontSize: 12, color: "#94A3B8" }}>Set by {r.setBy}{r.updatedAt ? ` on ${new Date(r.updatedAt).toLocaleDateString()}` : ""}</div>}
          {canManage && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6, alignItems: "center" }}>
              {r.kind === "yesno"
                ? [true, false].map((v) => <button key={String(v)} type="button" disabled={!!busy || r.value === v} onClick={() => save(r, "memory_set", v)} style={{ ...S.btn("#FFF", "#334155"), border: "1px solid #CBD5E1", padding: "4px 10px", fontSize: 12 }}>{v ? "Yes" : "No"}</button>)
                : (<>
                    <input type="number" min={r.min || 1} max={r.max || 3650} aria-label={r.label} value={edit[r.key] ?? (r.value ?? "")} onChange={(e) => setEdit((x) => ({ ...x, [r.key]: e.target.value }))}
                      style={{ width: 80, border: "1px solid #CBD5E1", borderRadius: 6, padding: "4px 8px", fontSize: 12 }} />
                    <button type="button" disabled={!!busy || edit[r.key] === undefined || edit[r.key] === ""} onClick={() => save(r, "memory_set", Number(edit[r.key]))} style={{ ...S.btn(ACCENT, "#FFF"), padding: "4px 10px", fontSize: 12 }}>Save</button>
                  </>)}
              {r.value !== null && <button type="button" disabled={!!busy} onClick={() => save(r, "memory_forget")} style={{ ...S.btn("#FFF", "#B91C1C"), border: "1px solid #FCA5A5", padding: "4px 10px", fontSize: 12 }}>Forget</button>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// Jack's setup cards (jack-agent/setup.ts): business details and branding, how quotes and invoices go out,
// building styles, a window or a ramp, sales lots and the serial start, a step ticked by hand, and the
// "where to set it" guide. One card draws all seven kinds. The server decides which buttons it may show.
// Place it AFTER `const JACK_CARDS = {};`.
function JackSetupCard({ proposal, viewingName, onChanged, onNavigate }) {
  const p = proposal;
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const titleRef = useRef(null);
  // A sentence about the card as it was doesn't outlive that state.
  useEffect(() => { setErr(""); }, [p.status]);
  const call = async (action, body) => {
    setBusy(action); setErr("");
    try {
      const { data, error } = await sb.functions.invoke("jack-agent", { body: { action, id: p.id, ...body } });
      // The save ran server to server, so an open designer reads its settings again, as JackCard does.
      if ((action === "proposal_approve" || action === "proposal_undo") && typeof ssSettingsSaved === "function") {
        ssSettingsSaved(typeof ssResolvedClientId !== "undefined" ? (ssResolvedClientId || null) : null);
      }
      let said = data;
      if (error && error.context && typeof error.context.json === "function") said = await error.context.json().catch(() => null);
      if (said && said.proposal) onChanged(said.proposal);
      if (error || (said && said.ok === false && !said.proposal)) setErr((said && said.error) || JACK_ERR);
      // The pressed button is about to go, and focus shouldn't fall to the page.
      if (said && said.proposal && titleRef.current) titleRef.current.focus();
    } catch (_e) {
      setErr(JACK_ERR);
    }
    setBusy("");
  };
  const pv = p.preview || {};
  const res = p.result || {};
  const undoInfo = res.undo || null;
  const undoReports = (undoInfo && undoInfo.reports) || [];
  const reports = (undoReports.length ? undoReports : res.reports) || [];
  const undoBack = undoInfo ? (undoInfo.restored || 0) + (undoInfo.removed || 0) : 0;
  const lines = Array.isArray(pv.lines) ? pv.lines : [];
  const notes = Array.isArray(pv.notes) ? pv.notes : [];
  const ticks = Array.isArray(pv.ticks) ? pv.ticks : [];
  const ticked = Array.isArray(res.ticked) ? res.ticked : [];
  const tickNotes = Array.isArray(res.tickNotes) ? res.tickNotes : [];
  const route = pv.route && pv.route.page ? pv.route : null;
  const guide = p.kind === "setup_guide";
  const isTick = p.kind === "setup_tick";
  const open = p.status === "ready";
  const done = p.status === "applied" || p.status === "partly_applied";
  const hasOld = lines.some((l) => l.from !== undefined && l.from !== null && l.from !== "");
  const quoted = (list) => list.map((x) => `"${x}"`).join(" and ");
  const btn = (bg, fg, border) => ({ ...S.btn(bg, fg), padding: "8px 14px", ...(border ? { border: "1px solid " + border } : {}) });
  const th = { textAlign: "left", padding: "6px 10px", fontSize: 11, fontWeight: 700, color: "#64748B", borderBottom: "1px solid #E2E8F0", background: "#F8FAFC", whiteSpace: "nowrap" };
  const td = { padding: "6px 10px", fontSize: 13, borderBottom: "1px solid #F1F5F9", verticalAlign: "top", overflowWrap: "anywhere" };
  const stateLine = {
    applying: "Saving…",
    undoing: "Putting it back…",
    expired: "This expired after 24 hours and nothing changed. Ask me again and I'll start from what's there now.",
    cancelled: "Cancelled. Nothing changed.",
    failed: p.failure || "That didn't work. Nothing changed.",
  }[p.status];
  return (
    <div data-jack-card={p.id} data-kind={p.kind} data-status={p.status} style={{ border: "1px solid #E2E8F0", borderRadius: 10, padding: 14, background: "#FFF", marginTop: 8, maxWidth: "100%" }}>
      <div ref={titleRef} tabIndex={-1} style={{ fontSize: 14, fontWeight: 700, color: "#1E293B", overflowWrap: "anywhere", outline: "none" }}>{p.title}</div>
      <div role="status">
        {stateLine && <div style={{ fontSize: 13, color: p.status === "failed" ? "#B91C1C" : "#64748B", marginTop: 6 }}>{stateLine}</div>}
      </div>

      {guide && (
        <div style={{ fontSize: 13, color: "#334155", marginTop: 6 }}>
          {pv.say}{pv.where ? <span style={{ color: "#64748B" }}> It's on {pv.where}.</span> : null}
        </div>
      )}

      {!guide && lines.length > 0 && p.status !== "failed" && (
        <div style={{ marginTop: 10, overflowX: "auto", border: "1px solid #E2E8F0", borderRadius: 8 }}>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead><tr>
              <th style={th}>What</th>
              {hasOld && <th style={th}>Now</th>}
              <th style={th}>New</th>
            </tr></thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td style={{ ...td, fontWeight: 600, color: "#334155" }}>{l.label}</td>
                  {hasOld && (
                    <td style={{ ...td, color: "#94A3B8" }}>
                      {l.from ? <span style={{ textDecoration: open ? "line-through" : "none" }}>{String(l.from)}</span> : <span style={{ color: "#CBD5E1" }}>blank</span>}
                    </td>
                  )}
                  <td style={{ ...td, color: "#1E293B", fontWeight: 600 }}>{String(l.to ?? "")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open && !isTick && ticks.length > 0 && (
        <div style={{ fontSize: 13, color: "#0F766E", marginTop: 8 }}>Approving this also ticks {quoted(ticks)} on your setup checklist.</div>
      )}
      {open && isTick && <div style={{ fontSize: 13, color: "#0F766E", marginTop: 8 }}>Approving this ticks the step on your setup checklist. Nothing else changes.</div>}
      {(open || done) && notes.map((n, i) => <div key={i} style={{ fontSize: 12, color: "#B45309", marginTop: 6 }}>{n}</div>)}
      {open && !guide && viewingName && <div style={{ fontSize: 12, color: "#B45309", marginTop: 10 }}>These are <b>{viewingName}</b>'s settings. Your name goes on the record.</div>}
      {err && <div role="alert" style={{ fontSize: 13, color: "#B91C1C", marginTop: 8 }}>{err}</div>}

      <div role="status">
        {done && !guide && (
          <div style={{ fontSize: 13, color: p.status === "applied" ? "#047857" : "#B45309", marginTop: 8 }}>
            {p.status === "applied" ? (isTick ? "Ticked." : "Saved.") : "Some of it didn't save. It's listed here."}
            {!isTick && ticked.length > 0 ? ` Ticked ${quoted(ticked)} on your setup checklist.` : ""}
          </div>
        )}
        {done && tickNotes.map((n, i) => <div key={i} style={{ fontSize: 12, color: "#B45309", marginTop: 4 }}>{n}</div>)}
        {done && undoInfo && undoInfo.failed > 0 && <div style={{ fontSize: 13, color: "#B45309", marginTop: 8 }}>That didn't all go back. Press Undo to try again.</div>}
        {p.status === "undone" && (
          <div style={{ fontSize: 13, color: undoReports.length ? "#B45309" : "#047857", marginTop: 8 }}>
            {!undoReports.length ? "Put back." : undoBack ? "Put back, except what's listed here." : "That stayed as it is:"}
          </div>
        )}
      </div>
      {reports.length > 0 && (
        <div style={{ marginTop: 6, fontSize: 12, color: "#B45309", maxHeight: 200, overflowY: "auto" }}>
          {reports.map((r, i) => <div key={i} style={{ overflowWrap: "anywhere" }}>{r.label}: {r.reason}</div>)}
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
        {open && !guide && p.hash && (
          <button type="button" disabled={!!busy} onClick={() => call("proposal_approve", { hash: p.hash })} style={{ ...btn(ACCENT, "#FFF"), opacity: busy ? 0.6 : 1 }}>{busy === "proposal_approve" ? "Saving…" : "Approve"}</button>
        )}
        {open && !guide && (
          <button type="button" disabled={!!busy} onClick={() => call("proposal_cancel", {})} style={btn("#FFF", "#334155", "#CBD5E1")}>Cancel</button>
        )}
        {p.canUndo && (
          <button type="button" disabled={!!busy} onClick={() => call("proposal_undo", {})} style={btn("#FFF", "#334155", "#CBD5E1")}>{busy === "proposal_undo" ? "Putting it back…" : "Undo"}</button>
        )}
        {route && (guide || !open) && (
          <button type="button" onClick={() => onNavigate && onNavigate(route.page, route.sub || null)}
            style={guide ? btn("#EEF2FF", ACCENT) : btn("#FFF", "#334155", "#CBD5E1")}>
            {guide ? "Take me there →" : `Open ${pv.where || "the page"}`}
          </button>
        )}
      </div>
    </div>
  );
}
Object.assign(JACK_CARDS, {
  setup_company: JackSetupCard, setup_paperwork: JackSetupCard, setup_styles: JackSetupCard, setup_fixture: JackSetupCard,
  setup_locations: JackSetupCard, setup_tick: JackSetupCard, setup_guide: JackSetupCard,
  // Insulation rates (jack-agent/insulation.ts): the same now and new lines, notes and Open button.
  insulation_price: JackSetupCard,
  // Prices on Interior items, colors and Electrical items (jack-agent/options.ts, 11-10): the same lines.
  option_price: JackSetupCard,
});

// Jack's when/then rule cards (jack-agent/rules.ts): a new rule (automation_rule) and a pause or turn-on
// (automation_pause). The rule reads the way Carolyn's Automations list says it, every step shows the full
// words it sends, and her own warning sits on any rule that messages customers.
const JACK_RULE_OUTBOUND = "This rule messages the customer by itself, with nobody reading it first. Texts skip anyone who has opted out, and wait for the morning if it is night where the customer lives. Try it on one card before you leave it running.";

function JackRuleCard({ proposal, viewingName, onChanged, onNavigate }) {
  const p = proposal;
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const titleRef = useRef(null);
  useEffect(() => { setErr(""); }, [p.status]);
  const call = async (action, body) => {
    setBusy(action); setErr("");
    try {
      const { data, error } = await sb.functions.invoke("jack-agent", { body: { action, id: p.id, ...body } });
      let said = data;
      if (error && error.context && typeof error.context.json === "function") said = await error.context.json().catch(() => null);
      if (said && said.proposal) onChanged(said.proposal);
      if (error || (said && said.ok === false && !said.proposal)) setErr((said && said.error) || JACK_ERR);
      if (said && said.proposal && titleRef.current) titleRef.current.focus();
    } catch (_e) {
      setErr(JACK_ERR);
    }
    setBusy("");
  };
  const pv = p.preview || {};
  const isPause = p.kind === "automation_pause";
  const r = (isPause ? pv.pause : pv.rule) || {};
  const turnsOn = isPause && r.on === true;
  const steps = r.steps || [];
  const res = p.result || {};
  const undoInfo = res.undo || null;
  const undoLines = (undoInfo && undoInfo.reports) || [];
  const lines = (undoLines.length ? undoLines : res.reports) || [];
  const open = p.status === "ready";
  const done = p.status === "applied" || p.status === "partly_applied";
  const warn = r.outbound && (!isPause || turnsOn) && (open || done);
  const btn = (bg, fg, border) => ({ ...S.btn(bg, fg), padding: "8px 14px", ...(border ? { border: "1px solid " + border } : {}) });
  const small = { fontSize: 12, color: "#64748B", marginTop: 6 };
  const pill = { display: "inline-block", fontSize: 11, fontWeight: 700, color: "#334155", background: "#F1F5F9", border: "1px solid #E2E8F0", borderRadius: 999, padding: "2px 8px" };
  const amber = { fontSize: 12, fontWeight: 600, color: "#B45309", background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 8, padding: "6px 8px", marginTop: 8, lineHeight: 1.45 };
  const undoneWords = undoLines.length ? ""
    : isPause ? (turnsOn ? "Paused again." : "Turned back on.")
    : undoInfo && undoInfo.removed && !undoInfo.restored ? "It isn't in Automations any more, so there was nothing to pause."
    : "Paused. It won't run again unless someone turns it on in Automations, and a message it was holding, like a text for the morning, won't go out. What it already sent stays sent.";
  return (
    <div data-jack-card={p.id} data-status={p.status} data-kind={p.kind} style={{ border: "1px solid #E2E8F0", borderRadius: 10, padding: 14, background: "#FFF", marginTop: 8, maxWidth: "100%" }}>
      <div ref={titleRef} tabIndex={-1} style={{ fontSize: 14, fontWeight: 700, color: "#1E293B", overflowWrap: "anywhere", outline: "none" }}>{p.title}</div>
      <div role="status">
        {p.status === "applying" && <div style={small}>Saving…</div>}
        {p.status === "undoing" && <div style={small}>{isPause ? "Putting it back…" : "Pausing it…"}</div>}
        {p.status === "expired" && <div style={small}>This expired after 24 hours and nothing changed. Ask again and I'll redo it against your rules as they are now.</div>}
        {p.status === "cancelled" && <div style={small}>Cancelled. Nothing changed.</div>}
        {p.status === "failed" && <div style={{ fontSize: 13, color: "#B91C1C", marginTop: 6 }}>{p.failure || "That didn't save. Nothing changed."}</div>}
      </div>

      {r.sentence && <div style={{ fontSize: 13, color: "#334155", marginTop: 6, overflowWrap: "anywhere" }}>{r.sentence}</div>}
      {(r.whoFor || r.once) && (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 6 }}>
          {r.whoFor && <span data-jack-rule-who="" style={pill}>{r.whoFor}</span>}
          {r.once && <span style={{ fontSize: 12, color: "#64748B" }}>{r.once}</span>}
        </div>
      )}
      {(r.onlyIf || []).length > 0 && (
        <div style={{ fontSize: 12, color: "#475569", marginTop: 6 }}>
          <div style={{ fontWeight: 600 }}>Only if:</div>
          {r.onlyIf.map((c, i) => <div key={i} style={{ overflowWrap: "anywhere" }}>{c}</div>)}
        </div>
      )}
      {steps.length > 0 && (
        <ol style={{ margin: "8px 0 0", paddingLeft: 20, fontSize: 13, color: "#1E293B" }}>
          {steps.map((a, i) => (
            <li key={i} style={{ marginTop: i ? 8 : 0 }}>
              <div style={{ fontWeight: 600 }}>{a.says}</div>
              {a.subject && <div style={{ fontSize: 12, color: "#475569", marginTop: 2, overflowWrap: "anywhere" }}>{a.kind === "create_task" ? "Task: " : a.kind === "create_card" ? "Card: " : "Subject: "}{a.subject}</div>}
              {a.text && <div style={{ fontSize: 12.5, color: "#334155", marginTop: 4, whiteSpace: "pre-wrap", overflowWrap: "anywhere", background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 6, padding: "6px 8px" }}>{a.text}</div>}
            </li>
          ))}
        </ol>
      )}
      {warn && <div data-jack-rule-outbound="" style={amber}>{JACK_RULE_OUTBOUND}</div>}
      {open && !isPause && <div style={small}>It starts with what happens from now on. It won't act on anything that already happened.</div>}
      {open && !isPause && (pv.runsAfter || []).length > 0 && <div style={small}>Rules run top to bottom, so this one runs after {pv.runsAfter.join(", ")}, which start on the same thing.</div>}
      {open && !isPause && <div style={small}>Undo pauses it. It can't unsend what already went.</div>}
      {open && isPause && !turnsOn && <div style={small}>Pausing stops new runs, and a message it was holding, like a text for the morning, won't go out.</div>}
      {open && isPause && !turnsOn && (pv.notes || []).map((n, i) => <div key={"n" + i} data-jack-rule-note="" style={{ fontSize: 12, color: "#B45309", marginTop: 6 }}>{n}</div>)}
      {open && turnsOn && <div style={small}>It picks up from now.{r.catchesUp ? " A days-after rule also catches up the cards that came due while it was paused." : ""}</div>}
      {open && viewingName && <div style={{ fontSize: 12, color: "#B45309", marginTop: 8 }}>These are <b>{viewingName}</b>'s rules. Your name goes on the record.</div>}
      {err && <div role="alert" style={{ fontSize: 13, color: "#B91C1C", marginTop: 8 }}>{err}</div>}

      {open && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
          {p.hash && <button type="button" disabled={!!busy} onClick={() => call("proposal_approve", { hash: p.hash })} style={{ ...btn(ACCENT, "#FFF"), opacity: busy ? 0.6 : 1 }}>{busy === "proposal_approve" ? "Saving…" : "Approve"}</button>}
          <button type="button" disabled={!!busy} onClick={() => call("proposal_cancel", {})} style={btn("#FFF", "#334155", "#CBD5E1")}>Cancel</button>
        </div>
      )}

      <div role="status">
        {p.status === "applied" && (
          <div style={{ fontSize: 13, color: "#047857", marginTop: 8 }}>
            {isPause ? (turnsOn ? "Turned on. It runs by itself from now on." : "Paused. A message it was holding won't go out.") : "Saved. It's in Settings > Customer Hub > Automations, and it runs by itself from now on."}
          </div>
        )}
        {done && undoInfo && undoInfo.failed > 0 && <div style={{ fontSize: 13, color: "#B45309", marginTop: 8 }}>That didn't go through. Press Undo to try again.</div>}
        {p.status === "undone" && undoneWords && <div style={{ fontSize: 13, color: "#047857", marginTop: 8 }}>{undoneWords}</div>}
        {p.status === "undone" && undoLines.length > 0 && <div style={{ fontSize: 13, color: "#B45309", marginTop: 8 }}>I left it as it is:</div>}
      </div>
      {lines.length > 0 && (
        <div style={{ marginTop: 6, fontSize: 12, color: "#B45309" }}>
          {lines.map((x, i) => <div key={i} style={{ overflowWrap: "anywhere" }}>{x.reason}</div>)}
        </div>
      )}
      {(done || p.status === "undone") && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
          {p.canUndo && <button type="button" disabled={!!busy} onClick={() => call("proposal_undo", {})} style={btn("#FFF", "#334155", "#CBD5E1")}>{busy === "proposal_undo" ? (isPause ? "Putting it back…" : "Pausing…") : isPause ? "Undo" : "Undo (pause it)"}</button>}
          <button type="button" onClick={() => onNavigate && onNavigate("settings", "automations")} style={btn("#FFF", "#334155", "#CBD5E1")}>Open Automations</button>
        </div>
      )}
    </div>
  );
}
JACK_CARDS.automation_rule = JackRuleCard;
JACK_CARDS.automation_pause = JackRuleCard;

// A look-up's whole list, for the person who asked (the card is private: a teammate sees only that it was
// asked). Each row opens that customer's record, the order, or Inventory. Nothing here changes anything.
function JackLookupCard({ proposal, onNavigate }) {
  const p = proposal;
  const pv = p.preview || {};
  const groups = Array.isArray(pv.groups) ? pv.groups : [];
  const d = pv.detail || null;
  const first = groups.find((x) => x.count > 0) || groups[0] || null;
  const [tab, setTab] = useState(first ? first.key : null);
  const g = groups.find((x) => x.key === tab) || first;
  const go = (link) => { if (link && onNavigate) onNavigate(link.page, link.sub || null); };
  const money = (c) => jackMoney(Math.round(Number(c) || 0) / 100);
  const ago = (n) => (n === 0 ? "today" : `${jackPlural(n, "day", "days")} ago`);
  const days = (n, word) => {
    if (n === null || n === undefined) return "";
    if (word === "ago") return ago(n);
    return n === 0 ? `under a day ${word || ""}`.trim() : `${jackPlural(n, "day", "days")}${word ? " " + word : ""}`;
  };
  const box = { border: "1px solid #E2E8F0", borderRadius: 10, padding: 14, background: "#FFF", marginTop: 8, maxWidth: "100%" };
  const chip = { display: "inline-block", fontSize: 11, fontWeight: 600, color: "#475569", background: "#F1F5F9", borderRadius: 4, padding: "1px 6px", marginRight: 4, marginTop: 4 };
  const quote = { marginTop: 4, padding: "4px 8px", background: "#F8FAFC", borderLeft: "3px solid #CBD5E1", color: "#334155", fontSize: 12, overflowWrap: "anywhere", whiteSpace: "pre-wrap" };
  const linkBtn = { background: "none", border: "none", padding: 0, color: ACCENT, fontWeight: 700, fontSize: 13, cursor: "pointer", textAlign: "left", overflowWrap: "anywhere" };
  const stageWord = { lead: "New lead", quoted: "Estimate out", accepted: "Accepted, not sold yet", sold: "Sold", lost: "Lost", open: "Open" };
  const titleOf = (link) => (link && link.page === "orders" ? "Open the order" : link && link.page === "inventory" ? "Open Inventory" : "Open their record");

  // Cleared 30 days after it was made (jack-agent PRIVATE_KEEP_DAYS): only the title is left.
  if (pv.cleared === true) {
    return (
      <div data-jack-card={p.id} data-status={p.status} data-cleared="1" style={box}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#1E293B", overflowWrap: "anywhere" }}>{p.title}</div>
        <div style={{ fontSize: 13, color: "#64748B", marginTop: 4 }}>This list was cleared after 30 days. Ask me again for a fresh one.</div>
      </div>
    );
  }

  if (!groups.length && !d) {
    return (
      <div data-jack-card={p.id} data-status={p.status} style={box}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#1E293B", overflowWrap: "anywhere" }}>{p.title}</div>
        <div style={{ fontSize: 13, color: "#64748B", marginTop: 4 }}>{p.private ? "Only the person who asked can see this list." : "Nothing to show."}</div>
      </div>
    );
  }

  const person = d && groups[0] && groups[0].rows && groups[0].rows[0] ? groups[0].rows[0] : null;
  return (
    <div data-jack-card={p.id} data-status={p.status} style={box}>
      <div style={{ fontSize: 14, fontWeight: 700, color: "#1E293B", overflowWrap: "anywhere" }}>{p.title}</div>
      {pv.heading && <div style={{ fontSize: 13, color: "#334155", marginTop: 4, overflowWrap: "anywhere" }}>{pv.heading}</div>}
      {(pv.asked || []).length > 0 && <div style={{ fontSize: 12, color: "#64748B", marginTop: 4 }}>{pv.asked.join(" ")}</div>}

      {d && (
        <div style={{ marginTop: 8, fontSize: 13, color: "#334155" }}>
          {(d.company || d.town) && <div style={{ color: "#64748B" }}>{[d.company, d.town].filter(Boolean).join(" · ")}</div>}
          {d.reach && <div style={{ marginTop: 4 }}>Texts: {d.reach.text}. Email: {d.reach.email}.</div>}
          <div style={{ marginTop: 4, fontSize: 12, color: "#475569" }}>
            {d.lastFromThem ? `Last from them ${ago(d.lastFromThem.daysAgo)}${d.lastFromThem.by ? ` by ${d.lastFromThem.by}` : ""}. ` : "Nothing from them yet. "}
            {d.lastFromYou ? `Last from you ${ago(d.lastFromYou.daysAgo)}${d.lastFromYou.by ? ` by ${d.lastFromYou.by}` : ""}.` : "Nothing from you yet."}
            {d.nextAppointment ? ` Next appointment ${new Date(d.nextAppointment).toLocaleString()}.` : ""}
          </div>
          {(d.deals || []).map((x, i) => (
            <div key={"d" + i} style={{ marginTop: 6, overflowWrap: "anywhere" }}>
              <b>{x.building || x.status || "Deal"}</b> · {stageWord[x.stage] || x.status || "Open"}
              {x.value ? ` · ${x.value}` : ""}
              {x.quoteSentDaysAgo !== undefined && x.quoteSentDaysAgo !== null ? ` · estimate out ${jackPlural(x.quoteSentDaysAgo, "day", "days")}` : ""}
              {x.invoiceOutNotSigned ? " · invoice out, not signed" : ""}
              {x.lostReason ? ` · ${x.lostReason}` : ""}
            </div>
          ))}
          {(d.orders || []).map((o, i) => (
            <div key={"o" + i} style={{ marginTop: 6, overflowWrap: "anywhere" }}>
              Order {o.order || ""}: {o.total}{o.owed && o.owed !== "$0" ? `, ${o.owed} owed` : ""}{o.clearing ? ` (${o.clearing} still clearing)` : ""}
              {o.build ? `. Build: ${o.build}` : ""}{o.delivery ? `. Delivery: ${o.delivery}` : ""}.
            </div>
          ))}
          {d.ordersNote && <div style={{ fontSize: 12, color: "#B45309", marginTop: 6 }}>{d.ordersNote}</div>}
          {(d.cantSee || []).length > 0 && <div style={{ fontSize: 12, color: "#B45309", marginTop: 6 }}>Your access doesn't show {d.cantSee.join(", ")}.</div>}
          {person && person.link && (
            <button type="button" onClick={() => go(person.link)} style={{ ...S.btn("#FFF", "#334155"), border: "1px solid #CBD5E1", padding: "8px 14px", marginTop: 10 }}>Open their record</button>
          )}
        </div>
      )}

      {!d && groups.length > 1 && (
        <div role="tablist" style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
          {groups.map((x) => {
            const on = !!g && x.key === g.key;
            return (
              <button key={x.key} type="button" role="tab" aria-selected={on} onClick={() => setTab(x.key)}
                style={{ border: "1px solid " + (on ? ACCENT : "#CBD5E1"), background: on ? ACCENT : "#FFF", color: on ? "#FFF" : "#334155", borderRadius: 999, padding: "4px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                {x.label} ({Number(x.count || 0).toLocaleString("en-US")})
              </button>
            );
          })}
        </div>
      )}

      {!d && g && (
        <div style={{ marginTop: 8 }}>
          {(g.cents || g.note) && <div style={{ fontSize: 12, color: "#475569", marginBottom: 6 }}>{g.cents ? `${money(g.cents)} in total. ` : ""}{g.note || ""}</div>}
          {!(g.rows || []).length && <div style={{ fontSize: 13, color: "#64748B" }}>Nobody here.</div>}
          {(g.rows || []).length > 0 && (
            <div style={{ border: "1px solid #E2E8F0", borderRadius: 8, maxHeight: 420, overflowY: "auto" }}>
              {g.rows.map((r, i) => (
                <div key={r.ref || i} style={{ padding: "8px 10px", borderTop: i ? "1px solid #F1F5F9" : "none", fontSize: 13 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                    {r.link
                      ? <button type="button" onClick={() => go(r.link)} title={titleOf(r.link)} style={linkBtn}>{r.name || "No name saved"}</button>
                      : <b style={{ color: "#1E293B" }}>{r.name || "No name saved"}</b>}
                    <span style={{ color: "#475569", fontSize: 12 }}>
                      {[days(r.days, r.daysWord), r.cents !== null && r.cents !== undefined ? `${money(r.cents)}${r.centsWord ? " " + r.centsWord : ""}` : ""].filter(Boolean).join(" · ")}
                    </span>
                  </div>
                  {r.line && <div style={{ color: "#64748B", fontSize: 12, marginTop: 2, overflowWrap: "anywhere" }}>{r.line}</div>}
                  {(r.flags || []).length > 0 && <div>{r.flags.map((f, j) => <span key={j} style={chip}>{f}</span>)}</div>}
                  {(r.words || []).map((w, j) => <div key={"w" + j} style={quote}>{w}</div>)}
                </div>
              ))}
            </div>
          )}
          {g.more > 0 && <div style={{ fontSize: 12, color: "#64748B", marginTop: 4 }}>and {Number(g.more).toLocaleString("en-US")} more not shown here.</div>}
        </div>
      )}

      {(pv.leftOut || []).length > 0 && (
        <div style={{ fontSize: 12, color: "#475569", marginTop: 8 }}>Left out: {pv.leftOut.map((x) => `${x.label} (${Number(x.count || 0).toLocaleString("en-US")})`).join(" · ")}</div>
      )}
      {(pv.notes || []).map((n, i) => <div key={"n" + i} style={{ fontSize: 12, color: "#B45309", marginTop: 6 }}>{n}</div>)}
    </div>
  );
}
JACK_CARDS.lookup = JackLookupCard;

// Jack's reply cards (jack-agent drafts.ts and sends.ts): words for one customer. Every amount and date on
// one was checked against the record before it was shown.
//   reply_draft (version 1, and whenever this person may not send from here): nothing is sent from the
//     card. Open their record (the deal picked, their texts or emails showing), Copy, and Not now.
//   reply_send: Approve, which sends it, Open their record, and Not now. The press is the approval: the
//     server reads the customer again, checks it all again, and sends exactly these words once, through
//     the route the record's own Send uses. Nothing to undo once it goes. The Structure Studio team in
//     view-as never sends a text (the record page hides texting there, and the server refuses the press).
//     No Copy on a card that sends: words copied and sent by hand, then Approved, would reach the customer
//     twice. Only a draft that can't send offers Copy (the same for estimate_resend and a change order).
// preview = { contactId, dealKey, channel, subject, body, firstName, fullName, company, town, to, sameName,
//   dealLabel, factsUsed, notes, sendable, ruleNotes: string[], quiet: { sentence, opensAt } | null }.
//   fullName, company and town say exactly who a press sends to (a record with no name gets no card that
//   sends), and `to` exactly where: "(816) 555-0142" for a text, the address for an email (11-09; the press
//   refuses when their record's number or address isn't this one). sameName: a sentence when another
//   customer has the same name, shown while the card waits. A card from before 11-09 has neither.
// Approve posts send: true: the server runs a send card only from a page that shows its words. It also
//   posts `to`, the destination this card drew (11-09): the server runs a card whose preview has a `to` only
//   from a page that drew that line. A card with no `to` (made before 11-09) can't be sent at all, so it
//   shows no Approve and says to ask again.
// result (reply_send): sent { sent: 1, channel, at, ledgerId } on "applied"; waiting { waiting: { reason,
//   sentence, retryAt } } back on "ready" with nothing sent; refused is "failed" with the sentence in
//   failure; unclear is "partly_applied" with the sentence in reports[].reason (a stalled press may have
//   no `sent` key, so the report is what's read).
const JACK_SEND_UNSURE = "I couldn't tell whether it went. Check their record before sending it again.";   // sends.ts SEND_SAID.unsure
// A press whose answer never came back: it may have gone, so this never says to try again. It names the
// card's own button, Approve.
const JACK_SEND_LOST = "I didn't hear back from that press. Check their record before pressing Approve again.";
/** "3:42 PM", or "3:42 PM on Nov 7" on another day, on this person's own clock. */
function jackAt(iso) {
  const d = new Date(iso || "");
  if (!Number.isFinite(d.getTime())) return "";
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? time : `${time} on ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}
/** The press on a send card (Approve), and Not now. Approve runs once on the server whatever happens
 *  here (the claim is the guard). A press whose answer is lost reads the card again, so Approve never
 *  stays up on a card that may have gone; the poller takes over while it's still sending. */
function useJackSend(p, onChanged, titleRef) {
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  // A sentence about the card as it was doesn't outlive that state.
  useEffect(() => { setErr(""); }, [p.status]);
  const reread = async () => {
    try {
      const { data } = await sb.functions.invoke("jack-agent", { body: { action: "proposal_get", id: p.id } });
      if (data && data.proposal) onChanged(data.proposal);
    } catch (_e) { /* the card stays as it was, and the server still refuses a second send */ }
  };
  const call = async (action, body) => {
    if (busy) return;
    setBusy(action); setErr("");
    const sending = action === "proposal_approve";
    // An Approve press that brings no card back (a refusal before the claim, a fault, or an answer that was
    // lost) reads the card again: it may be sending, or sent, by now.
    let cardBack = false;
    try {
      const { data, error } = await sb.functions.invoke("jack-agent", { body: { action, id: p.id, ...body } });
      let said = data;
      if (error && error.context && typeof error.context.json === "function") said = await error.context.json().catch(() => null);
      if (said && said.proposal) { onChanged(said.proposal); cardBack = true; }
      // A refusal comes back with its sentence; no sentence means the answer was lost.
      if (error || (said && said.ok === false && !said.proposal)) setErr((said && said.error) || (sending ? JACK_SEND_LOST : JACK_ERR));
      // The pressed button is about to go, and focus shouldn't fall to the page.
      if (cardBack && titleRef && titleRef.current) titleRef.current.focus();
    } catch (_e) {
      setErr(sending ? JACK_SEND_LOST : JACK_ERR);
    }
    if (sending && !cardBack) await reread();
    setBusy("");
  };
  // A lost press may have sent it, so while that sentence shows the card never also says nothing went.
  const lost = !!err && err === JACK_SEND_LOST;
  return { busy, err, setErr, call, lost };
}
/** Dimmed while a press is with the server, like Approve, since every button waits then. */
const jackWaitLook = (style, busy) => ({ ...style, opacity: busy ? 0.6 : 1 });
// An estimate's number stays on one line ("estimate E-2041"): on a phone's narrow card it broke at its
// hyphen, leaving "E-" at the end of one line. Only a short number with a digit is held together.
const JACK_ESTIMATE_NO = /(\bestimate [A-Za-z]{0,6}-?\d[A-Za-z0-9-]{0,15}(?![A-Za-z0-9-]))/i;
function jackKeepNumbers(text) {
  const parts = String(text == null ? "" : text).split(JACK_ESTIMATE_NO);
  return parts.length === 1 ? parts[0] : parts.map((x, i) => (i % 2 ? <span key={i} style={{ whiteSpace: "nowrap" }}>{x}</span> : x));
}
// drafts.ts adds this note to a view-as text draft. The new card's own line already says it, so the note
// shows only on a page from before that line (it would say the same thing twice here).
const JACK_NO_TEXT_NOTE = "Texting from their record isn't available while you're viewing another account.";
/** Where a send card stands once it's past ready: { text, tone }, or null while it waits for a press.
 *  `what`: "reply" or "estimate". */
function jackSendSays(p, what, sending) {
  const res = p.result || {};
  if (sending || p.status === "applying") return { text: "Sending…", tone: "#64748B" };
  if (p.status === "applied") {
    const at = jackAt(res.at || p.appliedAt);
    return { text: `${at ? `Sent at ${at}.` : "Sent."} It's on their record.${what === "estimate" ? " Its sent date moved to today." : ""}`, tone: "#047857" };
  }
  if (p.status === "partly_applied") {
    const why = [...new Set((Array.isArray(res.reports) ? res.reports : []).map((r) => r && r.reason).filter(Boolean))];
    return { text: why.length ? why.join(" ") : JACK_SEND_UNSURE, tone: "#B45309" };
  }
  if (p.status === "failed") return { text: p.failure || "That didn't go through. Nothing was sent.", tone: "#B91C1C" };
  if (p.status === "cancelled") return { text: jackPutAway(p), tone: "#64748B" };
  if (p.status === "expired") {
    return { text: what === "estimate"
      ? "This card is more than a day old, so I put it away. Nothing was sent. Ask me again and I'll look at the estimate fresh."
      : "This draft is more than a day old, so I put it away. Nothing was sent. Ask me again and I'll read their record fresh.", tone: "#64748B" };
  }
  return null;
}
/** Why a card was put away: the server's sentence (a newer card replaced it, or an older one was being
 *  sent when it was made), else Not now. Nothing was sent either way. */
function jackPutAway(p) {
  const f = typeof p.failure === "string" ? p.failure.trim() : "";
  if (!f) return "Put away. Nothing was sent.";
  return /Nothing was sent\.$/.test(f) ? f : `${f} Nothing was sent.`;
}
/** A send card refused because the customer was merged into another record (sends.ts atPress): the
 *  record at its id is gone from the hub (contact reads skip merged_into), so the card offers no
 *  Open their record, and its sentence says to look them up again. */
const jackMergedAway = (p) => p.status === "failed" && /was merged into another record/.test(String(p.failure || ""));
/** Who a send card goes to, for its title: the record's whole name. */
const jackWho = (pv) => pv.fullName || pv.firstName || "this customer";
/** The line under the title: their company and town, so two people with one name can be told apart. */
const jackWhere = (pv) => [pv.company, pv.town].filter((x) => typeof x === "string" && x.trim()).join(" · ");
/** Where a send card goes, right under who: "To (816) 555-0142", or "To dale@example.com". Approve posts
 *  exactly this back, so the server knows the page showed it. */
const jackTo = (pv) => (typeof pv.to === "string" && pv.to.trim() ? pv.to.trim() : "");
/** A ready send card from before 11-09 says nowhere where it goes: it can't be sent, so it says so. */
const JACK_NO_WHERE = "This card doesn't show where it goes, so it can't be sent. Ask me again and I'll make a fresh card.";
const jackToLine = { fontSize: 12.5, fontWeight: 600, color: "#1E293B", marginTop: 2, overflowWrap: "anywhere" };
const jackRuleBox = { fontSize: 12, fontWeight: 600, color: "#B45309", background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 8, padding: "6px 8px", marginTop: 8, lineHeight: 1.45 };

function JackDraftCard({ proposal, viewingName, onChanged, onNavigate }) {
  const p = proposal;
  const pv = p.preview || {};
  const sends = p.kind === "reply_send";
  const titleRef = useRef(null);
  const { busy, err, setErr, call, lost } = useJackSend(p, onChanged, titleRef);
  const [copied, setCopied] = useState("");
  const timer = useRef(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const isText = pv.channel === "sms";
  const body = String(pv.body || "");
  const subject = String(pv.subject || "");
  const facts = Array.isArray(pv.factsUsed) ? pv.factsUsed : [];
  const allNotes = Array.isArray(pv.notes) ? pv.notes : [];
  const live = p.status === "ready";
  const sending = busy === "proposal_approve";
  const res = p.result || {};
  const waiting = sends && live && res.waiting && typeof res.waiting === "object" ? res.waiting : null;
  // The team in view-as can't text from here: the record page hides texting, and the server refuses it.
  const noTextHere = sends && isText && !!viewingName;
  // A send card that doesn't say where it goes (made before 11-09) can only be refused at the press, so it
  // offers no Approve and says to ask again.
  const noWhere = sends && live && !noTextHere && !jackTo(pv);
  const canSend = sends && live && !!p.hash && !noTextHere && !noWhere;
  // What can't be undone is said once, right above Approve, in words that match the button. drafts.ts
  // OLD_PAGE_NOTE ("Reload the page...", for a page from before round 2) is left out here.
  const backNote = sends ? allNotes.find((n) => /can't be taken back/i.test(String(n))) : undefined;
  // A view-as text draft says texting isn't available in its own line, once.
  const viewAsDraft = !sends && isText && !!viewingName && live;
  const notes = allNotes.filter((n) => n !== backNote && !(viewAsDraft && n === JACK_NO_TEXT_NOTE));
  const ruleNotes = sends && Array.isArray(pv.ruleNotes) ? pv.ruleNotes : [];
  // Quiet where they live when the card was made; gone once texting hours have opened, and never said to
  // someone who can't send it from here anyway.
  const quiet = canSend && isText && !waiting && pv.quiet && pv.quiet.sentence && !(Date.parse(pv.quiet.opensAt) <= Date.now()) ? pv.quiet : null;
  // A press again works only inside the card's 24 hours, so a time after that is never offered.
  const insideCard = (iso) => Date.parse(iso) < Date.parse(p.expiresAt || "");
  // Until texting hours open there, a press sends nothing: the line above Approve says so.
  const opensAt = canSend && isText ? (waiting && waiting.retryAt && insideCard(waiting.retryAt) && Date.parse(waiting.retryAt) > Date.now() ? waiting.retryAt : quiet ? quiet.opensAt : null) : null;
  const after = sends ? jackSendSays(p, "reply", sending) : null;
  const btn = (bg, fg, border) => ({ ...S.btn(bg, fg), padding: "8px 14px", ...(border ? { border: "1px solid " + border } : {}) });
  const copy = async (what, words) => {
    setErr("");
    const done = () => {
      setCopied(what);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(""), 1600);
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(words); done(); return; }
    } catch (_e) { /* the prompt below */ }
    window.prompt("Copy this:", words);
  };
  // The same route Conversations uses: the deal comes picked, the Messages or Emails chip is open, and
  // Back returns here. Ids only: no words of the draft go into the address or the history.
  const openRecord = () => {
    if (!onNavigate || !pv.contactId) return;
    onNavigate("contacts", "c-" + pv.contactId, false, { deal: pv.dealKey || null, chip: isText ? "messages" : "emails", from: { page: "jack" } });
  };
  // Cleared 30 days after it was made (jack-agent PRIVATE_KEEP_DAYS): no words, no buttons. The title
  // never names the customer, so it stays.
  if (pv.cleared === true) {
    const at = jackAt(res.at || p.appliedAt);
    return (
      <div data-jack-card={p.id} data-kind={p.kind} data-status={p.status} data-cleared="1" style={{ border: "1px solid #E2E8F0", borderRadius: 10, padding: 14, background: "#FFF", marginTop: 8, maxWidth: "100%" }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#1E293B", overflowWrap: "anywhere" }}>{p.title}</div>
        <div role="status" style={{ fontSize: 13, color: "#64748B", marginTop: 6 }}>
          {sends && p.status === "applied" ? `${at ? `Sent at ${at}.` : "Sent."} Its words were cleared from here after 30 days, and it's still on their record.` : "This draft was cleared after 30 days."}
        </div>
      </div>
    );
  }
  // "From this card": their record may hold an earlier send of the same thing. And while a lost press's
  // sentence shows (it may have gone), the card doesn't also say nothing went.
  const nothingYet = lost ? "" : "Nothing has been sent from this card yet.";
  const waitSaid = waiting ? String(waiting.sentence || "Nothing was sent.") : "";
  const readyLine = !sends
    ? (isText && viewingName
      ? "Nothing has been sent. Texting isn't available while you're viewing another account: copy it for the builder to send, or ask me for an email instead."
      : "Nothing has been sent. Read it, change anything you like, and send it from their record.")
    : noWhere
    ? `${nothingYet} ${JACK_NO_WHERE}`.trim()
    : waiting
    ? `${lost ? waitSaid.replace(/^Nothing was sent\.\s*/, "") : waitSaid}${waiting.retryAt && canSend && insideCard(waiting.retryAt) ? ` You can press Approve again from ${jackAt(waiting.retryAt)} your time.` : ""}`.trim()
    : noTextHere
    ? nothingYet
    : `${nothingYet} Approve sends exactly these words. To change a word, ask me to write it again.`.trim();
  return (
    <div data-jack-card={p.id} data-kind={p.kind} data-status={p.status} style={{ border: "1px solid #E2E8F0", borderRadius: 10, padding: 14, background: "#FFF", marginTop: 8, maxWidth: "100%" }}>
      <div ref={titleRef} tabIndex={-1} style={{ fontSize: 14, fontWeight: 700, color: "#1E293B", overflowWrap: "anywhere", outline: "none" }}>{isText ? "Text" : "Email"} to {jackWho(pv)}</div>
      {jackWhere(pv) && <div data-jack-send-who="" style={{ fontSize: 12, color: "#64748B", marginTop: 2, overflowWrap: "anywhere" }}>{jackWhere(pv)}</div>}
      {jackTo(pv) && <div data-jack-send-to="" style={jackToLine}>To {jackTo(pv)}</div>}
      {live && typeof pv.sameName === "string" && pv.sameName && <div data-jack-same-name="" style={jackRuleBox}>{pv.sameName}</div>}
      {pv.dealLabel && <div style={{ fontSize: 12, color: "#64748B", marginTop: 2, overflowWrap: "anywhere" }}>About {jackKeepNumbers(pv.dealLabel)}</div>}
      {viewingName && live && <div style={{ fontSize: 12, color: "#B45309", marginTop: 4 }}>This is <b>{viewingName}</b>'s customer.</div>}
      <div role="status" style={{ fontSize: 13, color: after ? after.tone : waiting ? "#B45309" : "#64748B", marginTop: 6 }}>
        {after ? after.text : live ? readyLine : null}
        {!sends && p.status === "expired" && "This draft is more than a day old, so I put it away. Ask me again and I'll read their record fresh."}
        {!sends && p.status === "cancelled" && jackPutAway(p)}
      </div>
      <div style={{ marginTop: 8, padding: 10, background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 8, opacity: live || sending || p.status === "applying" || p.status === "applied" ? 1 : 0.6 }}>
        {!isText && <div style={{ fontSize: 13, color: "#334155", marginBottom: 6, overflowWrap: "anywhere" }}><b>Subject:</b> {subject}</div>}
        <div style={{ fontSize: 13, color: "#1E293B", whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.5, maxHeight: 320, overflowY: "auto" }}>{body}</div>
        {isText && <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 6 }}>{body.length.toLocaleString("en-US")} of 1,600 characters</div>}
      </div>
      {facts.length > 0 && (
        <div style={{ fontSize: 12, color: "#475569", marginTop: 8 }}>
          <div style={{ fontWeight: 600 }}>Checked against their record ({jackPlural(facts.length, "item", "items")}):</div>
          {facts.map((f, i) => <div key={i} style={{ overflowWrap: "anywhere" }}>{jackKeepNumbers(f)}</div>)}
        </div>
      )}
      {(!sends || live) && notes.map((n, i) => <div key={i} style={{ fontSize: 12, color: "#B45309", marginTop: 6 }}>{n}</div>)}
      {live && ruleNotes.map((n, i) => <div key={i} data-jack-send-rules="" style={jackRuleBox}>{n}</div>)}
      {quiet && <div data-jack-quiet="" style={jackRuleBox}>{quiet.sentence} You can approve it from {jackAt(quiet.opensAt)} your time.</div>}
      {noTextHere && live && <div style={{ fontSize: 12, color: "#B45309", marginTop: 6 }}>Texting isn't available while you're viewing another account, so this text can't be sent from here.</div>}
      {err && <div role="alert" style={{ fontSize: 13, color: "#B91C1C", marginTop: 8 }}>{err}</div>}
      {/* A text's quiet hours are checked again at the press (the card was made at another hour), so a
          text card never promises "right away". An email has no quiet hours. */}
      {canSend && <div data-jack-send-final="" style={{ fontSize: 12.5, color: "#334155", fontWeight: 600, marginTop: 10 }}>{opensAt
        ? `Approve sends nothing before ${jackAt(opensAt)} your time. A text can't be taken back.`
        : isText
        ? "Approve sends this text now if it's texting hours where they live. A text can't be taken back."
        : "Approve emails this to them right away. An email can't be taken back."}</div>}
      {live && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: canSend ? 6 : 10, alignItems: "center" }}>
          {canSend && (
            <button type="button" disabled={!!busy} onClick={() => call("proposal_approve", { hash: p.hash, send: true, to: jackTo(pv) })} style={jackWaitLook(btn(ACCENT, "#FFF"), busy)}>{sending ? "Sending…" : "Approve"}</button>
          )}
          {pv.contactId && onNavigate && (
            <button type="button" disabled={!!busy} onClick={openRecord} style={jackWaitLook(sends ? btn("#FFF", "#334155", "#CBD5E1") : btn(ACCENT, "#FFF"), busy)}>Open their record</button>
          )}
          {/* Copy only on a draft: words copied from a card that sends could go once by hand and once on Approve. */}
          {!sends && (
            <button type="button" disabled={!!busy} onClick={() => copy("message", body)} style={jackWaitLook(btn("#FFF", "#334155", "#CBD5E1"), busy)}>{isText ? "Copy" : "Copy message"}</button>
          )}
          {!sends && !isText && subject && (
            <button type="button" disabled={!!busy} onClick={() => copy("subject", subject)} style={jackWaitLook(btn("#FFF", "#334155", "#CBD5E1"), busy)}>Copy subject</button>
          )}
          <button type="button" disabled={!!busy} onClick={() => call("proposal_cancel", {})} style={jackWaitLook(btn("#FFF", "#334155", "#CBD5E1"), busy)}>{busy === "proposal_cancel" ? "Putting it away…" : "Not now"}</button>
          {!sends && <span role="status" aria-live="polite" style={{ fontSize: 12, color: "#047857" }}>{copied ? `Copied the ${copied}.` : ""}</span>}
        </div>
      )}
      {sends && !live && !sending && (p.status === "applied" || p.status === "partly_applied" || p.status === "failed") && !jackMergedAway(p) && pv.contactId && onNavigate && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
          <button type="button" onClick={openRecord} style={btn("#FFF", "#334155", "#CBD5E1")}>Open their record</button>
        </div>
      )}
    </div>
  );
}
JACK_CARDS.reply_draft = JackDraftCard;
JACK_CARDS.reply_send = JackDraftCard;

// renders: estimate_resend (register: JACK_CARDS.estimate_resend = JackEstimateResendCard;)
// props: { proposal, viewingName, onChanged, onNavigate }, the props JackAnyCard already passes (onSay and busy are ignored).
// preview = { contactId, dealKey (the design's code), firstName, fullName, company, town, to (the address saved on
//   the estimate, 11-09), sameName (a sentence, or null), dealLabel, estimateNumber,
//   total ("$8,450" or null), lastSentOn (ISO, or null when it can't be told: no row), ageDays (from when it was made),
//   notes: string[], ruleNotes: string[] }.
// result: as a reply_send card's (sent, refused, unclear). Never "waiting": an email has no quiet hours.
// One of a customer's Structure Studio estimates, emailed to them again (jack-agent sends.ts) on Approve, once,
// through the Orders screen's own route, to the address saved on the estimate. Nothing to undo once it goes.
// Place it AFTER `const JACK_CARDS = {};`.
function JackEstimateResendCard({ proposal, viewingName, onChanged, onNavigate }) {
  const p = proposal;
  const pv = p.preview || {};
  const titleRef = useRef(null);
  const { busy, err, call, lost } = useJackSend(p, onChanged, titleRef);
  const live = p.status === "ready";
  const sending = busy === "proposal_approve";
  const res = p.result || {};
  const number = String(pv.estimateNumber || "");
  const label = String(pv.dealLabel || "");
  // dealLabel ends with the estimate's own number, which has its own row here.
  const tail = number ? `, estimate ${number}` : "";
  const building = tail && label.endsWith(tail) ? label.slice(0, -tail.length) : label;
  const allNotes = Array.isArray(pv.notes) ? pv.notes : [];
  // sends.ts's OLD_PAGE_NOTE is for a page from before round 2: this card says what Approve does itself.
  const backNote = allNotes.find((n) => /can't be taken back/i.test(String(n)));
  const notes = allNotes.filter((n) => n !== backNote);
  const ruleNotes = Array.isArray(pv.ruleNotes) ? pv.ruleNotes : [];
  // No `to` (a card from before 11-09): it can't be sent, so no Approve (as the reply card).
  const noWhere = live && !jackTo(pv);
  const canSend = live && !!p.hash && !noWhere;
  const after = jackSendSays(p, "estimate", sending);
  const days = typeof pv.ageDays === "number" && pv.ageDays >= 0 ? pv.ageDays : null;
  // Once it has gone again, Last sent is that send, so the row never keeps the old date beside "Its sent
  // date moved to today". (No time on the answer is no row.)
  const sentOn = p.status === "applied" ? new Date(res.at || p.appliedAt || "") : pv.lastSentOn ? new Date(pv.lastSentOn) : null;
  const rows = [
    ["Building", building || null],
    ["Total", typeof pv.total === "string" && pv.total ? pv.total : null],
    // No date is no row: the date comes from their record's recent history, which can leave an older
    // send out, so a missing one never says "not sent".
    ["Last sent", sentOn && Number.isFinite(sentOn.getTime()) ? sentOn.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : null],
    ["Age", days === null ? null : `${jackPlural(days, "day", "days")}, from when it was made`],
  ].filter((r) => r[1]);
  const btn = (bg, fg, border) => ({ ...S.btn(bg, fg), padding: "8px 14px", ...(border ? { border: "1px solid " + border } : {}) });
  const openRecord = () => {
    if (!onNavigate || !pv.contactId) return;
    onNavigate("contacts", "c-" + pv.contactId, false, { deal: pv.dealKey || null, chip: "emails", from: { page: "jack" } });
  };
  if (pv.cleared === true) {
    const at = jackAt(res.at || p.appliedAt);
    return (
      <div data-jack-card={p.id} data-kind={p.kind} data-status={p.status} data-cleared="1" style={{ border: "1px solid #E2E8F0", borderRadius: 10, padding: 14, background: "#FFF", marginTop: 8, maxWidth: "100%" }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#1E293B", overflowWrap: "anywhere" }}>{p.title}</div>
        <div role="status" style={{ fontSize: 13, color: "#64748B", marginTop: 6 }}>
          {p.status === "applied" ? `${at ? `Sent at ${at}.` : "Sent."} Its details were cleared from here after 30 days, and it's still on their record.` : "This card was cleared after 30 days."}
        </div>
      </div>
    );
  }
  const td = { padding: "4px 10px 4px 0", fontSize: 13, verticalAlign: "top", overflowWrap: "anywhere" };
  return (
    <div data-jack-card={p.id} data-kind={p.kind} data-status={p.status} style={{ border: "1px solid #E2E8F0", borderRadius: 10, padding: 14, background: "#FFF", marginTop: 8, maxWidth: "100%" }}>
      <div ref={titleRef} tabIndex={-1} style={{ fontSize: 14, fontWeight: 700, color: "#1E293B", overflowWrap: "anywhere", outline: "none" }}>{number ? <>Estimate <span style={{ whiteSpace: "nowrap" }}>{number}</span></> : "An estimate"} for {jackWho(pv)}</div>
      {jackWhere(pv) && <div data-jack-send-who="" style={{ fontSize: 12, color: "#64748B", marginTop: 2, overflowWrap: "anywhere" }}>{jackWhere(pv)}</div>}
      {jackTo(pv) && <div data-jack-send-to="" style={jackToLine}>To {jackTo(pv)}</div>}
      {live && typeof pv.sameName === "string" && pv.sameName && <div data-jack-same-name="" style={jackRuleBox}>{pv.sameName}</div>}
      {viewingName && live && <div style={{ fontSize: 12, color: "#B45309", marginTop: 4 }}>This is <b>{viewingName}</b>'s customer.</div>}
      <div role="status" style={{ fontSize: 13, color: after ? after.tone : "#64748B", marginTop: 6 }}>
        {/* "From this card": their record shows when it last went. Not said beside a lost press's sentence. */}
        {after ? after.text : live && !lost ? `Nothing has been sent from this card yet.${noWhere ? ` ${JACK_NO_WHERE}` : ""}` : live && noWhere ? JACK_NO_WHERE : null}
      </div>
      {rows.length > 0 && (
        <table style={{ borderCollapse: "collapse", marginTop: 8, opacity: live || sending || p.status === "applying" || p.status === "applied" ? 1 : 0.6 }}>
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k}><td style={{ ...td, fontWeight: 600, color: "#475569", whiteSpace: "nowrap" }}>{k}</td><td style={{ ...td, color: "#1E293B" }}>{v}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      {live && notes.map((n, i) => <div key={i} style={{ fontSize: 12, color: "#B45309", marginTop: 6 }}>{n}</div>)}
      {live && ruleNotes.map((n, i) => <div key={i} data-jack-send-rules="" style={jackRuleBox}>{n}</div>)}
      {err && <div role="alert" style={{ fontSize: 13, color: "#B91C1C", marginTop: 8 }}>{err}</div>}
      {canSend && <div data-jack-send-final="" style={{ fontSize: 12.5, color: "#334155", fontWeight: 600, marginTop: 10 }}>Approve emails the estimate right away to the address saved on it. An email can't be taken back.</div>}
      {live && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: canSend ? 6 : 10, alignItems: "center" }}>
          {canSend && (
            <button type="button" disabled={!!busy} onClick={() => call("proposal_approve", { hash: p.hash, send: true, to: jackTo(pv) })} style={jackWaitLook(btn(ACCENT, "#FFF"), busy)}>{sending ? "Sending…" : "Approve"}</button>
          )}
          {pv.contactId && onNavigate && <button type="button" disabled={!!busy} onClick={openRecord} style={jackWaitLook(btn("#FFF", "#334155", "#CBD5E1"), busy)}>Open their record</button>}
          <button type="button" disabled={!!busy} onClick={() => call("proposal_cancel", {})} style={jackWaitLook(btn("#FFF", "#334155", "#CBD5E1"), busy)}>{busy === "proposal_cancel" ? "Putting it away…" : "Not now"}</button>
        </div>
      )}
      {!live && !sending && (p.status === "applied" || p.status === "partly_applied" || p.status === "failed") && !jackMergedAway(p) && pv.contactId && onNavigate && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
          <button type="button" onClick={openRecord} style={btn("#FFF", "#334155", "#CBD5E1")}>Open their record</button>
        </div>
      )}
    </div>
  );
}
JACK_CARDS.estimate_resend = JackEstimateResendCard;

// JACK'S BALANCE LINE, under the composer (plan section 9: "a balance line under the chat"). It reads
// portal-billing's own `status` with this person's token (sb.functions.invoke adds the view-as tenant), so a
// figure shows only where the Billing card would show it: portal-billing's `mine`, which is Billing access
// and, for the team, can_bill. jack-agent never sends a money figure. Jack's meter is listed among the
// wallet's meters only once it is armed and Jack is on here (portal-billing onlyIfJackOn), so nothing about
// money shows before then. `refreshKey`: JackTab bumps it after a billed reply, a wallet refusal, or a price
// list card that finished reading.
const JACK_LOW_CENTS = 1000;   // jack-agent/billing.ts LOW_CENTS
const JACK_EMPTY_CENTS = 100;  // jack-agent/billing.ts FLOOR_CENTS.chat
function jackCents(c) {
  const n = Math.round(Number(c) || 0);
  return (n < 0 ? "-$" : "$") + (Math.abs(n) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function JackBalanceLine({ refreshKey, onNavigate }) {
  // undefined: not read yet, or the read failed (then nothing shows rather than a wrong line).
  const [said, setSaid] = useState(undefined);
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const { data, error } = await sb.functions.invoke("portal-billing", { body: { action: "status" } });
        if (!dead) setSaid(!error && data && typeof data === "object" && !data.error ? data : undefined);
      } catch (_e) {
        if (!dead) setSaid(undefined);
      }
    })();
    return () => { dead = true; };
  }, [refreshKey]);
  if (!said) return null;
  const line = { fontSize: 12, color: "#64748B", marginTop: 8, lineHeight: 1.5, display: "flex", flexWrap: "wrap", gap: "2px 10px", alignItems: "baseline" };
  const link = { background: "none", border: "none", padding: 0, color: ACCENT, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" };
  const go = () => { if (onNavigate) onNavigate("settings", "wallet"); };
  const w = said.wallet && typeof said.wallet === "object" ? said.wallet : null;
  // No wallet in the answer (an admin without Billing, or a team member without can_bill): nothing, since
  // whether Jack's meter is even armed can't be told from here, and money talk before then would be wrong.
  if (!w) return null;
  // Exempt for Jack is metered_exempt (wallet.exempt) or billing_exempt (entitlement.exempt).
  if (w.exempt || (said.entitlement && said.entitlement.exempt)) return <div data-jack-balance="exempt" style={line}>Jack isn't charged on this account.</div>;
  const armed = Array.isArray(w.meters) && w.meters.some((m) => m && m.kind === "jack_ai");
  if (!armed) return null;
  const balance = Number(w.balanceCents) || 0;
  const held = Number(w.heldCents) || 0;
  const avail = balance - held;
  const auto = w.autoTopup || {};
  const state = avail < JACK_EMPTY_CENTS ? "Empty" : avail < JACK_LOW_CENTS ? "Low" : null;
  const red = "#B91C1C", amber = "#B45309";
  return (
    <div data-jack-balance={state ? state.toLowerCase() : "ok"} style={line}>
      <span>
        Wallet <b style={{ color: state === "Empty" ? red : "#334155" }}>{jackCents(balance)}</b>
        {held > 0 ? ` (${jackCents(held)} set aside)` : ""}
        {state ? <span style={{ color: state === "Empty" ? red : amber, fontWeight: 700 }}>{" · " + state}</span> : null}
        {auto.enabled ? " · automatic top-up on" : ""}
      </span>
      {!auto.enabled && (
        <span>{auto.disabledReason ? "Automatic top-up switched itself off. Billing says why." : "Turn on automatic top-up so Jack doesn't stop when your credit runs out."}</span>
      )}
      <button type="button" onClick={go} style={link} data-jack-balance-link="">{auto.enabled ? "See what Jack has cost" : "Open Billing"}</button>
    </div>
  );
}

// ── Jack v2: record-change cards (jack-agent inventory.ts, changeorders.ts, buildschedule.ts, delivery.ts, commissions.ts) ──
// renders: inventory_price, inventory_listing, inventory_photos (register: JACK_CARDS.inventory_price = JackInventoryCard; JACK_CARDS.inventory_listing = JackInventoryCard; JACK_CARDS.inventory_photos = JackInventoryCard;)
// props: { proposal, viewingName, onChanged, onNavigate }, the props JackAnyCard already passes (onSay and busy are ignored).
// proposal is proposalView: id, kind, status, title, preview, hash, result, failure, canUndo.
// preview = { unit: { label, lot, status, sold, listed }, lines: [{ label, from, to, long? }], notes: string[],
//   where: "Inventory", route: { page: "inventory", sub: null }, photos?: { from: [{ url, aiEdited }], to: [{ url, aiEdited }] } }.
// result = { saved, created, reports: [{ label, status, reason }], undo?: { restored, removed, failed, reports } }.
// Jack's lot-building cards (jack-agent/inventory.ts): a new asking price or lot, an Online Shop listing, and
// the photo order or cover. The card shows the building, each change with what it is now, the photos before
// and after, and the notes that say what goes public. The server decides which buttons it may show.
// Place it AFTER `const JACK_CARDS = {};`.
function JackInventoryCard({ proposal, viewingName, onChanged, onNavigate }) {
  const p = proposal;
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const titleRef = useRef(null);
  // A sentence about the card as it was doesn't outlive that state.
  useEffect(() => { setErr(""); }, [p.status]);
  const call = async (action, body) => {
    setBusy(action); setErr("");
    try {
      const { data, error } = await sb.functions.invoke("jack-agent", { body: { action, id: p.id, ...body } });
      let said = data;
      if (error && error.context && typeof error.context.json === "function") said = await error.context.json().catch(() => null);
      if (said && said.proposal) onChanged(said.proposal);
      if (error || (said && said.ok === false && !said.proposal)) setErr((said && said.error) || JACK_ERR);
      // The pressed button is about to go, and focus shouldn't fall to the page.
      if (said && said.proposal && titleRef.current) titleRef.current.focus();
    } catch (_e) {
      setErr(JACK_ERR);
    }
    setBusy("");
  };
  const pv = p.preview || {};
  const unit = pv.unit || {};
  const lines = Array.isArray(pv.lines) ? pv.lines : [];
  const notes = Array.isArray(pv.notes) ? pv.notes : [];
  const photos = pv.photos && Array.isArray(pv.photos.from) && Array.isArray(pv.photos.to) ? pv.photos : null;
  const route = pv.route && pv.route.page ? pv.route : null;
  const res = p.result || {};
  const undoInfo = res.undo || null;
  const undoReports = (undoInfo && undoInfo.reports) || [];
  const reports = (undoReports.length ? undoReports : res.reports) || [];
  const undoBack = undoInfo ? (undoInfo.restored || 0) + (undoInfo.removed || 0) : 0;
  const open = p.status === "ready";
  const done = p.status === "applied" || p.status === "partly_applied";
  const hasOld = lines.some((l) => l.from !== undefined && l.from !== null && l.from !== "");
  const btn = (bg, fg, border) => ({ ...S.btn(bg, fg), padding: "8px 14px", ...(border ? { border: "1px solid " + border } : {}) });
  const th = { textAlign: "left", padding: "6px 10px", fontSize: 11, fontWeight: 700, color: "#64748B", borderBottom: "1px solid #E2E8F0", background: "#F8FAFC", whiteSpace: "nowrap" };
  const td = { padding: "6px 10px", fontSize: 13, borderBottom: "1px solid #F1F5F9", verticalAlign: "top", overflowWrap: "anywhere" };
  const longText = { whiteSpace: "pre-wrap", maxHeight: 160, overflowY: "auto", display: "block" };
  const amber = { fontSize: 12, color: "#B45309", background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 8, padding: "6px 8px", marginTop: 6, lineHeight: 1.45 };
  const badge = (bg, fg) => ({ position: "absolute", top: 3, fontSize: 10, fontWeight: 700, color: fg, background: bg, borderRadius: 4, padding: "0 4px", lineHeight: "15px" });
  const stateLine = {
    applying: "Saving…",
    undoing: "Putting it back…",
    expired: "This expired after 24 hours and nothing changed. Ask me again and I'll start from what's there now.",
    cancelled: "Cancelled. Nothing changed.",
    failed: p.failure || "That didn't save. Nothing changed.",
  }[p.status];
  const strip = (list, label) => (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "#64748B", marginBottom: 4 }}>{label}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {list.map((ph, i) => (
          <div key={i} style={{ position: "relative", width: 72, height: 54, borderRadius: 6, overflow: "hidden", border: i === 0 ? "2px solid " + ACCENT : "1px solid #E2E8F0", background: "#F1F5F9" }}>
            {ph.url ? <img src={ph.url} alt={`Photo ${i + 1}`} loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} /> : null}
            {i === 0 && <span style={{ ...badge(ACCENT, "#FFF"), left: 3 }}>Cover</span>}
            {ph.aiEdited && <span style={{ ...badge("rgba(255,255,255,.92)", "#334155"), right: 3 }}>AI</span>}
          </div>
        ))}
      </div>
    </div>
  );
  return (
    <div data-jack-card={p.id} data-kind={p.kind} data-status={p.status} style={{ border: "1px solid #E2E8F0", borderRadius: 10, padding: 14, background: "#FFF", marginTop: 8, maxWidth: "100%" }}>
      <div ref={titleRef} tabIndex={-1} style={{ fontSize: 14, fontWeight: 700, color: "#1E293B", overflowWrap: "anywhere", outline: "none" }}>{p.title}</div>
      {(unit.lot || unit.status) && (
        <div style={{ fontSize: 12, color: "#64748B", marginTop: 2 }}>
          {[unit.lot, unit.status, unit.sold ? "Sold" : null, unit.listed ? "On your Online Shop" : null].filter(Boolean).join(" · ")}
        </div>
      )}
      <div role="status">
        {stateLine && <div style={{ fontSize: 13, color: p.status === "failed" ? "#B91C1C" : "#64748B", marginTop: 6 }}>{stateLine}</div>}
      </div>

      {lines.length > 0 && p.status !== "failed" && (
        <div style={{ marginTop: 10, overflowX: "auto", border: "1px solid #E2E8F0", borderRadius: 8 }}>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead><tr>
              <th style={th}>What</th>
              {hasOld && <th style={th}>Now</th>}
              <th style={th}>New</th>
            </tr></thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td style={{ ...td, fontWeight: 600, color: "#334155", whiteSpace: "nowrap" }}>{l.label}</td>
                  {hasOld && (
                    <td style={{ ...td, color: "#94A3B8" }}>
                      {l.from
                        ? <span style={{ ...(l.long ? longText : {}), textDecoration: open && !l.long ? "line-through" : "none" }}>{String(l.from)}</span>
                        : <span style={{ color: "#CBD5E1" }}>blank</span>}
                    </td>
                  )}
                  <td style={{ ...td, color: "#1E293B", fontWeight: 600 }}>
                    {l.to ? <span style={l.long ? { ...longText, fontWeight: 400 } : {}}>{String(l.to)}</span> : <span style={{ color: "#CBD5E1", fontWeight: 400 }}>blank</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {photos && p.status !== "failed" && (
        <div>
          {strip(photos.from, open ? "Now" : "Before")}
          {strip(photos.to, open ? "New order" : "After")}
          <div style={{ fontSize: 11.5, color: "#94A3B8", marginTop: 4 }}>The first photo is the cover. Nothing is added or removed.</div>
        </div>
      )}

      {(open || done) && notes.map((n, i) => <div key={i} style={amber}>{n}</div>)}
      {open && viewingName && <div style={{ fontSize: 12, color: "#B45309", marginTop: 10 }}>This is <b>{viewingName}</b>'s inventory. Your name goes on the record.</div>}
      {err && <div role="alert" style={{ fontSize: 13, color: "#B91C1C", marginTop: 8 }}>{err}</div>}

      <div role="status">
        {done && (
          <div style={{ fontSize: 13, color: p.status === "applied" ? "#047857" : "#B45309", marginTop: 8 }}>
            {p.status === "applied" ? "Saved." : "Some of it didn't save. It's listed here."}
          </div>
        )}
        {done && undoInfo && undoInfo.failed > 0 && <div style={{ fontSize: 13, color: "#B45309", marginTop: 8 }}>That didn't all go back. Press Undo to try again.</div>}
        {p.status === "undone" && (
          <div style={{ fontSize: 13, color: undoReports.length ? "#B45309" : "#047857", marginTop: 8 }}>
            {!undoReports.length ? "Put back." : undoBack ? "Put back, except what's listed here." : "That stayed as it is:"}
          </div>
        )}
      </div>
      {reports.length > 0 && (
        <div style={{ marginTop: 6, fontSize: 12, color: "#B45309", maxHeight: 200, overflowY: "auto" }}>
          {reports.map((r, i) => <div key={i} style={{ overflowWrap: "anywhere" }}>{r.label}: {r.reason}</div>)}
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
        {open && p.hash && (
          <button type="button" disabled={!!busy} onClick={() => call("proposal_approve", { hash: p.hash })} style={{ ...btn(ACCENT, "#FFF"), opacity: busy ? 0.6 : 1 }}>{busy === "proposal_approve" ? "Saving…" : "Approve"}</button>
        )}
        {open && (
          <button type="button" disabled={!!busy} onClick={() => call("proposal_cancel", {})} style={btn("#FFF", "#334155", "#CBD5E1")}>Cancel</button>
        )}
        {p.canUndo && (
          <button type="button" disabled={!!busy} onClick={() => call("proposal_undo", {})} style={btn("#FFF", "#334155", "#CBD5E1")}>{busy === "proposal_undo" ? "Putting it back…" : "Undo"}</button>
        )}
        {route && !open && (
          <button type="button" onClick={() => onNavigate && onNavigate(route.page, route.sub || null)} style={btn("#FFF", "#334155", "#CBD5E1")}>
            {`Open ${pv.where || "Inventory"}`}
          </button>
        )}
      </div>
    </div>
  );
}
JACK_CARDS.inventory_price = JackInventoryCard;
JACK_CARDS.inventory_listing = JackInventoryCard;
JACK_CARDS.inventory_photos = JackInventoryCard;

// renders: changeorder_attrs, changeorder_unlock (register: JACK_CARDS.changeorder_attrs = JackChangeOrderCard; JACK_CARDS.changeorder_unlock = JackChangeOrderCard;)
// props: { proposal, viewingName, onChanged, onNavigate }, the props JackAnyCard already passes (onSay and busy are ignored).
// proposal is proposalView: id, kind, status, title, preview, hash, result, failure, canUndo.
// preview (changeorder_attrs) = { order: { no, building, totalCents }, lines: [{ label, from, to }], totals: { beforeCents, afterCents },
//   description (the exact words the customer signs), fee: { cents, taxable, label } | null, feeSay?, notes: string[],
//   rules: string[], rulesSay: string | null, link: { page: "orders", sub: "o-<id>" }, where }.
// preview (changeorder_unlock) = { order, reason, notes: string[], link, where }.
// result = { changeOrders, coNo, emailed, reports: [{ label, status, reason }], undo?: { restored, removed, failed, reports } }.
// Jack's change-order cards (jack-agent/changeorders.ts): a roof, cladding or paint change on a signed order, staged and
// emailed to the customer on Approve, and a request to unlock a locked order. Money is in cents (jackMoney(cents / 100)).
// changeorder_attrs is a send card (changeorders.ts sends: true): its Approve posts { hash, send: true }, like a reply's
// or an estimate's, because this page shows the words the customer signs. The line right above it says it emails the
// customer and that an email can't be taken back, and the card has no Copy. changeorder_unlock posts { hash } only.
// An Approve whose answer never came back reads the card again, and never says to try again: it may have gone.
// Place it AFTER `const JACK_CARDS = {};`.
const JACK_CO_LOST = "I didn't hear back from that press. Check the order before pressing it again.";
function JackChangeOrderCard({ proposal, viewingName, onChanged, onNavigate }) {
  const p = proposal;
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const titleRef = useRef(null);
  // A sentence about the card as it was doesn't outlive that state.
  useEffect(() => { setErr(""); }, [p.status]);
  const reread = async () => {
    try {
      const { data } = await sb.functions.invoke("jack-agent", { body: { action: "proposal_get", id: p.id } });
      if (data && data.proposal) onChanged(data.proposal);
    } catch (_e) { /* the card stays as it was, and the server still refuses a second press */ }
  };
  const call = async (action, body) => {
    if (busy) return;
    setBusy(action); setErr("");
    const approving = action === "proposal_approve";
    // An Approve that brings no card back (a refusal before the claim, a fault, or a lost answer) reads the
    // card again: it may be staging, or emailed, by now.
    let cardBack = false;
    try {
      const { data, error } = await sb.functions.invoke("jack-agent", { body: { action, id: p.id, ...body } });
      let said = data;
      if (error && error.context && typeof error.context.json === "function") said = await error.context.json().catch(() => null);
      if (said && said.proposal) { onChanged(said.proposal); cardBack = true; }
      // A refusal comes back with its sentence; no sentence means the answer was lost.
      if (error || (said && said.ok === false && !said.proposal)) setErr((said && said.error) || (approving ? JACK_CO_LOST : JACK_ERR));
      // The pressed button is about to go, and focus shouldn't fall to the page.
      if (cardBack && titleRef.current) titleRef.current.focus();
    } catch (_e) {
      setErr(approving ? JACK_CO_LOST : JACK_ERR);
    }
    if (approving && !cardBack) await reread();
    setBusy("");
  };
  const pv = p.preview || {};
  const isUnlock = p.kind === "changeorder_unlock";
  const order = pv.order || {};
  const lines = Array.isArray(pv.lines) ? pv.lines : [];
  const allNotes = Array.isArray(pv.notes) ? pv.notes : [];
  // What Approve does is said once, right above it, with what can't be taken back (as a reply's and an
  // estimate's card say it): the server's own "Approve stages it..." note moves there.
  const approveNote = isUnlock ? undefined : allNotes.find((n) => /^Approve /.test(String(n)));
  const notes = allNotes.filter((n) => n !== approveNote);
  const canSend = !isUnlock && p.status === "ready" && !!p.hash;
  const finalLine = `${approveNote || "Approve stages it and emails it to the customer to sign."} An email can't be taken back.`;
  const totals = pv.totals || null;
  const res = p.result || {};
  const undoInfo = res.undo || null;
  const undoReports = (undoInfo && undoInfo.reports) || [];
  // Once it's undone, what Approve said ("... Undo discards it.") is over: only Undo's own lines show.
  const reports = (p.status === "undone" || undoReports.length ? undoReports : res.reports) || [];
  // "moved": the void put the building back but the customer answered first, so it wasn't left alone.
  const undoMoved = undoReports.some((r) => r && r.status === "moved");
  const open = p.status === "ready";
  const done = p.status === "applied" || p.status === "partly_applied";
  const money = (c) => jackMoney(Math.round(Number(c) || 0) / 100);
  const coName = res.coNo ? `CO-${res.coNo}` : "The change order";
  const btn = (bg, fg, border) => ({ ...S.btn(bg, fg), padding: "8px 14px", ...(border ? { border: "1px solid " + border } : {}) });
  const small = { fontSize: 12, color: "#64748B", marginTop: 6, lineHeight: 1.45 };
  const amber = { fontSize: 12, fontWeight: 600, color: "#B45309", background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 8, padding: "6px 8px", marginTop: 8, lineHeight: 1.45 };
  const th = { textAlign: "left", padding: "6px 10px", fontSize: 11, fontWeight: 700, color: "#64748B", borderBottom: "1px solid #E2E8F0", background: "#F8FAFC", whiteSpace: "nowrap" };
  const td = { padding: "6px 10px", fontSize: 13, borderBottom: "1px solid #F1F5F9", verticalAlign: "top", overflowWrap: "anywhere" };
  const stateLine = {
    applying: isUnlock ? "Sending the request…" : "Staging it and emailing the customer…",
    undoing: "Discarding it…",
    expired: "This expired after 24 hours and nothing changed. Ask me again and I'll start from the order as it is now.",
    cancelled: "Cancelled. Nothing changed.",
    failed: p.failure || "That didn't go through. Nothing changed.",
  }[p.status];
  const change = totals ? totals.afterCents - totals.beforeCents : 0;
  const link = pv.link && pv.link.page ? pv.link : null;
  return (
    <div data-jack-card={p.id} data-kind={p.kind} data-status={p.status} style={{ border: "1px solid #E2E8F0", borderRadius: 10, padding: 14, background: "#FFF", marginTop: 8, maxWidth: "100%" }}>
      <div ref={titleRef} tabIndex={-1} style={{ fontSize: 14, fontWeight: 700, color: "#1E293B", overflowWrap: "anywhere", outline: "none" }}>{p.title}</div>
      {(order.no || order.building) && (
        <div style={{ fontSize: 12, color: "#64748B", marginTop: 4 }}>
          {[order.no ? `Order #${order.no}` : null, order.building || null].filter(Boolean).join(" · ")}
        </div>
      )}
      <div role="status">
        {stateLine && <div style={{ fontSize: 13, color: p.status === "failed" ? "#B91C1C" : "#64748B", marginTop: 6 }}>{stateLine}</div>}
      </div>

      {!isUnlock && lines.length > 0 && p.status !== "failed" && (
        <div style={{ marginTop: 10, overflowX: "auto", border: "1px solid #E2E8F0", borderRadius: 8 }}>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead><tr><th style={th}>What</th><th style={th}>Now</th><th style={th}>New</th></tr></thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td style={{ ...td, fontWeight: 600, color: "#334155" }}>{l.label}</td>
                  <td style={{ ...td, color: "#94A3B8" }}><span style={{ textDecoration: open ? "line-through" : "none" }}>{String(l.from || "none")}</span></td>
                  <td style={{ ...td, color: "#1E293B", fontWeight: 600 }}>{String(l.to || "none")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!isUnlock && totals && p.status !== "failed" && (
        <div style={{ fontSize: 13, color: "#1E293B", marginTop: 8, fontVariantNumeric: "tabular-nums" }}>
          Order total {money(totals.beforeCents)} → <b>{money(totals.afterCents)}</b>
          <span style={{ color: "#64748B" }}> ({change >= 0 ? "+" : "-"}{money(Math.abs(change))})</span>
        </div>
      )}
      {!isUnlock && pv.feeSay && (open || done) && <div style={{ fontSize: 12.5, color: "#334155", marginTop: 4 }}>{pv.feeSay}</div>}
      {!isUnlock && pv.description && (open || done) && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#475569" }}>What the customer signs:</div>
          <div style={{ fontSize: 12.5, color: "#334155", marginTop: 4, whiteSpace: "pre-wrap", overflowWrap: "anywhere", background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 6, padding: "6px 8px" }}>{pv.description}</div>
        </div>
      )}

      {isUnlock && pv.reason && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#475569" }}>What needs changing, for whoever unlocks it:</div>
          <div style={{ fontSize: 12.5, color: "#334155", marginTop: 4, whiteSpace: "pre-wrap", overflowWrap: "anywhere", background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 6, padding: "6px 8px" }}>{pv.reason}</div>
        </div>
      )}

      {open && notes.map((n, i) => (
        <div key={i} data-jack-co-rules={n === pv.rulesSay ? "" : undefined} style={n === pv.rulesSay ? amber : small}>{n}</div>
      ))}
      {open && viewingName && <div style={{ fontSize: 12, color: "#B45309", marginTop: 8 }}>This is <b>{viewingName}</b>'s order. Your name goes on the record.</div>}
      {err && <div role="alert" style={{ fontSize: 13, color: "#B91C1C", marginTop: 8 }}>{err}</div>}
      {canSend && <div data-jack-send-final="" style={{ fontSize: 12.5, color: "#334155", fontWeight: 600, marginTop: 10 }}>{finalLine}</div>}

      <div role="status">
        {p.status === "applied" && !isUnlock && (
          <div style={{ fontSize: 13, color: "#047857", marginTop: 8 }}>
            {coName} is staged and emailed to the customer to sign.
            <div style={{ ...small, marginTop: 4 }}>An email can't be taken back, so there's no Undo. If it shouldn't stand, a person voids it under Change orders on the order and speaks to the customer.</div>
          </div>
        )}
        {p.status === "applied" && isUnlock && (
          <div style={{ fontSize: 13, color: "#047857", marginTop: 8 }}>Asked. Whoever approves changes sees it on the order and decides it.</div>
        )}
        {p.status === "partly_applied" && <div style={{ fontSize: 13, color: "#B45309", marginTop: 8 }}>Not all of it went through:</div>}
        {done && undoInfo && undoInfo.failed > 0 && !undoReports.length && <div style={{ fontSize: 13, color: "#B45309", marginTop: 8 }}>That didn't go through. Press Undo to try again.</div>}
        {p.status === "undone" && (
          <div style={{ fontSize: 13, color: undoReports.length ? "#B45309" : "#047857", marginTop: 8 }}>
            {undoMoved ? "Check the order now:"
              : undoReports.length ? "I left it as it is:"
              : `Discarded. The building is back to what it was, and Jack never emailed it to the customer.${pv.rulesSay ? " Anything one of your rules sent when it was staged stays sent." : ""}`}
          </div>
        )}
      </div>
      {reports.length > 0 && (
        <div style={{ marginTop: 6, fontSize: 12, color: "#B45309" }}>
          {reports.map((r, i) => <div key={i} style={{ overflowWrap: "anywhere" }}>{r.reason}</div>)}
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: canSend ? 6 : 10 }}>
        {open && p.hash && (
          <button type="button" disabled={!!busy} onClick={() => call("proposal_approve", isUnlock ? { hash: p.hash } : { hash: p.hash, send: true })} style={{ ...btn(ACCENT, "#FFF"), opacity: busy ? 0.6 : 1 }}>
            {busy === "proposal_approve" ? (isUnlock ? "Sending…" : "Staging…") : isUnlock ? "Approve and ask" : "Approve and send"}
          </button>
        )}
        {open && <button type="button" disabled={!!busy} onClick={() => call("proposal_cancel", {})} style={btn("#FFF", "#334155", "#CBD5E1")}>Cancel</button>}
        {p.canUndo && (
          <button type="button" disabled={!!busy} onClick={() => call("proposal_undo", {})} style={btn("#FFF", "#334155", "#CBD5E1")}>{busy === "proposal_undo" ? "Discarding…" : "Undo (discard it)"}</button>
        )}
        {link && !open && (
          <button type="button" onClick={() => onNavigate && onNavigate(link.page, link.sub || null)} style={btn("#FFF", "#334155", "#CBD5E1")}>Open the order</button>
        )}
      </div>
      {p.canUndo && <div style={small}>Undo only if nobody has emailed it to the customer since.</div>}
    </div>
  );
}
JACK_CARDS.changeorder_attrs = JackChangeOrderCard;
JACK_CARDS.changeorder_unlock = JackChangeOrderCard;

// renders: build_job_add, build_job_change, build_job_built (register: JACK_CARDS.build_job_add = JackBuildScheduleCard; JACK_CARDS.build_job_change = JackBuildScheduleCard; JACK_CARDS.build_job_built = JackBuildScheduleCard;)
// props: { proposal, viewingName, onChanged, onNavigate }, the props JackAnyCard already passes (onSay and busy are ignored).
// proposal is proposalView: id, kind, status, title, preview, hash, result, failure, canUndo.
// preview = { action: "add" | "change" | "built", job: { building, customer, serial, what, column, buildDate, crew, repairWords? },
//   lines: [{ label, from, to }], notes: string[] (warnings, the rule sentence among them), keeps: string[] (what Undo can't
//   take back), where: "Build Schedule", route: { page: "build-schedule", sub: null } }.
// result = { saved, created, reports: [{ label, status, reason }], notes?: string[], undo?: { restored, removed, failed, reports } }.
// Jack's build schedule cards (jack-agent/buildschedule.ts): a building put on the schedule, a build date, crew or card note
// changed, and a job marked built. The card shows the job as the board has it, each change with what it is now, and what
// Undo can't take back. A job Jack adds has no Undo, and the card says how a person removes it. The server decides which
// buttons it may show. Place it AFTER `const JACK_CARDS = {};`.
function JackBuildScheduleCard({ proposal, viewingName, onChanged, onNavigate }) {
  const p = proposal;
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const titleRef = useRef(null);
  // A sentence about the card as it was doesn't outlive that state.
  useEffect(() => { setErr(""); }, [p.status]);
  const call = async (action, body) => {
    setBusy(action); setErr("");
    try {
      const { data, error } = await sb.functions.invoke("jack-agent", { body: { action, id: p.id, ...body } });
      let said = data;
      if (error && error.context && typeof error.context.json === "function") said = await error.context.json().catch(() => null);
      if (said && said.proposal) onChanged(said.proposal);
      if (error || (said && said.ok === false && !said.proposal)) setErr((said && said.error) || JACK_ERR);
      // The pressed button is about to go, and focus shouldn't fall to the page.
      if (said && said.proposal && titleRef.current) titleRef.current.focus();
    } catch (_e) {
      setErr(JACK_ERR);
    }
    setBusy("");
  };
  const pv = p.preview || {};
  const act = pv.action || (p.kind === "build_job_add" ? "add" : p.kind === "build_job_built" ? "built" : "change");
  const job = pv.job || {};
  const lines = Array.isArray(pv.lines) ? pv.lines : [];
  const notes = Array.isArray(pv.notes) ? pv.notes : [];
  const keeps = Array.isArray(pv.keeps) ? pv.keeps : [];
  const route = pv.route && pv.route.page ? pv.route : { page: "build-schedule", sub: null };
  const res = p.result || {};
  const resNotes = Array.isArray(res.notes) ? res.notes : [];
  const undoInfo = res.undo || null;
  const undoReports = (undoInfo && undoInfo.reports) || [];
  const reports = (undoReports.length ? undoReports : res.reports) || [];
  const undoBack = undoInfo ? (undoInfo.restored || 0) + (undoInfo.removed || 0) : 0;
  const open = p.status === "ready";
  const done = p.status === "applied" || p.status === "partly_applied";
  const hasOld = lines.some((l) => l.from !== undefined && l.from !== null && l.from !== "");
  const btn = (bg, fg, border) => ({ ...S.btn(bg, fg), padding: "8px 14px", ...(border ? { border: "1px solid " + border } : {}) });
  const th = { textAlign: "left", padding: "6px 10px", fontSize: 11, fontWeight: 700, color: "#64748B", borderBottom: "1px solid #E2E8F0", background: "#F8FAFC", whiteSpace: "nowrap" };
  const td = { padding: "6px 10px", fontSize: 13, borderBottom: "1px solid #F1F5F9", verticalAlign: "top", overflowWrap: "anywhere", whiteSpace: "pre-wrap" };
  const amber = { fontSize: 12, fontWeight: 600, color: "#B45309", background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 8, padding: "6px 8px", marginTop: 8, lineHeight: 1.45 };
  const small = { fontSize: 12, color: "#64748B", marginTop: 6, lineHeight: 1.45 };
  const stateLine = {
    applying: "Saving…",
    undoing: "Putting it back…",
    expired: "This expired after 24 hours and nothing changed. Ask me again and I'll start from the board as it is now.",
    cancelled: "Cancelled. Nothing changed.",
    failed: p.failure || "That didn't work. Nothing changed.",
  }[p.status];
  const doneWords = act === "add"
    ? "Added to the build schedule. There's no Undo for this: if it shouldn't be there, press Remove on the job."
    : act === "built" ? "Marked built." : "Saved.";
  const head = [job.building, job.serial].filter(Boolean).join(" ");
  const facts = [job.what, act !== "add" && job.column, act !== "add" && job.buildDate && `build date ${job.buildDate}`, act !== "add" && job.crew].filter(Boolean);
  return (
    <div data-jack-card={p.id} data-kind={p.kind} data-status={p.status} style={{ border: "1px solid #E2E8F0", borderRadius: 10, padding: 14, background: "#FFF", marginTop: 8, maxWidth: "100%" }}>
      <div ref={titleRef} tabIndex={-1} style={{ fontSize: 14, fontWeight: 700, color: "#1E293B", overflowWrap: "anywhere", outline: "none" }}>{p.title}</div>
      <div role="status">
        {stateLine && <div style={{ fontSize: 13, color: p.status === "failed" ? "#B91C1C" : "#64748B", marginTop: 6 }}>{stateLine}</div>}
      </div>

      {(head || job.customer || facts.length > 0) && (
        <div data-jack-build-job="" style={{ marginTop: 8, padding: "8px 10px", border: "1px solid #E2E8F0", borderRadius: 8, background: "#F8FAFC" }}>
          {(head || job.customer) && (
            <div style={{ fontSize: 13, fontWeight: 600, color: "#1E293B", overflowWrap: "anywhere" }}>
              {head}{head && job.customer ? " · " : ""}{job.customer || ""}
            </div>
          )}
          {facts.length > 0 && <div style={{ fontSize: 12, color: "#64748B", marginTop: 2, overflowWrap: "anywhere" }}>{facts.join(" · ")}</div>}
          {job.repairWords && <div style={{ fontSize: 12, color: "#475569", marginTop: 4, overflowWrap: "anywhere" }}>{job.repairWords}</div>}
        </div>
      )}

      {lines.length > 0 && p.status !== "failed" && (
        <div style={{ marginTop: 10, overflowX: "auto", border: "1px solid #E2E8F0", borderRadius: 8 }}>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead><tr>
              <th style={th}>What</th>
              {hasOld && <th style={th}>Now</th>}
              <th style={th}>{act === "add" ? "On the schedule" : "New"}</th>
            </tr></thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td style={{ ...td, fontWeight: 600, color: "#334155", whiteSpace: "nowrap" }}>{l.label}</td>
                  {hasOld && (
                    <td style={{ ...td, color: "#94A3B8" }}>
                      {l.from ? <span style={{ textDecoration: open ? "line-through" : "none" }}>{String(l.from)}</span> : <span style={{ color: "#CBD5E1" }}>none</span>}
                    </td>
                  )}
                  <td style={{ ...td, color: "#1E293B", fontWeight: 600 }}>{l.to ? String(l.to) : <span style={{ color: "#CBD5E1", fontWeight: 400 }}>none</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(open || done) && notes.map((n, i) => <div key={i} data-jack-build-note="" style={amber}>{n}</div>)}
      {open && keeps.map((k, i) => <div key={i} style={small}>{k}</div>)}
      {open && act === "change" && <div style={small}>Undo puts each change back, unless someone changes it first.</div>}
      {open && viewingName && <div style={{ fontSize: 12, color: "#B45309", marginTop: 10 }}>This is <b>{viewingName}</b>'s build schedule. Your name goes on the record.</div>}
      {err && <div role="alert" style={{ fontSize: 13, color: "#B91C1C", marginTop: 8 }}>{err}</div>}

      <div role="status">
        {done && (
          <div style={{ fontSize: 13, color: p.status === "applied" ? "#047857" : "#B45309", marginTop: 8 }}>
            {p.status === "applied" ? doneWords : "I couldn't tell if all of it saved. It's listed here."}
          </div>
        )}
        {done && resNotes.map((n, i) => <div key={i} style={{ fontSize: 12, color: "#B45309", marginTop: 4 }}>{n}</div>)}
        {done && undoInfo && undoInfo.failed > 0 && <div style={{ fontSize: 13, color: "#B45309", marginTop: 8 }}>That didn't all go back. Press Undo to try again.</div>}
        {p.status === "undone" && (
          <div style={{ fontSize: 13, color: undoReports.length ? "#B45309" : "#047857", marginTop: 8 }}>
            {!undoReports.length
              ? (act === "built" ? "Put back in its column. Its building serial and anything a rule already sent stay." : "Put back.")
              : undoBack ? "Put back, except what's listed here." : "That stayed as it is:"}
          </div>
        )}
      </div>
      {reports.length > 0 && (
        <div style={{ marginTop: 6, fontSize: 12, color: "#B45309", maxHeight: 200, overflowY: "auto" }}>
          {reports.map((r, i) => <div key={i} style={{ overflowWrap: "anywhere" }}>{r.label}: {r.reason}</div>)}
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
        {open && p.hash && (
          <button type="button" disabled={!!busy} onClick={() => call("proposal_approve", { hash: p.hash })} style={{ ...btn(ACCENT, "#FFF"), opacity: busy ? 0.6 : 1 }}>{busy === "proposal_approve" ? "Saving…" : "Approve"}</button>
        )}
        {open && (
          <button type="button" disabled={!!busy} onClick={() => call("proposal_cancel", {})} style={btn("#FFF", "#334155", "#CBD5E1")}>Cancel</button>
        )}
        {p.canUndo && (
          <button type="button" disabled={!!busy} onClick={() => call("proposal_undo", {})} style={btn("#FFF", "#334155", "#CBD5E1")}>{busy === "proposal_undo" ? "Putting it back…" : "Undo"}</button>
        )}
        {!open && (
          <button type="button" onClick={() => onNavigate && onNavigate(route.page, route.sub || null)} style={btn("#FFF", "#334155", "#CBD5E1")}>Open the Build Schedule</button>
        )}
      </div>
    </div>
  );
}
JACK_CARDS.build_job_add = JackBuildScheduleCard;
JACK_CARDS.build_job_change = JackBuildScheduleCard;
JACK_CARDS.build_job_built = JackBuildScheduleCard;

// renders: delivery_load_create, delivery_stop_add, delivery_stop_reorder, delivery_load_out, delivery_stop_delivered, delivery_load_delivered (register: JACK_CARDS.<kind> = JackDeliveryCard for each, at the end of this file)
// props: { proposal, viewingName, onChanged, onNavigate }, the props JackAnyCard already passes (onSay and busy are ignored).
// proposal is proposalView: id, kind, status, title, preview, hash, result, failure, canUndo.
// preview = { action, load?: { no, line, status }, lines?: [{ label, from, to }], stops?: [{ n, text, done? }],
//   order?: { from: string[], to: [{ text, was }] }, notes: string[], undo: string, ruleNames?: string[],
//   where: "Delivery Schedule", route: { page: "delivery-schedule", sub: null } }.
// result = { saved, reports: [{ label, status, reason }], loadNo?, stopNumber?, loadDone?, undo?: { restored, removed, failed, reports } }.
// Jack's delivery cards (jack-agent/delivery.ts): a new load on a day, a stop added to a load, a load's stops
// in a new order, a load marked out, and a stop or a whole load marked delivered. The card shows the load,
// what changes, the stops involved, what it sets off (rules, a permit, an estimate moving to Delivered) and
// what Undo can and can't do, before Approve. The server decides which buttons it may show.
// Place it AFTER `const JACK_CARDS = {};`.
function JackDeliveryCard({ proposal, viewingName, onChanged, onNavigate }) {
  const p = proposal;
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const titleRef = useRef(null);
  // A sentence about the card as it was doesn't outlive that state.
  useEffect(() => { setErr(""); }, [p.status]);
  const call = async (action, body) => {
    setBusy(action); setErr("");
    try {
      const { data, error } = await sb.functions.invoke("jack-agent", { body: { action, id: p.id, ...body } });
      let said = data;
      if (error && error.context && typeof error.context.json === "function") said = await error.context.json().catch(() => null);
      if (said && said.proposal) onChanged(said.proposal);
      if (error || (said && said.ok === false && !said.proposal)) setErr((said && said.error) || JACK_ERR);
      // The pressed button is about to go, and focus shouldn't fall to the page.
      if (said && said.proposal && titleRef.current) titleRef.current.focus();
    } catch (_e) {
      setErr(JACK_ERR);
    }
    setBusy("");
  };
  const pv = p.preview || {};
  const res = p.result || {};
  const undoInfo = res.undo || null;
  const undoReports = (undoInfo && undoInfo.reports) || [];
  const reports = (undoReports.length ? undoReports : res.reports) || [];
  const undoBack = undoInfo ? (undoInfo.restored || 0) + (undoInfo.removed || 0) : 0;
  const action = pv.action || "";
  const load = pv.load || null;
  const loadName = load && load.no ? `Load ${load.no}` : (res.loadNo ? `Load ${res.loadNo}` : "The load");
  const lines = Array.isArray(pv.lines) ? pv.lines : [];
  const stops = Array.isArray(pv.stops) ? pv.stops : [];
  const order = pv.order && Array.isArray(pv.order.to) ? pv.order : null;
  const notes = Array.isArray(pv.notes) ? pv.notes : [];
  const route = pv.route && pv.route.page ? pv.route : null;
  const open = p.status === "ready";
  const done = p.status === "applied" || p.status === "partly_applied";
  const hasOld = lines.some((l) => l.from !== undefined && l.from !== null && l.from !== "");
  const btn = (bg, fg, border) => ({ ...S.btn(bg, fg), padding: "8px 14px", ...(border ? { border: "1px solid " + border } : {}) });
  const small = { fontSize: 12, color: "#64748B", marginTop: 6 };
  const amber = { fontSize: 12, fontWeight: 600, color: "#B45309", background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 8, padding: "6px 8px", marginTop: 8, lineHeight: 1.45 };
  const th = { textAlign: "left", padding: "6px 10px", fontSize: 11, fontWeight: 700, color: "#64748B", borderBottom: "1px solid #E2E8F0", background: "#F8FAFC", whiteSpace: "nowrap" };
  const td = { padding: "6px 10px", fontSize: 13, borderBottom: "1px solid #F1F5F9", verticalAlign: "top", overflowWrap: "anywhere" };
  const num = (n) => (
    <span style={{ width: 20, height: 20, borderRadius: "50%", background: "#F1F5F9", color: "#475569", fontSize: 10.5, fontWeight: 800, display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "0 0 auto" }}>{n}</span>
  );
  const stateLine = {
    applying: "Saving…",
    undoing: "Putting it back…",
    expired: "This expired after 24 hours and nothing changed. Ask me again and I'll start from the board as it is now.",
    cancelled: "Cancelled. Nothing changed.",
    failed: p.failure || "That didn't go through. Nothing changed.",
  }[p.status];
  const appliedWords = {
    create_load: `Made ${res.loadNo ? `Load ${res.loadNo}` : "the load"}. It has no driver or stops yet.`,
    add_stop: `Added${res.stopNumber ? ` as stop ${res.stopNumber}` : ""} on ${loadName}.`,
    reorder_stops: `The stops on ${loadName} are in the new order.`,
    mark_load_out: `${loadName} is out.`,
    mark_stop_delivered: `Marked delivered.${res.loadDone ? ` ${loadName} is delivered too.` : ""}`,
    mark_load_delivered: `${loadName} is delivered.`,
  }[action] || "Done.";
  const undoneWords = undoReports.length
    ? (undoBack ? "Put back, except what's listed here." : "I left it as it is:")
    : action === "add_stop" ? `Taken off ${loadName}. A message a rule already sent stays sent.`
    : action === "reorder_stops" ? "The old order is back."
    : "Put back.";
  return (
    <div data-jack-card={p.id} data-kind={p.kind} data-status={p.status} style={{ border: "1px solid #E2E8F0", borderRadius: 10, padding: 14, background: "#FFF", marginTop: 8, maxWidth: "100%" }}>
      <div ref={titleRef} tabIndex={-1} style={{ fontSize: 14, fontWeight: 700, color: "#1E293B", overflowWrap: "anywhere", outline: "none" }}>{p.title}</div>
      {load && load.line && <div data-jack-delivery-load="" style={{ fontSize: 12, color: "#64748B", fontWeight: 600, marginTop: 2, overflowWrap: "anywhere" }}>{load.line}</div>}
      <div role="status">
        {stateLine && <div style={{ fontSize: 13, color: p.status === "failed" ? "#B91C1C" : "#64748B", marginTop: 6 }}>{stateLine}</div>}
      </div>

      {lines.length > 0 && p.status !== "failed" && (
        <div style={{ marginTop: 10, overflowX: "auto", border: "1px solid #E2E8F0", borderRadius: 8 }}>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead><tr>
              <th style={th}>What</th>
              {hasOld && <th style={th}>Now</th>}
              <th style={th}>New</th>
            </tr></thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td style={{ ...td, fontWeight: 600, color: "#334155", whiteSpace: "nowrap" }}>{l.label}</td>
                  {hasOld && (
                    <td style={{ ...td, color: "#94A3B8" }}>
                      {l.from ? <span style={{ textDecoration: open ? "line-through" : "none" }}>{String(l.from)}</span> : <span style={{ color: "#CBD5E1" }}>blank</span>}
                    </td>
                  )}
                  <td style={{ ...td, color: "#1E293B", fontWeight: 600 }}>{String(l.to ?? "")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {order && p.status !== "failed" && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#64748B", textTransform: "uppercase", letterSpacing: 0.3 }}>{p.status === "undone" ? "Was going to be" : open ? "New order" : "Order"}</div>
          {order.to.map((s, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, fontSize: 13, color: "#1E293B" }}>
              {num(i + 1)}
              <span style={{ overflowWrap: "anywhere", flex: 1 }}>{s.text}</span>
              {s.was && s.was !== i + 1 && <span style={{ fontSize: 11.5, color: "#94A3B8", whiteSpace: "nowrap" }}>was {s.was}</span>}
            </div>
          ))}
        </div>
      )}

      {stops.length > 0 && p.status !== "failed" && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#64748B", textTransform: "uppercase", letterSpacing: 0.3 }}>{stops.length === 1 ? "The stop" : "Stops"}</div>
          {stops.map((s, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, fontSize: 13, color: s.done ? "#94A3B8" : "#1E293B" }}>
              {num(s.n)}
              <span style={{ overflowWrap: "anywhere", flex: 1 }}>{s.text}</span>
              {s.done && <span style={{ fontSize: 11.5, color: "#15803D", fontWeight: 700, whiteSpace: "nowrap" }}>already delivered</span>}
            </div>
          ))}
        </div>
      )}

      {(open || done) && notes.map((n, i) => <div key={i} data-jack-delivery-note="" style={amber}>{n}</div>)}
      {open && pv.undo && <div style={small}>{pv.undo}</div>}
      {open && viewingName && <div style={{ fontSize: 12, color: "#B45309", marginTop: 10 }}>This is <b>{viewingName}</b>'s delivery schedule. Your name goes on the record.</div>}
      {err && <div role="alert" style={{ fontSize: 13, color: "#B91C1C", marginTop: 8 }}>{err}</div>}

      <div role="status">
        {done && (
          <div style={{ fontSize: 13, color: p.status === "applied" ? "#047857" : "#B45309", marginTop: 8 }}>
            {p.status === "applied" ? appliedWords : "I couldn't tell if all of it went through. It's listed here."}
          </div>
        )}
        {done && undoInfo && undoInfo.failed > 0 && <div style={{ fontSize: 13, color: "#B45309", marginTop: 8 }}>That didn't go through. Press Undo to try again.</div>}
        {p.status === "undone" && (
          <div style={{ fontSize: 13, color: undoReports.length ? "#B45309" : "#047857", marginTop: 8 }}>{undoneWords}</div>
        )}
      </div>
      {reports.length > 0 && (
        <div style={{ marginTop: 6, fontSize: 12, color: "#B45309", maxHeight: 200, overflowY: "auto" }}>
          {reports.map((r, i) => <div key={i} style={{ overflowWrap: "anywhere" }}>{r.label}: {r.reason}</div>)}
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
        {open && p.hash && (
          <button type="button" disabled={!!busy} onClick={() => call("proposal_approve", { hash: p.hash })} style={{ ...btn(ACCENT, "#FFF"), opacity: busy ? 0.6 : 1 }}>{busy === "proposal_approve" ? "Saving…" : "Approve"}</button>
        )}
        {open && (
          <button type="button" disabled={!!busy} onClick={() => call("proposal_cancel", {})} style={btn("#FFF", "#334155", "#CBD5E1")}>Cancel</button>
        )}
        {p.canUndo && (
          <button type="button" disabled={!!busy} onClick={() => call("proposal_undo", {})} style={btn("#FFF", "#334155", "#CBD5E1")}>
            {busy === "proposal_undo" ? "Putting it back…" : action === "add_stop" ? "Undo (take it off)" : "Undo"}
          </button>
        )}
        {route && !open && (
          <button type="button" onClick={() => onNavigate && onNavigate(route.page, route.sub || null)} style={btn("#FFF", "#334155", "#CBD5E1")}>Open the Delivery Schedule</button>
        )}
      </div>
    </div>
  );
}
JACK_CARDS.delivery_load_create = JackDeliveryCard;
JACK_CARDS.delivery_stop_add = JackDeliveryCard;
JACK_CARDS.delivery_stop_reorder = JackDeliveryCard;
JACK_CARDS.delivery_load_out = JackDeliveryCard;
JACK_CARDS.delivery_stop_delivered = JackDeliveryCard;
JACK_CARDS.delivery_load_delivered = JackDeliveryCard;

// renders: commission_rate (register: JACK_CARDS.commission_rate = JackCommissionCard;)
// props: { proposal, viewingName, onChanged, onNavigate }, the same props JackAnyCard passes to JackCard. proposal is proposalView: id, kind, status, title, preview, hash, result, failure, canUndo.
// preview: member {name, deactivated}, rate {from, to, fromWords, toWords, note}, ledger {lines, say} or null, notes[] (no figures), where, route {page, sub}.
// For the Structure Studio team (viewingName set), agent.ts takes preview.rate and preview.ledger off the card, so it
// says a rate is changing and for whom, and never the figures. The server refuses an operator's Approve and Undo,
// and this card shows them no buttons.
// Jack's commission rate card (jack-agent/commissions.ts): one team member's standing rate, the Commission % box on
// Settings > Company > Team. Place it AFTER `const JACK_CARDS = {};`.
function JackCommissionCard({ proposal, viewingName, onChanged, onNavigate }) {
  const p = proposal;
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const titleRef = useRef(null);
  // A sentence about the card as it was doesn't outlive that state.
  useEffect(() => { setErr(""); }, [p.status]);
  const call = async (action, body) => {
    setBusy(action); setErr("");
    try {
      const { data, error } = await sb.functions.invoke("jack-agent", { body: { action, id: p.id, ...body } });
      let said = data;
      if (error && error.context && typeof error.context.json === "function") said = await error.context.json().catch(() => null);
      if (said && said.proposal) onChanged(said.proposal);
      if (error || (said && said.ok === false && !said.proposal)) setErr((said && said.error) || JACK_ERR);
      // The pressed button is about to go, and focus shouldn't fall to the page.
      if (said && said.proposal && titleRef.current) titleRef.current.focus();
    } catch (_e) {
      setErr(JACK_ERR);
    }
    setBusy("");
  };
  const pv = p.preview || {};
  const member = pv.member || {};
  const rate = pv.rate || null;
  const ledger = pv.ledger || null;
  const notes = Array.isArray(pv.notes) ? pv.notes : [];
  const route = pv.route && pv.route.page ? pv.route : { page: "settings", sub: "team" };
  const where = pv.where || "Settings > Company > Team";
  const res = p.result || {};
  const undoInfo = res.undo || null;
  const undoReports = (undoInfo && undoInfo.reports) || [];
  const reports = (undoReports.length ? undoReports : res.reports) || [];
  const open = p.status === "ready";
  const done = p.status === "applied" || p.status === "partly_applied";
  const operator = !!viewingName;
  // A private card keeps its contents 30 days (jack-agent clearedIfOld): then only the title, state and Undo
  // record are left, and the preview reads { cleared: true }.
  const cleared = pv.cleared === true;
  const btn = (bg, fg, border) => ({ ...S.btn(bg, fg), padding: "8px 14px", ...(border ? { border: "1px solid " + border } : {}) });
  const small = { fontSize: 12, color: "#64748B", marginTop: 6 };
  const amber = { fontSize: 12, fontWeight: 600, color: "#B45309", background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 8, padding: "6px 8px", marginTop: 8, lineHeight: 1.45 };
  const th = { textAlign: "left", padding: "6px 10px", fontSize: 11, fontWeight: 700, color: "#64748B", borderBottom: "1px solid #E2E8F0", background: "#F8FAFC", whiteSpace: "nowrap" };
  const td = { padding: "6px 10px", fontSize: 13, borderBottom: "1px solid #F1F5F9", verticalAlign: "top", overflowWrap: "anywhere" };
  const stateLine = {
    applying: "Saving…",
    undoing: "Putting it back…",
    expired: "This expired after 24 hours and nothing changed. Ask me again and I'll start from the rate as it is now.",
    cancelled: "Cancelled. Nothing changed.",
    failed: p.failure || "That didn't save. Nothing changed.",
  }[p.status];
  return (
    <div data-jack-card={p.id} data-kind={p.kind} data-status={p.status} style={{ border: "1px solid #E2E8F0", borderRadius: 10, padding: 14, background: "#FFF", marginTop: 8, maxWidth: "100%" }}>
      <div ref={titleRef} tabIndex={-1} style={{ fontSize: 14, fontWeight: 700, color: "#1E293B", overflowWrap: "anywhere", outline: "none" }}>{p.title}</div>
      <div role="status">
        {stateLine && <div style={{ fontSize: 13, color: p.status === "failed" ? "#B91C1C" : "#64748B", marginTop: 6 }}>{stateLine}</div>}
      </div>

      {member.name && (
        <div style={{ fontSize: 13, color: "#334155", marginTop: 6, overflowWrap: "anywhere" }}>
          For <b>{member.name}</b>{member.deactivated ? <span style={{ color: "#94A3B8" }}> (login switched off)</span> : null}
        </div>
      )}

      {rate && p.status !== "failed" && (
        <div style={{ marginTop: 10, overflowX: "auto", border: "1px solid #E2E8F0", borderRadius: 8 }}>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead><tr>
              <th style={th}>What</th>
              <th style={th}>{done || p.status === "undone" ? "Was" : "Now"}</th>
              <th style={th}>New</th>
            </tr></thead>
            <tbody>
              <tr>
                <td style={{ ...td, fontWeight: 600, color: "#334155" }}>Commission rate</td>
                <td style={{ ...td, color: "#94A3B8" }}><span data-jack-rate-from="" style={{ textDecoration: open ? "line-through" : "none" }}>{rate.fromWords}</span></td>
                <td style={{ ...td, color: "#1E293B", fontWeight: 600 }}><span data-jack-rate-to="">{rate.toWords}</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      {cleared && <div style={small}>The details on this card were cleared after 30 days. {where} shows the rate as it is now.</div>}
      {!rate && !cleared && operator && (open || done) && (
        <div style={small}>The rates on this card are only shown to <b>{viewingName}</b>'s own team.</div>
      )}
      {rate && rate.note && (open || done) && <div data-jack-rate-note="" style={amber}>{rate.note}</div>}
      {ledger && ledger.say && open && <div data-jack-rate-ledger="" style={{ fontSize: 12.5, color: "#334155", marginTop: 8 }}>{ledger.say}</div>}
      {(open || done) && notes.map((n, i) => <div key={i} style={i === 0 ? amber : { fontSize: 12, color: "#B45309", marginTop: 6 }}>{n}</div>)}
      {open && !operator && <div style={small}>Undo puts the old rate back, if nobody has changed it since. Lines approved or paid in the meantime keep their new amount.</div>}
      {operator && (open || done) && (
        <div style={{ fontSize: 12, color: "#B45309", marginTop: 8 }}>The Structure Studio team can't change commission rates. Only the person on <b>{viewingName}</b>'s team who asked can approve or undo this.</div>
      )}
      {err && <div role="alert" style={{ fontSize: 13, color: "#B91C1C", marginTop: 8 }}>{err}</div>}

      <div role="status">
        {p.status === "applied" && <div style={{ fontSize: 13, color: "#047857", marginTop: 8 }}>Saved. The new rate is on {where}.</div>}
        {p.status === "partly_applied" && <div style={{ fontSize: 13, color: "#B45309", marginTop: 8 }}>I'm not sure this saved.</div>}
        {done && undoInfo && undoInfo.failed > 0 && <div style={{ fontSize: 13, color: "#B45309", marginTop: 8 }}>It didn't go back yet.</div>}
        {p.status === "undone" && (
          <div style={{ fontSize: 13, color: undoReports.length ? "#B45309" : "#047857", marginTop: 8 }}>
            {undoReports.length ? "I left it as it is:" : "Put back. The old rate is on again."}
          </div>
        )}
      </div>
      {reports.length > 0 && (
        <div style={{ marginTop: 6, fontSize: 12, color: "#B45309" }}>
          {reports.map((r, i) => <div key={i} style={{ overflowWrap: "anywhere" }}>{r.reason}</div>)}
        </div>
      )}

      {!operator && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
          {open && p.hash && (
            <button type="button" disabled={!!busy} onClick={() => call("proposal_approve", { hash: p.hash })} style={{ ...btn(ACCENT, "#FFF"), opacity: busy ? 0.6 : 1 }}>{busy === "proposal_approve" ? "Saving…" : "Approve"}</button>
          )}
          {open && (
            <button type="button" disabled={!!busy} onClick={() => call("proposal_cancel", {})} style={btn("#FFF", "#334155", "#CBD5E1")}>Cancel</button>
          )}
          {p.canUndo && (
            <button type="button" disabled={!!busy} onClick={() => call("proposal_undo", {})} style={btn("#FFF", "#334155", "#CBD5E1")}>{busy === "proposal_undo" ? "Putting it back…" : "Undo"}</button>
          )}
          {!open && (
            <button type="button" onClick={() => onNavigate && onNavigate(route.page, route.sub || null)} style={btn("#FFF", "#334155", "#CBD5E1")}>Open Team</button>
          )}
        </div>
      )}
    </div>
  );
}
JACK_CARDS.commission_rate = JackCommissionCard;

function JackTab({ viewingName, onNavigate, active }) {
  const [status, setStatus] = useState(null);
  const [loadErr, setLoadErr] = useState("");
  const [loadDenied, setLoadDenied] = useState(false);
  const [messages, setMessages] = useState([]);
  const [proposals, setProposals] = useState({});
  const [chatId, setChatId] = useState(null);
  const [chats, setChats] = useState([]);
  const [off, setOff] = useState([]);
  const [savingOff, setSavingOff] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [view, setView] = useState("chat");
  // Bumped after a billed answer, a wallet refusal, or a price list that finished reading: the balance
  // line under the composer reads Billing again.
  const [billTick, setBillTick] = useState(0);
  const listRef = useRef(null);
  const fileRef = useRef(null);
  const inputRef = useRef(null);

  const addProposals = (list) => {
    if (!list || !list.length) return;
    setProposals((prev) => { const next = { ...prev }; list.forEach((x) => { next[x.id] = x; }); return next; });
  };
  const showChat = (chat) => {
    setChatId(chat ? chat.id : null);
    setMessages(chat ? chat.messages || [] : []);
    if (chat) addProposals(chat.proposals);
  };
  const load = async () => {
    setLoadErr(""); setLoadDenied(false);
    const { data, error } = await sb.functions.invoke("jack-agent", { body: { action: "status" } });
    if (error || !data || !data.ok) {
      // Trying again can't fix a refusal, so it doesn't offer to.
      const denied = !!error && error.ssStatus === 403;
      setLoadDenied(denied);
      setLoadErr(denied ? "Your access doesn't include Jack. Ask an owner or admin." : "I couldn't open Jack just now. Please try again.");
      return;
    }
    setStatus(data);
    setChats(data.chats || []);
    setOff(data.off || []);
    showChat(data.chat);
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);
  // `active`: while the tab is hidden the list has no height, so a reply that landed meanwhile scrolls
  // into view on the way back.
  useEffect(() => { if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight; }, [messages, view, active]);

  // A sheet being read answers later, and a save someone else is watching finishes later. Ask after any
  // card still at it, and stop when none is. A card whose check keeps failing stops being asked after a
  // minute (at once on a refusal) and says so. That mark is only on this screen: a reload shows the
  // truth. A save that finishes here tells an open designer, as a press does.
  const workingIds = Object.values(proposals).filter((p) => p.status === "reading" || p.status === "applying" || p.status === "undoing").map((p) => p.id).join(",");
  useEffect(() => {
    if (!workingIds) return undefined;
    let dead = false, running = false;
    const fails = {};
    const timer = setInterval(async () => {
      if (running) return;
      running = true;
      for (const id of workingIds.split(",")) {
        const { data, error } = await sb.functions.invoke("jack-agent", { body: { action: "proposal_get", id } });
        if (dead) return;
        if (data && data.proposal) {
          fails[id] = 0;
          // Only a save ends in these, and only a card that was saving or putting back gets here with one.
          const s = data.proposal.status;
          if (s === "applied" || s === "partly_applied" || s === "undone") ssSettingsSaved(ssResolvedClientId || null);
          // A read that finished is billed; a save or an Undo isn't, so they don't re-read the wallet.
          if (data.proposal.kind === "price_sheet" && !["reading", "applying", "undoing"].includes(s)) setBillTick((n) => n + 1);
          addProposals([data.proposal]);
          continue;
        }
        const st = error && error.ssStatus;
        if (st === 403 || st === 404 || (fails[id] = (fails[id] || 0) + 1) >= 20) {
          setProposals((prev) => ({ ...prev, [id]: { ...prev[id], status: "failed", canRetry: false, failure: "I can't check on that right now. Reload the page to see where it got to." } }));
        }
      }
      running = false;
    }, 3000);
    return () => { dead = true; clearInterval(timer); };
  }, [workingIds]);

  // A new reply or estimate card cancels an older one for the same customer still waiting in this chat
  // (jack-agent replaceOlder, "Replaced by a newer draft."). The chat's other waiting ones are read again,
  // so a replaced card loses its Approve now rather than on a reload.
  // A corrected door or insulation card does the same for the older one of its kind (11-09).
  const rereadReplaced = (made) => {
    const groupOf = (k) => (JACK_REPLY_KINDS.includes(k) ? "reply" : JACK_REPLACING_KINDS.includes(k) ? k : null);
    const groups = new Set((Array.isArray(made) ? made : []).map((x) => x && groupOf(x.kind)).filter(Boolean));
    if (!groups.size) return;
    const fresh = new Set(made.map((x) => x.id));
    const ids = [...new Set(messages.flatMap((m) => m.proposal_ids || []))]
      .filter((id) => !fresh.has(id) && proposals[id] && proposals[id].status === "ready" && groups.has(groupOf(proposals[id].kind)));
    ids.forEach(async (id) => {
      try {
        const { data } = await sb.functions.invoke("jack-agent", { body: { action: "proposal_get", id } });
        if (data && data.proposal) addProposals([data.proposal]);
      } catch (_e) { /* the card stays; the server refuses a press on a replaced one */ }
    });
  };
  // `said`: words to send without the box, from a press on a question card ("7 days"). The box keeps
  // whatever the person was typing. `reviseId`: the words say what to change on that card (JackRevise).
  // Answers whether the words went in, so the Revise box keeps them when they didn't.
  const send = async (e, said, reviseId) => {
    if (e) e.preventDefault();
    const fromBox = typeof said !== "string";
    const text = fromBox ? draft.trim() : said.trim();
    if (!text || busy) return false;
    setBusy(true); setErr(""); if (fromBox) setDraft("");
    const revising = reviseId && proposals[reviseId] ? proposals[reviseId] : null;
    setMessages((m) => [...m, { id: "local", role: "user", body: revising ? `Revise "${revising.title}": ${text}` : text, proposal_ids: [] }]);
    // The person's own time zone: "today" and a job marked built are their day, not UTC's.
    let tz = null;
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch (_e) { tz = null; }
    const { data, error } = await sb.functions.invoke("jack-agent", { body: { action: "send", text, chatId, tz, ...(revising ? { revise: reviseId } : {}) } });
    let went = false;
    if (error || !data) {
      setMessages((m) => m.filter((x) => x.id !== "local"));
      if (fromBox) setDraft(text);
      // A 4xx is the server's own sentence, written for the person. Anything else is a generic fault.
      setErr(error && error.ssStatus >= 400 && error.ssStatus < 500 && !/non-2xx/i.test(error.message || "") ? error.message : JACK_ERR);
      // A card that moved on (approved, cancelled, expired) shows where it is now, without its Revise.
      if (revising) {
        try {
          const { data: again } = await sb.functions.invoke("jack-agent", { body: { action: "proposal_get", id: reviseId } });
          if (again && again.proposal) addProposals([again.proposal]);
        } catch (_e) { /* the card stays as drawn; a second press gets the same sentence */ }
      }
    } else if (data.capped) {
      if (data.capped === "wallet") setBillTick((n) => n + 1);
      if (Array.isArray(data.messages)) {
        // The count taken after the message went in: the server kept it and the refusal (jack-agent
        // handleSend), so the chat shows what it stored and the box doesn't offer it again.
        setChatId(data.chatId);
        setMessages((m) => [...m.filter((x) => x.id !== "local"), ...data.messages]);
        if (!chatId) refreshChats();
      } else {
        // The first check stores nothing: what was typed stays in the box.
        if (fromBox) setDraft(text);
        setMessages((m) => [...m.filter((x) => x.id !== "local"), { id: "cap" + Date.now(), role: "assistant", body: data.reply.body, proposal_ids: [] }]);
      }
    } else {
      went = true;
      if (data.billed) setBillTick((n) => n + 1);
      setChatId(data.chatId);
      addProposals(data.proposals);
      setMessages((m) => [...m.filter((x) => x.id !== "local"), ...data.messages]);
      if (!chatId) refreshChats();
      rereadReplaced(data.proposals);
    }
    setBusy(false);
    if (inputRef.current && !revising) inputRef.current.focus();
    return went;
  };
  const refreshChats = async () => {
    const { data } = await sb.functions.invoke("jack-agent", { body: { action: "status" } });
    if (data && data.chats) setChats(data.chats);
  };
  const upload = async (file) => {
    if (!file || busy) return;
    setBusy(true); setErr("");
    try {
      const body = await jackReadFile(file);
      const { data, error } = await sb.functions.invoke("jack-agent", { body: { action: "sheet_start", chatId, ...body } });
      let said = data;
      if (error && error.context && typeof error.context.json === "function") said = await error.context.json().catch(() => null);
      if (said && said.capped) {
        if (said.capped === "wallet") setBillTick((n) => n + 1);
        if (Array.isArray(said.messages)) {
          // The second count stopped it: the server kept "Uploaded a price list" and the refusal.
          setChatId(said.chatId);
          setMessages((m) => [...m, ...said.messages]);
          if (!chatId) refreshChats();
        } else setMessages((m) => [...m, { id: "cap" + Date.now(), role: "assistant", body: said.reply.body, proposal_ids: [] }]);
      }
      else if (error || !said || !said.ok) setErr((said && said.error) || "I couldn't take that file. Please try again.");
      else {
        setChatId(said.chatId);
        addProposals(said.proposals);
        setMessages((m) => [...m, ...said.messages]);
        if (!chatId) refreshChats();
      }
    } catch (e2) {
      setErr((e2 && e2.message) || "I couldn't read that file.");
    }
    setBusy(false);
    if (fileRef.current) fileRef.current.value = "";
  };
  // Neither of these runs during a turn: its reply would land in whichever chat is on screen by then.
  const newChat = async () => {
    if (busy) return;
    setView("chat");
    const { data, error } = await sb.functions.invoke("jack-agent", { body: { action: "new" } });
    // If the server still has the old chat open, the screen doesn't pretend otherwise.
    if (error || !data || !data.ok) { setErr(JACK_ERR); return; }
    showChat(null);
    setErr("");
    if (inputRef.current) inputRef.current.focus();
  };
  const openChat = async (id) => {
    if (busy) return;
    const { data } = await sb.functions.invoke("jack-agent", { body: { action: "chat", chatId: id } });
    setView("chat");
    if (data && data.chat) { showChat(data.chat); setErr(""); }
    else setErr("I couldn't open that chat. Please try again.");
  };
  // One switch per press, merged on the server into the list as it's stored, and one save at a time. The
  // screen then shows the server's list, so someone else's change since is shown, not undone.
  const toggle = async (key) => {
    const on = off.includes(key);
    setOff(on ? off.filter((k) => k !== key) : [...off, key]);
    setSavingOff(true);
    const { data, error } = await sb.functions.invoke("jack-agent", { body: { action: "set_switches", key, on } });
    setSavingOff(false);
    if (error || !data || !data.ok) { setOff(off); setErr("That didn't save. Please try again."); }
    else setOff(data.off || []);
  };

  if (loadErr) return <div style={S.card}><div role="alert" style={{ fontSize: 14, color: "#B91C1C", marginBottom: 10 }}>{loadErr}</div>{!loadDenied && <button type="button" onClick={load} style={S.btn(ACCENT, "#FFF")}>Try again</button>}</div>;
  if (!status) return <div style={{ color: "#64748B", fontSize: 14, padding: 20 }}>Loading…</div>;

  const linkBtn = { background: "none", border: "none", padding: "6px 0", color: ACCENT, fontSize: 13, fontWeight: 600, cursor: "pointer", textAlign: "left", display: "block" };
  const lastSaid = [...messages].reverse().find((m) => m.role === "assistant");
  // wrap-reverse so that on a phone, where the two columns stack, the chat is on top and the chat list
  // below it. flex-end is the top of the line in that direction.
  return (
    <div style={{ display: "flex", flexWrap: "wrap-reverse", gap: 16, alignItems: "flex-end" }}>
      <div style={{ flex: "1 1 220px", minWidth: 0, maxWidth: "100%" }}>
        <div style={{ ...S.card, marginBottom: 12 }}>
          <button type="button" onClick={newChat} disabled={busy} style={{ ...S.btn(ACCENT, "#FFF"), width: "100%", opacity: busy ? 0.6 : 1 }}>New chat</button>
          <div style={{ marginTop: 10, maxHeight: 240, overflowY: "auto" }}>
            {chats.map((c) => (
              <button key={c.id} type="button" onClick={() => openChat(c.id)} disabled={busy} aria-current={c.id === chatId ? "true" : undefined}
                style={{ display: "block", width: "100%", textAlign: "left", background: c.id === chatId ? "#EEF2FF" : "transparent", border: "none", borderRadius: 6, padding: "6px 8px", fontSize: 13, color: "#334155", cursor: busy ? "default" : "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {c.title || "Chat"}
              </button>
            ))}
            {!chats.length && <div style={{ fontSize: 12, color: "#94A3B8" }}>Your chats will show here.</div>}
          </div>
        </div>
        <div style={{ ...S.card, marginBottom: 12 }}>
          <button type="button" style={linkBtn} onClick={() => setView("activity")}>What Jack did</button>
          <button type="button" style={linkBtn} onClick={() => setView("remembers")}>What Jack remembers</button>
          <button type="button" style={linkBtn} onClick={() => setView(view === "switches" ? "chat" : "switches")}>What Jack can do</button>
          {view === "switches" && (status.switches || []).map((s) => (
            <label key={s.key} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13, color: "#334155", marginTop: 8 }}>
              <input type="checkbox" checked={!off.includes(s.key)} disabled={!status.canManage || savingOff} onChange={() => toggle(s.key)} style={{ marginTop: 2 }} />
              <span>{s.label}</span>
            </label>
          ))}
          {view === "switches" && !status.canManage && <div style={{ fontSize: 12, color: "#94A3B8", marginTop: 8 }}>An owner or admin can change these.</div>}
        </div>
      </div>

      <div style={{ flex: "999 1 480px", minWidth: 0, maxWidth: "100%" }}>
        {view === "activity" ? <JackActivity onBack={() => setView("chat")} /> : view === "remembers" ? <JackMemoryPanel canManage={!!status.canManage} onBack={() => setView("chat")} /> : (
          <div style={{ ...S.card, display: "flex", flexDirection: "column", minHeight: 460 }}>
            {/* For a screen reader: a short line, not the whole list with its tables. */}
            <div role="status" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" }}>
              {busy ? "Jack is on it…" : lastSaid ? String(lastSaid.body).slice(0, 500) : ""}
            </div>
            <div ref={listRef} style={{ flex: 1, overflowY: "auto", maxHeight: "62vh", paddingRight: 4 }}>
              {!messages.length && (
                <div style={{ fontSize: 14, color: "#475569", lineHeight: 1.6 }}>
                  <b>I'm Jack.</b> Send me your price list and I'll fill in your table, or tell me what you need, like "every 8 and 10 wide comes with one single door." You'll see every number before anything changes.
                </div>
              )}
              {messages.map((m) => (
                <div key={m.id} style={{ display: "flex", flexDirection: "column", alignItems: m.role === "user" ? "flex-end" : "flex-start", marginBottom: 10 }}>
                  <div style={{ maxWidth: "85%", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 14, lineHeight: 1.5, padding: "8px 12px", borderRadius: 10, background: m.role === "user" ? ACCENT : "#F1F5F9", color: m.role === "user" ? "#FFF" : "#1E293B" }}>{m.body}</div>
                  {(m.proposal_ids || []).map((id) => proposals[id] && (
                    <div key={id} style={{ width: "100%" }}>
                      <JackAnyCard proposal={proposals[id]} viewingName={viewingName} onChanged={(x) => addProposals([x])} onNavigate={onNavigate}
                        onSay={(words) => send(null, words)} busy={busy} />
                      <JackReplacedLine proposal={proposals[id]} />
                      {proposals[id].canRevise && <JackRevise proposal={proposals[id]} busy={busy} onRevise={(words) => send(null, words, id)} />}
                    </div>
                  ))}
                </div>
              ))}
              {busy && <div style={{ fontSize: 13, color: "#64748B", marginBottom: 8 }}>Jack is on it…</div>}
            </div>
            {status.unavailable && <div role="alert" style={{ fontSize: 13, color: "#B45309", marginTop: 8 }}>{status.unavailable}</div>}
            {err && <div role="alert" style={{ fontSize: 13, color: "#B91C1C", marginTop: 8 }}>{err}</div>}
            <form onSubmit={send} style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "flex-end" }}>
              <input ref={fileRef} type="file" accept=".xlsx,.csv,.pdf,image/png,image/jpeg,image/webp" style={{ display: "none" }} aria-label="Upload a price list" onChange={(e) => upload(e.target.files && e.target.files[0])} />
              <button type="button" title="Upload a price list" aria-label="Upload a price list" disabled={busy || !status.available} onClick={() => fileRef.current && fileRef.current.click()}
                style={{ ...S.btn("#FFF", "#334155"), border: "1px solid #CBD5E1", padding: "9px 11px", opacity: busy || !status.available ? 0.5 : 1 }}>📎</button>
              <textarea ref={inputRef} value={draft} rows={2} aria-label="Message to Jack" placeholder="Tell Jack what you need" disabled={!status.available}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                style={{ flex: 1, minWidth: 0, resize: "vertical", border: "1px solid #CBD5E1", borderRadius: 8, padding: "8px 10px", fontSize: 14, fontFamily: "inherit" }} />
              <button type="submit" disabled={busy || !draft.trim() || !status.available} style={{ ...S.btn(ACCENT, "#FFF"), opacity: busy || !draft.trim() || !status.available ? 0.6 : 1 }}>Send</button>
            </form>
            <JackBalanceLine refreshKey={billTick} onNavigate={onNavigate} />
          </div>
        )}
      </div>
    </div>
  );
}

// THE SUPPORT BUTTON, in the top bar (Carolyn, 10-26 call, modelled on the Support menu in her GHL
// dashboard). Chat icon + "Support" (icon only on a phone). The menu: Ask the assistant, Report a
// problem, Request a feature, Submit a ticket, My requests, What's new — Ahsan 10-27. A "Live
// support" entry exists for stage 2 and renders only when support-agent says liveSupport is
// available, which it never does yet. Mounted by the shell only while NOT viewing another account.
function SupportMenu({ clientId, onSubmitted, onNavigate }) {
  const [open, setOpen] = useState(false);
  const [chat, setChat] = useState(false);
  const [form, setForm] = useState(null);          // { kind, prefill, conversationId }
  const [live, setLive] = useState(false);
  const wrapRef = useRef(null);
  const menuRef = useRef(null);
  const asked = useRef(false);

  // The menu hangs from the button's right edge. On a phone with a wide business badge the button
  // sits far enough left that the 280 px menu ran 8 px off the screen (beta, 375 px, 10-28), so it
  // is nudged back inside an 8 px margin before it paints. The margin is measured from the VISIBLE
  // edge: on a page wider than the phone (Orders is 14 px wider at 375) the visible area can be
  // zoomed and panned, and the page's own left edge is then off screen.
  React.useLayoutEffect(() => {
    const m = menuRef.current;
    if (!open || !m) return;
    m.style.right = "";
    const vv = window.visualViewport;
    const over = (vv ? vv.offsetLeft : 0) + 8 - m.getBoundingClientRect().left;
    if (over > 0) m.style.right = `${-over}px`;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey); };
  }, [open]);

  // The stage-2 flag rides on the assistant's status read, asked once, the first time the menu opens.
  // It also boots the function, so the first question does not pay the cold start.
  useEffect(() => {
    if (!open || asked.current) return;
    asked.current = true;
    sb.functions.invoke("support-agent", { body: { action: "status" } })
      .then(({ data }) => { if (data && data.liveSupport && data.liveSupport.available) setLive(true); })
      .catch(() => {});
  }, [open]);

  const pick = (fn) => () => { setOpen(false); fn(); };
  const items = [
    ["chat", "💬", "Ask the assistant", "Get an answer right away", pick(() => setChat(true))],
    ["bug", "🐛", "Report a problem", "Something broken or not working", pick(() => setForm({ kind: "bug" }))],
    ["feature", "✨", "Request a feature", "An idea or improvement", pick(() => setForm({ kind: "feature" }))],
    ["ticket", "🎫", "Submit a ticket", "Anything you need a person for", pick(() => setForm({ kind: "ticket" }))],
    ["mine", "📋", "My requests", "Track what you've sent us", pick(() => onNavigate("support", "mine"))],
    ["news", "🆕", "What's new", "New features and fixes", pick(() => onNavigate("support", "features"))],
  ];

  return (
    <div className="ss-support" ref={wrapRef}>
      <button type="button" className="ss-sup-btn" aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((o) => !o)} title="Support">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        <span className="ss-sup-btn-t">Support</span>
      </button>
      {open && (
        <div className="ss-sup-menu" role="menu" aria-label="Support" ref={menuRef}>
          {items.map(([k, icon, label, sub, act]) => (
            <button key={k} type="button" role="menuitem" onClick={act}>
              <span className="ic" aria-hidden="true">{icon}</span>
              <span className="tx"><span className="lb">{label}</span><span className="sb">{sub}</span></span>
            </button>
          ))}
          {live && (
            <button type="button" role="menuitem" onClick={pick(() => setForm({ kind: "ticket" }))}>
              <span className="ic" aria-hidden="true">🎧</span>
              <span className="tx"><span className="lb">Live support</span><span className="sb">Talk to a person now</span></span>
            </button>
          )}
        </div>
      )}
      {/* Both render into <body>: the top bar is sticky with its own z-index, so anything drawn
          inside it sits UNDER every page element above 40 (sticky table headers are 70). */}
      {chat && ReactDOM.createPortal(
        <SupportChat onClose={() => setChat(false)} onNavigate={onNavigate}
          onTicket={(prefill, conversationId) => { setForm({ kind: "ticket", prefill, conversationId }); }} />,
        document.body,
      )}
      {form && ReactDOM.createPortal(
        <FeedbackDialog kind={form.kind} clientId={clientId} prefill={form.prefill || null}
          supportConversationId={form.conversationId || null}
          onClose={() => setForm(null)}
          onSubmitted={(row) => { if (form.conversationId) setChat(false); if (onSubmitted) onSubmitted(row); }} />,
        document.body,
      )}
    </div>
  );
}

// ─── "My Requests": this tenant's bugs + feature requests, with our replies ───
// The component and the `mine` route slug keep the older "submissions" naming — the rows
// are still feedback_submissions, and renaming the slug would break existing links.
// `supportOn` is the shell's switch (346): off, the empty-state sentence points at the 💬 Feedback
// pill those builders still have, word for word as before, and the Tickets chip shows only when a
// ticket row exists (release review, 10-30).
function MySubmissions({ refreshKey, supportOn = false }) {
  const [rows, setRows] = useState(null);       // null = loading
  const [comments, setComments] = useState({}); // submission_id -> [comment]
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null);       // expanded submission id
  const [filter, setFilter] = useState("all");  // all | bug | feature
  const [syncing, setSyncing] = useState(false);
  const [tick, setTick] = useState(0);
  const [draft, setDraft] = useState("");       // reply text for the open submission
  const [sending, setSending] = useState(false);
  const [sendErr, setSendErr] = useState("");
  // Column sort, same convention as DesignsTable/LeadsTable (SortTh + sortRows).
  // Default = newest first, matching the created_at DESC load order.
  const [sortKey, setSortKey] = useState("date");
  const [sortDir, setSortDir] = useState("desc");
  const onSort = makeOnSort(sortKey, setSortKey, sortDir, setSortDir);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // RLS scopes both reads to this tenant — no client_id filter needed here, and
      // adding one would be a false comfort (the policy is the actual boundary).
      const { data, error: err } = await sb
        .from("feedback_submissions")
        .select("id, kind, title, detail, severity, status, submitter_name, attachment_path, monday_item_id, created_at, status_changed_at")
        .order("created_at", { ascending: false });
      if (cancelled) return;
      if (err) { setError(err.message); setRows([]); return; }
      setRows(data || []);
      const ids = (data || []).map((r) => r.id);
      if (!ids.length) { setComments({}); return; }
      const { data: cs } = await sb
        .from("feedback_comments")
        .select("id, submission_id, author_name, author_kind, body, created_at")
        .in("submission_id", ids)
        .order("created_at", { ascending: true });
      if (cancelled) return;
      const map = {};
      for (const c of cs || []) (map[c.submission_id] = map[c.submission_id] || []).push(c);
      setComments(map);
    })();
    return () => { cancelled = true; };
  }, [refreshKey, tick]);

  // Belt-and-braces against a webhook that never arrived: pull current state from
  // Monday on demand, then re-read. The webhook is the normal path; this is the button
  // a client presses when they think we've gone quiet.
  const resync = async () => {
    setSyncing(true);
    try { await sb.functions.invoke("portal-feedback", { body: { action: "refresh" } }); } catch (_) {}
    setSyncing(false);
    setTick((t) => t + 1);
  };

  // A builder replying on their own submission. The server decides who they are and
  // records the comment as client-authored; it also copies the reply into the linked
  // Projects item so the team reads it where they work.
  const sendReply = async (submissionId) => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true); setSendErr("");
    try {
      const { data, error: err } = await sb.functions.invoke("portal-feedback", {
        body: { action: "comment", submissionId, body: text },
      });
      if (err) throw new Error(err.message || "Could not send that.");
      if (data && data.error) throw new Error(data.error);
      setDraft("");
      setTick((t) => t + 1);           // re-read so the thread shows it
    } catch (e) {
      setSendErr(e.message || "Could not send that.");
    }
    setSending(false);
  };

  const openAttachment = async (path) => {
    const { data, error: err } = await sb.storage.from("feedback-attachments").createSignedUrl(path, 300);
    if (err || !data) { alert("Couldn't open that attachment."); return; }
    window.open(data.signedUrl, "_blank", "noopener");
  };

  const fmtDT = (iso) => {
    if (!iso) return "";
    try { return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }); }
    catch { return iso; }
  };

  if (error) return <div style={S.err}>Couldn't load your submissions: {error}</div>;
  if (rows === null) return <div style={{ ...S.card, color: "#64748B" }}>Loading your submissions…</div>;

  const shown = filter === "all" ? rows : rows.filter((r) => r.kind === filter);
  const sortVal = (r) => {
    switch (sortKey) {
      case "name":   return r.title || "";
      case "user":   return r.submitter_name || "";
      case "status": return FB_STATUS_RANK[r.status] ?? 99;
      // ISO timestamps sort chronologically as plain strings — see sortRows.
      case "date":
      default:       return r.created_at || "";
    }
  };
  const sorted = sortRows(shown, sortVal, sortDir);

  return (
    <div style={S.card}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <span style={{ ...S.h2, marginBottom: 0 }}>My Requests</span>
        <span style={{ fontSize: 12, color: "#94A3B8" }}>({rows.length})</span>
        <div style={{ display: "flex", gap: 6, marginLeft: "auto", flexWrap: "wrap" }}>
          {[["all", "All"], ["bug", "🐛 Issues"], ["feature", "✨ Features"],
            ...(supportOn || rows.some((r) => r.kind === "ticket") ? [["ticket", "🎫 Tickets"]] : [])].map(([k, lbl]) => (
            <button key={k} type="button" onClick={() => setFilter(k)}
              style={{ fontFamily: "inherit", fontSize: 12, fontWeight: 700, padding: "5px 11px", borderRadius: 999, cursor: "pointer",
                border: filter === k ? "1px solid " + ACCENT : "1px solid #E2E8F0",
                background: filter === k ? ACCENT : "#FFF", color: filter === k ? "#FFF" : "#475569" }}>{lbl}</button>
          ))}
          <button type="button" onClick={resync} disabled={syncing}
            style={{ fontFamily: "inherit", fontSize: 12, fontWeight: 700, padding: "5px 11px", borderRadius: 999, cursor: syncing ? "default" : "pointer", border: "1px solid #E2E8F0", background: "#FFF", color: "#475569", opacity: syncing ? 0.6 : 1 }}>
            {syncing ? "Checking…" : "↻ Check for updates"}
          </button>
        </div>
      </div>

      {rows.length === 0 ? (
        <div style={{ fontSize: 13, color: "#64748B", padding: "8px 0", lineHeight: 1.6 }}>
          {supportOn ? (<>
            You haven't sent us anything yet. Use the <b>Support</b> button at the top of the page to report
            a problem, request a feature or send us a ticket — it'll show up here so you can follow what happens to it.
          </>) : (<>
            You haven't sent us anything yet. Use the <b>💬 Feedback</b> button in the bottom-right corner
            to report an issue or request a feature — it'll show up here so you can follow what happens to it.
          </>)}
        </div>
      ) : shown.length === 0 ? (
        <div style={{ fontSize: 13, color: "#64748B", padding: "8px 0" }}>Nothing here under this filter.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              <SortTh label="Request"    col="name"   sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              <SortTh label="Submitted by" col="user" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              <SortTh label="Status" col="status"     sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              <SortTh label="Date" col="date"         sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            </tr></thead>
            <tbody>
              {sorted.map((r) => {
                const isOpen = open === r.id;
                const cs = comments[r.id] || [];
                const toggle = () => (setOpen(isOpen ? null : r.id), setDraft(""), setSendErr(""));
                return (
                  <React.Fragment key={r.id}>
                  <tr onClick={toggle} tabIndex={0} aria-expanded={isOpen}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } }}
                    style={{ cursor: "pointer", background: isOpen ? "#F8FAFC" : undefined }}>
                    <td style={{ ...S.td, fontWeight: 700 }}>
                      <span style={{ color: ACCENT, fontSize: 11, marginRight: 6 }}>{isOpen ? "▾" : "▸"}</span>
                      <span style={{ marginRight: 6 }}>{(FB_KINDS[r.kind] || FB_KINDS.ticket).icon}</span>
                      {r.title}
                      {/* Tooltip names the sender rather than saying "from us": the reader
                          IS the client, so "us" scans as their own team — especially next
                          to a Submitted by column that can read "CSM Synergy". */}
                      {cs.length > 0 && (
                        <span title={cs.length + " repl" + (cs.length === 1 ? "y" : "ies") + " from Structure Studio"}
                          style={{ marginLeft: 8, fontSize: 11, fontWeight: 800, color: ACCENT, background: "#EEF2FF", borderRadius: 999, padding: "2px 8px", whiteSpace: "nowrap" }}>
                          💬 {cs.length}
                        </span>
                      )}
                    </td>
                    <td style={{ ...S.td, whiteSpace: "nowrap", color: "#475569" }}>{r.submitter_name}</td>
                    <td style={S.td}>{fbBadge(r.status)}</td>
                    <td style={{ ...S.td, whiteSpace: "nowrap", color: "#64748B" }}>{fmtDT(r.created_at)}</td>
                  </tr>

                  {isOpen && (
                    <tr style={{ background: "#F8FAFC" }}>
                      <td colSpan={4} style={{ ...S.td, paddingTop: 0 }}>
                        {r.detail && <div style={{ fontSize: 13, color: "#475569", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{r.detail}</div>}
                        <div style={{ fontSize: 11.5, color: "#94A3B8", marginTop: 8, display: "flex", gap: 12, flexWrap: "wrap" }}>
                          {r.severity && <span>{r.kind === "bug" ? "Severity" : "Importance"}: <b style={{ color: "#64748B" }}>{r.severity}</b></span>}
                          {r.status_changed_at && <span>Last update: <b style={{ color: "#64748B" }}>{fmtDT(r.status_changed_at)}</b></span>}
                          {r.attachment_path && (
                            <button type="button" onClick={(e) => { e.stopPropagation(); openAttachment(r.attachment_path); }}
                              style={{ background: "none", border: "none", padding: 0, color: ACCENT, fontWeight: 700, fontSize: 11.5, cursor: "pointer", fontFamily: "inherit", textDecoration: "underline" }}>
                              View attachment
                            </button>
                          )}
                        </div>
                        {/* The conversation, oldest first — your request, then everything
                            either side has said since. A reply from us is teal; your own
                            words are indigo and labelled "You", so a thread reads at a
                            glance without anyone having to parse names. */}
                        {cs.length > 0 && (
                          <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                            {cs.map((c) => {
                              const mine = c.author_kind === "client";
                              return (
                                <div key={c.id} style={{
                                  borderLeft: `3px solid ${mine ? "#6366F1" : "#8ED8CF"}`,
                                  background: mine ? "#FFF" : "#F2FBFA",
                                  borderRadius: 6, padding: "8px 12px",
                                }}>
                                  <div style={{ fontSize: 11, fontWeight: 800, color: "#64748B" }}>
                                    {mine ? "You" : (c.author_name || "Structure Studio")}
                                    {mine && c.author_name ? <span style={{ fontWeight: 600 }}> · {c.author_name}</span> : null}
                                    <span style={{ fontWeight: 600, color: "#94A3B8" }}> · {fmtDT(c.created_at)}</span>
                                  </div>
                                  <div style={{ fontSize: 13, color: "#334155", lineHeight: 1.6, whiteSpace: "pre-wrap", marginTop: 2 }}>{c.body}</div>
                                </div>
                              );
                            })}
                          </div>
                        )}

                        {/* Reply. Clicking inside must not collapse the row — the whole
                            <tr> above toggles `open`, so every control here stops the click. */}
                        <div style={{ marginTop: 10 }} onClick={(e) => e.stopPropagation()}>
                          {sendErr && <div style={{ ...S.err, marginBottom: 6 }}>{sendErr}</div>}
                          <textarea rows={2} placeholder="Reply to us about this…"
                            style={{ ...S.input, resize: "vertical", fontWeight: 500 }}
                            value={draft} onChange={(e) => setDraft(e.target.value)} />
                          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6 }}>
                            <span style={{ fontSize: 11.5, color: "#94A3B8" }}>
                              Goes straight to the Structure Studio team, on this request.
                            </span>
                            <button type="button" disabled={sending || !draft.trim()}
                              onClick={() => sendReply(r.id)}
                              style={{ ...S.btn(ACCENT, "#FFF"), marginLeft: "auto", padding: "6px 16px", fontSize: 12, opacity: sending || !draft.trim() ? 0.6 : 1 }}>
                              {sending ? "Sending…" : "Send"}
                            </button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── The builder's setup checklist ("Getting set up") ───────────────────────
// Carolyn 2026-08-28: new builders get an ordered list of what to do, in the order to do
// it, assigned from the template operators keep in Projects. Reads are RLS-scoped direct
// (tenant_setup_items is readable to its own tenant); the tick goes through portal-setup
// so that WHO completed it — the builder, or us on a call — is decided server-side.
// The builder's setup checklist.
//
// ⚠️ IT NO LONGER READS tenant_setup_items DIRECTLY, and must not go back to it. That read
// was RLS-scoped to current_client_id() — the SIGNED-IN person's tenant — so an operator in
// view-as was shown THEIR OWN tenant's checklist under a banner naming somebody else (both
// operator accounts carry a client_users row for structure-studio, which has its own
// 19-step list). portal-setup is in SS_TENANT_SCOPED_FNS, so it answers for the VIEWED
// tenant; it is also where the gating verdict is computed, because entitlement is a
// server-side question — and since 2026-09-15 featureOn() in the browser mirrors the viewed
// tenant for every operator, so the two now agree instead of the server correcting a blanket.
//
// `items` and `counts` are owned by ReleasesView above (one fetch feeds both the tab badge
// and this list, so they cannot disagree). A `locked` row is a paid add-on this builder has
// not bought: shown, padlocked, and left out of the count — Carolyn 2026-09-04, it doubles
// as the upsell. A step we have not finished building never arrives here at all.
function SetupChecklist({ items, counts, canEdit, onPatch, onReload, onNavigate, canAdmin }) {
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);      // id being toggled
  const [viewing, setViewing] = useState(null); // { url, title } — screenshot popup

  // Ticking is portal-setup's owner/admin action (or an operator who can write). Everyone
  // else reads the list; their checkbox is disabled rather than ticking and bouncing back.
  const mayTick = canEdit !== false;
  const toggle = async (it) => {
    if (it.locked || !mayTick) return;
    const done = !it.completed_at;
    setBusy(it.id); setError(null);
    // Optimistic: ticking a box that then sits there doing nothing feels broken.
    if (onPatch) onPatch(it.id, done);
    try {
      const { data, error: err } = await sb.functions.invoke("portal-setup", { body: { action: "toggle", id: it.id, done } });
      if (err) throw new Error(err.message || "Could not save that.");
      if (data && data.error) throw new Error(data.error);
      if (onReload) onReload();     // re-read so the real name/time replace the guess
    } catch (e) {
      setError(e.message || "Could not save that.");
      if (onReload) onReload();     // and never leave a tick the server did not accept
    }
    setBusy(null);
  };

  if (items === null || items === undefined) return <div style={{ ...S.card, color: "#64748B" }}>Loading your setup steps…</div>;
  if (!items.length) return null;   // nothing assigned — the tab is hidden anyway

  // Counted over what they can actually DO. A padlocked step is not homework, so it is
  // neither in the tally nor in the numbering below — a bar reading "3 of 15" above rows
  // numbered to 19 looks broken.
  const total = counts ? counts.total : items.filter((i) => !i.locked).length;
  const done = counts ? counts.done : items.filter((i) => !i.locked && i.completed_at).length;
  const allDone = total > 0 && done === total;
  let stepNo = 0;

  return (
    <div style={S.card}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4, flexWrap: "wrap" }}>
        <span style={{ ...S.h2, marginBottom: 0 }}>Getting set up</span>
        <span style={{ fontSize: 12, fontWeight: 700, color: allDone ? "#0E9F6E" : "#64748B" }}>
          {done} of {total} done
        </span>
        <div style={{ flex: "1 1 120px", minWidth: 80, height: 6, borderRadius: 999, background: "#EEF2F7", overflow: "hidden" }}>
          <div style={{ width: `${total ? Math.round((done / total) * 100) : 0}%`, height: "100%", background: allDone ? "#0E9F6E" : ACCENT, transition: "width .2s ease-out" }} />
        </div>
      </div>
      <div style={{ fontSize: 13, color: "#64748B", marginBottom: 12 }}>
        {allDone
          ? "That's everything — your account is ready to share with customers."
          : "Work down the list in order. Each step takes you straight to the screen that does it."}
      </div>
      {error && <div style={S.err}>{error}</div>}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {items.map((it, i) => {
          const isDone = !!it.completed_at;
          const locked = !!it.locked;
          const feat = it.requiresFeature;
          if (!locked) stepNo++;   // only doable steps carry a number — see the tally above
          return (
            <React.Fragment key={it.id}>
            {/* Section header whenever it changes walking the list in order — the copy
                carries its sections from the template, so a builder reads "The basics",
                works down it, and can see the paid-features arc is a later chapter. */}
            {it.section && it.section !== ((items[i - 1] || {}).section || null) && (
              <div style={{ fontSize: 11.5, fontWeight: 800, color: "#64748B", textTransform: "uppercase", letterSpacing: 0.6, margin: i === 0 ? "2px 0 0" : "14px 0 0" }}>{it.section}</div>
            )}
            <div style={{
              display: "flex", gap: 11, alignItems: "flex-start",
              border: "1px solid " + (locked ? "#E2E8F0" : isDone ? "#DCFCE7" : "#E2E8F0"),
              background: locked ? "#F8FAFC" : isDone ? "#F7FEF9" : "#FFF",
              borderRadius: 10, padding: "10px 13px",
            }}>
              {/* A padlock where the checkbox would be. A greyed-out checkbox invites a
                  click that does nothing; the lock says why before they reach for it. */}
              {locked ? (
                <span style={{ marginTop: 3, width: 16, display: "flex", justifyContent: "center", flexShrink: 0 }}>
                  <SsLock title={`Needs ${ssFeatureLabel(feat)}`} />
                </span>
              ) : (
                <input type="checkbox" checked={isDone} disabled={busy === it.id || !mayTick}
                  onChange={() => toggle(it)} aria-label={it.title}
                  title={mayTick ? undefined : "An owner or admin ticks these off"}
                  style={{ marginTop: 3, width: 16, height: 16, flexShrink: 0, cursor: mayTick ? "pointer" : "default" }} />
              )}
              <div style={{ minWidth: 0, flex: 1 }}>
                {/* No line-through on a locked row — that reads as "done". */}
                <div style={{ fontSize: 13.5, fontWeight: 700, color: locked ? "#94A3B8" : isDone ? "#64748B" : "#1E293B", textDecoration: !locked && isDone ? "line-through" : "none" }}>
                  <span style={{ color: "#94A3B8", fontWeight: 800, marginRight: 6 }}>{locked ? "—" : `${stepNo}.`}</span>
                  {it.title}
                </div>
                {it.detail && <div style={{ fontSize: 12.5, color: "#64748B", lineHeight: 1.5, marginTop: 3 }}>{it.detail}</div>}
                {it.image_url && (
                  <img src={it.image_url} alt={"Where to find: " + it.title} loading="lazy"
                    onClick={() => setViewing({ url: it.image_url, title: it.title })}
                    style={{ display: "block", maxHeight: 120, maxWidth: "100%", borderRadius: 8, border: "1px solid #E2E8F0", marginTop: 7, cursor: "zoom-in" }} />
                )}
                {isDone && (
                  <div style={{ fontSize: 11.5, color: "#0E9F6E", fontWeight: 700, marginTop: 4 }}>
                    Done{it.completed_by_name ? ` · ${it.completed_by_kind === "team" ? "by " + it.completed_by_name + " (Structure Studio)" : it.completed_by_name}` : ""}{it.completed_via === "jack" ? " with Jack" : ""} · {fmtDate(it.completed_at)}
                  </div>
                )}
              </div>
              {/* Locked: the upsell replaces "Take me there". The button is owner/admin
                  only — a sales rep cannot open Settings → Billing, so for them it would
                  be a dead end (the QuickBooksLocked rule, below). And the deep link goes
                  to the BILLING sub-tab specifically: navigate("settings") alone lands on
                  the Structures catalog editor with nothing about payment on screen.
                  A grant-only feature (view_3d) has nothing to buy, so it never gets a
                  button whoever is looking. */}
              {locked ? (
                canAdmin && (SS_FEATURE_LABELS[feat] || {}).buyable ? (
                  <button type="button" onClick={() => onNavigate && onNavigate("settings", "billing")}
                    style={{ ...S.btn("#EEF2FF", ACCENT), padding: "6px 12px", fontSize: 12, whiteSpace: "nowrap", flexShrink: 0 }}>
                    Add {ssFeatureLabel(feat)} — see Billing
                  </button>
                ) : (
                  <span style={{ fontSize: 11.5, color: "#94A3B8", fontWeight: 700, whiteSpace: "nowrap", flexShrink: 0, marginTop: 4 }}>
                    Needs {ssFeatureLabel(feat)}
                  </span>
                )
              ) : it.link_page && !isDone && (
                <button type="button" onClick={() => {
                  const [page, sub] = String(it.link_page).split("/");
                  if (onNavigate) onNavigate(page, sub || null);
                }}
                  style={{ ...S.btn("#EEF2FF", ACCENT), padding: "6px 12px", fontSize: 12, whiteSpace: "nowrap", flexShrink: 0 }}>
                  Take me there →
                </button>
              )}
            </div>
            </React.Fragment>
          );
        })}
      </div>

      {viewing && (
        <PdfModal url={viewing.url} title={viewing.title} image onClose={() => setViewing(null)} />
      )}
    </div>
  );
}

// ─── Support: setup checklist, the tenant's own submissions, and the global product
// changelog (read-only; team-populated). Renamed from "What's New" 2026-08-30 — the
// changelog is now one view inside it, not the whole page. ───
// `canAdmin` reaches SetupChecklist for one reason: only an owner/admin can open
// Settings → Billing, so only they get the "add this add-on" button on a padlocked step.
function ReleasesView({ submissionsKey, sub, onSub, onNavigate, canAdmin, supportOn = false }) {
  const [rows, setRows] = useState(null); // null = loading
  const [error, setError] = useState(null);
  // The sub-tab lives in the URL (/support/setup — /releases/setup still
  // resolves via SS_TAB_ALIASES), so a "Take me there" link or a
  // bookmark lands on the right one. `null` = the visitor has not chosen; see the default
  // below, which only then decides for them.
  const subtab = sub || null;
  const setSubtab = (x) => { if (onSub) onSub(x); };
  const [mineCount, setMineCount] = useState(0);

  useEffect(() => {
    (async () => {
      const { data, error: err } = await sb
        .from("release_notes")
        .select("id, released_at, version, kind, title, detail, status, sort_order, section")
        .order("released_at", { ascending: false })
        .order("sort_order", { ascending: false });
      if (err) { setError(err.message); setRows([]); return; }
      setRows(data || []);
    })();
  }, []);

  // The setup checklist, fetched ONCE here and handed to SetupChecklist below — the badge
  // and the list read the same object, so they cannot disagree about the tally. It used to
  // be two independent reads of tenant_setup_items straight from the browser; both were
  // RLS-scoped to the SIGNED-IN person's tenant, which meant an operator in view-as saw
  // their own checklist under another builder's name. portal-setup answers for the VIEWED
  // tenant and is also where the padlocks are decided. See SetupChecklist's header.
  const [setupData, setSetupData] = useState(null);   // null = not loaded yet
  const loadSetup = useCallback(async () => {
    try {
      const { data, error: err } = await sb.functions.invoke("portal-setup", { body: { action: "list" } });
      if (err) throw new Error(err.message);
      if (!data || data.error) throw new Error((data && data.error) || "no data");
      const items = data.items || [];
      // Derived here when absent so the edge function and this bundle can land in either
      // order without the checklist going blank in between.
      const counts = data.counts || (() => {
        const c = items.filter((i) => !i.locked);
        return { total: c.length, done: c.filter((i) => i.completed_at).length, open: c.filter((i) => !i.completed_at).length };
      })();
      // `canEdit` is whether this caller's tick will be accepted (owner/admin, or an operator
      // who can write). Absent from an older edge function → assume yes, as before.
      const next = { items, counts, canEdit: data.canEdit !== false };
      setSetupData(next);
      return next;
    } catch (_e) {
      // A builder who was never assigned a list looks the same as a failure here, and both
      // should simply leave the tab out rather than showing an error in a changelog.
      setSetupData({ items: [], counts: { total: 0, done: 0, open: 0 } });
      return null;
    }
  }, []);
  // Which tab leads the strip and gets landed on. LATCHED on the first read and never
  // recomputed: ticking the last setup step would otherwise reorder the tabs and switch
  // the page out from under the person who just ticked it. They graduate to My Requests
  // leading on their next visit, which is the right moment for the strip to change.
  const [lead, setLead] = useState(null);
  useEffect(() => {
    loadSetup().then((d) => setLead(d && d.counts.open > 0 ? "setup" : "mine"));
  }, [loadSetup]);
  const setupOpen = setupData ? { total: setupData.items.length, open: setupData.counts.open } : null;
  // Optimistic tick, applied to the one copy of the data. Recomputed rather than patched
  // so the badge, the bar and the row can never drift apart by a rounding of the truth.
  const patchSetup = useCallback((id, done) => {
    setSetupData((cur) => {
      if (!cur) return cur;
      const items = cur.items.map((x) => x.id === id
        ? { ...x, completed_at: done ? new Date().toISOString() : null, completed_by_kind: done ? "client" : null, completed_by_name: done ? "You" : null, completed_via: null }
        : x);
      const c = items.filter((i) => !i.locked);
      return { ...cur, items, counts: { total: c.length, done: c.filter((i) => i.completed_at).length, open: c.filter((i) => !i.completed_at).length } };
    });
  }, []);

  // Count only — the list itself is fetched by MySubmissions when that tab opens.
  // RLS scopes this to the signed-in user's tenant.
  useEffect(() => {
    (async () => {
      const { count } = await sb.from("feedback_submissions").select("id", { count: "exact", head: true });
      setMineCount(count || 0);
    })();
  }, [submissionsKey]);

  const fmtDT = (iso) => {
    if (!iso) return "";
    try { return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }); }
    catch { return iso; }
  };

  // Deliberately NO early return on loading/error: that would also hide the My
  // Submissions tab, which has its own data path and must stay reachable even when
  // the release_notes read fails. Both states are rendered inside the tab body below.
  const list = rows || [];
  const features = list.filter((r) => r.kind === "feature");
  const fixes = list.filter((r) => r.kind === "fix");
  const requested = list.filter((r) => r.kind === "requested");

  // 'shipped' deliberately has NO badge — a live feature is just a feature, and badging the
  // normal case would make every entry shout. Everything else says how real it is yet.
  const statusBadge = (status) => {
    const map = {
      // On beta, not yet promoted to main (migration 103). Published the moment the work
      // lands so tenants can watch it coming and try it, and flipped to 'shipped' by the
      // Monday merge workflow — so an entry never claims to be live before it is.
      beta:      { bg: "#FFF7ED", fg: "#C2410C", label: "On beta for testing" },
      roadmap:   { bg: "#EEF2FF", fg: "#4F46E5", label: "On the roadmap" },
      planned:   { bg: "#EEF2FF", fg: "#4F46E5", label: "Planned" },
      requested: { bg: "#FEF3C7", fg: "#B45309", label: "Requested" },
    };
    const m = map[status]; if (!m) return null;
    return <span style={{ background: m.bg, color: m.fg, fontSize: 10, fontWeight: 800, borderRadius: 999, padding: "2px 8px", textTransform: "uppercase", letterSpacing: 0.4, whiteSpace: "nowrap" }}>{m.label}</span>;
  };

  // Which part of the product an entry is about (migration 114). Rendered FIRST on the line so
  // the eye can run down the left edge and skip whole areas — the list is 88 entries and
  // growing, and a label at the end of the title would have to be read to be used.
  //
  // Brand colours, not neutral grey (Carolyn 2026-08-23): light blue ground, ACCENT purple text.
  // #DBEAFF is the light blue already used elsewhere in the portal, and ACCENT is the brand
  // purple from 01-core — the constant rather than a copy of its hex, so a rebrand moves this
  // with everything else. It reads as OURS rather than as a second status badge, which was the
  // worry about colouring it at all; the status badges stay distinguishable because they are
  // orange (beta), indigo (roadmap/planned) and amber (requested), none of which is this blue.
  // An entry with no section renders NOTHING here — '' is the column's default, so an
  // unlabelled entry looks exactly as it did before.
  const sectionChip = (section) => {
    const s = String(section || "").trim();
    if (!s) return null;
    return (
      <span style={{
        background: "#DBEAFF", color: ACCENT, fontSize: 10, fontWeight: 800,
        borderRadius: 5, padding: "2px 7px", letterSpacing: 0.3, whiteSpace: "nowrap",
        textTransform: "uppercase", flexShrink: 0,
      }}>{s}</span>
    );
  };

  const entry = (r) => (
    <div key={r.id} style={{ padding: "12px 0", borderBottom: "1px solid #F1F5F9" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        {sectionChip(r.section)}
        <span style={{ fontSize: 14, fontWeight: 700, color: "#1E293B" }}>{r.title}</span>
        {statusBadge(r.status)}
        <span style={{ marginLeft: "auto", fontSize: 11, color: "#94A3B8", whiteSpace: "nowrap" }}>{fmtDT(r.released_at)}</span>
      </div>
      {r.detail && <div style={{ fontSize: 13, color: "#475569", marginTop: 4, lineHeight: 1.5 }}>{r.detail}</div>}
    </div>
  );

  // Section definitions — one per sub-tab. `empty` shows when that tab has no rows.
  // "mine" is the odd one out: it renders <MySubmissions /> rather than release_notes
  // entries, so it carries its own count instead of a `list`. It LEADS the strip
  // (Carolyn 2026-08-28) — a builder's own open requests matter more to them than our
  // changelog does. Its id stays "mine" so /support/mine — and the older
  // /releases/mine, via the alias — both keep working.
  const TABS = [
    { id: "mine",     label: "My Requests",  dot: "#7E22CE", count: mineCount },
    { id: "features", label: "New Features", dot: "#10B981", list: features, empty: "No new features yet — check back soon." },
    { id: "fixes",    label: "Bug Fixes",    dot: "#F59E0B", list: fixes,    empty: "No bug fixes to report right now." },
    { id: "roadmap",  label: "Roadmap",      dot: "#6366F1", list: requested, empty: "Nothing on the roadmap yet — check back soon." },
  ];
  // Setup LEADS while there are steps left — finishing the account is what a new builder
  // is here to do — and drops to second once it is done, where it stays as a record of
  // what was set up. Hidden entirely for tenants who were never assigned a list, so
  // nothing about this strip changes for them.
  if (setupOpen && setupOpen.total > 0) {
    TABS.splice(lead === "setup" ? 0 : 1, 0,
      { id: "setup", label: "Getting set up", dot: "#0EA5E9", count: setupOpen.open });
  }
  // An explicit choice — a click, or a /support/<sub> link — always wins; with
  // none, the page lands on whichever tab leads.
  const effTab = subtab || lead || "mine";
  const active = TABS.find((t) => t.id === effTab) || TABS[0];
  const tabCount = (t) => (t.count != null ? t.count : t.list.length);
  // How many of this tab's entries are on beta, for the line under its heading (Carolyn
  // 2026-10-12: testers need to see which changes are on beta). The badge alone says "On beta
  // for testing" on each one; the line says what that means, once, and only when it applies.
  const betaHere = active.list ? active.list.filter((r) => r.status === "beta").length : 0;

  return (
    <div>
      <div style={{ ...S.card, background: "linear-gradient(135deg,#3D3672 0%,#1B7895 100%)", color: "#FFF", border: "none", marginBottom: 12 }}>
        <div style={{ fontSize: 18, fontWeight: 800 }}>Support</div>
        <div style={{ fontSize: 13, opacity: 0.9, marginTop: 4 }}>Get set up, track anything you've sent us, and see what's shipped — try the new things out and tell us how they land.</div>
      </div>

      {/* Sub-tab nav: New Features · Bug Fixes · Roadmap */}
      <div role="tablist" style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
        {TABS.map((t) => {
          const on = t.id === effTab;
          return (
            <button key={t.id} type="button" role="tab" aria-selected={on} onClick={() => setSubtab(t.id)}
              style={{
                display: "flex", alignItems: "center", gap: 7, cursor: "pointer", fontFamily: "inherit",
                fontSize: 13, fontWeight: 700, padding: "8px 14px", borderRadius: 999,
                border: on ? "1px solid " + ACCENT : "1px solid #E2E8F0",
                background: on ? ACCENT : "#FFF", color: on ? "#FFF" : "#475569",
              }}>
              <span style={{ width: 9, height: 9, borderRadius: 3, background: t.dot, flexShrink: 0 }} />
              {t.label}
              <span style={{ fontSize: 11, fontWeight: 800, color: on ? "#FFF" : "#94A3B8", opacity: on ? 0.85 : 1 }}>{tabCount(t)}</span>
            </button>
          );
        })}
      </div>

      {effTab === "setup" ? <SetupChecklist items={setupData && setupData.items} counts={setupData && setupData.counts}
        canEdit={!setupData || setupData.canEdit !== false}
        onPatch={patchSetup} onReload={loadSetup} onNavigate={onNavigate} canAdmin={canAdmin} />
        : effTab === "mine" ? <MySubmissions refreshKey={submissionsKey} supportOn={supportOn} />
        : error ? <div style={S.err}>Couldn't load updates: {error}</div>
        : rows === null ? <div style={{ ...S.card, color: "#64748B" }}>Loading updates…</div>
        : rows.length === 0
        ? <div style={{ ...S.card, color: "#64748B" }}>No updates yet — check back soon.</div>
        : (
          <div style={S.card}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <span style={{ width: 10, height: 10, borderRadius: 3, background: active.dot, flexShrink: 0 }} />
              <span style={{ ...S.h2, marginBottom: 0 }}>{active.label}</span>
              <span style={{ fontSize: 12, color: "#94A3B8" }}>({active.list.length})</span>
            </div>
            {betaHere > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12.5, color: "#9A3412", background: "#FFF7ED", border: "1px solid #FED7AA", borderRadius: 8, padding: "7px 10px", margin: "8px 0 4px", lineHeight: 1.45 }}>
                {statusBadge("beta")}
                <span>
                  {betaHere === 1 ? "1 entry here is" : `${betaHere} entries here are`} live on beta now and
                  {betaHere === 1 ? " comes" : " come"} to everyone with the next release.
                </span>
              </div>
            )}
            {active.list.length === 0
              ? <div style={{ fontSize: 13, color: "#64748B", padding: "8px 0" }}>{active.empty}</div>
              : active.list.map(entry)}
          </div>
        )}
    </div>
  );
}

// ─── QuickBooks Sync: the not-switched-on card ───
// One component for BOTH mounts of QuickBooks (the top-level tab and Settings → QuickBooks),
// so the two can never drift into saying different things. Same shape as the scheduling
// teasers: the tab stays visible, this explains what they'd get, and an owner/admin gets a
// button straight to Billing. A non-admin gets no button — they cannot buy it.
function QuickBooksLocked({ canAdmin, onSeeBilling }) {
  return (
    <ComingSoon
      title="QuickBooks Sync"
      icon={<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="#FFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.5 8.5A2.5 2.5 0 0 0 9.5 15H12M14.5 15.5a2.5 2.5 0 0 0 0-6H12"/></svg>}
      blurb="Send your accepted estimates to QuickBooks Online as invoices, without typing them twice. Map each building style and add-on to the right QuickBooks item once, and every invoice lands in your books the way your accountant expects."
      bullets={[
        "Push an invoice to QuickBooks straight from a design",
        "Map styles, sizes and add-ons to your own QuickBooks items",
        "Keep your books matching your estimates, with no re-keying",
      ]}
      cta={canAdmin ? { label: "Turn on QuickBooks Sync — see Billing", onClick: onSeeBilling } : null}
      available
    />
  );
}

// ─── Coming-soon teaser panel ───
// Placeholder for features that aren't built yet, shown to every logged-in user so
// they can see what's on the way. Pure presentation — no data, no side effects.
// `cta` (optional, { label, onClick }) turns the teaser into an AVAILABLE-NOW card: the
// badge flips from "Coming soon" to "Available now" and the footer becomes the button —
// used by billable features that have launched but this tenant hasn't switched on yet.
// `available` says the feature HAS SHIPPED and is simply not switched on for this tenant.
// It has to be separate from `cta`, because only an owner/admin gets a cta — so deriving
// "is it live?" from the button meant a sales rep was told a shipped feature was "Coming
// soon" and that we were still building it. They would repeat that to a customer.
function ComingSoon({ icon, title, blurb, bullets, cta, available = false }) {
  return (
    <div style={{ ...S.card, padding: 0, overflow: "hidden", maxWidth: 720 }}>
      <div style={{ background: "linear-gradient(135deg, #3D3672 0%, #1B7895 100%)", padding: "34px 28px", color: "#FFF", display: "flex", alignItems: "center", gap: 20 }}>
        <div style={{ width: 62, height: 62, borderRadius: 15, background: "rgba(255,255,255,0.15)", border: "1px solid rgba(255,255,255,0.28)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          {icon}
        </div>
        <div style={{ minWidth: 0 }}>
          <span style={{ display: "inline-block", background: "#75E6DA", color: "#22345B", fontSize: 10.5, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", borderRadius: 999, padding: "3px 10px", marginBottom: 9 }}>{(cta || available) ? "Available now" : "Coming soon"}</span>
          <div style={{ fontSize: 22, fontWeight: 800, lineHeight: 1.15 }}>{title}</div>
        </div>
      </div>
      <div style={{ padding: "24px 28px" }}>
        <p style={{ fontSize: 14.5, color: "#334155", lineHeight: 1.6, margin: "0 0 16px" }}>{blurb}</p>
        {bullets && bullets.length > 0 && (
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 10 }}>
            {bullets.map((b, i) => (
              <li key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10, fontSize: 13.5, color: "#475569" }}>
                <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="#1B7895" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}><path d="M20 6 9 17l-5-5"/></svg>
                <span>{b}</span>
              </li>
            ))}
          </ul>
        )}
        {cta ? (
          <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid #F1F5F9" }}>
            <button type="button" onClick={cta.onClick} style={S.btn(ACCENT, "#FFF")}>{cta.label}</button>
          </div>
        ) : (
          <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid #F1F5F9", fontSize: 12.5, color: "#94A3B8", fontWeight: 600 }}>
            {available
              ? "This is ready to go — ask an owner or admin on your account to switch it on."
              : "We're actively building this — it'll appear right here when it's ready, with nothing for you to set up."}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Orders, when it can't be shown ───
// The "Coming soon / Work in progress" teaser that stood here (example orders behind a lock) went
// on 2026-10-21. Orders shipped to builders on 2026-09-01, so the teaser only ever reached two
// people, and told both of them something false: an operator viewing a builder (orders and payments
// RLS is scoped to the signed-in tenant, so view-as can't read them) and a team member whose title
// doesn't hold Orders. Carolyn asked on 2026-10-19: "Why does it say work in progress?" (a 10-20
// error row's address carried ?view=structure-studio). Each now gets the true sentence and the way out.
function OrdersNotShown({ viewingName = null, onExitView = null }) {
  return (
    <div style={{ maxWidth: 560 }}>
      <div style={{ ...S.card }} data-ss-orders-not-shown={viewingName ? "view-as" : "access"}>
        <div style={{ ...S.h2, fontSize: 16 }}>Orders</div>
        {viewingName ? (
          <>
            <p style={{ fontSize: 13.5, color: "#475569", lineHeight: 1.55, margin: "0 0 14px" }}>
              Orders isn't shown while viewing as <b>{viewingName}</b>. Their orders and payments can only be read from their own sign-in.
            </p>
            {onExitView && <button type="button" onClick={onExitView} style={S.btn(ACCENT, "#FFF")}>Exit view-as</button>}
          </>
        ) : (
          <p style={{ fontSize: 13.5, color: "#475569", lineHeight: 1.55, margin: 0 }}>
            Orders isn't part of your access. Ask an owner to turn it on for you under Settings → Team.
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Orders & payments ───
// An order appears automatically once a design's status reaches accepted (the
// designs_ensure_order trigger, migration 053). This view is the money view:
// what each job is worth, what's been collected, and what's still owed.
//
// Phase 1 is RECORD-ONLY — cash / check / card-taken-elsewhere. Nothing is charged
// here, so no payment gateway is involved; balances are still real. Card charging
// drops in later on the same payments table (its gateway_* columns are already there).
//
// Totals come from the GHL estimate via sync-design-status (GHL applies tax, so our
// pre-tax subtotal is not a safe substitute). When GHL hasn't given us one, the total
// reads "Set total" and the owner types it — we never show a guessed number.
const money = (cents) => cents == null ? "—" : "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Dollars → cents. Returns NaN for anything without a digit: Number("") is 0, so a
// blank or junk field would otherwise read as a legitimate $0.00 and get saved.
const centsFrom = (txt) => {
  const s = String(txt == null ? "" : txt);
  if (!/\d/.test(s)) return NaN;
  const n = Number(s.replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
};
// Today in the LOCAL calendar (en-CA renders YYYY-MM-DD). Not toISOString(), which is
// UTC — that files an evening payment under tomorrow's date for every US timezone.
const todayLocal = () => new Date().toLocaleDateString("en-CA");
const PAY_METHODS = [["cash", "Cash"], ["check", "Check"], ["card", "Card"], ["ach", "Bank / ACH"], ["other", "Other"]];

// ── Bank details: a Routing box and a Checking box (Carolyn, 2026-09-02) ───────────────────
// "You need two boxes there … one says routing and one says checking." CardPointe's hosted
// tokenizer takes a bank account only as ONE "routing/account" string in ONE field, so the two
// boxes are ours, and the string they compose goes from this browser straight to CardSecure's
// tokenize endpoint on the tokenizer's own origin (served by portal-payments pay_options, never
// written here — the repo is public). The token that comes back is charged exactly as the
// iframe's was. The numbers never reach our servers.
//
// Checked 2026-10-06 from headless Chrome on the beta and production origins, with an empty
// body: CardSecure answers both the preflight and the request with
// Access-Control-Allow-Origin: *, so the browser can read the token.
//
// ⚠️ TWINS. my-quotes.html carries the customer's copy of these three, in that page's ES5.
// scripts/preflight.mjs (checkAchBankInputs) lifts achRoutingOk/achAccountOk out of BOTH files
// and runs them against the same vectors, and refuses a push where an ach* name meets
// localStorage, a URL, the console or the error log. The numbers live in two pieces of
// OrderDetail state and in the body of one POST, and nowhere else.

// 9 digits, and the 9th is the ABA check digit: 3(d1+d4+d7) + 7(d2+d5+d8) + (d3+d6+d9) is a
// multiple of 10. That catches a mistyped digit at the counter instead of at the bank. A wrong
// ACCOUNT number cannot be caught: it tokenizes fine and fails only at the gateway.
function achRoutingOk(v) {
  const d = String(v == null ? "" : v);
  if (!/^\d{9}$/.test(d)) return false;
  const n = [];
  for (let i = 0; i < 9; i++) n.push(d.charCodeAt(i) - 48);
  return (3 * (n[0] + n[3] + n[6]) + 7 * (n[1] + n[4] + n[7]) + (n[2] + n[5] + n[8])) % 10 === 0;
}
// 4 to 17 digits (17 is the width of the bank-file field).
function achAccountOk(v) {
  return /^\d{4,17}$/.test(String(v == null ? "" : v));
}
// routing + "/" + account -> { token } or { error }. The sentences name neither number, and
// CardSecure's own message is never shown, so nothing it echoes can reach the screen.
async function achTokenize(origin, achRouting, achAccount) {
  const bad = { error: "Those bank details couldn't be checked. Check both numbers and try again." };
  if (!/^https:\/\//.test(String(origin || "")) || !achRoutingOk(achRouting) || !achAccountOk(achAccount)) return bad;
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), 15000) : null;
  try {
    const res = await fetch(`${origin}/cardsecure/api/v1/ccn/tokenize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account: `${achRouting}/${achAccount}`, unique: true }),
      credentials: "omit",
      cache: "no-store",
      signal: ctl ? ctl.signal : undefined,
    });
    // The body read stays OUTSIDE the JSON try: a connection that drops mid-body is a
    // connection problem (the catch below), not numbers to re-check. my-quotes.html agrees.
    const text = await res.text();
    let j = null;
    try { j = JSON.parse(text); } catch (_e) { /* not JSON */ }
    let tok = j && typeof j.token === "string" ? j.token.trim() : "";
    // An older reply shape carries the token in `message` beside errorcode 0.
    if (!tok && j && Number(j.errorcode) === 0 && /^\d{8,}$/.test(String(j.message || ""))) tok = String(j.message);
    // "NNNN::reason" is how CardSecure spells a failure inside a 200, and it may come
    // URL-encoded ("0008%3A%3A…"): Fiserv's own itoke.js decodes before it tests, so do we.
    let plain = tok;
    try { plain = decodeURIComponent(tok); } catch (_e) { /* not encoded */ }
    if (!res.ok || !tok || tok.length > 256 || /^\d{4}::/.test(plain)) return bad;
    return { token: tok };
  } catch (_e) {
    return { error: "Couldn't reach the bank-details check. Check the connection and try again." };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ORDERS IS ALL SALES (Carolyn 2026-08-08): "even an inventory building will need delivery
// so it is an ORDER." So this is the ONE page a sold building leaves for the shop or the
// truck — Designs and Inventory report, Orders dispatches. Two routes out, decided by what
// was actually sold:
//   * a custom build (its own design)      -> Build Schedule, then delivery via the pool
//   * a lot building (an inventory sale)   -> straight to Delivery; it is already built
// Both are gated on the design being INVOICED, which is what "sold" means here.
//
// ⚠️ `ordersOn` is the orders:edit half of the same grant model `coOn` already carries. The
// Orders TAB is readable at orders='view' — that is what shipped to crew leaders and drivers
// on 2026-09-01 — but recording a payment, voiding one and typing an order total are writes,
// and until this prop existed the detail screen offered all three to every viewer. Migration
// 188 is the control (restrictive area policies on orders/payments); this is the courtesy
// half, so a viewer sees a read-only order instead of a button that returns a raw RLS
// refusal. It DEFAULTS TO TRUE: 12-shell.jsx has computed `ordersCanEdit` since 2026-09-01
// but does not yet pass it, and defaulting to false would take Record-a-payment away from
// owners and admins. The default is the no-op, `ordersOn={ordersCanEdit}` at the call site
// is the fix — see the note returned with this change.
function OrdersView({ clientId, schedOn = false, deliverOn = false, coOn = false, coApproveOn = false, ordersOn = true, onScheduleDelivery = null, onOpenDesign = null, urlOpenId = null, onOpenChange = null }) {
  // Seeded from the tab cache so a revisit shows the order rows at once instead of a
  // skeleton. Caching rows that carry `paid` is safe here precisely because `moneyReady`
  // below starts false on every mount: every figure renders as pending until this load's
  // own payment read lands. Structure arrives early; money still never does.
  const [rows, setRows] = useState(() => ssCacheGet("rest", "orders", clientId));   // null = loading; [{order, design, paid}]
  const [error, setError] = useState(null);
  const [schedLinks, setSchedLinks] = useState(null);   // { byDesign, saleDesigns, … }
  const [schedBusy, setSchedBusy] = useState(null);
  const [schedMsg, setSchedMsg] = useState(null);       // { ok } | { err }
  // ── THE ORDER DETAIL HAS A URL NOW ───────────────────────────────────────────────
  // It was pure component state, so the browser Back button walked out of Orders entirely
  // instead of closing the order, and an order could not be linked to at all. The CRM code
  // names this gap in its own comment -- "there is no /orders/<id> route to
  // deep-link to" -- which is why its Orders card could not link out.
  //
  // Carolyn, 2026-08-28 @41:03, on why this matters more than it looks: "One of my biggest
  // frustrating parts of ShedSuite, which we use for many years, is you could never hit the
  // back button. If you hit the back button, you lost everything on that screen ... I just
  // don't want it to be like, oh no, you can't click that back button."
  //
  // The URL is the source of truth when the shell supplies one; the local state is the
  // fallback for any host that does not. Keeping BOTH means this component still works
  // unchanged if it is ever mounted somewhere without a router.
  const [openIdLocal, setOpenIdLocal] = useState(null);
  const openId = onOpenChange ? urlOpenId : openIdLocal;
  const setOpenId = (id) => { if (onOpenChange) onOpenChange(id); else setOpenIdLocal(id); };
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  // Facet filters: ordered date-range + amount min/max (dollars, against the order total).
  const [fFrom, setFFrom] = useState("");
  const [fTo, setFTo] = useState("");
  const [fMin, setFMin] = useState("");
  const [fMax, setFMax] = useState("");
  const hasFacets = !!fFrom || !!fTo || fMin !== "" || fMax !== "";
  const clearFacets = () => { setFFrom(""); setFTo(""); setFMin(""); setFMax(""); };

  // MONEY ARRIVES SECOND, and the screen says so until it does.
  //
  // Carolyn, 2026-08-26, on Orders: "I feel like it takes a while for that to load too."
  // It did, for the same reason Contacts did — one await chain, one setRows at the end. But
  // Orders cannot simply paint its first read: the SS-only row filter needs `designs` (a
  // GHL-quoted order must never appear), so orders+designs is the smallest honest unit.
  //
  // Payments are the slow leg — a paginated loop over every payment the tenant has ever
  // taken — and they only affect MONEY, not which rows exist. So they land second, and
  // until they do, every figure derived from them is rendered as pending rather than as
  // zero. Painting $0 collected and "Awaiting payment" on a settled order for two seconds
  // is not a faster page, it is a page that lies about money and then corrects itself,
  // which is exactly the silent understatement the payment pagination exists to prevent.
  const [moneyReady, setMoneyReady] = useState(false);
  // The tenant whose pending bank payments this mount has already asked the gateway about —
  // see "BANK MONEY ONLY MOVES WHEN SOMEBODY ASKS" at the end of load().
  const reconcileFiredRef = useRef(null);
  const load = useCallback(async () => {
    setError(null);
    setMoneyReady(false);
    const { data: ords, error: oErr } = await sb
      .from("orders").select("*").eq("client_id", clientId).order("ordered_at", { ascending: false }).limit(2000);
    if (oErr) { setError(oErr.message); setRows([]); return; }
    const list = ords || [];
    const codes = list.map((o) => o.short_code).filter(Boolean);
    // designs + payments are separate reads: orders.short_code is a soft link (a
    // future manual order has none), so there's no FK for PostgREST to embed.
    // ALL payments, voided included — voided rows stay visible in the history (the
    // void dialog promises exactly that); they're excluded from the math below, not
    // from the fetch. Paged to the end: a flat .limit() never fails loudly, it just
    // drops the OLDEST rows (received_at DESC), which understates "paid" and shows
    // an open balance on orders a large tenant has actually settled.
    const fetchAllPayments = async () => {
      const page = 1000; const seen = new Set(); const out = [];
      for (let from = 0; ; from += page) {
        // id is the TIEBREAKER, not decoration: received_at is stored as local noon of the
        // chosen day, so every payment taken on one day sorts equal. Postgres is free to
        // order a tie group differently per page, and then a boundary row comes back twice
        // (the Set below drops it) while the row it displaced comes back never — the same
        // silent understatement of "paid" the paging exists to prevent.
        const { data, error: pErr } = await sb.from("payments").select("*").eq("client_id", clientId)
          .order("received_at", { ascending: false }).order("id", { ascending: false })
          .range(from, from + page - 1);
        if (pErr) return { error: pErr };
        // Dedupe by id: a payment landing mid-pagination (the mount-time GHL sync)
        // shifts the pages and could repeat a row — double-counting real money.
        (data || []).forEach((p) => { if (!seen.has(p.id)) { seen.add(p.id); out.push(p); } });
        if (!data || data.length < page) return { data: out };
      }
    };
    // ⏱ The money reads start HERE, not after the paint, and overlap the designs read below.
    // Neither depends on designs, so awaiting the paint before starting them just added a
    // round trip to how long the figures showed as pending. They are still CONSUMED after
    // the paint — nothing about the ordering of what appears on screen changes.
    //
    // ⛔ These cannot be moved in FRONT of the paint, and the designs read cannot be
    // parallelised with the orders read: `ssOrders` below decides which orders this tab
    // shows at all, using each design's ss_quote_number. Painting before designs land would
    // list GHL-quoted orders and then remove them.
    const paysP = fetchAllPayments().then((r) => r, (e) => ({ error: e }));
    // Pending change orders (migration 126): the row wears an amber chip, and the server
    // 409s an invoice while one is open — the chip is the courtesy half of that rule.
    //
    // ⚠️ NO `.in("short_code", codes)`. PostgREST reads filters from the QUERY STRING, so that
    // list travelled as one `short_code=in.(...)` parameter carrying every order code in the
    // tenant. Around 500 orders it crosses the URL length ceiling and the whole Orders tab
    // dies on a read that is pure decoration — and it fails at the SIZE a real tenant grows
    // into, not in testing. The filter also bought nothing: `client_id` + RLS already scope
    // this to the tenant, `status = pending_ack` is a handful of rows on any tenant, and
    // `pendingCo` below is only ever probed per rendered order, so codes that belong to no
    // shown order are inert. The read stays a fixed-size URL whatever the tenant's volume.
    // 'draft' JOINS 'pending_ack' (2026-09-07): a change a rep opened and walked away from
    // is exactly the thing this list has to surface, and it is invisible everywhere else.
    // The two states mean different things on the row, so the STATUS comes back with the
    // code rather than being flattened into one boolean.
    const coP = (codes.length
      ? sb.from("change_orders").select("short_code, co_no, status").eq("client_id", clientId).in("status", ["draft", "pending_ack"])
      : Promise.resolve({ data: [] })
    ).then((r) => r, (e) => ({ error: e }));

    // Orders somebody has asked to unlock, and orders an approver has unlocked but nobody
    // has used yet. Both are waiting on a PERSON, and neither shows anywhere else in the
    // product — an approver would otherwise have to open every order to find the one request
    // sitting on their desk. Same fixed-size URL discipline as the change-order read above:
    // no `.in("short_code", ...)`, because the open set is tiny on any tenant.
    // SOFT: a decoration read must never take the tab down (its own `.then` swallow, and no
    // error branch below), unlike the two reads whose failure would understate money.
    const unlockP = (codes.length
      ? sb.from("order_unlocks").select("short_code, decision")
          .eq("client_id", clientId).is("consumed_at", null).is("released_at", null)
      : Promise.resolve({ data: [] })
    ).then((r) => r, () => ({ data: [] }));

    // Through the server (portal-settings orders_designs), NOT direct RLS: the designs
    // policy answers "may you read DESIGNS", and since this tab shipped to tenants its
    // viewers include titles that hold Orders and not Designs. See that action's header.
    const dsnRes = codes.length
      ? await sb.functions.invoke("portal-settings", { body: { action: "orders_designs", shortCodes: codes } })
          .then((r) => r.error ? { error: r.error } : { data: (r.data && r.data.designs) || [] })
      : { data: [] };
    // A failed designs read must not read as "no designs": byCode would come up empty,
    // the SS-only filter below would drop EVERY order, and the tab would show
    // "No orders yet." + $0.00 tiles with nothing anywhere saying a read failed.
    if (dsnRes.error) { setError(dsnRes.error.message); setRows([]); return; }
    const byCode = {}; (dsnRes.data || []).forEach((d) => { byCode[d.short_code] = d; });
    // SS ORDERS ONLY (Carolyn 2026-08-24: "the Orders tab should NOT show any orders
    // from GHL — only the SS invoices/orders"). The designs_ensure_order trigger mints
    // a row for EVERY accepted/invoiced design, GHL-quoted ones included — those rows
    // stay in the table (other code may care), but this tab is the ledger of paperwork
    // StructureStudio issued: the design carries an ss_quote_number, or the order has no
    // design at all (a future manual/walk-in order is SS-native by definition).
    const ssOrders = list.filter((o) => !o.short_code || (byCode[o.short_code] && byCode[o.short_code].ss_quote_number));
    // PAINT NOW: the right rows, with the money still marked pending. `paid: 0` is never
    // read while moneyReady is false — every consumer of it is gated below.
    setRows(ssOrders.map((o) => ({ o, d: byCode[o.short_code] || null, pays: [], paid: 0, coPending: false, coDraft: false, coNo: null, unlockState: null })));

    // Both were started before the designs read above; by now they are usually already in.
    const [paysRes, coRes] = await Promise.all([paysP, coP]);
    // A failed payments read must not render every order as unpaid — that's the same
    // silent understatement the paging above exists to prevent. moneyReady stays false, so
    // the figures stay pending rather than resolving to a wrong number behind an error.
    if (paysRes.error) { setError(paysRes.error.message); return; }
    // Same for change orders: swallowing this read hides every "CO pending" chip while
    // the server's invoice 409 still stands — the courtesy half of the rule goes dark.
    if (coRes.error) { setError(coRes.error.message); return; }
    const payByOrder = {}; (paysRes.data || []).forEach((p) => { (payByOrder[p.order_id] = payByOrder[p.order_id] || []).push(p); });
    const coByCode = {};
    for (const c of ((coRes && coRes.data) || [])) coByCode[c.short_code] = c;
    const unlockRes = await unlockP;
    const unlockByCode = {};
    for (const u of ((unlockRes && unlockRes.data) || [])) {
      // A DECLINED request is not an open one, and the row should stop shouting about it.
      if (u.decision === "declined") continue;
      unlockByCode[u.short_code] = u.decision === "granted" ? "granted" : "asked";
    }
    const settled = ssOrders.map((o) => {
      const ps = payByOrder[o.id] || [];
      return {
        o, d: byCode[o.short_code] || null, pays: ps,
        // ⚠️ SETTLED MONEY ONLY (migration 174). A bank payment is not money until it
        // funds — it can come back Rejected up to three days later, and a builder who
        // scheduled a build against it has a real problem. `pending` counts toward
        // NOTHING here, and that is why this split lives at this one source: balOf, every
        // status chip, the tiles and the detail card all inherit the honesty from it
        // rather than each re-deciding.
        paid: ps.reduce((s, p) => s + (p.voided_at || p.funding_state === "pending" || p.funding_state === "returned" ? 0 : (p.amount_cents || 0)), 0),
        pending: ps.reduce((s, p) => s + (!p.voided_at && p.funding_state === "pending" ? (p.amount_cents || 0) : 0), 0),
        // `coPending` keeps its old meaning EXACTLY — awaiting the customer — because the
        // invoice gate downstream is pending_ack-only and this chip explains that gate.
        coPending: (coByCode[o.short_code] || {}).status === "pending_ack",
        coDraft: (coByCode[o.short_code] || {}).status === "draft",
        coNo: (coByCode[o.short_code] || {}).co_no || null,
        unlockState: unlockByCode[o.short_code] || null,   // 'asked' | 'granted' | null
      };
    });
    setRows(settled);
    // Cached only once the money is real — a half-loaded row set (paid: 0 everywhere) must
    // never be what a revisit paints from, even behind the pending flag.
    ssCachePut("rest", "orders", clientId, settled);
    setMoneyReady(true);

    // ── BANK MONEY ONLY MOVES WHEN SOMEBODY ASKS ──────────────────────────────────────
    // portal-payments' `reconcile` is the ONLY code that turns a pending bank payment into
    // settled (or returned) money — there is no pg_cron — and its header names this tab as
    // the caller: fire-and-forget on load, never awaited in the paint path, then re-read the
    // money. Nothing called it, so every ACH payment, from either the customer's pay screen
    // or the Record-a-payment modal, read "Bank payment clearing" forever, the balance never
    // closed, and paymentAmountDecision refused every further payment on that order
    // ("A bank payment on this order is still clearing").
    // Only when a gateway payment IS pending (the sweep has nothing to do otherwise, and a
    // tenant without card payments must not file a refusal on every load), and at most once
    // per mount, so a sweep that reports movement can never become a reload loop.
    const hasPendingBank = (paysRes.data || []).some((p) =>
      p.gateway === "cardpointe" && !p.voided_at && p.funding_state === "pending");
    if (hasPendingBank && reconcileFiredRef.current !== clientId) {
      reconcileFiredRef.current = clientId;
      sb.functions.invoke("portal-payments", { body: { action: "reconcile" } }).then(({ data }) => {
        const moved = data && !data.error && (
          (Array.isArray(data.updated) && data.updated.length > 0) ||
          (Array.isArray(data.resolved) && data.resolved.some((x) => x && x.resolved)));
        if (moved) load();
      }, () => {});
    }
  }, [clientId]);

  // Refresh = re-read the tables. This used to also pull totals/statuses from GHL
  // (sync-design-status over every order's code), but Orders is SS paperwork only now
  // (Carolyn 2026-08-24): the GHL-quoted orders it refreshed are no longer shown, and SS
  // designs are fenced out of that sync by design — so the GHL leg refreshed nothing this
  // tab renders and cost a GHL API read per mount. Statuses on SS orders are written
  // locally (customer-accept / send_invoice) and arrive with the plain read.
  const [syncing, setSyncing] = useState(false);
  const syncFromGhl = useCallback(async () => {
    setSyncing(true);
    await load();
    setSyncing(false);
  }, [load]);

  useEffect(() => { load(); }, [load]);

  // Which buildings are already on the board or on a load, and which orders are lot sales.
  // Only fetched when this person can actually act on it — a read of the schedule is still
  // a read of the schedule.
  const loadSchedLinks = useCallback(async () => {
    if (!schedOn && !deliverOn) return;
    const { data } = await sb.functions.invoke("portal-schedule", { body: { action: "schedule_links" } });
    if (data && !data.error) setSchedLinks(data);
  }, [schedOn, deliverOn, clientId]);
  useEffect(() => { loadSchedLinks(); }, [loadSchedLinks]);

  const addToBuildSchedule = async (r) => {
    setSchedBusy(r.o.id); setSchedMsg(null);
    const { data, error: fnErr } = await sb.functions.invoke("portal-schedule", {
      body: { action: "create_job", source: "order", designShortCode: r.o.short_code },
    });
    setSchedBusy(null);
    // Say so when it fails. This one legitimately refuses — an uninvoiced design, an
    // inventory sale that belongs on a load, or a building already on the board.
    if (!data || data.error) {
      setSchedMsg({ err: (data && data.error) || (fnErr ? await fnError(fnErr) : "Could not add that to the build schedule.") });
      return;
    }
    setSchedMsg({ ok: `${nameOf(r)}'s building is on the Build Schedule.` });
    loadSchedLinks();
  };

  const nameOf = (r) => ((r.d && r.d.contact && r.d.contact.name) || "—");
  const bldgOf = (r) => {
    const sel = (r.d && r.d.selections) || {};
    return [titleCase(sel.style), sel.size].filter(Boolean).join(" ") || "—";
  };

  // The Schedule column. Three questions in order: is it sold yet, is it a lot building or
  // a build, and has it already gone where it's going?
  const schedChipStyle = (bg, fg) => ({ display: "inline-flex", alignItems: "center", gap: 5, background: bg, color: fg, borderRadius: 20, padding: "4px 10px", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" });
  const schedLinkBtn = (label, title, onClick, busy) => (
    <button type="button" onClick={onClick} disabled={busy} title={title}
      style={{ ...S.btn("#FFF", "#475569"), border: "1px solid #CBD5E1", padding: "5px 10px", fontSize: 12 }}>
      {busy ? "Working…" : label}
    </button>
  );
  const schedCell = (r) => {
    const links = schedLinks || {};
    const sale = (links.saleDesigns || {})[r.o.short_code];   // set = this order sold a LOT building
    const job = (links.byDesign || {})[r.o.short_code];       // set = already on the build board
    // SOLD = the customer SIGNED the bill. Since migration 136 `status: 'invoiced'` means
    // exactly that — sign_invoice is its only writer and send_invoice stopped flipping it —
    // so the gate below is right. Only the old label was wrong: it said "Invoice first" at
    // a builder who had already sent the invoice and was waiting on the customer, pointing
    // them at a job that was done. Same split, and the same words, as stateOf's chip.
    const sold = r.d && (normStatus(r.d.status) === "invoiced" || normStatus(r.d.status) === "delivered");
    if (!sold) {
      const waiting = r.d && r.d.ss_invoice_sent_at;
      return (
        <span style={{ fontSize: 11.5, color: "#94A3B8", fontWeight: 600 }}
          title={waiting
            ? "The invoice is out — this can be scheduled once the customer signs it."
            : "Send the invoice; scheduling unlocks when the customer signs it."}>
          {waiting ? "Awaiting signature" : "Invoice first"}
        </span>
      );
    }

    if (sale) {
      // Already built and sitting on a lot — it never touches the build board, it just
      // needs a truck. Serial shown because that is how the yard refers to it.
      // DELIVERED first: `onLoad` only counts an OPEN stop, so once the sale stop was marked
      // delivered this row fell through to "Schedule delivery →" again — for a building
      // standing in the buyer's yard. Marking that stop delivered writes 'delivered' onto
      // this very design (portal-schedule writeBackDelivered), so the row already knows.
      if (normStatus(r.d.status) === "delivered") return <span style={schedChipStyle("#F0FDF4", "#15803D")}>Delivered ✓</span>;
      if (sale.onLoad) return <span style={schedChipStyle("#EEF2FF", "#3D3672")}>On a load</span>;
      if (!deliverOn) return <span style={{ fontSize: 11.5, color: "#94A3B8", fontWeight: 600 }}>#{sale.serial} · needs a load</span>;
      return schedLinkBtn("Schedule delivery →", `Building #${sale.serial} is on the lot — take it to the Delivery Schedule`,
        () => onScheduleDelivery && onScheduleDelivery(sale), false);
    }
    if (job) {
      return (
        <span style={schedChipStyle("#F1F5F9", "#334155")}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: job.color || "#94A3B8", display: "inline-block" }}></span>
          {job.stage || "On the board"}
        </span>
      );
    }
    if (!schedOn) return <span style={{ fontSize: 11.5, color: "#94A3B8", fontWeight: 600 }}>Not scheduled</span>;
    return schedLinkBtn("Add to build schedule", "Put this building on the Build Schedule — it takes the next shop serial number the first time, and keeps it",
      () => addToBuildSchedule(r), schedBusy === r.o.id);
  };
  const balOf = (r) => (r.o.total_cents == null ? null : r.o.total_cents - r.paid);
  const stateOf = (r) => {
    // Every state below "Needs total" is a claim about what has been collected, and until
    // the payments read lands we do not know. One honest pending state beats six confident
    // wrong ones. It is deliberately not a filterable key — see the chip guard below.
    if (!moneyReady) return { key: "pending", label: "…", bg: "#F1F5F9", fg: "#94A3B8" };
    const bal = balOf(r);
    if (bal == null) return { key: "nototal", label: "Needs total", bg: "#F1F5F9", fg: "#475569" };
    // Collected more than the total — say so plainly instead of "Paid in full", which
    // would hide that money is owed BACK to the customer.
    //
    // "Refund owed", not "Overpaid" (Carolyn 2026-09-06). Until a rep could take money OFF a
    // signed order this only ever happened by accident — someone paid twice — and "Overpaid"
    // described the accident. An amendment makes it a normal, deliberate outcome: the
    // customer dropped the loft on a job they had already paid for, and the builder owes them
    // the difference. That is an obligation with an action attached, and the word has to say
    // so. Reversing a real card charge is Refund on the payment itself; nothing here does it
    // automatically, and nothing here ever touches a payment.
    if (bal < 0) return { key: "over", label: "Refund owed", bg: "#FFEDD5", fg: "#9A3412" };
    // "Paid in full" uses SETTLED money only — a pending bank payment can never produce it.
    if (bal === 0) return { key: "paid", label: "Paid in full", bg: "#DCFCE7", fg: "#166534" };
    // Clearing OUTRANKS "Partially paid", and the order matters: "partially paid" is a
    // claim about money we hold, and clearing money is money we do not hold yet.
    if ((r.pending || 0) > 0) return { key: "clearing", label: "Bank payment clearing", bg: "#FEF3C7", fg: "#92400E" };
    // NOTE: no "Deposit paid" chip at LIST level, deliberately. The deposit lives on
    // invoice_sends, which has RLS with zero policies and is not browser-readable — the
    // same reason designs.ss_invoice_sent_at had to exist. Deriving it here would need
    // either a mirrored column or a per-row edge call on every list load. The deposit IS
    // shown on the order itself, where pay_options already carries it.
    if (r.paid > 0) return { key: "partial", label: "Partially paid", bg: "#DBEAFE", fg: "#1E40AF" };
    // Nothing collected yet — and these are now THREE different jobs, each waiting on a
    // different person. A quote the customer accepted but nobody has billed is the OWNER's
    // move. An invoice that is out but unsigned is the CUSTOMER's (migration 136 — the
    // signature moved to the invoice, and the design stays 'accepted' until they sign).
    // An invoice that is signed and unpaid is the customer's too, but for money.
    // Lumping them together hides which follow-up is actually owed.
    if ((r.d && r.d.status) === "accepted") {
      if (r.d && r.d.ss_invoice_sent_at) return { key: "invoiceout", label: "Awaiting signature", bg: "#FEF9C3", fg: "#854D0E" };
      // "Invoice to approve" (migration 229; Ahsan 2026-09-15: "Accept → auto-DRAFT invoice,
      // builder approves with one click"). The CUSTOMER accepted in their account and asked for
      // the invoice; nothing is numbered, emailed or pushed until the builder approves. Same move
      // as "Needs invoice" — issue it — but somebody is now waiting on it, so it gets its own
      // name. portal-settings "Not now" clears the stamp, which drops the order back to
      // "Needs invoice". A server from before 229 never sends the column: this branch sleeps.
      return (r.d && r.d.ss_invoice_requested_at)
        ? { key: "invoicereq", label: "Invoice to approve", bg: "#EDE9FE", fg: "#5B21B6" }
        : { key: "needsinvoice", label: "Needs invoice", bg: "#FEF3C7", fg: "#92400E" };
    }
    return { key: "awaiting", label: "Awaiting payment", bg: "#FFE4E6", fg: "#9F1239" };
  };

  const all = rows || [];
  const shown = all.filter((r) => {
    // While the money is pending every row reads "pending", so a state filter left over
    // from before a Refresh would empty the table for a second and look like a wipe.
    if (moneyReady && filter !== "all" && stateOf(r).key !== filter) return false;
    if (!inDateRange(r.o.ordered_at, fFrom, fTo)) return false;
    // Amount range compares the ORDER TOTAL in dollars; an order with no total yet only
    // shows while no amount bound is set (it has no amount to compare).
    if (fMin !== "" || fMax !== "") {
      const tot = r.o.total_cents == null ? null : r.o.total_cents / 100;
      if (tot == null) return false;
      if (fMin !== "" && tot < Number(fMin)) return false;
      if (fMax !== "" && tot > Number(fMax)) return false;
    }
    const extra = [nameOf(r), bldgOf(r), "#" + r.o.order_no, r.o.short_code,
      (r.d && r.d.ghl_estimate_number) ? "EST-" + r.d.ghl_estimate_number : "", (r.d && r.d.ss_quote_number) || "", stateOf(r).label, fmtDate(r.o.ordered_at)].join(" ");
    return rowMatchesQuery(r.o, query, extra);
  });
  const openRow = openId ? all.find((r) => r.o.id === openId) : null;

  // Paging over the filtered list; the tiles and counts above still read the whole tenant.
  const [pageSize, setPageSize] = usePageSize("orders");
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [query, filter, fFrom, fTo, fMin, fMax]);
  const pageCount = Math.max(1, Math.ceil(shown.length / pageSize));
  const curPage = Math.min(page, pageCount);
  const pagedShown = shown.slice((curPage - 1) * pageSize, curPage * pageSize);

  // Summary tiles — only orders with a known total can contribute to money figures.
  const withTotal = all.filter((r) => r.o.total_cents != null);
  const openBalance = withTotal.reduce((s, r) => s + Math.max(0, balOf(r)), 0);
  // ⚠️ `openBalance` CLAMPS AT ZERO — deliberately, since a credit on one order does not pay
  // for another. But that clamp also means money owed BACK to customers appears in no figure
  // on this page at all, and an amendment can now create it on purpose. Counted separately,
  // and shown only when there is some: a permanent "$0.00 refunds owed" tile is noise.
  const refundsOwed = withTotal.reduce((s, r) => s + Math.max(0, -(balOf(r) || 0)), 0);
  const refundCount = withTotal.filter((r) => (balOf(r) || 0) < 0).length;
  const collected = all.reduce((s, r) => s + r.paid, 0);
  // Voided rows are fetched (they stay visible in the history) but must not be counted.
  const payCount = all.reduce((s, r) => s + r.pays.filter((p) => !p.voided_at).length, 0);
  const needsInvoice = all.filter((r) => stateOf(r).key === "needsinvoice").length;
  const invoiceReq = all.filter((r) => stateOf(r).key === "invoicereq").length;
  const invoiceOut = all.filter((r) => stateOf(r).key === "invoiceout").length;
  const awaitingCount = all.filter((r) => stateOf(r).key === "awaiting").length;
  const needsTotal = all.filter((r) => r.o.total_cents == null).length;

  if (error) return <div style={S.err}>Couldn't load orders: {error}</div>;
  if (rows === null) {
    // Tiles then table, in the shape they will occupy — the page stops jumping when the
    // data lands, which is half of what makes a load feel fast.
    return (
      <div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(168px, 1fr))", gap: 11, marginBottom: 16 }}>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} style={{ ...S.card, marginBottom: 0, padding: "13px 15px" }}>
              <SkelBar w="58%" h={9} />
              <SkelBar w="72%" h={21} style={{ marginTop: 9 }} />
              <SkelBar w="46%" h={8} style={{ marginTop: 8 }} />
            </div>
          ))}
        </div>
        <div style={S.card}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>
                {["Order", "Customer", "Building", "Ordered", "Total", "Paid", "Status", "Schedule"].map((h) => <th key={h} style={S.th}>{h}</th>)}
              </tr></thead>
              <tbody><SkelRows cols={8} rows={6} /></tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }

  // moneyReady travels WITH the row: `row.paid` is 0 and `balOf(row)` is the full total until
  // the payments read lands, and the detail screen states both as fact — "$0.00 of $84,000
  // collected", "Nothing recorded yet", and a Record-a-payment button prefilled with a
  // balance that is about to change. The list has always known better (its chip reads "…");
  // this is the same honesty one component further in.
  if (openRow) return <OrderDetail row={openRow} clientId={clientId} onBack={() => setOpenId(null)} onChanged={load} stateOf={stateOf} nameOf={nameOf} bldgOf={bldgOf} balOf={balOf} onOpenDesign={onOpenDesign} coOn={coOn} coApproveOn={coApproveOn} ordersOn={ordersOn} moneyReady={moneyReady} />;

  const tile = (label, value, note, accent) => (
    <div style={{ ...S.card, marginBottom: 0, padding: "13px 15px", borderLeft: accent ? `3px solid ${accent}` : S.card.border }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, color: "#64748B", textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 23, fontWeight: 800, marginTop: 5, fontVariantNumeric: "tabular-nums", letterSpacing: -0.5 }}>{value}</div>
      <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 3 }}>{note}</div>
    </div>
  );
  const chip = (id, label) => (
    <button key={id} type="button" onClick={() => setFilter(id)}
      style={{ background: filter === id ? ACCENT : "#F1F5F9", border: `1px solid ${filter === id ? ACCENT : "#E2E8F0"}`, color: filter === id ? "#FFF" : "#475569", fontSize: 12, fontWeight: 700, borderRadius: 20, padding: "6px 13px", cursor: "pointer", fontFamily: "inherit" }}>{label}</button>
  );

  return (
    <div>
      {schedMsg && schedMsg.ok && <div style={S.okMsg}>{schedMsg.ok}</div>}
      {schedMsg && schedMsg.err && <div style={S.err}>{schedMsg.err}</div>}
      {/* Money tiles stay grey until the payments read lands. A $0.00 "Collected" that
          becomes $84,000 a second later is worse than a placeholder — the first number is
          the one someone reads out loud. "Needs a total" is safe either way: it counts
          orders with no total_cents, which the first read already knows. */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(168px, 1fr))", gap: 11, marginBottom: 16 }}>
        {moneyReady ? (
          <>
            {tile("Open balance", money(openBalance), `across ${withTotal.filter((r) => balOf(r) > 0).length} open orders`, "#F59E0B")}
            {refundsOwed > 0 && tile("Refunds owed", money(refundsOwed), `${refundCount} order${refundCount === 1 ? "" : "s"} paid above the total`, "#9A3412")}
            {tile("Collected", money(collected), `${payCount} payment${payCount === 1 ? "" : "s"} recorded`, "#16A34A")}
            {/* Only while one is waiting, like "Awaiting signature": a permanent "0 to approve"
                tile is noise on every tenant that has never had a customer accept online. */}
            {invoiceReq > 0 && tile("Invoice to approve", String(invoiceReq), "customer accepted — approve to issue", "#6D28D9")}
            {tile("Needs invoice", String(needsInvoice), needsInvoice ? "accepted, not billed yet" : "all billed", "#92400E")}
            {invoiceOut > 0 && tile("Awaiting signature", String(invoiceOut), "invoice sent, not signed", "#CA8A04")}
            {tile("Awaiting payment", String(awaitingCount), "signed, nothing collected", "#9F1239")}
          </>
        ) : (
          ["Open balance", "Collected", "Needs invoice", "Awaiting payment"].map((label) => (
            <div key={label} style={{ ...S.card, marginBottom: 0, padding: "13px 15px" }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: "#64748B", textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
              <SkelBar w="70%" h={21} style={{ marginTop: 9 }} />
              <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 5 }}>counting payments…</div>
            </div>
          ))
        )}
        {needsTotal > 0 && tile("Needs a total", String(needsTotal), "set it on the order", null)}
      </div>

      <div style={S.card}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap", marginBottom: 12 }}>
          <div style={{ ...S.h2, marginBottom: 0, marginRight: 4 }}>Orders {rows ? (query || filter !== "all" || hasFacets ? `(${shown.length} of ${all.length})` : `(${all.length})`) : ""}</div>
          {/* Every chip below "All" filters on a payment-derived state, so they only appear
              once the payments are counted — a chip that reliably returns nothing for two
              seconds teaches people it is broken. */}
          {chip("all", "All")}
          {moneyReady && (<>
            {/* Kept while it is the active filter even at zero: "Not now" on the last one
                would otherwise hide the chip that explains why the table just emptied. */}
            {(invoiceReq > 0 || filter === "invoicereq") && chip("invoicereq", "Invoice to approve")}
            {chip("needsinvoice", "Needs invoice")}
            {invoiceOut > 0 && chip("invoiceout", "Awaiting signature")}
            {chip("awaiting", "Awaiting payment")}{chip("partial", "Partially paid")}{chip("paid", "Paid in full")}
            {needsTotal > 0 && chip("nototal", "Needs total")}
            {all.some((r) => stateOf(r).key === "over") && chip("over", "Refund owed")}
          </>)}
          <div style={{ marginLeft: "auto", minWidth: 240, flex: "0 1 300px" }}>
            <SearchInput value={query} onChange={setQuery} placeholder="Search orders — name, building, order #…" />
          </div>
          <button onClick={syncFromGhl} disabled={syncing} style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0", padding: "6px 12px", opacity: syncing ? 0.6 : 1 }}>{syncing ? "Syncing…" : "↻ Refresh"}</button>
        </div>
        {all.length > 0 && (
          <FilterBar hasFilters={hasFacets} onClear={clearFacets} shown={shown.length} total={all.length} noun="order">
            <DateRange label="Ordered" from={fFrom} to={fTo} onFrom={setFFrom} onTo={setFTo} />
            <div style={FCTRL}><span style={FLBL}>Amount ($)</span>
              <div style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                <input type="number" min="0" step="any" value={fMin} onChange={(e) => setFMin(e.target.value)} placeholder="Min" style={{ ...S.input, padding: "6px 8px", width: 90 }} />
                <span style={{ color: "#94A3B8", fontSize: 12 }}>–</span>
                <input type="number" min="0" step="any" value={fMax} onChange={(e) => setFMax(e.target.value)} placeholder="Max" style={{ ...S.input, padding: "6px 8px", width: 90 }} />
              </div>
            </div>
          </FilterBar>
        )}

        {all.length === 0 && (
          <p style={{ fontSize: 13, color: "#64748B", padding: 12 }}>
            No orders yet. An order appears here automatically as soon as a customer signs a
            StructureStudio estimate. (Estimates and invoices issued through your CRM live in your
            CRM — this page only tracks the paperwork StructureStudio issues.)
          </p>
        )}
        {all.length > 0 && shown.length === 0 && (
          <p style={{ fontSize: 13, color: "#64748B", padding: 12 }}>
            No orders match this filter{hasFacets ? <>. Adjust or <button onClick={clearFacets} style={{ background: "none", border: "none", color: ACCENT, cursor: "pointer", fontWeight: 700, fontSize: 13, padding: 0, fontFamily: "inherit", textDecoration: "underline" }}>clear the filters</button></> : null}.
          </p>
        )}
        {shown.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>
                <th style={S.th}>Order</th><th style={S.th}>Customer</th><th style={S.th}>Building</th><th style={S.th}>Ordered</th>
                <th style={{ ...S.th, textAlign: "right" }}>Total</th><th style={{ ...S.th, textAlign: "right" }}>Paid</th>
                <th style={{ ...S.th, textAlign: "right" }}>Balance</th><th style={S.th}>Status</th>
                {(schedOn || deliverOn) && <th style={S.th}>Schedule</th>}
                <th style={S.th}></th>
              </tr></thead>
              <tbody>
                {pagedShown.map((r) => {
                  const st = stateOf(r); const bal = balOf(r);
                  const numCell = { ...S.td, textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };
                  return (
                    <tr key={r.o.id} onClick={() => setOpenId(r.o.id)} style={{ cursor: "pointer" }}>
                      <td style={{ ...S.td, fontWeight: 700, whiteSpace: "nowrap" }}>#{r.o.order_no}</td>
                      <td style={{ ...S.td, fontWeight: 700 }}>{nameOf(r)}
                        <div style={{ fontSize: 11, color: "#94A3B8", fontWeight: 500 }}>{(r.d && r.d.contact && r.d.contact.phone) || ""}</div></td>
                      <td style={S.td}>{bldgOf(r)}</td>
                      <td style={{ ...S.td, whiteSpace: "nowrap" }}>{fmtDate(r.o.ordered_at)}</td>
                      <td style={numCell}>{r.o.total_cents == null ? <span style={{ color: ACCENT, fontWeight: 700 }}>Set total</span> : money(r.o.total_cents)}</td>
                      {/* Paid and Balance are unknown until the payments read lands. A dash
                          would read as "nothing paid", which is a claim, so these stay grey
                          bars — the one cell shape that says "not yet" rather than "zero". */}
                      <td style={numCell}>{!moneyReady ? <SkelBar w={54} style={{ display: "inline-block" }} /> : r.paid ? money(r.paid) : <span style={{ color: "#94A3B8" }}>—</span>}</td>
                      <td style={{ ...numCell, fontWeight: bal ? 800 : 600, color: bal === 0 ? "#94A3B8" : bal < 0 ? "#9A3412" : "#1E293B" }}>
                        {!moneyReady ? <SkelBar w={54} style={{ display: "inline-block" }} /> : bal == null ? "—" : bal < 0 ? `${money(-bal)} back` : money(bal)}
                      </td>
                      <td style={S.td}>
                        <span style={{ background: st.bg, color: st.fg, borderRadius: 20, padding: "4px 11px", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" }}>{st.label}</span>
                        {r.coPending && (
                          <span title="A change order is awaiting the customer's acknowledgment — invoicing is blocked until they sign or a verbal confirmation is recorded"
                            style={{ background: "#FEF3C7", color: "#B45309", borderRadius: 20, padding: "4px 11px", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap", marginLeft: 6 }}>CO pending</span>
                        )}
                        {/* A change somebody OPENED and has not finished. Nobody has been
                            asked for anything, so it does not block invoicing — but it is
                            holding the order open and it is invisible everywhere else. */}
                        {r.coDraft && (
                          <span title="A change was opened on this order and hasn't been finished — open the order to pick it up or discard it"
                            style={{ background: "#FFEDD5", color: "#9A3412", borderRadius: 20, padding: "4px 11px", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap", marginLeft: 6 }}>
                            Change open{r.coNo ? ` · CO-${r.coNo}` : ""}
                          </span>
                        )}
                        {/* Waiting on a PERSON. The "asked" half is the only place an
                            approver can see there is a decision sitting on their desk. */}
                        {r.unlockState === "asked" && (
                          <span title="Someone has asked for this signed order to be unlocked so it can be changed"
                            style={{ background: "#FEE2E2", color: "#991B1B", borderRadius: 20, padding: "4px 11px", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap", marginLeft: 6 }}>Unlock asked</span>
                        )}
                        {r.unlockState === "granted" && (
                          <span title="This order has been unlocked and the change hasn't been started yet — the unlock expires on its own"
                            style={{ background: "#DCFCE7", color: "#166534", borderRadius: 20, padding: "4px 11px", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap", marginLeft: 6 }}>Unlocked</span>
                        )}
                      </td>
                      {(schedOn || deliverOn) && (
                        // stopPropagation throughout: the row itself opens the order detail.
                        <td style={{ ...S.td, whiteSpace: "nowrap" }} onClick={(e) => e.stopPropagation()}>{schedCell(r)}</td>
                      )}
                      <td style={{ ...S.td, whiteSpace: "nowrap" }}><span style={{ color: ACCENT, fontWeight: 700, fontSize: 12 }}>Open →</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <PageBar size={pageSize} onSize={setPageSize} page={curPage} onPage={setPage} total={shown.length} noun="order" />
          </div>
        )}
      </div>
    </div>
  );
}

// One order: the money detail + payment history + record-a-payment.
/* Change orders (migration 126) — SS-mode orders only (the design carries an SS quote).
   A change to an agreed order needs the customer's acknowledgment: e-signature from their
   quote page, OR the rep's verbal attestation (checkbox + name + conversation date) —
   either/or, Carolyn 2026-08-23. While one is pending, send_invoice 409s server-side.
   Reads/writes are direct RLS (the orders precedent); the guard trigger owns the rules a
   browser must not bypass (co_no assignment, signature acks, frozen-when-acknowledged). */
function ChangeOrdersCard({ clientId, shortCode, orderId, currentTotalCents, reloadKey, onChanged }) {
  const [cos, setCos] = useState(null);        // null = loading
  const [msg, setMsg] = useState(null);        // { ok } | { err }
  const [busy, setBusy] = useState(false);
  // New-CO form
  const [formOpen, setFormOpen] = useState(false);
  const [desc, setDesc] = useState("");
  const [newTotal, setNewTotal] = useState("");
  const [ackPath, setAckPath] = useState("sign");   // 'sign' | 'verbal'
  const [repName, setRepName] = useState("");
  const [convDate, setConvDate] = useState(todayLocal());
  const [note, setNote] = useState("");
  // Per-CO verbal-attestation form
  const [verbalFor, setVerbalFor] = useState(null); // co.id | null
  const [vRep, setVRep] = useState("");
  const [vDate, setVDate] = useState(todayLocal());
  const [vNote, setVNote] = useState("");
  const [vConfirm, setVConfirm] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await sb.from("change_orders")
      .select("*").eq("client_id", clientId).eq("short_code", shortCode)
      .order("co_no", { ascending: false });
    if (error) { setMsg({ err: error.message }); setCos([]); return; }
    setCos(data || []);
  }, [clientId, shortCode]);
  // reloadKey, not just [clientId, shortCode]: staging a change on the document above
  // UPDATES the pending CO in place, so a card still holding its mount-time list reads
  // "None." under a banner announcing that CO — and hands its superseded total to
  // applyAckedTotal, billing the customer a figure the frozen CO no longer states.
  useEffect(() => { load(); }, [load, reloadKey]);

  // Returns false ONLY when the order-total write failed — a CO with no new total is
  // nothing to write, so it returns true — and every caller must respect that false:
  // React batches both setMsg calls across the await, so an unconditional "confirmed
  // verbally" banner painted straight over this error and the operator walked away from
  // an acknowledged, frozen CO with the order still at its old total and nothing saying so.
  const applyAckedTotal = async (co) => {
    // THE SERVER WORKS OUT THE MONEY (portal-settings apply_change_order_money), with the one
    // arithmetic customer-accept and attest_change_order use. This used to write
    // `total_cents = co.total_after_cents` alone, which left pretax_subtotal_cents and
    // tax_cents at the accepted figures and dropped every change-order fee — so the invoice
    // (reconciled against the pre-tax column) billed the OLD amount with a "Change order /
    // Order adjustment" pair that cancelled out, while the balance and the pay screen asked
    // for the new one. Called even for a change with no new total: a fee is still owed.
    const { data, error } = await sb.functions.invoke("portal-settings", {
      body: { action: "apply_change_order_money", shortCode },
    });
    let m = (data && data.error) || null;
    if (error && !m) m = await fnError(error);
    if (!m) return true;
    // A portal-settings that predates the action answers "Unrecognised action" — keep the old
    // single-column write for that window rather than leave the order on its pre-change total.
    if (/Unrecognised action/i.test(String(m))) {
      if (co.total_after_cents == null) return true;
      const { error: legacyErr } = await sb.from("orders")
        .update({ total_cents: co.total_after_cents, total_source: "manual", updated_at: new Date().toISOString() })
        .eq("client_id", clientId).eq("short_code", shortCode);
      if (!legacyErr) return true;
      m = legacyErr.message;
    }
    setMsg({ err: `Change recorded, but the order total didn't update: ${m}` });
    return false;
  };

  const createCo = async () => {
    const d = desc.trim();
    if (!d) { setMsg({ err: "Describe the change — this text is what the customer signs off on." }); return; }
    let totalCents = null;
    if (newTotal.trim()) {
      totalCents = centsFrom(newTotal);
      if (!Number.isFinite(totalCents) || totalCents < 0) { setMsg({ err: "Enter the new total as a dollar amount, e.g. 9575.00" }); return; }
    }
    const verbal = ackPath === "verbal";
    if (verbal && (!repName.trim() || !convDate)) { setMsg({ err: "Verbal confirmation needs your name and the date of the conversation." }); return; }
    setBusy(true); setMsg(null);
    const rowBase = {
      client_id: clientId, short_code: shortCode, order_id: orderId || null,
      source: "manual", description: d,
      total_before_cents: currentTotalCents == null ? null : currentTotalCents,
      total_after_cents: totalCents,
    };
    const { data: created, error } = await sb.from("change_orders")
      .insert(verbal
        ? { ...rowBase, status: "acknowledged", ack_method: "verbal", verbal_rep_name: repName.trim(), verbal_conversation_date: convDate, verbal_note: note.trim() || null }
        : rowBase)
      .select("id, co_no, total_after_cents, status").maybeSingle();
    setBusy(false);
    if (error) { setMsg({ err: error.message }); return; }
    setFormOpen(false); setDesc(""); setNewTotal(""); setRepName(""); setNote("");
    if (verbal) {
      if (await applyAckedTotal(created)) setMsg({ ok: `CO-${created.co_no} recorded with your verbal confirmation.` });
    } else {
      // Email it for signature right away — a pending CO nobody was told about blocks the
      // invoice forever. sent:false just means print/hand it over; the CO still exists.
      const { data: sent } = await sb.functions.invoke("portal-settings", { body: { action: "send_change_order", changeOrderId: created.id } });
      setMsg(sent && sent.sent
        ? { ok: `CO-${created.co_no} created and emailed to the customer for signature.` }
        : { ok: `CO-${created.co_no} created. Email not sent${sent && sent.reason ? ` (${sent.reason})` : ""} — the customer can sign it from their estimate page link.` });
    }
    load(); onChanged();
  };

  const recordVerbal = async (co) => {
    if (!vConfirm) { setMsg({ err: "Tick the confirmation box — it is your attestation." }); return; }
    if (!vRep.trim() || !vDate) { setMsg({ err: "Verbal confirmation needs your name and the date of the conversation." }); return; }
    setBusy(true); setMsg(null);
    // The update is conditional on BOTH the status and the amount this card is showing,
    // and .select() makes it prove itself: without a returned row, zero rows matched comes
    // back error:null and we'd report "confirmed verbally" AND overwrite the order total
    // from a CO that is not the one the rep read out.
    //   status — it was signed or voided elsewhere while this form sat open.
    //   amount — staging a design edit rewrites a pending CO's total IN PLACE, and `co` is
    //     this card's cached copy. Neither figure is usable then: the cached one bills a
    //     total the frozen CO doesn't state, and the database's one stamps the
    //     attestation — the rep's name, their conversation date — onto a number they never
    //     said to the customer. So refuse, reload, and make them re-read it first.
    // total_after_cents is nullable (a description-only CO) and PostgREST .eq cannot match
    // NULL, so .is() is the null arm of the same condition.
    let q = sb.from("change_orders")
      .update({ status: "acknowledged", ack_method: "verbal", verbal_rep_name: vRep.trim(), verbal_conversation_date: vDate, verbal_note: vNote.trim() || null })
      .eq("id", co.id).eq("status", "pending_ack");
    q = co.total_after_cents == null ? q.is("total_after_cents", null) : q.eq("total_after_cents", co.total_after_cents);
    const { data: upd, error } = await q.select("id, total_after_cents");
    setBusy(false);
    if (error) { setMsg({ err: error.message }); return; }
    setVerbalFor(null); setVRep(""); setVNote(""); setVConfirm(false);
    if (!upd || upd.length === 0) {
      // Nothing matched — reload so the list shows the CO as it really stands, and leave
      // the order total alone (it may already reflect a signed or voided CO).
      setMsg({ err: `CO-${co.co_no} is not the change you were reading — it was signed, voided, or its amount was restaged while this form was open. Nothing was recorded: check the amount below and go through it with the customer again before confirming.` });
      load(); onChanged();
      return;
    }
    if (await applyAckedTotal(upd[0])) setMsg({ ok: `CO-${co.co_no} confirmed verbally.` });
    load(); onChanged();
  };

  const emailCo = async (co) => {
    setBusy(true); setMsg(null);
    const { data, error } = await sb.functions.invoke("portal-settings", { body: { action: "send_change_order", changeOrderId: co.id } });
    setBusy(false);
    if (error || (data && data.error)) { setMsg({ err: (data && data.error) || error.message }); return; }
    setMsg(data && data.sent
      ? { ok: `CO-${co.co_no} emailed to the customer for signature.` }
      : { err: `Email not sent${data && data.reason ? ` (${data.reason})` : ""} — the customer can still sign from their estimate page.` });
  };

  // ⚠️ THROUGH void_change_order, NOT a direct update. Voiding is not one column: when the CO
  // carries `snapshot_before` — every CO staged from the order document, and every one the
  // document adopted — the server RESTORES the design the customer signed, writes the
  // reverting design_version and regenerates the quote PDF (portal-settings). A direct
  // `status = 'void'` writes the change order's own row and nothing else, so the design keeps
  // the revision nobody ever signed while the record says the change was discarded, and the
  // next quote or invoice PDF prints from it. The Discard button on the document above has
  // always called this action; the card's Void is the same act and had to be the same call.
  //
  // Pending-only is the server's rule (it 400s an acknowledged or already-void CO) and the
  // card only offers Void on pending_ack, so behaviour is unchanged — but the body is
  // surfaced rather than swallowed, because that 400 is also what a second tab racing this
  // one produces. The area gate is the same one that renders the card (change_orders/edit).
  const voidCo = async (co) => {
    const reason = window.prompt(`Void CO-${co.co_no}? Give a reason (kept in the record):`);
    if (reason == null) return;
    if (!reason.trim()) { setMsg({ err: "Voiding needs a reason." }); return; }
    setBusy(true); setMsg(null);
    const { data, error } = await sb.functions.invoke("portal-settings", {
      body: { action: "void_change_order", changeOrderId: co.id, reason: reason.trim() },
    });
    setBusy(false);
    if (error || (data && data.error)) {
      setMsg({ err: (data && data.error) || await fnError(error) });
      // Reload either way: a refusal usually means this card is holding a stale copy of the
      // change order (signed or voided in another tab), and the list should say so.
      load();
      return;
    }
    setMsg({ ok: `CO-${co.co_no} voided${data && data.reverted ? " — the design is back to what the customer signed" : ""}.` });
    load(); onChanged();
  };

  const chip = (co) => {
    const s = co.status === "pending_ack"
      ? { bg: "#FEF3C7", fg: "#B45309", label: "Awaiting customer" }
      : co.status === "acknowledged"
        ? { bg: "#F0FDF4", fg: "#15803D", label: "Acknowledged" }
        : { bg: "#F1F5F9", fg: "#64748B", label: "Void" };
    return <span style={{ background: s.bg, color: s.fg, borderRadius: 20, padding: "3px 10px", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" }}>{s.label}</span>;
  };

  return (
    <div style={S.card}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <div style={{ ...S.h2, marginBottom: 0 }}>Change orders</div>
        <button type="button" onClick={() => setFormOpen((o) => !o)}
          style={{ ...S.btn("#FFF", ACCENT), border: `1px solid ${ACCENT}`, marginLeft: "auto", padding: "5px 12px", fontSize: 12 }}>
          {formOpen ? "Cancel" : "+ New change order"}
        </button>
      </div>
      {msg && msg.err && <div style={S.err}>{msg.err}</div>}
      {msg && msg.ok && <div style={S.okMsg}>{msg.ok}</div>}

      {formOpen && (
        <div style={{ background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 10, padding: 12, marginBottom: 12 }}>
          <span style={S.lbl}>What changed?</span>
          <textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={3}
            placeholder={'e.g. "Moved delivery to the week of Sept 14" or "Added a 4\' side door, $250"'}
            style={{ ...S.input, resize: "vertical", fontFamily: "inherit" }} />
          <div style={{ marginTop: 10, maxWidth: 220 }}>
            <span style={S.lbl}>New order total (optional)</span>
            <input style={S.input} value={newTotal} onChange={(e) => setNewTotal(e.target.value)} placeholder="e.g. 9575.00" inputMode="decimal" />
          </div>
          <div style={{ display: "flex", gap: 16, marginTop: 12, fontSize: 13, fontWeight: 600, color: "#334155", flexWrap: "wrap" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
              <input type="radio" name="ss-co-ack" checked={ackPath === "sign"} onChange={() => setAckPath("sign")} />
              Send to the customer to e-sign
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
              <input type="radio" name="ss-co-ack" checked={ackPath === "verbal"} onChange={() => setAckPath("verbal")} />
              Customer already confirmed verbally
            </label>
          </div>
          {ackPath === "verbal" && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10, marginTop: 10, maxWidth: 520 }}>
              <div><span style={S.lbl}>Your name</span>
                <input style={S.input} value={repName} onChange={(e) => setRepName(e.target.value)} placeholder="Who spoke with them" /></div>
              <div><span style={S.lbl}>Date of conversation</span>
                <input type="date" style={S.input} value={convDate} onChange={(e) => setConvDate(e.target.value)} /></div>
              <div style={{ gridColumn: "1 / -1" }}><span style={S.lbl}>Note (optional)</span>
                <input style={S.input} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. phone call, spoke with Dave" /></div>
            </div>
          )}
          <button type="button" onClick={createCo} disabled={busy}
            style={{ ...S.btn(ACCENT, "#FFF"), marginTop: 12, padding: "8px 16px", fontSize: 13, opacity: busy ? 0.6 : 1 }}>
            {busy ? "Saving…" : (ackPath === "verbal" ? "Record change with verbal confirmation" : "Create & send for signature")}
          </button>
        </div>
      )}

      {cos === null && <p style={{ fontSize: 13, color: "#64748B", padding: "6px 0" }}>Loading…</p>}
      {cos && cos.length === 0 && !formOpen && (
        <p style={{ fontSize: 13, color: "#64748B", padding: "6px 0" }}>
          None. If this order changes after the customer accepted, record it here — they
          acknowledge it with a signature, or you record their verbal OK.
        </p>
      )}
      {cos && cos.map((co) => (
        <div key={co.id} style={{ borderTop: "1px solid #F1F5F9", padding: "10px 0", opacity: co.status === "void" ? 0.6 : 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <b style={{ fontSize: 13 }}>CO-{co.co_no}</b>
            <span style={{ fontSize: 11, color: "#94A3B8", fontWeight: 600 }}>{co.source === "design_edit" ? "From design revision" : "Manual"} · {fmtDate(co.created_at)}</span>
            {chip(co)}
            {(co.total_before_cents != null || co.total_after_cents != null) && (
              <span style={{ fontSize: 12.5, fontWeight: 700, marginLeft: "auto" }}>
                {co.total_before_cents != null ? money(co.total_before_cents) : "—"} → {co.total_after_cents != null ? money(co.total_after_cents) : "—"}
              </span>
            )}
          </div>
          <div style={{ fontSize: 12.5, color: "#334155", whiteSpace: "pre-wrap", marginTop: 6 }}>{co.description}</div>
          {co.status === "acknowledged" && (
            <div style={{ fontSize: 12, color: "#15803D", fontWeight: 600, marginTop: 6 }}>
              {co.ack_method === "verbal"
                /* verbal_conversation_date is DATE-ONLY: parsed bare it reads as UTC
                   midnight and renders the previous local day. Midday anchor, the same
                   trick recordPayment and the schedule use. */
                ? `Verbal — ${co.verbal_rep_name}, conversation on ${fmtDate(co.verbal_conversation_date + "T12:00:00")}${co.verbal_note ? ` (${co.verbal_note})` : ""}`
                : `Signed by the customer${co.acknowledged_at ? ` · ${fmtDate(co.acknowledged_at)}` : ""}`}
            </div>
          )}
          {co.status === "void" && co.void_reason && (
            <div style={{ fontSize: 12, color: "#64748B", marginTop: 6 }}>Voided — {co.void_reason}</div>
          )}
          {co.status === "pending_ack" && (
            <div style={{ marginTop: 8 }}>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                <button type="button" onClick={() => emailCo(co)} disabled={busy}
                  style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: ACCENT, fontWeight: 700, fontSize: 12.5 }}>Email to customer</button>
                <button type="button" onClick={() => { setVerbalFor(verbalFor === co.id ? null : co.id); setVConfirm(false); }}
                  style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: ACCENT, fontWeight: 700, fontSize: 12.5 }}>Record verbal confirmation</button>
                <button type="button" onClick={() => voidCo(co)} disabled={busy}
                  style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "#94A3B8", fontWeight: 700, fontSize: 12.5, opacity: busy ? 0.6 : 1 }}>Void</button>
              </div>
              {verbalFor === co.id && (
                <div style={{ background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 10, padding: 12, marginTop: 8 }}>
                  <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12.5, fontWeight: 600, color: "#334155" }}>
                    <input type="checkbox" checked={vConfirm} onChange={(e) => setVConfirm(e.target.checked)} style={{ marginTop: 2 }} />
                    The customer confirmed this change in a conversation with me.
                  </label>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10, marginTop: 10, maxWidth: 520 }}>
                    <div><span style={S.lbl}>Your name</span>
                      <input style={S.input} value={vRep} onChange={(e) => setVRep(e.target.value)} /></div>
                    <div><span style={S.lbl}>Date of conversation</span>
                      <input type="date" style={S.input} value={vDate} onChange={(e) => setVDate(e.target.value)} /></div>
                    <div style={{ gridColumn: "1 / -1" }}><span style={S.lbl}>Note (optional)</span>
                      <input style={S.input} value={vNote} onChange={(e) => setVNote(e.target.value)} placeholder="e.g. phone call, spoke with Dave" /></div>
                  </div>
                  <button type="button" onClick={() => recordVerbal(co)} disabled={busy}
                    style={{ ...S.btn(ACCENT, "#FFF"), marginTop: 10, padding: "7px 14px", fontSize: 12.5, opacity: busy ? 0.6 : 1 }}>
                    {busy ? "Saving…" : "Confirm"}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/* ─── The invoice-style order document (migration 127) ─────────────────────────────────
   SS-mode orders render the ORDER itself "between an invoice and a PDF" (Carolyn
   2026-08-24): letterhead, the priced line items from designs.estimate_lines — the same
   snapshot every PDF renders from, so screen and paper can't disagree — with roof,
   cladding and paint as LIVE dropdowns. Changing one stages a change (dryRun price
   preview from the server's catalog math), raises the change order the customer must
   acknowledge, and can be discarded (void_change_order restores the as-signed design
   from snapshot_before). Totals show the current numbers plus the amendment trail. */

// De-render the snapshot's GHL-flavored HTML for display — MUST match
// _shared/estimateLines.ts `deHtml` (the server is the authority; this is presentation).
const ssDeHtml = (s) => String(s || "")
  .replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, "")
  .replace(/<br\s*\/?>/gi, "\n")
  .replace(/<[^>]*>/g, "")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
  .trim();
const ssRound2 = (n) => Math.round(n * 100) / 100;
// One pool of the line items — MUST match _shared/estimateLines.ts `poolOf`.
const ssPoolOf = (lines, wantTaxable) => {
  let sum = 0;
  for (const li of lines) {
    if (!!(li && li.nonTaxable) === wantTaxable) continue; // nonTaxable true => not the taxable pool
    sum += ssRound2((Number(li && li.qty) || 0) * (Number(li && li.amount) || 0));
  }
  return ssRound2(sum);
};
// Totals over the snapshot — MUST match _shared/estimateLines.ts `totalFromSnapshot`.
//
// TAX IS PART OF THE TOTAL, and this used to implement the pre-tax branch ONLY. Since 158b
// put `tax_cents` inside orders.total_cents, that omission made every figure here short by
// exactly the tax on a taxed order, with two consequences that both read as something else:
// `designPricedCents` came out below a tax-inclusive `o.total_cents`, so baselineDriftCents
// was non-zero on EVERY taxed accepted order and the drift banner blamed a discarded
// revision for arithmetic; and the totals block printed a pre-tax total beside a PDF the
// customer had signed at the taxed one. Only bit tenants with invoice_in_ghl = false and a
// non-zero ss_tax_rate, which is why it survived — that was one tenant on 2026-09-02.
//
// The two shapes match _shared/estimatePdf.ts, so screen and paper cannot disagree:
//   untaxed -> `subtotal` is GROSS and the caller renders Subtotal / Discount / Total.
//   taxed   -> `subtotal` is NET of discounts (the PDF's own "Subtotal" row on a taxed
//              document) and the caller renders Subtotal / <tax label> / Total. `discount`
//              is still reported for reference but MUST NOT be subtracted again — it is
//              already inside `subtotal`, exactly as the paper has it.
const ssSnapTotals = (snap) => {
  const lines = (snap && Array.isArray(snap.lines)) ? snap.lines : [];
  const rawTax = (snap && snap.tax && snap.tax.amount != null) ? Number(snap.tax.amount) : null;
  const tax = (rawTax != null && isFinite(rawTax)) ? Math.max(0, ssRound2(rawTax)) : null;

  if (tax == null) {
    let subtotal = 0;
    for (const li of lines) subtotal += ssRound2((Number(li.qty) || 0) * (Number(li.amount) || 0));
    subtotal = ssRound2(subtotal);
    const discount = Number(snap && snap.discount) || 0;
    // Clamped at >= 0 like estimatePdf.ts' Total row (audit 2026-08-20).
    const total = Math.max(0, discount > 0 ? ssRound2(subtotal - discount) : subtotal);
    return { subtotal, discount, tax: null, taxLabel: null, total };
  }

  // Discounts split by pool, as subtotalsFromSnapshot does: a non-taxable discount row must
  // not shrink the base the tax was charged on, or the customer cannot check the tax against
  // the figure printed above it.
  const taxable = ssPoolOf(lines, true);
  const nonTaxable = ssPoolOf(lines, false);
  let taxableDiscount, nonTaxableDiscount;
  const rows = snap.discounts && snap.discounts.rows;
  if (Array.isArray(rows)) {
    let t = 0, n = 0;
    for (const r of rows) {
      const amt = ssRound2(Math.abs(Number(r && r.amount) || 0));
      if (amt <= 0) continue;
      // Absent `taxable` reads as taxable — the designer's default for a new row, and the
      // reading that never quietly removes something from the tax base.
      if (r && r.taxable === false) n += amt; else t += amt;
    }
    taxableDiscount = ssRound2(t); nonTaxableDiscount = ssRound2(n);
  } else {
    taxableDiscount = ssRound2(Math.max(0, Number(snap.discount) || 0));
    nonTaxableDiscount = 0;
  }
  const taxableBase = Math.max(0, ssRound2(taxable - taxableDiscount));
  const nonTaxableNet = Math.max(0, ssRound2(nonTaxable - nonTaxableDiscount));
  const subtotal = ssRound2(taxableBase + nonTaxableNet);

  // "Sales tax (7.25% · Bibb County, GA)" — the rate and jurisdiction are a LABEL. The
  // amount beside them is the stored figure the customer signed for, never rate x base
  // recomputed here. Same construction as estimatePdf.ts.
  const rate = Number(snap.tax.rate);
  const pct = (isFinite(rate) && rate > 0) ? `${String(ssRound2(rate * 100)).replace(/\.0+$/, "")}%` : "";
  const juris = String((snap.tax.jurisdiction || "")).trim();
  const paren = [pct, juris].filter(Boolean).join(" · ");
  const base = String(snap.tax.label || "").trim() || "Sales tax";

  return {
    subtotal,
    discount: ssRound2(taxableDiscount + nonTaxableDiscount),
    tax,
    taxLabel: paren ? `${base} (${paren})` : base,
    total: Math.max(0, ssRound2(subtotal + tax)),
  };
};
const ssUsd = (n) => {
  if (n == null || !isFinite(Number(n))) return "—";
  const v = ssRound2(Number(n));
  const [int, frac] = Math.abs(v).toFixed(2).split(".");
  return `${v < 0 ? "-" : ""}$${int.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${frac}`;
};
// The tax a customer agreed to, from an acceptance row's frozen columns (migration 158):
// "incl. $912.38 sales tax · 7.25% · Bibb County, GA · verified". Null when the row carries no
// tax — every CRM-mode acceptance, and every one from before tax shipped — so "was not taxed"
// never renders as "$0.00 tax". `tax_source` has only two values: "avalara" is a rate verified
// for the delivery address; "fallback" is one of the builder's own rates (a location's or the
// company's — the row does not record which, so this does not guess).
function ssSignedTaxText(a) {
  if (!a || a.tax_amount == null || !isFinite(Number(a.tax_amount))) return null;
  const parts = [`incl. ${ssUsd(Number(a.tax_amount))} sales tax`];
  const rate = Number(a.tax_rate);
  if (a.tax_rate != null && isFinite(rate)) parts.push(`${Math.round(rate * 1000000) / 10000}%`);
  const where = String(a.tax_jurisdiction || "").trim();
  if (where) parts.push(where);
  if (a.tax_source === "avalara") parts.push("verified");
  else if (a.tax_source === "fallback") parts.push("your rate");
  return parts.join(" · ");
}
// The built-in cladding names — the FALLBACK, not the authority. Since 207 the offered set and
// the customer-facing name are per tenant, per style (style_cladding), and order_paperwork
// carries this design's own list; this is what an account with no rows yet falls back to.
//
// ⚠️ `batten` was MISSING from this list, and it was not cosmetic. stage_order_attribute_change
// validated against the matching server list and `next.cladding` defaults to the design's
// CURRENT value — so a design saved as Board & Batten made every attribute change on its order
// fail with "That cladding isn't offered", including a pure roof-colour edit. All five now: vinyl
// joined on 2026-10-06 (migration 285), the day lap's built-in name became 7" LP Lap Siding.
const SS_CLADDING_NAMES = { lap: "7\" LP Lap Siding", vinyl: "4.5\" Vinyl Siding", panel: "Panel Siding", batten: "Board & Batten", agpanel: "AG Panel" };
const SS_CLADDING_ORDER = ["panel", "lap", "vinyl", "batten", "agpanel"];
// `offered` is order_paperwork's list: [{ id, label }] with label = the tenant's override or
// null. An empty/absent list means "this tenant has not configured cladding", which reads as
// all five under our own names — the behaviour before 207.
const ssCladdingOpts = (offered, current) => {
  const rows = (Array.isArray(offered) && offered.length)
    ? offered.map((o) => [String(o.id), (o.label && String(o.label).trim()) || SS_CLADDING_NAMES[String(o.id)] || String(o.id)])
    : SS_CLADDING_ORDER.map((id) => [id, SS_CLADDING_NAMES[id]]);
  const out = [["", "Builder's standard"], ...rows];
  // A design carrying a cladding this style no longer offers keeps it listed, so opening the
  // document does not silently restage it as something else — the same reason colorOpts
  // unshifts the current value.
  const cur = String(current || "");
  if (cur && !out.some((c) => c[0] === cur)) out.push([cur, SS_CLADDING_NAMES[cur] || cur]);
  return out;
};
const ssCladdingLabel = (id, offered) => {
  const cur = String(id || "");
  const hit = (Array.isArray(offered) ? offered : []).find((o) => String(o.id) === cur);
  if (hit && hit.label && String(hit.label).trim()) return String(hit.label).trim();
  if (!cur) return "Builder's standard";
  return SS_CLADDING_NAMES[cur] || cur;
};


/* ─── Changing a signed order (migrations 209-216) ──────────────────────────────────────
   Carolyn 2026-09-06: "When we click the change order button, that should open the
   invoice/design/entire order and allow the sales rep to edit/add/remove/change anything in
   the order, without losing the payment that has already been applied."

   So this is not a form. It is the ONE control that decides what a rep can do to a signed
   order right now, and every branch of it is answered by the server: `amendment_status`
   returns the gate (is it open, under what authority, what does it cost), the live change if
   there is one, the outstanding unlock if there is one, and the tenant's policy. Nothing here
   decides eligibility on its own — the same gate function refuses at the database, so what
   this panel offers and what the server allows can never disagree.

   ⚠️ THE FEE IS DISCLOSED BEFORE THE REP STARTS, never afterwards on the invoice. That is
   what `preflight` is: a sheet they must dismiss, rendered from the server's own numbers. */
function AmendmentPanel({ clientId, shortCode, orderId, amend, coOn, coApproveOn, onOpenDesign, onMsg, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [preflight, setPreflight] = useState(false);   // the fee sheet
  const [askOpen, setAskOpen] = useState(false);       // the "why does this need changing?" box
  const [reason, setReason] = useState("");

  // A failed read leaves `amend` null. Offer nothing rather than guessing — the design's
  // own "Open design" button below is unaffected, so nobody is stranded.
  if (!amend || !amend.gate) return null;
  const gate = amend.gate;
  const live = amend.amendment || null;          // a draft or pending_ack change, if any
  const unlock = amend.unlock || null;           // an outstanding request or grant, if any
  const policy = amend.policy || null;

  // Nothing to re-open: the customer has not committed to anything yet, so editing the
  // design is just editing the design.
  if (gate.signed !== true) return null;

  const feeCents = Number(gate.fee_cents) || 0;
  const feeLabel = (policy && policy.feeLabel) || "Change order fee";
  const usd = (c) => ssUsd(c / 100);

  const call = async (action, body) => {
    setBusy(true); onMsg(null);
    const { data, error } = await sb.functions.invoke("portal-settings", { body: { action, shortCode, ...(body || {}) } });
    setBusy(false);
    if (error || (data && data.error)) { onMsg({ err: (data && data.error) || error.message }); return null; }
    return data;
  };

  // Open (or re-open) the change and hand the rep the designer. open_amendment is
  // idempotent — a second call returns the row that already exists — so "Continue the
  // change" and "Change this order" are the same call and a double click is harmless.
  const startChange = async () => {
    setPreflight(false);
    const data = await call("open_amendment");
    if (!data) return;
    const co = data.changeOrder || {};
    onChanged();
    onOpenDesign(shortCode, null, {
      amendment: {
        changeOrderId: co.id, coNo: co.co_no, orderId,
        feeCents: Number(co.fee_cents) || 0,
        feeTaxCents: Number(co.fee_tax_cents) || 0,
        feeLabel,
        raisedUnder: co.raised_under || null,
      },
    });
  };

  const bar = (bg, border, fg, children) => (
    <div style={{ background: bg, border: `1px solid ${border}`, color: fg, borderRadius: 9, padding: "10px 13px", marginTop: 12, fontSize: 12.5, lineHeight: 1.55 }}>
      {children}
    </div>
  );
  const btn = (label, onClick, primary) => (
    <button type="button" onClick={onClick} disabled={busy}
      style={{ ...S.btn(primary ? "#B45309" : "#FFF", primary ? "#FFF" : "#92400E"), border: `1px solid ${primary ? "#B45309" : "#FCD34D"}`, padding: "6px 12px", fontSize: 12.5, cursor: "pointer", opacity: busy ? 0.6 : 1 }}>
      {label}
    </button>
  );

  // ── A CHANGE IS ALREADY UNDERWAY ────────────────────────────────────────────────────
  // Ahead of every other branch, because it is what the gate itself now answers first
  // (migration 215): whatever authorised this change has already been checked and spent.
  if (live) {
    const isDraft = String(live.status) === "draft";
    return bar("#FFFBEB", "#FDE68A", "#92400E", (
      <>
        <div style={{ fontWeight: 700, marginBottom: 4 }}>
          {isDraft ? `Change CO-${live.co_no} is open and not finished` : `Change CO-${live.co_no} is with the customer`}
        </div>
        <div>
          {isDraft
            ? <>Nobody has been asked to approve anything yet. Pick it back up in the designer, or discard it and the order goes back exactly as it was signed.</>
            : <>The customer has been sent this change to sign. Their answer decides it — you can still discard it if it was raised by mistake.</>}
          {Number(live.fee_cents) > 0 && <> A {feeLabel.toLowerCase()} of {usd(Number(live.fee_cents) + (Number(live.fee_tax_cents) || 0))} goes on this change.</>}
        </div>
        {coOn && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 9 }}>
            {isDraft && btn(`Continue the change (CO-${live.co_no})`, startChange, true)}
            {btn("Discard this change", async () => {
              if (!window.confirm(`Discard CO-${live.co_no}? The order goes back to exactly what the customer signed.`)) return;
              const d = await call("void_change_order", { changeOrderId: live.id, reason: "Discarded from the order screen" });
              if (d) { onMsg({ ok: `CO-${live.co_no} discarded — the order is back to what the customer signed.` }); onChanged(); }
            })}
          </div>
        )}
      </>
    ));
  }

  // ── THE ORDER IS OPEN FOR CHANGE ────────────────────────────────────────────────────
  if (gate.open === true) {
    if (!coOn) {
      return bar("#F8FAFC", "#E2E8F0", "#64748B", (
        <>This order can be changed, but changing it raises a change order — and that is not part of your access. Ask an owner or admin to turn on <b>Change Orders</b> for you in Settings → Team.</>
      ));
    }
    const authority = String(gate.authority || "");
    return (
      <>
        {bar("#F0FDF4", "#BBF7D0", "#166534", (
          <>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>This order can be changed</div>
            <div>
              {authority === "unlock"
                ? <>Unlocked by {(unlock && unlock.decided_by_name) || "an approver"}{unlock && unlock.expires_at ? ` until ${fmtDate(unlock.expires_at)}` : ""}. Everything is editable — the drawing included — and the customer signs the revised order when you are done.</>
                : authority === "free_window"
                  ? <>Everything is editable — the drawing, the options, the price. The customer signs the revised order when you are done, and any payment already taken stays exactly where it is.</>
                  : <>Everything is editable, and the customer signs the revised order when you are done.</>}
              {feeCents > 0 && <> <b>A {feeLabel.toLowerCase()} of {usd(feeCents)} applies.</b></>}
            </div>
            <div style={{ marginTop: 9 }}>
              {btn("Change this order", () => (feeCents > 0 ? setPreflight(true) : startChange()), true)}
            </div>
          </>
        ))}
        {preflight && (
          <PreflightSheet feeCents={feeCents} feeTaxCents={0} feeLabel={feeLabel}
            taxable={!!(policy && policy.feeTaxable)}
            onCancel={() => setPreflight(false)} onGo={startChange} busy={busy} />
        )}
      </>
    );
  }

  // ── LOCKED ───────────────────────────────────────────────────────────────────────────
  // Someone has to unlock it. Two different people see two different things here, and the
  // split is the whole point of the two permission switches: holding Approve does not
  // imply holding Change Orders, and vice versa.
  const waiting = unlock && !unlock.decision;
  const declined = unlock && unlock.decision === "declined";
  return bar("#FEF2F2", "#FECACA", "#991B1B", (
    <>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>This order is signed and locked</div>
      <div>{String(gate.reason || "An admin or crew leader has to unlock it before it can be changed.")}
        {feeCents > 0 && <> Once unlocked, a {feeLabel.toLowerCase()} of {usd(feeCents)} goes on the change.</>}
      </div>

      {waiting && (
        <div style={{ marginTop: 8, fontWeight: 600 }}>
          {(unlock.requested_by_name || "Someone")} asked for this on {fmtDate(unlock.requested_at)} — “{unlock.reason}”
        </div>
      )}
      {declined && (
        <div style={{ marginTop: 8, fontWeight: 600 }}>
          {/* The period lives BEFORE the quoted note, not after it — an approver's note
              almost always ends with one of its own, and “…build on this one.”. is the
              tell of a sentence assembled without reading it. */}
          Declined by {unlock.decided_by_name || "an approver"}{unlock.decision_note ? <> — “{unlock.decision_note}”</> : "."}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 9 }}>
        {/* THE APPROVER'S HALF. `decide_order_unlock` is the only action on the
            change_order_approve area — this button IS that switch. An approver may unlock an
            order nobody has asked about: the builder often decides the change is happening
            before the rep has typed anything. */}
        {coApproveOn && (
          <button type="button" disabled={busy}
            onClick={async () => {
              const note = window.prompt(waiting ? "Anything to tell them? (optional)" : "Why are you unlocking this order?", waiting ? "" : "");
              if (note === null) return;
              const d = await call("decide_order_unlock", { decision: "granted", note });
              if (d) { onMsg({ ok: "Unlocked — this order can be changed now." }); onChanged(); }
            }}
            style={{ ...S.btn("#B45309", "#FFF"), padding: "6px 12px", fontSize: 12.5, cursor: "pointer", opacity: busy ? 0.6 : 1 }}>
            {waiting ? "Unlock it" : "Unlock this order"}
          </button>
        )}
        {coApproveOn && waiting && (
          <button type="button" disabled={busy}
            onClick={async () => {
              const note = window.prompt("Why not? They will see this.");
              if (note === null) return;
              const d = await call("decide_order_unlock", { decision: "declined", note });
              if (d) { onMsg({ ok: "Declined — they have been told." }); onChanged(); }
            }}
            style={{ ...S.btn("#FFF", "#991B1B"), border: "1px solid #FECACA", padding: "6px 12px", fontSize: 12.5, cursor: "pointer", opacity: busy ? 0.6 : 1 }}>
            Decline
          </button>
        )}

        {/* THE REP'S HALF. The reason is not paperwork — it is what the approver reads
            before deciding, and it lands permanently on the order's amendment trail. */}
        {coOn && !waiting && !askOpen && (
          <button type="button" disabled={busy} onClick={() => setAskOpen(true)}
            style={{ ...S.btn("#FFF", "#991B1B"), border: "1px solid #FECACA", padding: "6px 12px", fontSize: 12.5, cursor: "pointer", opacity: busy ? 0.6 : 1 }}>
            Ask for it to be unlocked
          </button>
        )}
      </div>

      {coOn && askOpen && !waiting && (
        <div style={{ marginTop: 10 }}>
          <span style={S.lbl}>What needs changing?</span>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500}
            placeholder="Whoever unlocks it reads this — e.g. “Customer wants the door moved to the gable end.”"
            style={{ ...S.input, resize: "vertical", fontFamily: "inherit" }} />
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button type="button" disabled={busy || !reason.trim()}
              onClick={async () => {
                const d = await call("request_order_unlock", { reason });
                if (!d) return;
                setAskOpen(false); setReason("");
                onMsg({ ok: d.already ? (d.message || "Someone has already asked.") : "Asked — whoever approves changes will see it." });
                onChanged();
              }}
              style={{ ...S.btn("#B45309", "#FFF"), padding: "6px 12px", fontSize: 12.5, cursor: "pointer", opacity: busy || !reason.trim() ? 0.6 : 1 }}>
              Send the request
            </button>
            <button type="button" onClick={() => { setAskOpen(false); setReason(""); }}
              style={{ ...S.btn("#FFF", "#64748B"), border: "1px solid #E2E8F0", padding: "6px 12px", fontSize: 12.5, cursor: "pointer" }}>Cancel</button>
          </div>
        </div>
      )}
    </>
  ));
}

/* The pre-flight sheet. It exists for ONE reason: a rep must never meet the fee for the
   first time on the customer's invoice, and neither must the customer. Rendered from the
   server's own numbers (order_amendment_gate stamped them; the trigger will stamp the same
   ones onto the row), so what this sheet promises is what gets charged. */
function PreflightSheet({ feeCents, feeLabel, taxable, onCancel, onGo, busy }) {
  return (
    <div onClick={onCancel}
      style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)", zIndex: 90, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ background: "#FFF", borderRadius: 12, maxWidth: 460, width: "100%", padding: 20, boxShadow: "0 18px 50px rgba(15,23,42,0.28)" }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: "#0F172A" }}>This change carries a fee</div>
        <p style={{ fontSize: 13, color: "#334155", lineHeight: 1.6, marginTop: 10 }}>
          Changing this order after it was signed adds <b>{ssUsd(feeCents / 100)}</b> to it, as its
          own line reading “{feeLabel}” on the customer's invoice{taxable ? ", plus sales tax at the rate on their agreement" : ""}.
        </p>
        <p style={{ fontSize: 13, color: "#334155", lineHeight: 1.6 }}>
          The customer signs the revised order before any of it counts, and <b>every payment they have
          already made stays exactly where it is</b>. If you discard the change, the fee goes with it.
        </p>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
          <button type="button" onClick={onCancel}
            style={{ ...S.btn("#FFF", "#334155"), border: "1px solid #E2E8F0", padding: "8px 14px", fontSize: 13, cursor: "pointer" }}>Not now</button>
          <button type="button" onClick={onGo} disabled={busy}
            style={{ ...S.btn("#B45309", "#FFF"), padding: "8px 14px", fontSize: 13, cursor: "pointer", opacity: busy ? 0.6 : 1 }}>
            {busy ? "Opening…" : "Start the change"}
          </button>
        </div>
      </div>
    </div>
  );
}

function OrderDocumentCard({ clientId, o, st, doc, busyExt, onMsg, onChanged, onOpenDesign = null, onPreview = null, onRetry = null, coOn = false, coApproveOn = false, invoiceRequestedAt = null }) {
  const [draft, setDraft] = useState(null);      // null = viewing; else the six attrs
  const [preview, setPreview] = useState(null);  // dryRun result { totalBefore, totalAfter, description }
  const [previewErr, setPreviewErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [phoneOpen, setPhoneOpen] = useState(false);   // the "sign on their phone" sheet
  const [smsMsg, setSmsMsg] = useState(null);
  const debounceRef = useRef(null);

  // A sub-read failed: say so, in place of the WHOLE body. Rendering off partial data
  // looks healthy while lying — with paperwork missing it would offer "Create & send
  // invoice" on an order that may already be invoiced and awaiting signature. This
  // must come before the loading gate: on a failed designs read design is null, and
  // the null-design branch below reads as "Loading the order…" forever.
  if (doc && doc.error) {
    return (
      <div style={S.card}>
        <div style={S.err}>Couldn't load this order's paperwork: {doc.error}</div>
        {onRetry && (
          <button type="button" onClick={onRetry}
            style={{ ...S.btn("#0F172A", "#FFF"), padding: "8px 14px", fontSize: 12.5 }}>Retry</button>
        )}
      </div>
    );
  }
  if (!doc || !doc.design) {
    return <div style={S.card}><p style={{ fontSize: 13, color: "#64748B" }}>Loading the order…</p></div>;
  }
  const { design, acceptances, cos, paperwork } = doc;
  const biz = (paperwork && paperwork.business) || {};
  const colors = (paperwork && paperwork.colors) || [];
  // What this design's STYLE offers, from order_paperwork (207). Empty means the tenant has
  // configured none, which reads as all five under our built-in names — the behaviour this
  // screen had before cladding was configurable.
  const cladOffered = (paperwork && paperwork.cladding) || [];
  const invoice = (paperwork && paperwork.invoice) || null;
  const snap = design.estimate_lines || { lines: [], discount: 0 };
  const lines = Array.isArray(snap.lines) ? snap.lines : [];
  const sel = design.selections || {};
  const pc = design.paint_colors || {};
  const locked = ["invoiced", "delivered"].includes(String(design.status || ""));
  const amend = (doc && doc.amend) || null;
  const amendGate = amend && amend.gate ? amend.gate : null;
  // The roof/cladding/paint dropdowns specifically. Editing one on a signed order RAISES a
  // change order (stage_order_attribute_change), which moved onto its own permission area
  // on 2026-09-01 — so they freeze to text without the grant. Deliberately NOT folded into
  // `locked`: that flag also gates the invoicing panel below, and a rep holds orders:edit
  // precisely so they CAN invoice, take payment and collect the signature. Two flags,
  // because there are genuinely two questions.
  //
  // ⚠️ `locked` NO LONGER FREEZES THESE (2026-09-07). It used to, and that single term is
  // what made Carolyn's requirement false: "a change order can happen anytime throughout the
  // process up until after delivery and final payment." An invoiced order is exactly when a
  // change is most likely and most consequential. The question is no longer WHICH STATUS the
  // order is in but whether the builder's own rules leave it open — the free window, or an
  // unlock somebody granted — and that is `order_amendment_gate`, the same function the
  // server asks before it writes, so the dropdowns and the database always agree.
  //
  // The fallback keeps the OLD behaviour when the gate read failed: a missing answer must
  // not read as permission. `amendment_status` is soft on purpose (see its loader), so this
  // is a real state, not a theoretical one.
  const attrsLocked = !coOn || (amendGate ? amendGate.open !== true : locked);
  const acceptance = (acceptances || []).find((a) => a.subject === "quote") || null;
  const ackedCos = (cos || []).filter((c) => c.status === "acknowledged")
    .sort((a, b) => String(a.acknowledged_at || "").localeCompare(String(b.acknowledged_at || "")));
  // 'draft' JOINS 'pending_ack' HERE (2026-09-07). open_amendment creates a DRAFT and that
  // is now the ordinary way a change on a signed order begins, so a draft is every bit as
  // "live" as a sent one for the three jobs this variable does: it feeds discardStaged, the
  // amendment trail, and the `!pendingCo` drift exception below — and a draft has already
  // revised the design, which is precisely what that exception is about.
  const pendingCo = (cos || []).find((c) => (c.status === "pending_ack" || c.status === "draft") && c.source === "design_edit") || null;
  // Two questions, deliberately not one. The DOCUMENT's staging logic means the design_edit
  // CO specifically - it feeds discardStaged, the amendment trail and the `!pendingCo` drift
  // exception, and void_change_order restores from snapshot_before, which a manual CO never
  // writes. The INVOICE gate does not: send_invoice refuses on ANY pending_ack CO
  // (portal-settings :7068, source-blind), as does the list-level 'CO pending' chip. So a
  // manual CO raised from Change orders used to leave a live green 'Create & send invoice'
  // that only ever bought a 409 after the confirm dialog - and an info row in app_errors
  // every time. Source-blind HERE and nowhere else.
  //
  // ⚠️ AND THIS ONE STAYS 'pending_ack'-ONLY — the opposite decision to `pendingCo` above,
  // deliberately. This flag gates INVOICING, and send_invoice's own 409 is pending_ack-only.
  // Widening it to drafts would let a rep who opened a change and wandered off brick
  // invoicing on that order forever, with nothing on screen explaining why.
  const anyPendingCo = (cos || []).find((c) => c.status === "pending_ack") || null;
  // A change approved AFTER the invoice was issued means the PDF in the customer's inbox
  // shows the wrong amount. customer-accept refuses to let them sign a stale invoice, so
  // the operator has to be told the remedy is "regenerate", not "wait" (migration 136).
  // `document_at` since migration 221 — the DOCUMENT's freshness, not when an email last
  // succeeded. Reading `updated_at` here meant a builder whose customer email bounces saw
  // this banner forever, because the only thing that moved that column was a successful send.
  const ackedAfterInvoice = !!invoice && !invoice.signed_at && ackedCos.some((c) =>
    Date.parse(String(c.acknowledged_at || "")) > Date.parse(String(invoice.document_at || invoice.updated_at || "")));

  const cur = {
    roofType: String(sel.roofType || "").trim(),
    roofColor: String(sel.roofColor || "").trim(),
    cladding: String(sel.cladding || ""),
    paintStatus: (sel.paint && String(sel.paint).toLowerCase() === "painted") ? "Paint" : "Unpaint",
    paintBody: String(pc.body || "").trim(),
    paintTrim: String(pc.trim || "").trim(),
  };
  const eff = draft || cur;

  // Palette slices for the dropdowns. A stored value missing from today's palette still
  // renders — a renamed color must not silently rewrite a signed order. An EMPTY stored
  // value gets an explicit "(not chosen)" option: without one the browser displays the
  // first option while the select's value stays "", and what the rep sees isn't what
  // would be staged.
  const colorOpts = (flag, current) => {
    const opts = colors.filter((c) => c[flag] === true && !c.allow_custom).map((c) => c.label);
    if (current && !opts.some((l) => l.toLowerCase() === current.toLowerCase())) opts.unshift(current);
    if (!current) opts.unshift("");
    return opts;
  };
  const optLabel = (l) => (l === "" ? "(not chosen)" : l);
  const roofTypes = [["Shingle", colors.some((c) => c.shingle === true)], ["Metal", colors.some((c) => c.metal === true)]]
    .filter(([, ok]) => ok).map(([t]) => t);

  const queuePreview = (next) => {
    setDraft(next); setPreview(null); setPreviewErr(null);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      const { data, error } = await sb.functions.invoke("portal-settings", {
        body: { action: "stage_order_attribute_change", shortCode: o.short_code, attrs: next, dryRun: true },
      });
      if (error || (data && data.error)) { setPreviewErr((data && data.error) || error.message); return; }
      setPreview(data);
    }, 450);
  };
  const change = (k, v) => {
    const next = { ...eff, [k]: v };
    if (k === "roofType" && v !== eff.roofType) {
      // The designer's rule: a type change resets the color to that type's first offering.
      const flag = String(v).toLowerCase() === "metal" ? "metal" : "shingle";
      const first = colors.find((c) => c[flag] === true && !c.allow_custom);
      next.roofColor = first ? first.label : "";
    }
    queuePreview(next);
  };
  const discardDraft = () => { setDraft(null); setPreview(null); setPreviewErr(null); if (debounceRef.current) clearTimeout(debounceRef.current); };

  // A change order staged here is priced from the DESIGN snapshot; money moved by hand —
  // a manual CO (which deliberately never touches the snapshot) or an order total typed in
  // below — lives only on orders.total_cents. When those two disagree, signing a staged CO
  // writes the snapshot figure straight over the order, the hand-moved amount leaves the
  // book of record, and the invoice prints an "Order adjustment" cancelling it back out.
  // The two can also part company with no hand-moved money at all: discarding a
  // DESIGNER-raised revision voids the CO but leaves the design carrying it
  // (void_change_order restores only from a snapshot_before, which that path never
  // writes), so the snapshot prices out away from the signed total on its own.
  // So the test is the MONEY, not which kind of CO came last — and the design-side figure to
  // test is what the design ITSELF prices out at right now, because that is what signing
  // writes onto the order: total_after_cents is totalFromSnapshot of the design's own lines
  // with the staged attribute delta applied.
  // ⚠️ NOT `preview.totalBefore`. Until migration 153 those were the same number and this
  // read it; they are not the same number any more. The server's baseline is now
  // designs.accepted_snapshot — the design as of the customer's last AGREEMENT — and for a
  // DISCARDED designer revision that is precisely the order's total, so a drift measured
  // against it is structurally zero for the second case above, the one this guard was
  // written for. The design's own price still sees it (it is carrying the revision), and it
  // still sees hand-moved money too (there the design prices at the agreed figure and the
  // order does not). It fires only when something is actually at stake, it is not fooled by
  // voiding the manual CO (voiding does not put orders.total_cents back), and it clears as
  // soon as the design carries the amount again — a designer resubmit that prices it in —
  // instead of shutting the dropdowns off for the life of the order.
  // The `!pendingCo` term is the one exception: while a design_edit CO is pending, the design
  // has ALREADY been revised (both writers apply the change to the row at staging time, and
  // the customer acknowledges after), so it prices away from the still-signed order total by
  // the pending amount and EVERY pending CO would otherwise read as drift. Blocking would not
  // save hand-moved money there anyway, since signing that pending CO overwrites the order
  // total with its own figure regardless.
  // ⚠️ TRADE-OFF, deliberate: the real fix is server-side (stage_order_attribute_change
  // deriving totalBefore from orders.total_cents, or carrying the manual delta forward).
  // Until that lands, an order whose total and design have parted company genuinely cannot
  // be changed from this document without losing the agreed total, and "+ New change
  // order" amends the TOTAL ONLY — the design, its PDFs and the build paperwork keep the
  // roof/cladding/paint they already carry. The message says so rather than implying the
  // two paths are equivalent, and the banner shows it as soon as the price preview lands,
  // not at the final click.
  // No priced lines at all is not a $0 design — the server refuses to stage against one, so
  // make no claim about it rather than reading it as the order being the whole total adrift.
  const designPricedCents = lines.length ? Math.round(ssSnapTotals(snap).total * 100) : null;
  const baselineDriftCents = (design.accepted_at && !pendingCo && designPricedCents != null && o.total_cents != null && o.total_cents !== designPricedCents)
    ? o.total_cents - designPricedCents
    : 0;
  const baselineDriftMsg = baselineDriftCents === 0 ? null
    : `This order's total (${money(o.total_cents)}) isn't what the design currently prices out at (${money(designPricedCents)}) — the order is ${money(Math.abs(baselineDriftCents))} ${baselineDriftCents > 0 ? "above" : "below"} the design's figure. Either the money was moved on the order alone (a manual change order, or a total typed in below), or a designer revision was discarded — discarding one leaves the design priced at a revision the customer never signed. Either way the order total is the book of record and the design is the side that is out of step. A change staged from this document is priced from the design, so signing it would overwrite the order total with the design's figure and the agreed amount would leave the record. Record this change under Change orders → + New change order below — that amends the total only, so the roof, cladding and paint you just picked will not reach the design, its PDFs or the build paperwork — or have the designer resubmit the design priced at ${money(o.total_cents)}, after which staging from this document works again.`;

  const stage = async () => {
    if (baselineDriftMsg) { onMsg({ err: baselineDriftMsg }); return; }
    setBusy(true); onMsg(null);
    const { data, error } = await sb.functions.invoke("portal-settings", {
      body: { action: "stage_order_attribute_change", shortCode: o.short_code, attrs: eff },
    });
    if (error || (data && data.error)) { setBusy(false); onMsg({ err: (data && data.error) || error.message }); return; }
    let note;
    if (data.changeOrderId) {
      const { data: sent } = await sb.functions.invoke("portal-settings", { body: { action: "send_change_order", changeOrderId: data.changeOrderId } });
      note = sent && sent.sent
        ? { ok: `Change order CO-${data.coNo} staged and emailed to the customer for signature.` }
        : { ok: `Change order CO-${data.coNo} staged. Email not sent${sent && sent.reason ? ` (${sent.reason})` : ""} — they can sign from their estimate page link.` };
    } else {
      note = { ok: "Estimate updated — the customer hasn't signed yet, so no change order was needed." };
    }
    setBusy(false); discardDraft(); onMsg(note); onChanged();
  };

  const discardStaged = async () => {
    if (!pendingCo) return;
    if (!window.confirm(`Discard the staged change (CO-${pendingCo.co_no}) and restore the order as the customer signed it?`)) return;
    setBusy(true); onMsg(null);
    const { data, error } = await sb.functions.invoke("portal-settings", {
      body: { action: "void_change_order", changeOrderId: pendingCo.id, reason: "Discarded from the order screen — restored to the signed configuration" },
    });
    setBusy(false);
    if (error || (data && data.error)) { onMsg({ err: (data && data.error) || error.message }); return; }
    onMsg({ ok: `CO-${pendingCo.co_no} discarded${data.reverted ? " — the order is back to what the customer signed" : ""}.` });
    onChanged();
  };

  const selStyle = { fontFamily: "inherit", fontSize: 12, padding: "5px 8px", border: "1px solid #CBD5E1", borderRadius: 7, background: "#FFF", color: "#1E293B", maxWidth: 170 };
  const th = { fontSize: 10.5, fontWeight: 700, color: "#94A3B8", letterSpacing: 0.5, textTransform: "uppercase", textAlign: "left", padding: "10px 0 6px" };
  const td = { fontSize: 13, color: "#1E293B", padding: "9px 0", borderTop: "1px solid #F1F5F9", verticalAlign: "top" };
  const optionRows = (label, control) => (
    <tr key={label}>
      <td style={td}>
        <div style={{ fontWeight: 700 }}>{label}</div>
        <div style={{ marginTop: 6, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>{control}</div>
      </td>
      <td style={{ ...td, textAlign: "center", color: "#94A3B8" }}>—</td>
      <td style={{ ...td, textAlign: "right" }}></td>
    </tr>
  );

  const totals = ssSnapTotals(snap);
  const ssInvoicePdf = invoice && invoice.issued_by === "structurestudio" && invoice.invoice_pdf_url ? invoice.invoice_pdf_url : null;
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(cur);
  const anyBusy = busy || busyExt;

  // ONE send handler for "Create & send invoice" and "Approve & send invoice" (migration 229).
  // Approving a customer's invoice request has no action of its own on purpose: it IS
  // send_invoice, which marks the request approved when it records the invoice. A second call
  // shape would be a second thing to keep in step with the claim ladder, the numbering and QBO.
  const createAndSendInvoice = async () => {
    const totalTxt = o.total_cents != null ? money(o.total_cents) : ssUsd(totals.total);
    if (!window.confirm(`Create invoice for ${design.ss_quote_number} (${totalTxt}) and email it to the customer?\n\nThe invoice gets its own number and PDF. The customer signs the invoice — the order is marked Invoiced once they do.`)) return;
    setBusy(true); onMsg(null);
    const { data, error } = await sb.functions.invoke("portal-settings", { body: { action: "send_invoice", shortCode: o.short_code } });
    setBusy(false);
    if (error || (data && data.error)) { onMsg({ err: (data && data.error) || error.message }); return; }
    // The invoice-time tax check is a NOTE beside the outcome, never the outcome: it cannot change
    // the invoice (the customer agreed to that total) and cannot block it (ssTaxCheckNote).
    const note = ssTaxCheckNote(data && data.taxCheck);
    onMsg(data && data.sent === false
      ? { err: `Invoice ${data.invoiceNumber || ""} created, but the customer was NOT emailed${data.emailReason ? ` (${data.emailReason})` : ""} — they can't sign it until they get it. Print it or copy the customer link.`, note }
      : { ok: `Invoice ${(data && data.invoiceNumber) || ""} sent — awaiting the customer's signature.`, note });
    onChanged();
  };
  // "Not now" (portal-settings dismiss_invoice_request). Issues, numbers and emails nothing;
  // the order stays accepted and drops back to "Needs invoice", so issuing later is still the
  // one button. fnError, not error.message: the refusals here are sentences worth reading
  // ("That invoice has already been issued."), and invoke hides a non-2xx body behind a
  // generic message.
  const dismissInvoiceRequest = async () => {
    setBusy(true); onMsg(null);
    const { data, error } = await sb.functions.invoke("portal-settings", { body: { action: "dismiss_invoice_request", shortCode: o.short_code } });
    setBusy(false);
    if (error) { onMsg({ err: await fnError(error) }); onChanged(); return; }
    if (data && data.error) { onMsg({ err: data.error }); return; }
    onMsg({ ok: `Set aside — ${design.ss_quote_number || "this order"} is back under Needs invoice. Create the invoice whenever you're ready.` });
    onChanged();
  };

  // The amendment trail: accepted total + acknowledged CO snapshots — never re-summed line
  // items, so double-counting is structurally impossible.
  //
  // The base row says ACCEPTED, not "Signed". `acceptance` is the row with subject 'quote',
  // and since migration 136 a quote is accepted with a CLICK — the binding signature is on
  // the INVOICE and lives in a different row entirely. "Signed" here asserted a signature
  // that does not exist for every quote accepted under the current ladder. "Accepted" is
  // true of both shapes: a legacy drawn/typed quote row was also, necessarily, accepted.
  const trail = [];
  if (acceptance && acceptance.total != null) {
    let running = Number(acceptance.total);
    trail.push({
      label: acceptance.method === "rep"
        ? `Authorised by ${acceptance.recorded_by_name || "your team"} · ${fmtDate(acceptance.accepted_at)}`
        : `Accepted ${fmtDate(acceptance.accepted_at)}`,
      amountText: ssUsd(running), tone: "base",
      // The tax INSIDE that accepted total, from the columns frozen with it — not the snapshot.
      sub: ssSignedTaxText(acceptance),
    });
    // ⚠️ EACH CHANGE'S OWN DELTA, NOT A CHAIN THROUGH `total_after_cents` (2026-09-07).
    // That column is "the whole order after this change" as computed FROM THE DESIGN'S LINES
    // — and a manual change order never touches those lines, nor does a fee. So chaining
    // through it made a design edit look like it reversed every manual change above it: on
    // the beta order this was found on, a no-cost roof change read "CO-5 · −$650.00 →
    // $3,400.00" immediately above "Current total $4,200.00". Nothing was wrong with the
    // money; the trail was describing it with the wrong arithmetic, and saying so directly
    // above the right answer.
    //
    // The same reasoning the server settled on in orderCentsAfterAck: take what each change
    // itself moved (its own before → after) plus the fee it carried, and accumulate that.
    // The running total then lands on orders.total_cents by construction rather than by
    // coincidence, which is the property that makes the last two rows agree.
    for (const c of ackedCos) {
      const delta = (c.total_after_cents == null || c.total_before_cents == null)
        ? 0 : ssRound2((c.total_after_cents - c.total_before_cents) / 100);
      const feeAll = ssRound2(((Number(c.fee_cents) || 0) + (Number(c.fee_tax_cents) || 0)) / 100);
      const moved = ssRound2(delta + feeAll);
      running = ssRound2(running + moved);
      const feeNote = feeAll > 0 ? ` (incl. ${ssUsd(feeAll)} fee)` : "";
      trail.push({
        label: `CO-${c.co_no} · ${fmtDate(c.acknowledged_at)}`,
        amountText: moved === 0
          ? "no price change"
          : `${moved >= 0 ? "+" : "-"}${ssUsd(Math.abs(moved))}${feeNote} → ${ssUsd(running)}`,
        tone: "base",
      });
    }
    trail.push({ label: "Current total", amountText: o.total_cents == null ? "—" : money(o.total_cents), tone: "final" });
    if (pendingCo && pendingCo.total_after_cents != null) {
      trail.push({ label: `Pending CO-${pendingCo.co_no} (awaiting sign-off)`, amountText: `→ ${ssUsd(pendingCo.total_after_cents / 100)}`, tone: "pending" });
    }
  }

  return (
    <div style={{ ...S.card, padding: "20px 24px" }}>
      {/* Letterhead */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, borderBottom: "2px solid #CBD5E1", paddingBottom: 13 }}>
        <div>
          <div style={{ fontSize: 17, fontWeight: 800, color: "#1E293B" }}>{biz.name || "—"}</div>
          <div style={{ fontSize: 11.5, color: "#64748B", marginTop: 2 }}>
            {[biz.phone, biz.website].filter(Boolean).join(" · ")}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 14, fontWeight: 800, letterSpacing: 0.5, color: "#1E293B" }}>ORDER · {design.ss_quote_number}</div>
          <div style={{ fontSize: 11.5, color: "#64748B", marginTop: 2 }}>
            Ordered {fmtDate(o.ordered_at)}
            {invoice && invoice.invoice_number ? ` · Invoice ${invoice.invoice_number}` : " · not yet invoiced"}
          </div>
          <span style={{ display: "inline-block", marginTop: 6, background: st.bg, color: st.fg, borderRadius: 20, padding: "3px 11px", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" }}>{st.label}</span>
          {/* THE BUILDING SERIAL (163). Carolyn, 2026-08-28 @59:25: "it'll be a serial
              number. It's considered a serial number. They will literally write this in the
              building. They can make tabs or something for the building."

              ⚠️ IT HAS TO LIVE HERE, not on the thin header card below. That card is the
              `ssMode` FALSE branch and its own comment says this component "replaces the old
              thin header card for SS orders" -- so on every StructureStudio-native order,
              which is all of them, the other one never renders. Putting it there first and
              only finding out by opening the page is exactly why this got looked at.

              Monospace and select-all because the whole job of this string is to be copied
              onto a physical tag without a transcription error. Since 316 (2026-10-18) it is
              issued WHEN THE ORDER IS CREATED and frozen (MMYY-STYLE-SIZE-COLORS-NUMBER), so it
              can ride the first invoice. Absent means the builder has not set a starting
              building number yet (316 will not number a sale against an unset counter). */}
          <div style={{ fontSize: 11.5, marginTop: 6 }}>
            {o.building_serial ? (
              <span title="This building's serial number — write this on the tag"
                style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontWeight: 700, letterSpacing: 0.5, color: "#0F172A", background: "#F1F5F9", border: "1px solid #E2E8F0", borderRadius: 6, padding: "3px 8px", userSelect: "all" }}>{o.building_serial}</span>
            ) : (
              <span style={{ color: "#94A3B8" }}>No serial yet — set your starting building number in Settings → Business Details</span>
            )}
          </div>
        </div>
      </div>

      {pendingCo && (
        <div style={{ background: "#FEF3C7", border: "1px solid #FDE68A", borderRadius: 8, padding: "9px 13px", marginTop: 12, fontSize: 12.5, color: "#B45309", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <b>CO-{pendingCo.co_no} is awaiting the customer's sign-off</b> — the values below include it; invoicing is blocked until they sign or you record their verbal OK.
          {/* The NOTICE stays for everyone: a rep whose invoicing is blocked has to be told
              why. Discarding is the change-order power, so only the grant gets the button —
              void_change_order refuses without it anyway, and offering a 403 is not an offer. */}
          {coOn && <button type="button" onClick={discardStaged} disabled={anyBusy}
            style={{ marginLeft: "auto", background: "none", border: "none", padding: 0, cursor: "pointer", color: "#B45309", fontWeight: 700, fontSize: 12, textDecoration: "underline", fontFamily: "inherit" }}>
            Discard staged change
          </button>}
        </div>
      )}

      {/* Line items */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 4 }}>
        <thead><tr><th style={th}>Item</th><th style={{ ...th, textAlign: "center", width: 46 }}>Qty</th><th style={{ ...th, textAlign: "right", width: 92 }}>Amount</th></tr></thead>
        <tbody>
          {lines.map((li, i) => {
            const kind = String(li.kind || "");
            const lineTotal = ssRound2((Number(li.qty) || 0) * (Number(li.amount) || 0));
            let descCell = null;
            if (!attrsLocked && kind === "paint") {
              descCell = (
                <div style={{ marginTop: 6, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <select style={selStyle} value={eff.paintStatus} onChange={(e) => change("paintStatus", e.target.value)}>
                    <option value="Paint">Painted</option><option value="Unpaint">Unpainted</option>
                  </select>
                  {eff.paintStatus === "Paint" && (
                    <>
                      <span style={{ fontSize: 11.5, color: "#64748B" }}>Body</span>
                      <select style={selStyle} value={eff.paintBody} onChange={(e) => change("paintBody", e.target.value)}>
                        {colorOpts("siding", eff.paintBody).map((l) => <option key={l} value={l}>{optLabel(l)}</option>)}
                      </select>
                      <span style={{ fontSize: 11.5, color: "#64748B" }}>Trim</span>
                      <select style={selStyle} value={eff.paintTrim} onChange={(e) => change("paintTrim", e.target.value)}>
                        {colorOpts("trim", eff.paintTrim).map((l) => <option key={l} value={l}>{optLabel(l)}</option>)}
                      </select>
                    </>
                  )}
                </div>
              );
            } else if (!attrsLocked && kind === "roof") {
              descCell = (
                <div style={{ marginTop: 6, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <select style={selStyle} value={eff.roofType} onChange={(e) => change("roofType", e.target.value)}>
                    {!eff.roofType && <option value="">Select…</option>}
                    {roofTypes.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                  {eff.roofType && (
                    <select style={selStyle} value={eff.roofColor} onChange={(e) => change("roofColor", e.target.value)}>
                      {colorOpts(String(eff.roofType).toLowerCase() === "metal" ? "metal" : "shingle", eff.roofColor).map((l) => <option key={l} value={l}>{optLabel(l)}</option>)}
                    </select>
                  )}
                </div>
              );
            }
            return (
              <React.Fragment key={i}>
                <tr>
                  <td style={td}>
                    <div style={{ fontWeight: 700 }}>{li.name || "—"}</div>
                    {descCell || (li.desc ? <div style={{ fontSize: 12, color: "#64748B", whiteSpace: "pre-wrap", marginTop: 2 }}>{ssDeHtml(li.desc)}</div> : null)}
                  </td>
                  <td style={{ ...td, textAlign: "center" }}>{Number(li.qty) === 1 && (kind === "paint" || kind === "roof") ? "—" : (li.qty ?? "—")}</td>
                  <td style={{ ...td, textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{ssUsd(lineTotal)}</td>
                </tr>
                {kind === "building" && optionRows("Cladding",
                  attrsLocked
                    ? <span style={{ fontSize: 12, color: "#64748B" }}>{ssCladdingLabel(cur.cladding, cladOffered)}</span>
                    : (
                      <select style={selStyle} value={eff.cladding} onChange={(e) => change("cladding", e.target.value)}>
                        {ssCladdingOpts(cladOffered, cur.cladding).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                      </select>
                    ))}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>

      {/* Staged-change banner (dryRun preview) */}
      {dirty && (
        <div style={{ background: "#FEF3C7", border: "1px solid #FDE68A", borderRadius: 8, padding: "10px 14px", marginTop: 10 }}>
          {previewErr && <div style={{ fontSize: 12.5, fontWeight: 700, color: "#B91C1C" }}>{previewErr}</div>}
          {!previewErr && !preview && <div style={{ fontSize: 12.5, fontWeight: 700, color: "#B45309" }}>Pricing the change…</div>}
          {!previewErr && preview && (
            <>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: "#B45309" }}>
                This changes the order {ssUsd(preview.totalBefore)} → {ssUsd(preview.totalAfter)}
                {preview.totalBefore != null && preview.totalAfter != null && (
                  <> ({preview.totalAfter - preview.totalBefore >= 0 ? "+" : "-"}{ssUsd(Math.abs(ssRound2(preview.totalAfter - preview.totalBefore)))})</>
                )}
              </div>
              <div style={{ fontSize: 12, color: "#92400E", whiteSpace: "pre-wrap", marginTop: 4 }}>{preview.description}</div>
              {/* The refusal belongs HERE, with the price it applies to — discovering it
                  only on the final click means the rep has already picked the colors. */}
              {baselineDriftMsg
                ? <div style={{ fontSize: 12, fontWeight: 700, color: "#B91C1C", marginTop: 6 }}>{baselineDriftMsg}</div>
                : (
                  <div style={{ fontSize: 12, color: "#B45309", marginTop: 4 }}>
                    {design.accepted_at ? "The customer must sign off before this order can be invoiced." : "The customer hasn't signed yet — this just updates the estimate."}
                  </div>
                )}
            </>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button type="button" onClick={stage} disabled={anyBusy || !preview || !!baselineDriftMsg}
              style={{ ...S.btn(ACCENT, "#FFF"), padding: "7px 14px", fontSize: 12.5, opacity: anyBusy || !preview || !!baselineDriftMsg ? 0.6 : 1 }}>
              {busy ? "Staging…" : (design.accepted_at ? "Stage & send for signature" : "Update the estimate")}
            </button>
            <button type="button" onClick={discardDraft} disabled={anyBusy}
              style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0", padding: "7px 14px", fontSize: 12.5 }}>Discard</button>
          </div>
        </div>
      )}

      {/* Totals + the amendment trail */}
      <div style={{ borderTop: "2px solid #CBD5E1", marginTop: 10, paddingTop: 9 }}>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 40, fontSize: 13, padding: "2px 0", color: "#64748B" }}>
          <span>Subtotal</span><span style={{ minWidth: 92, textAlign: "right", color: "#1E293B", fontVariantNumeric: "tabular-nums" }}>{ssUsd(totals.subtotal)}</span>
        </div>
        {/* On a taxed document the discounts are already netted into Subtotal, exactly as
            estimatePdf.ts prints it — showing a Discount row here too would read as a second
            deduction the Total does not make. Untaxed keeps the collapsed row it always had. */}
        {totals.tax == null && totals.discount > 0 && (
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 40, fontSize: 13, padding: "2px 0", color: "#64748B" }}>
            <span>Discount</span><span style={{ minWidth: 92, textAlign: "right", color: "#1E293B", fontVariantNumeric: "tabular-nums" }}>-{ssUsd(totals.discount)}</span>
          </div>
        )}
        {totals.tax != null && (
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 40, fontSize: 13, padding: "2px 0", color: "#64748B" }}>
            {/* Which rate priced it (Avalara stage): verified for the delivery address, the sales
                location's rate, or the company rate. Screen only — the PDF prints the label. */}
            <span style={{ textAlign: "right" }}>
              {totals.taxLabel}
              {ssTaxBasisText(snap.tax) && <span style={{ display: "block", fontSize: 11, color: "#94A3B8" }}>{ssTaxBasisText(snap.tax)}</span>}
            </span>
            <span style={{ minWidth: 92, textAlign: "right", color: "#1E293B", fontVariantNumeric: "tabular-nums" }}>{ssUsd(totals.tax)}</span>
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 40, fontSize: 16, fontWeight: 800, padding: "5px 0 2px", color: "#1E293B" }}>
          <span>Total</span><span style={{ minWidth: 92, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{ssUsd(totals.total)}</span>
        </div>
        {trail.length > 0 && (
          <div style={{ background: "#F8FAFC", border: "1px solid #F1F5F9", borderRadius: 8, padding: "8px 12px", marginTop: 8 }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "#94A3B8", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 3 }}>Amendment trail</div>
            {trail.map((t, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12, padding: "2px 0",
                color: t.tone === "pending" ? "#B45309" : t.tone === "final" ? "#1E293B" : "#64748B",
                fontWeight: t.tone === "final" ? 800 : 500,
                borderTop: t.tone === "final" ? "1px solid #E2E8F0" : "none",
                marginTop: t.tone === "final" ? 3 : 0, paddingTop: t.tone === "final" ? 4 : 2 }}>
                <span>{t.label}{t.sub && <span style={{ display: "block", fontSize: 11, color: "#94A3B8", fontWeight: 500 }}>{t.sub}</span>}</span>
                <span style={{ fontVariantNumeric: "tabular-nums" }}>{t.amountText}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* THE INVOICE STEP — the missing rung Carolyn hit (2026-08-25: "I see no way for
          creating that into an invoice"). The ladder is: QUOTE (the signed offer, SST-…)
          → this order → INVOICE (the bill, SSI-…). One clear affordance per state. */}
      {!locked && (
        !design.accepted_at
          ? <div style={{ background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 8, padding: "9px 13px", marginTop: 12, fontSize: 12.5, color: "#64748B" }}>
              <b>Estimate sent — awaiting the customer's acceptance.</b> Invoicing unlocks when they accept it from their estimate page (Copy customer link below, or hand them your phone).
            </div>
          : ssInvoicePdf
          /* The invoice is OUT but the design is not locked, which since migration 136 can
             only mean one thing: the customer has not signed it yet. Nothing here creates a
             second invoice — every button here re-sends the same number. */
          ? <div style={{ background: "#FEFCE8", border: "1px solid #FDE68A", borderRadius: 8, padding: "10px 13px", marginTop: 12, fontSize: 12.5, color: "#713F12" }}>
              <b>Invoice {invoice.invoice_number || ""} sent{design.ss_invoice_sent_at ? ` ${fmtDate(design.ss_invoice_sent_at)}` : ""} — awaiting the customer's signature.</b>
              <div style={{ marginTop: 4, color: "#854D0E" }}>
                Send the link to their phone, or they sign it from their estimate page. The build schedule unlocks once they do.
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 9, flexWrap: "wrap" }}>
                {/* One offer, never both: a plain resend rebuilds nothing, but it still bumps
                    invoice_sends.updated_at — the ONLY record anywhere that the PDF predates
                    the acknowledged CO. That single click clears this warning, the stale badge
                    on the customer's quote page and customer-accept's refusal at once, and the
                    customer can then sign a PDF showing the old amount. */}
                {/* Carolyn 2026-09-01: the customer is often sitting right there, and
                    "they sign it from their quote page" is not a thing you can say out
                    loud to someone across a desk. This puts the link on THEIR phone. */}
                <button type="button" onClick={() => { setSmsMsg(null); setPhoneOpen(true); }}
                  style={{ ...S.btn("#3D3672", "#FFF"), padding: "8px 14px", fontSize: 12.5 }}>
                  Sign on their phone
                </button>
                {(ackedAfterInvoice ? [["Regenerate & resend", true]] : [["Resend invoice", false]]).map(([label, regen]) => (
                  <button key={label} type="button" disabled={anyBusy}
                    onClick={async () => {
                      if (!window.confirm(regen
                        ? `Rebuild invoice ${invoice.invoice_number || ""} from the current totals and email it again?\n\nSame invoice number — the customer can't sign the outdated one.`
                        : `Email invoice ${invoice.invoice_number || ""} to the customer again?`)) return;
                      setBusy(true); onMsg(null);
                      // ⚠️ REGENERATE GOES TO `reissue_invoice`, NOT send_invoice (2026-09-08).
                      // send_invoice's already-invoiced branch is an EMAIL RETRY: it re-sends
                      // the stored PDF without rebuilding it, and moves the staleness
                      // timestamp only if the email lands. So this button said "Regenerate"
                      // and regenerated nothing — and on a customer whose address bounces it
                      // could never clear the banner, leaving the order unpayable by anyone.
                      // reissue_invoice rebuilds the document and stamps document_at whether
                      // or not anything is delivered; the email rides along as a courtesy.
                      const { data, error } = regen
                        ? await sb.functions.invoke("portal-settings", { body: { action: "reissue_invoice", shortCode: o.short_code } })
                        : await sb.functions.invoke("portal-settings", { body: { action: "send_invoice", shortCode: o.short_code } });
                      setBusy(false);
                      if (error || (data && data.error)) { onMsg({ err: (data && data.error) || error.message }); return; }
                      // Same informational tax note as the first send, if this answer carries one.
                      const note = ssTaxCheckNote(data && data.taxCheck);
                      onMsg(data && data.sent === false
                        ? (regen
                          // The document IS rebuilt — say so, or a builder reads a send
                          // failure as "nothing happened" and clicks again forever.
                          ? { ok: `Invoice ${data.invoiceNumber || ""} rebuilt with the current totals. Not emailed${data.sendReason ? ` — ${data.sendReason}` : ""}; print it or copy the customer link.`, note }
                          : { err: `Invoice ${data.invoiceNumber || ""} is ready but the customer was NOT emailed${data.emailReason || data.sendReason ? ` (${data.emailReason || data.sendReason})` : ""} — print it or copy the customer link.`, note })
                        : { ok: `Invoice ${(data && data.invoiceNumber) || ""} ${regen ? "rebuilt and " : ""}sent again — still awaiting their signature.`, note });
                      onChanged();
                    }}
                    style={{ ...S.btn(regen ? "#B45309" : "#0F172A", "#FFF"), padding: "8px 14px", fontSize: 12.5, opacity: anyBusy ? 0.6 : 1 }}>
                    {busy ? "Working…" : label}
                  </button>
                ))}
              </div>
              {ackedAfterInvoice && (
                <div style={{ marginTop: 7, color: "#9A3412" }}>
                  A change order was approved after this invoice went out, so the amount on it is out of date — the customer can't sign it until you regenerate.
                </div>
              )}
            </div>
          : anyPendingCo
          ? <div style={{ background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 8, padding: "9px 13px", marginTop: 12, fontSize: 12.5, color: "#64748B" }}>
              <b style={{ color: "#B45309" }}>Ready to invoice once CO-{anyPendingCo.co_no} is acknowledged</b> — the customer signs it from their estimate page, or record their verbal OK below.
            </div>
          : invoiceRequestedAt
          /* INVOICE TO APPROVE (migration 229; Ahsan 2026-09-15). The customer accepted from
             their account, which raised a DRAFT invoice: no number, no PDF, no QuickBooks push
             and no inventory claim until this click. Below the change-order branch on purpose —
             a pending change order still blocks issuing, and send_invoice would 409 anyway. */
          ? <div data-invoice-request="pending" style={{ background: "#F5F3FF", border: "1px solid #DDD6FE", borderRadius: 8, padding: "10px 13px", marginTop: 12, fontSize: 12.5, color: "#4C1D95" }}>
              <b>Invoice to approve</b>
              <div style={{ marginTop: 3, color: "#5B21B6" }}>
                Customer accepted {fmtDate(design.accepted_at || invoiceRequestedAt)}. Approve to issue the invoice (it takes the next number).
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 9, flexWrap: "wrap" }}>
                <button type="button" disabled={anyBusy} onClick={createAndSendInvoice}
                  style={{ ...S.btn("#059669", "#FFF"), padding: "9px 18px", fontSize: 13, opacity: anyBusy ? 0.6 : 1 }}>
                  {busy ? "Working…" : "Approve & send invoice"}
                </button>
                <button type="button" disabled={anyBusy} onClick={dismissInvoiceRequest}
                  style={{ ...S.btn("#FFF", "#5B21B6"), border: "1px solid #DDD6FE", padding: "9px 14px", fontSize: 13, opacity: anyBusy ? 0.6 : 1 }}>
                  Not now
                </button>
              </div>
            </div>
          : <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
              <button type="button" disabled={anyBusy} onClick={createAndSendInvoice}
                style={{ ...S.btn("#059669", "#FFF"), padding: "9px 18px", fontSize: 13, opacity: anyBusy ? 0.6 : 1 }}>
                {busy ? "Working…" : "Create & send invoice"}
              </button>
              <span style={{ fontSize: 11.5, color: "#94A3B8" }}>Accepted {fmtDate(design.accepted_at)} — the invoice takes the next number in your sequence.</span>
            </div>
      )}

      {/* Changing a signed order — the one control that decides what can happen to this
          order right now. Above the action row because it outranks everything in it. */}
      {onOpenDesign && (
        <AmendmentPanel clientId={clientId} shortCode={o.short_code} orderId={o.id} amend={amend}
          coOn={coOn} coApproveOn={coApproveOn} onOpenDesign={onOpenDesign}
          onMsg={onMsg} onChanged={onChanged} />
      )}

      {/* Action row. The documents open IN A POPUP (Carolyn 2026-08-25), not a tab —
          the viewer's own toolbar carries print/download. */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", borderTop: "1px solid #F1F5F9", marginTop: 12, paddingTop: 12 }}>
        {(() => {
          const docBtn = (label, url, title) => (
            <button type="button" onClick={() => (onPreview ? onPreview(url, title) : window.open(url, "_blank"))}
              style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0", cursor: "pointer" }}>{label}</button>
          );
          return (
            <>
              {ssInvoicePdf
                ? docBtn("Print invoice", ssInvoicePdf, `Invoice ${invoice.invoice_number || ""}`)
                : (design.ss_quote_pdf_url && docBtn("Print estimate", design.ss_quote_pdf_url, `Estimate ${design.ss_quote_number}`))}
              {ssInvoicePdf && design.ss_quote_pdf_url && docBtn("Estimate (PDF)", design.ss_quote_pdf_url, `Estimate ${design.ss_quote_number}`)}
              {design.image_url && docBtn("Floor plan", design.image_url, "Floor plan")}
            </>
          );
        })()}
        {/* IN-PORTAL designer, never the public ?id= page — staff browsing there fires
            capture-lead/draft saves and corrupts the tenant's Contacts activity. */}
        {/* "View design" once the order is signed and this person cannot raise a change —
            the button still opens the real designer, but calling it "Open design" beside a
            locked order invites an edit that the save will refuse. */}
        {/* A real link (ssDesignHref): the wheel, a new tab and a reload open THIS design. */}
        {o.short_code && onOpenDesign && (
          <a href={ssDesignHref(o.short_code)} onClick={ssNavClick(() => onOpenDesign(o.short_code))} data-ss-open-design="1"
            style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0", cursor: "pointer", display: "inline-block", textDecoration: "none" }}>
            {amendGate && amendGate.signed === true && attrsLocked ? "View design" : "Open design"}
          </a>
        )}
        <button type="button"
          onClick={(e) => {
            // The designer's own account panel, focused on THIS order (plan 3.8, Carolyn
            // 2026-09-14: accept and sign live in the designer now). Invoices once the invoice
            // is out, Quotes before. The designer switches to whichever tab the card actually
            // lives on, so a stale guess still lands. /my-quotes stays up for older links.
            const link = `${window.location.origin}/?client=${encodeURIComponent(clientId)}&account=${ssInvoicePdf ? "invoices" : "quotes"}&q=${encodeURIComponent(o.short_code)}`;
            const btn = e.currentTarget;
            const done = () => { btn.textContent = "Copied ✓"; setTimeout(() => { btn.textContent = "Copy customer link"; }, 2000); };
            if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(done, done);
            else window.prompt("Copy the customer link:", link);
          }}
          style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0", cursor: "pointer" }}>Copy customer link</button>
        <button type="button" disabled={anyBusy}
          onClick={async () => {
            setBusy(true); onMsg(null);
            const { data: res, error: err } = await sb.functions.invoke("portal-settings", { body: { action: "resend_quote_email", shortCode: o.short_code } });
            setBusy(false);
            if (err || (res && res.error)) { onMsg({ err: (res && res.error) || err.message }); return; }
            onMsg(res && res.sent
              ? { ok: `Estimate ${design.ss_quote_number} emailed to the customer.` }
              : { err: `Estimate email not sent${res && res.reason ? ` — ${res.reason}` : ""}. Print the PDF or copy the customer link instead.` });
          }}
          style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0", cursor: "pointer", opacity: anyBusy ? 0.6 : 1 }}>Resend estimate email</button>
      </div>
      {attrsLocked && (
        <div style={{ fontSize: 11.5, color: "#94A3B8", marginTop: 8 }}>
          {!coOn
            ? "Changing these raises a change order, which needs the customer's sign-off. Ask an owner or admin to turn on Change Orders for you in Settings → Team."
            : "These are frozen while the order is locked — see above."}
        </div>
      )}

      {phoneOpen && (
        <SignOnPhoneModal
          clientId={clientId} shortCode={o.short_code} design={design} invoice={invoice}
          msg={smsMsg} setMsg={setSmsMsg} onClose={() => setPhoneOpen(false)} />
      )}
    </div>
  );
}

/**
 * "Sign on their phone" — the same signing link, three ways to hand it over.
 *
 * The link is built HERE, in the browser, from the origin the operator is already on:
 * a link generated on beta must stay on beta, and that is exactly what window.origin
 * gives without a round trip. `?account=invoices&q=` is the designer's deep link (plan 3.8,
 * 2026-09-15; it was /my-quotes?q= before the account panel moved into the designer) — it
 * points at one invoice and opens its Sign panel, and grants nothing on its own: the customer
 * still logs in with the code we send them, and customer-quotes only ever returns designs
 * matching that verified phone or email. Opening someone else's link on your own number shows
 * you your own quotes. The URL stays well inside the QR's 213-byte version-10 capacity.
 */
function SignOnPhoneModal({ clientId, shortCode, design, invoice, msg, setMsg, onClose }) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const link = `${window.location.origin}/?client=${encodeURIComponent(clientId)}&account=invoices&q=${encodeURIComponent(shortCode)}`;
  const phone = (design && design.contact && design.contact.phone) || "";

  // The matrix is derived once per link, not per render — it is ~200 lines of bit work.
  const qr = useMemo(() => { try { return ssQrMatrix(link); } catch (e) { return null; } }, [link]);

  const copy = () => {
    const done = () => { setCopied(true); setTimeout(() => setCopied(false), 2000); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(done, done);
    else { window.prompt("Copy the signing link:", link); done(); }
  };

  const textIt = async () => {
    setBusy(true); setMsg(null);
    const { data, error } = await sb.functions.invoke("portal-settings", {
      body: { action: "text_sign_link", shortCode },
    });
    setBusy(false);
    if (error || (data && data.error)) { setMsg({ err: (data && data.error) || error.message }); return; }
    setMsg(data && data.sent
      ? { ok: `Texted to ${data.to || "the customer"} — they can sign from the link now.` }
      : { err: `Not texted${data && data.reason ? ` — ${data.reason}` : ""}. Show them the QR code instead.` });
  };

  return (
    <div onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 18, zIndex: 1200 }}>
      <div style={{ background: "#FFF", borderRadius: 14, maxWidth: 400, width: "100%", boxShadow: "0 24px 60px rgba(0,0,0,0.3)", overflow: "hidden" }}>
        <div style={{ background: ACCENT, color: "#FFF", padding: "15px 18px", display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ fontSize: 15.5, fontWeight: 800 }}>Sign on their phone</div>
          <button type="button" onClick={onClose}
            style={{ marginLeft: "auto", background: "rgba(255,255,255,0.16)", border: "none", color: "#FFF", width: 26, height: 26, borderRadius: 7, cursor: "pointer", fontSize: 15, fontFamily: "inherit", lineHeight: 1 }}>×</button>
        </div>
        <div style={{ padding: "17px 18px" }}>
          <div style={{ fontSize: 12.5, color: "#475569", lineHeight: 1.5 }}>
            Have them scan this with their phone camera. It opens invoice{" "}
            <b>{(invoice && invoice.invoice_number) || ""}</b> ready to sign — they still enter
            the code we text them, so only they can sign it.
          </div>

          <div style={{ display: "flex", justifyContent: "center", margin: "15px 0 4px" }}>
            {qr
              ? <QrSvg matrix={qr} size={212} />
              : <div style={{ fontSize: 12, color: "#B45309", textAlign: "center", padding: "18px 8px" }}>
                  This link is too long to show as a QR code — copy it instead.
                </div>}
          </div>

          <div style={{ fontSize: 10.5, color: "#94A3B8", textAlign: "center", wordBreak: "break-all", marginBottom: 13 }}>{link}</div>

          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={copy}
              style={{ ...S.btn("#F1F5F9", "#334155"), flex: 1, border: "1px solid #E2E8F0" }}>
              {copied ? "Copied ✓" : "Copy link"}
            </button>
            <button type="button" onClick={textIt} disabled={busy || !phone}
              title={phone ? `Text it to ${phone}` : "This customer has no phone number on their design"}
              style={{ ...S.btn("#059669", "#FFF"), flex: 1, opacity: busy || !phone ? 0.55 : 1 }}>
              {busy ? "Texting…" : "Text it to them"}
            </button>
          </div>

          {msg && (
            <div style={{ marginTop: 11, fontSize: 12, lineHeight: 1.45, color: msg.err ? "#9F1239" : "#047857" }}>
              {msg.err || msg.ok}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** The matrix as an SVG. One <rect> per dark module — a sign link is at most 53x53, so
 *  this stays small, and an SVG prints and scales without a canvas or a data URI. */
function QrSvg({ matrix, size = 200 }) {
  const n = matrix.length;
  const quiet = 4;                       // the spec's quiet zone; scanners need it
  const span = n + quiet * 2;
  const rects = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (matrix[r][c]) rects.push(<rect key={`${r}-${c}`} x={c + quiet} y={r + quiet} width={1} height={1} fill="#0F172A" />);
    }
  }
  return (
    <svg width={size} height={size} viewBox={`0 0 ${span} ${span}`} shapeRendering="crispEdges"
      style={{ display: "block", borderRadius: 8 }} role="img" aria-label="Signing link QR code">
      <rect x={0} y={0} width={span} height={span} fill="#FFF" />
      {rects}
    </svg>
  );
}

// ── Refund: all of a payment, or part of it (board card "Partial refunds", migration 349) ───────
// One box for every payment a builder can refund. A card or bank payment taken HERE goes back
// through the card network (portal-payments refund_payment, or void_payment to cancel the whole
// sale before it settles). One RECORDED by hand (cash, a check, a card run elsewhere) is paid back
// by the builder, and this records how. Either way the amount starts at what is left and cannot go
// above it, and several partial refunds are fine until nothing is left.
//
// ONE KEY PER REFUND. `requestKey` is minted when the box opens and sent with every try of the same
// refund, so a double click, or a retry after the answer was lost, gets the first refund's outcome
// back instead of a second refund (payment_refund_open). After an answer that says nothing went back
// (a refusal, the card network busy) the next try is a NEW refund and gets a new key.
//
// ⚠️ A PARTIAL AMOUNT IS ALWAYS A REFUND. A void cancels the whole sale, so before a card payment
// settles (overnight) the only reversal is the whole of it; the server says so in plain words
// (reason "not_settled") and this box offers the whole cancel instead.
const refundKey = () => {
  try { if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID(); } catch (_e) {}
  return "rk-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12);
};

function RefundModal({ p, refundOwedCents = null, onClose, onDone }) {
  const left = Number(p.amount_cents) || 0;
  const taken = left + (Number(p.refunded_cents) || 0);
  const viaNetwork = p.gateway === "cardpointe";
  // The same reading voidGatewayPayment always used: a card payment counted settled and over 12 hours
  // old has been batched; anything younger may still be cancelled whole. The server decides for real.
  const settledAlready = viaNetwork && p.funding_state === "settled" && Date.parse(p.received_at) < Date.now() - 12 * 3600 * 1000;
  const bankClearing = viaNetwork && p.method === "ach" && p.funding_state === "pending";
  const [amount, setAmount] = useState((left / 100).toFixed(2));
  const [payBack, setPayBack] = useState(PAY_METHODS.some((m) => m[0] === p.method) ? p.method : "cash");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);          // { text, reason }
  const keyRef = useRef(refundKey());
  const cents = centsFrom(amount);
  const amountOk = Number.isFinite(cents) && cents > 0 && cents <= left;
  const whole = amountOk && cents === left;
  const methodName = (PAY_METHODS.find((m) => m[0] === p.method) || [, p.method])[1];
  const card = p.instrument_last4 ? ` ending ${p.instrument_last4}` : "";

  // Reads the edge function's answer the way the rest of this tab does: a non-2xx arrives as
  // `error`, its body on error.context. No body at all means we never heard back.
  const ask = async (body) => {
    const { data, error } = await sb.functions.invoke("portal-payments", { body });
    if (!error) return data && data.error ? { fail: data } : { ok: data || {} };
    let ctx = null;
    try { ctx = await error.context.json(); } catch (_e) {}
    return ctx ? { fail: ctx } : { lost: true };
  };
  const done = (text) => { onDone(text); };
  const failed = (f) => {
    const reason = (f && f.reason) || null;
    // Nothing went back (or it was never sent): the next try is a new refund. A refund we could not
    // confirm keeps its key, so trying again asks about the same one.
    if (reason !== "refund_unconfirmed") keyRef.current = refundKey();
    setErr({ text: (f && f.error) || "That refund didn't go through.", reason });
  };

  const refund = async (amountCents) => {
    const out = await ask({ action: "refund_payment", paymentId: p.id, amountCents, requestKey: keyRef.current,
      ...(viaNetwork ? {} : { refundMethod: payBack, reference: reference.trim() || undefined }) });
    if (out.ok) {
      const r = out.ok;
      const rest = r.leftCents != null && r.leftCents > 0 ? ` ${money(r.leftCents)} of this payment is left.` : "";
      done(viaNetwork
        ? `Refunded ${money(r.refunded)} to the customer${card ? ` (card${card})` : ""}.${rest}`
        : `Recorded a ${money(r.refunded)} refund by ${(PAY_METHODS.find((m) => m[0] === payBack) || [, payBack])[1].toLowerCase()}.${rest}`);
      return;
    }
    if (out.lost) { setErr({ text: "We didn't hear back, so we can't tell yet whether that went through. Press it again: it won't refund twice.", reason: "lost" }); return; }
    failed(out.fail);
  };

  // The whole sale, before it settles: a void. "Already settled" chains to a refund of all that is
  // left, as the old Refund button did; a bank payment still clearing says why it can't.
  const cancelWhole = async () => {
    const out = await ask({ action: "void_payment", paymentId: p.id });
    if (out.ok) { done(out.ok.voided || out.ok.already ? "Payment cancelled at the card network. The customer won't be charged." : "Done."); return; }
    if (out.lost) { setErr({ text: "We didn't hear back from the card network. Check the payment again in a minute before trying again.", reason: "lost" }); return; }
    const f = out.fail || {};
    if (f.settled && bankClearing) { setErr({ text: "This bank payment is still clearing. It can be refunded once it clears.", reason: "ach_pending" }); return; }
    if (f.settled) { await refund(left); return; }
    failed(f);
  };

  const submit = async () => {
    if (busy) return;
    if (!amountOk) { setErr({ text: `Enter an amount from $0.01 up to ${money(left)}.`, reason: "amount" }); return; }
    setBusy(true); setErr(null);
    try {
      if (viaNetwork && whole && !settledAlready) await cancelWhole();
      else await refund(cents);
    } finally {
      setBusy(false);
    }
  };
  const cancelInstead = async () => {
    if (busy) return;
    setBusy(true); setErr(null);
    try { await cancelWhole(); } finally { setBusy(false); }
  };

  const chip = (label, c) => (
    <button type="button" key={label} onClick={() => { setAmount((c / 100).toFixed(2)); setErr(null); }} data-ss-refund-chip={label}
      style={{ background: cents === c ? "#EEF2FF" : "#F8FAFC", color: cents === c ? "#3730A3" : "#475569", border: `1px solid ${cents === c ? "#C7D2FE" : "#E2E8F0"}`, borderRadius: 999, padding: "4px 10px", fontSize: 11.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>{label}</button>
  );
  const primary = !viaNetwork
    ? (amountOk ? `Record refund of ${money(cents)}` : "Record refund")
    : whole && !settledAlready ? "Cancel the whole payment"
      : amountOk ? `Refund ${money(cents)}` : "Refund";

  return (
    <div data-ss-refund-modal="1" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
      style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 1200 }}>
      <div role="dialog" aria-modal="true" aria-label="Refund payment"
        style={{ background: "#FFF", borderRadius: 14, maxWidth: 420, width: "100%", maxHeight: "calc(100vh - 32px)", overflowY: "auto", boxShadow: "0 24px 60px rgba(0,0,0,0.3)" }}>
        <div style={{ background: ACCENT, color: "#FFF", padding: "15px 18px", display: "flex", alignItems: "center", gap: 10, borderRadius: "14px 14px 0 0" }}>
          <div style={{ fontSize: 15.5, fontWeight: 800 }}>Refund {viaNetwork ? "this payment" : "a recorded payment"}</div>
          <button type="button" onClick={() => { if (!busy) onClose(); }} aria-label="Dismiss"
            style={{ marginLeft: "auto", background: "rgba(255,255,255,0.16)", border: "none", color: "#FFF", width: 26, height: 26, borderRadius: 7, cursor: "pointer", fontSize: 15, fontFamily: "inherit", lineHeight: 1 }}>×</button>
        </div>
        <div style={{ padding: "16px 18px" }}>
          <div style={{ fontSize: 12.5, color: "#475569", lineHeight: 1.5, marginBottom: 12 }}>
            {methodName}{card} · taken {fmtDate(p.received_at)} · {money(taken)}
            {taken !== left && <> · <b>{money(taken - left)}</b> refunded already</>}
            <br />
            <b style={{ color: "#1E293B" }}>{money(left)}</b> can still be refunded.
          </div>

          <label style={S.lbl} htmlFor="ss-refund-amount">Amount to refund</label>
          <input id="ss-refund-amount" data-ss-refund-amount="1" inputMode="decimal" value={amount} disabled={busy}
            onChange={(e) => { setAmount(e.target.value); setErr(null); }}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            style={{ ...S.input, fontSize: 16, fontVariantNumeric: "tabular-nums" }} />
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 7 }}>
            {chip(`All ${money(left)}`, left)}
            {refundOwedCents != null && refundOwedCents > 0 && refundOwedCents < left && chip(`Refund owed ${money(refundOwedCents)}`, refundOwedCents)}
          </div>
          {Number.isFinite(cents) && cents > left && (
            <div style={{ fontSize: 11.5, color: "#B45309", marginTop: 6 }}>That's more than the {money(left)} left on this payment.</div>
          )}

          {!viaNetwork && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 12 }}>
              <div>
                <label style={S.lbl} htmlFor="ss-refund-method">Paid back by</label>
                <select id="ss-refund-method" data-ss-refund-method="1" value={payBack} disabled={busy} onChange={(e) => setPayBack(e.target.value)} style={S.input}>
                  {PAY_METHODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
              <div>
                <label style={S.lbl} htmlFor="ss-refund-ref">Check # / note</label>
                <input id="ss-refund-ref" data-ss-refund-ref="1" value={reference} maxLength={200} disabled={busy} onChange={(e) => setReference(e.target.value)} style={S.input} placeholder="Optional" />
              </div>
            </div>
          )}

          <div style={{ fontSize: 11.5, color: "#64748B", lineHeight: 1.5, marginTop: 12 }}>
            {!viaNetwork
              ? "You give the money back yourself (cash, a check…). This records it, and the order's balance updates."
              : bankClearing
                ? "This bank payment is still clearing. Today it can only be cancelled whole; once it clears it can be refunded in part."
                : whole && !settledAlready
                  ? "This payment hasn't settled yet, so the whole of it is cancelled and the customer is never charged. A part of it can be refunded after it settles (overnight)."
                  : !settledAlready
                    ? "Card payments settle overnight. Until then only the whole payment can be cancelled, so a partial refund may be refused until tomorrow."
                    : "The customer gets this back on their card. It can't be undone from here."}
          </div>

          {err && (
            <div data-ss-refund-error={err.reason || "1"} style={{ ...S.err, marginTop: 12, marginBottom: 0 }}>
              {err.text}
              {err.reason === "not_settled" && !whole && viaNetwork && !bankClearing && (
                <div style={{ marginTop: 8 }}>
                  <button type="button" onClick={cancelInstead} disabled={busy} data-ss-refund-cancel-whole="1"
                    style={{ ...S.btn("#FFF", "#9F1239"), border: "1px solid #FECACA", padding: "6px 12px", fontSize: 12 }}>Cancel the whole {money(left)} instead</button>
                </div>
              )}
            </div>
          )}

          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <button type="button" onClick={() => { if (!busy) onClose(); }} disabled={busy}
              style={{ ...S.btn("#F1F5F9", "#334155"), flex: 1, border: "1px solid #E2E8F0" }}>Close</button>
            <button type="button" onClick={submit} disabled={busy || !amountOk || (err && err.reason === "refund_unconfirmed")} data-ss-refund-submit="1"
              style={{ ...S.btn("#BE123C", "#FFF"), flex: 2, opacity: busy || !amountOk || (err && err.reason === "refund_unconfirmed") ? 0.55 : 1 }}>
              {busy ? "Working…" : primary}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// `ordersOn` = may this person WRITE money on this order (orders:edit). It defaults to true
// for the reason spelled out on OrdersView: the shell does not pass it yet, and a false
// default would take Record-a-payment away from owners. `moneyReady` = has the payments read
// landed; while it is false `row.paid` is 0 and `balOf(row)` is the whole total, so every
// figure derived from them is a number this screen does not know yet.
function OrderDetail({ row, clientId, onBack, onChanged, stateOf, nameOf, bldgOf, balOf, onOpenDesign = null, coOn = false, coApproveOn = false, ordersOn = true, moneyReady = true }) {
  const { o, d } = row;
  const [payOpen, setPayOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("cash");
  const [reference, setReference] = useState("");
  const [when, setWhen] = useState(todayLocal);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [totalDraft, setTotalDraft] = useState(o.total_cents == null ? "" : (o.total_cents / 100).toFixed(2));
  const [editTotal, setEditTotal] = useState(o.total_cents == null);
  const bal = balOf(row); const st = stateOf(row);

  // ── Refunds (migration 349) ───────────────────────────────────────────────────────────
  // `refundFor` is the payment the Refund box is open on. `refunds` are this order's refunds, for
  // the lines under each payment. A database without the ledger, or a read that fails, shows none:
  // each payment's own figures (what is left, what was refunded) still say it.
  const [refundFor, setRefundFor] = useState(null);
  const [refunds, setRefunds] = useState([]);
  const [refundsKey, setRefundsKey] = useState(0);
  const refundAskedRef = useRef(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      const { data, error } = await sb.from("payment_refunds")
        .select("id, payment_id, amount_cents, kind, state, method, reference, created_at, completed_at")
        .eq("client_id", clientId).eq("order_id", o.id).order("created_at", { ascending: true });
      if (!alive) return;
      const list = error || !Array.isArray(data) ? [] : data;
      setRefunds(list);
      // A card-network refund we never heard back about, older than a refund can take: reconcile
      // asks the card network about it by its own order id (once per visit to this order), then
      // the money is read again if it settled.
      const stuck = list.some((r) => r.kind === "gateway" && (r.state === "pending" || r.state === "unknown")
        && Date.now() - Date.parse(r.created_at) > 3 * 60 * 1000);
      if (stuck && refundAskedRef.current !== o.id) {
        refundAskedRef.current = o.id;
        sb.functions.invoke("portal-payments", { body: { action: "reconcile", orderId: o.id } }).then(({ data: rd }) => {
          if (alive && rd && Array.isArray(rd.refunds) && rd.refunds.some((x) => x && x.state !== "open")) { onChanged(); setRefundsKey((k) => k + 1); }
        }, () => {});
      }
    })();
    return () => { alive = false; };
  }, [clientId, o.id, refundsKey, row.pays]);

  // ── Taking the payment, rather than recording one already taken (migration 174) ──────
  // This lives INSIDE the Record-a-payment modal on purpose. The method chips already say
  // cash / check / card / ach; picking a card or a bank account and then choosing "charge
  // it now" is the same sentence a builder says out loud. What it must never do is blur
  // the two: recording cannot fail in a way that costs money, and charging can, so the
  // choice is explicit and the confirmation text differs.
  const [collect, setCollect] = useState("recorded");   // "recorded" | "charge"
  const [entry, setEntry] = useState("keyed");          // "keyed" | "swipe"
  const [payOpts, setPayOpts] = useState(null);
  const [payToken, setPayToken] = useState(null);
  const payTokenRef = useRef(null);   // the token right now, for the read timer (see the message listener)
  payTokenRef.current = payToken;
  // When the CARD frame posted its token (Date.now()), for the age check in chargeCard. A bank
  // token is never stamped: it carries no CVV. See CARD_TOKEN_MAX_MS.
  const payTokenAtRef = useRef(0);
  // Part of the keyed card frame's key: bumped for a NEW, empty frame once its card is spent (too
  // old, or seen by the gateway). The reader's frame has armCount for the same job.
  const [cardGen, setCardGen] = useState(0);
  const [payExpiry, setPayExpiry] = useState(null);
  const [tokenErr, setTokenErr] = useState("");
  const [surcharge, setSurcharge] = useState(null);
  const [armed, setArmed] = useState(false);
  // Every arming REMOUNTS the reader's frame (armCount is its key), because the frame's own
  // autofocus is the only thing that puts focus in its card box, and it runs once per load. The
  // reader is said to be waiting only once that load is done (frameReady): a swipe that arrives
  // while the new frame is still loading is lost without a word.
  //
  // NO "READY" BUTTON (Carolyn 2026-10-20: "why do I have to press Ready?"). Choosing Card > Charge
  // it now > Swipe arms the reader by itself, and a refusal re-arms it 1.5 s later, at most
  // READER_AUTO_REARMS times in a row; then "Reset reader". A click on the reader box arms it too.
  const [armCount, setArmCount] = useState(0);
  const [frameReady, setFrameReady] = useState(false);
  const READER_AUTO_REARMS = 3;
  // A read in flight: the reader's frame said "typing" and has not answered yet. The modal can't be
  // closed meanwhile, or the rest of the read types into whatever is under it.
  const [reading, setReading] = useState(false);
  // Whether the reader's frame holds the page's focus (document.activeElement is the frame, in a
  // focused window). Polled while the reader is up: the frame's own box can't be seen across
  // origins, so this is the closest sign there is that the reader's keys will reach it.
  const [readerFocus, setReaderFocus] = useState(false);
  const [readerStuck, setReaderStuck] = useState(false);
  const rearmTimerRef = useRef(null);
  const rearmLeftRef = useRef(READER_AUTO_REARMS);
  // Set once the current frame has been seen holding the focus: proof that this browser lets the
  // frame take it without a click. Only then does the page re-arm by itself when focus wanders.
  const focusOkRef = useRef(false);
  // A reader burst that landed on the page while the reader is not what the modal shows (see the
  // burst guard): the sentence for it, under the amount box.
  const [readerHint, setReaderHint] = useState("");
  // The amount box was filled by the PAGE (on open, from pay_options, on picking Charge it now),
  // not by a person: the page may still replace it until someone types or picks a chip. What
  // someone typed is never replaced (Carolyn 2026-10-20: "it flips over").
  const amountAutoRef = useRef(true);
  const readTimerRef = useRef(null);   // the reader typed, no token yet: see the message listener
  const landTimerRef = useRef(null);   // the trap's "the burst is over" debounce
  // How many reader keys this attempt reached the PAGE instead of the card box (a count, never
  // the keys). 2026-10-20: two real swipes came back 1001 "manual" although the reader's output
  // ends like ID TECH's 02...03 swipe, which the frame accepts whole; a lost START would do that.
  const outsideKeysRef = useRef(0);
  // When this attempt was armed (`ready`: the name the filed rows have always used), its reader
  // frame loaded, and the reader's first key arrived (page or frame), in ms: a swipe started before
  // the frame has focus loses its start.
  const swipeTimesRef = useRef({ ready: 0, load: 0, firstKey: 0 });
  const swipeTiming = () => {
    const s = swipeTimesRef.current;
    return {
      readyToLoadMs: s.ready && s.load ? s.load - s.ready : null,
      loadToFirstKeyMs: s.load && s.firstKey ? s.firstKey - s.load : null,
    };
  };
  const noteFirstKey = () => { if (!swipeTimesRef.current.firstKey) swipeTimesRef.current.firstKey = Date.now(); };
  // A new attempt starts counting from nothing: an arming, the Swipe chip, closing the modal, and
  // each filed refusal (a second swipe into the same frame must not repeat the first one's numbers).
  const resetSwipeCounts = (ready = 0) => { outsideKeysRef.current = 0; swipeTimesRef.current = { ready, load: 0, firstKey: 0 }; };
  const endSwipeAttempt = () => { outsideKeysRef.current = 0; swipeTimesRef.current.firstKey = 0; };
  const stopReadTimer = () => { if (readTimerRef.current) { clearTimeout(readTimerRef.current); readTimerRef.current = null; } };
  // How long a read may take, from the reader's FIRST key, before the page says Fiserv refused it.
  // The frame says "typing" once per read and nothing at the end of one, so this window has to
  // hold the whole read: a key pressed before the swipe, the reader's own typing speed, the
  // frame's 2 s of quiet and CardSecure's answer. At 8 s a slow read was told "refused" while the
  // reader was still typing (2026-10-13). 20 s was still too short: the VP3350 measured 2026-10-30
  // types a tap for 15-16 s (about 1,060 keys, 40-110 a second), so the frame only sends at
  // 17-18 s and the answer lands near 19 s, and a slower tap was thrown away mid-answer. 40 s
  // leaves a whole second tap's worth of room.
  const READ_WAIT_MS = 40000;
  // ⚠️ A CARD TOKEN HOLDS THE CVV FOR 2 MINUTES, AND FOR ONE AUTH. Fiserv (CardPointe integrations),
  // 2026-10-14: the CVV stays linked to the CardSecure token for 2 minutes. Counted from the moment
  // the frame posts the token, on the wall clock, and treated as used up by the first auth, approved
  // or not. A builder keying a phone order often reads the card, then confirms the address with the
  // customer, and that can pass 2 minutes. So Charge checks the age first (100 s leaves the upload,
  // a cold start and the database writes inside the 2 minutes), and a charge the gateway saw
  // (newCardNeeded) asks for the card again. A swipe is held to the same limit: whether its track
  // data lasts longer is not known, and one more read costs little. Bank tokens are not
  // timed. scripts/preflight.mjs (checkCardTokenMaxAge) holds this equal to my-quotes.html's.
  const CARD_TOKEN_MAX_MS = 100000;
  // The bank rail's two boxes (see achTokenize). These two strings are the ONLY place the
  // numbers live: every way out of the modal empties them, and nothing copies them anywhere.
  const [achRouting, setAchRouting] = useState("");
  const [achAccount, setAchAccount] = useState("");
  const [achLeft, setAchLeft] = useState({});        // boxes the operator has moved on from, so a half-typed number isn't scolded mid-keystroke
  const [achChecking, setAchChecking] = useState(false);
  const [achRetry, setAchRetry] = useState(0);       // bumped to re-check unchanged numbers after a failed charge
  const clearAch = () => { setAchRouting(""); setAchAccount(""); setAchLeft({}); setAchChecking(false); };
  // Name on card, billing street and ZIP for a KEYED card (2026-10): the card's bank checks the
  // street and ZIP (AVS), and nothing sent them before. Prefilled from pay_options' billingPrefill
  // (the delivery address on the estimate) and editable, because the card may be billed somewhere
  // else. Hidden for a swipe (the card is present) and for a bank payment (the server names the
  // account holder from the estimate, as it always did).
  const [billName, setBillName] = useState("");
  const [billStreet, setBillStreet] = useState("");
  const [billZip, setBillZip] = useState("");
  const [billErr, setBillErr] = useState("");
  const frameRef = useRef(null);
  const modalRef = useRef(null);
  const chargeable = method === "card" || method === "ach";
  const keyedCard = method === "card" && entry === "keyed";
  // The server's ZIP rule (cpBillingFields): 5 digits, or ZIP+4.
  const billZipOk = /^\d{5}(-?\d{4})?$/.test(billZip.trim());
  const billProblem = !billName.trim() ? "Enter the name on the card."
    : !billStreet.trim() ? "Enter the card's billing street address."
    : !billZipOk ? "Enter the card's billing ZIP code (5 digits)." : "";

  // What CAN be charged is decided by the server, never here: the deposit-vs-balance rule,
  // the pending-ACH block and the signature gate all live in portal-payments. The browser
  // renders the answer and echoes the figure back.
  useEffect(() => {
    if (!payOpen) return;
    let alive = true;
    (async () => {
      const { data } = await sb.functions.invoke("portal-payments", {
        body: { action: "pay_options", orderId: o.id },
      });
      // A refusal (online payments not switched on for this account, which is a 503 with no
      // body to render) is an ANSWER, not a load still pending: say so, so the effect below
      // can tell "can't charge here" from "not asked yet".
      if (alive) setPayOpts(data || { canCharge: false });
    })();
    return () => { alive = false; };
  }, [payOpen, o.id]);
  // Closed, the answer goes too: OrderDetail stays mounted, and the next open would otherwise fill
  // the box from THIS answer (the deposit, or a balance since paid) before its own arrives, and
  // keep it when the new one says nothing can be charged (2026-10-23 promotion review).
  useEffect(() => { if (!payOpen) setPayOpts(null); }, [payOpen]);

  // Choosing Card or Bank lands on "Take it now", but only an account that CAN charge draws
  // the Already collected / Take it now toggle. Without it, landing on "charge" was a dead end:
  // a disabled Charge $0.00, no Record payment, and no way back — and on the bank rail, two
  // boxes asking for numbers nothing would use. So once the answer is "can't charge here", the
  // modal is a recording one, whichever chip was picked and whenever the answer arrived.
  useEffect(() => {
    if (payOpts && !payOpts.canCharge && collect === "charge") {
      setCollect("recorded"); setPayToken(null); setTokenErr(""); setArmed(false); clearAch();
    }
  }, [payOpts, collect]);

  // Each fresh pay_options answer prefills the billing fields. An older portal-payments sends no
  // billingPrefill, and an operator or a viewer is sent null: the fields then start empty.
  useEffect(() => {
    const p = (payOpts && payOpts.billingPrefill) || {};
    setBillName(p.name || ""); setBillStreet(p.street || ""); setBillZip(p.zip || ""); setBillErr("");
  }, [payOpts]);

  // ONE amount for both modes (2026-10-21). It opens on the order's balance; once pay_options says
  // what is due now (the deposit, or the balance), the box takes that figure, but only while the
  // page filled it: a figure someone typed, or a chip they picked, is never replaced. Charge it now
  // charges what is in the box, inside the balance; the server checks the same range.
  useEffect(() => {
    if (!payOpen || !payOpts || !payOpts.canCharge || !payOpts.askCents || !amountAutoRef.current) return;
    setAmount((payOpts.askCents / 100).toFixed(2));
  }, [payOpen, payOpts]);

  // The tokenizer hands the card back through postMessage. ⚠️ The origin test is the whole
  // security of this listener — without it any page that opens this one could post a forged
  // token. The origin comes from the SERVER (pay_options), so it can never be
  // attacker-chosen, and this repo is public so it could not be hardcoded anyway.
  useEffect(() => {
    if (!payOpen || collect !== "charge") return;
    const origin = payOpts && payOpts.tokenizer ? payOpts.tokenizer.origin : "";
    if (!origin) return;
    const onMsg = (e) => {
      if (e.origin !== origin) return;
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return;
      let m = null;
      try { m = JSON.parse(e.data); } catch (_e) { return; }
      // The reader's frame (sendcardtypingevent) posts {cardTyping:true} on the reader's first
      // character and {cardTyping:false} after a token; neither carries a token or an error, so
      // both fall through to the `!tok` return below. When Fiserv's card system refuses the read
      // (a reader keyed for the other system, a damaged stripe), the frame posts NOTHING else:
      // it only answers a 200. So "typing, then READ_WAIT_MS of silence" is the only sign there is.
      //   * Not while a token is held: after a token the frame says "typing" again on ANY key in
      //     its box (an Enter, a Shift), and the timer then threw a good card away.
      //   * Only for the frame that said it: a switch to Bank / ACH, or an arming that reloads the
      //     frame, leaves this timer behind, and it must not touch what is on screen by then.
      //   * Until it fires the page stays armed, and `reading` holds the modal open and keeps every
      //     re-arm away: one mid-read reloads the frame and throws the read away.
      if (m && m.cardTyping === true && entry === "swipe" && !payTokenRef.current) {
        noteFirstKey();
        stopReadTimer();
        setReading(true);
        const f = frameRef.current;
        readTimerRef.current = setTimeout(() => {
          readTimerRef.current = null;
          if (frameRef.current !== f || payTokenRef.current) return;
          setArmed(false); setReading(false);
          setTokenErr("That card didn't go through. Try it again, or key the card in.");
          // Filed too (warn), beside swipe_refused below: silence is what a reader keyed for the
          // other system looks like, so support needs the two told apart. No card data.
          if (window.ssLogError) window.ssLogError("portal", "A swipe got no answer from the card reader frame", "swipe_no_answer",
            { waitedMs: READ_WAIT_MS, keysOutsideFrame: outsideKeysRef.current, ...swipeTiming(), orderId: o.id }, "warn");
          endSwipeAttempt();
          rearmSoon();
        }, READ_WAIT_MS);
      }
      // Every answer below ends the swipe attempt: it disarms, and a refusal re-arms by itself
      // 1.5 s later (rearmSoon) so the next try needs no click.
      // A swipe's frame text is about typed numbers ("Invalid Account Number" for a half read),
      // so the reader gets its own sentence; the keyed form keeps the frame's own words.
      const swipeMiss = "The reader didn't get a clean read. Swipe, insert or tap the card again.";
      // ...but that sentence alone hid WHY the frame refused (2026-10-19, the first real VP3350
      // swipe of a Fiserv test card: a complete read, refused, and nothing to tell a half read
      // from a reader keyed for the live system). So a swipe refusal also shows CardPointe's own
      // code and words, and files them (warn) for support. Only the frame's answer travels: never
      // the swipe, the token or the card. The words are free text (CardSecure's after "NNNN::"),
      // so anything shaped like track data blanks them, and every run of 4+ digits (spaced or
      // dashed too) and of 12+ hex is cut, in case a frame ever echoes part of what it was given.
      // How to read the code: 1001 "Invalid Account Number" is the FRAME's own verdict (it did not
      // recognise the reader's output as a swipe; nothing reached CardSecure, so it says nothing
      // about the reader's keys); a 4-digit code with other words is CardSecure's answer.
      //
      // 1001 GETS A HINT (2026-10-21). This reader (MSR-to-chip fallback on, per its manual's DFEF62)
      // answers a swipe of any card whose stripe says "chip" with an "insert the card" code in front
      // of the read, and the frame then sees no swipe at all: 1001. Inserting is the fix.
      const swipeRefused = (kind, rawCode, rawWords) => {
        const str = (v) => (typeof v === "string" || typeof v === "number" ? String(v) : "");
        let said = str(rawWords);
        if (/[%^;=?*|]/.test(said)) said = "";
        said = said.replace(/[0-9A-Fa-f]{12,}/g, "…").replace(/\d(?:[\s-]?\d){3,}/g, "…").trim().slice(0, 120);
        const code = str(rawCode).replace(/[^0-9A-Za-z-]/g, "").slice(0, 12);
        const shown = [code ? "code " + code : "", said].filter(Boolean).join(", ");
        let frame = "";
        try { frame = new URL((payOpts && payOpts.tokenizer && payOpts.tokenizer.origin) || "").host; } catch (_e) { /* no origin */ }
        if (window.ssLogError) window.ssLogError("portal", "A swipe was refused by the card reader frame", "swipe_refused",
          { kind, errorCode: code || null, reason: said || null, entry: typeof m.entry === "string" ? m.entry.slice(0, 10) : null, frame, keysOutsideFrame: outsideKeysRef.current, ...swipeTiming(), orderId: o.id }, "warn");
        endSwipeAttempt();
        const hint = code === "1001" ? " If the card has a chip, insert it chip-first." : "";
        return (shown ? swipeMiss + " (CardPointe: " + shown + ")" : swipeMiss) + hint;
      };
      if (m && m.validationError) {
        stopReadTimer(); setPayToken(null); setArmed(false);
        if (entry === "swipe") { setReading(false); setTokenErr(swipeRefused("validation", m.errorCode, m.validationError)); rearmSoon(); }
        else setTokenErr(m.validationError);
        return;
      }
      // enhancedresponse: errorCode "0" means the token is real. Without this a failure is
      // indistinguishable from a strange token and the button would arm on nothing.
      if (m && m.errorCode && String(m.errorCode) !== "0") {
        stopReadTimer();
        setPayToken(null); setArmed(false);
        if (entry === "swipe") { setReading(false); setTokenErr(swipeRefused("error", m.errorCode, m.errorMessage)); rearmSoon(); }
        else setTokenErr(m.errorMessage || "That card wasn't accepted — check the number.");
        return;
      }
      const tok = m && (m.token || m.message);
      if (!tok) return;
      stopReadTimer();
      setReading(false);
      // swipeonly does nothing next to tokenizewheninactive, so a card number TYPED into the
      // reader's frame is tokenized too, as entry "manual". Charged as a swipe it would go out
      // with no ecomind and no billing address. enhancedresponse reports the entry on every token.
      // A chip read (ID TECH's DFEE25/DFEE26 output) is classed "swipe" by the frame, so it passes.
      if (entry === "swipe" && m.entry !== "swipe") {
        setPayToken(null); setArmed(false);
        setTokenErr("That was typed, not read by the card reader. Swipe, insert or tap the card.");
        rearmSoon();
        return;
      }
      payTokenAtRef.current = Date.now();
      // A card in hand ends the run of refusals: the next one gets its three re-arms again.
      rearmLeftRef.current = READER_AUTO_REARMS; setReaderStuck(false);
      setTokenErr(""); setPayExpiry(m.expiry || null); setPayToken(String(tok)); setArmed(false);
    };
    window.addEventListener("message", onMsg, false);
    return () => { window.removeEventListener("message", onMsg, false); stopReadTimer(); setReading(false); };
  }, [payOpen, collect, payOpts, entry, method]);

  // The bank rail has no iframe to post a token back: once BOTH boxes are valid, the numbers
  // are tokenized from here, two seconds after the last keystroke — the quiet the tokenizer's
  // own iframe waited (inactivityto=2000), since any 4+ digits looks like an account number and
  // a shorter pause would arm Charge on half of one. Any edit re-runs this effect, and its
  // cleanup drops an answer that arrives for numbers no longer on screen.
  useEffect(() => {
    if (!payOpen || collect !== "charge" || method !== "ach") return;
    const origin = payOpts && payOpts.tokenizer ? payOpts.tokenizer.origin : "";
    if (!origin || !achRoutingOk(achRouting) || !achAccountOk(achAccount)) return;
    let alive = true;
    setAchChecking(true);
    const t = setTimeout(async () => {
      const r = await achTokenize(origin, achRouting, achAccount);
      if (!alive) return;
      setAchChecking(false);
      if (r.token) { setTokenErr(""); setPayExpiry(null); setPayToken(r.token); }
      else { setPayToken(null); setTokenErr(r.error); }
    }, 2000);
    return () => { alive = false; clearTimeout(t); setAchChecking(false); };
  }, [payOpen, collect, method, payOpts, achRouting, achAccount, achRetry]);

  // An edit to either box: digits only, and the token goes FIRST — Charge must never stay
  // armed on numbers that are no longer the ones on screen. A keystroke that changes no DIGIT
  // (a space, a dash, the same number pasted again) is not an edit: the numbers are the ones
  // that were tokenized, and since they did not change the effect above would not re-run, so
  // clearing the token there left Charge dead with nothing on screen to say why.
  const editAch = (which, cur, set) => (e) => {
    const next = String(e.target.value || "").replace(/\D/g, "");
    if (next === cur) return;
    setPayToken(null); setTokenErr(""); setAchLeft((l) => ({ ...l, [which]: false }));
    set(next);
  };
  // Leaving a box names what is wrong with it; leaving one with both numbers valid and no token
  // (a dropped connection, or a charge the bank refused) simply checks them again.
  const leaveAch = (which) => {
    setAchLeft((l) => ({ ...l, [which]: true }));
    if (!payToken && !achChecking && achRoutingOk(achRouting) && achAccountOk(achAccount)) setAchRetry((n) => n + 1);
  };
  // What is wrong, in words — never the number itself.
  const achProblem = (() => {
    const r = achRouting, a = achAccount;
    if (r.length > 9 || (achLeft.routing && r.length > 0 && r.length < 9)) return "A routing number is 9 digits.";
    if (r.length === 9 && !achRoutingOk(r)) return "That routing number doesn't look right. Check it against the bottom of a check.";
    if (a.length > 17) return "A checking account number is 17 digits at most.";
    if (achLeft.account && a.length > 0 && a.length < 4) return "A checking account number is at least 4 digits.";
    return "";
  })();

  // Whether a surcharge applies cannot be known until the CARD is known — the card brands
  // forbid it on debit, so the same order is one price on one card and another on the next.
  // Probe once a token exists, and never let a failed probe block a payment. A keyed card's
  // billing ZIP goes with it (a fee can turn on where the card is billed), and a new ZIP asks again.
  //
  // ⚠️ CHARGE WAITS FOR THE ANSWER THAT MATCHES WHAT IT SENDS. Each answer is stored with the card
  // and ZIP it was for (`key`), and Charge stays on "Checking card fee…" until the answer on screen
  // is the one for the card and ZIP the charge will carry: the gateway adds the fee for THOSE, so
  // charging on an older answer could take a fee nobody saw. A failed probe, or one with no answer
  // in FEE_WAIT_MS, counts as "could not look it up" and releases Charge.
  const FEE_WAIT_MS = 8000;
  const probeZip = keyedCard && billZipOk ? billZip.trim().replace("-", "") : "";
  const feeKey = payToken && method === "card" ? `${payToken}|${probeZip}` : "";
  const probedTokenRef = useRef(null);
  useEffect(() => {
    if (!payToken || method !== "card") { setSurcharge(null); probedTokenRef.current = null; return; }
    let alive = true;
    const key = `${payToken}|${probeZip}`;
    // A new card asks at once; a changed ZIP waits for a 400 ms pause, so one typed toward a ZIP+4
    // is asked about once it settles rather than at every valid length on the way.
    const wait = probedTokenRef.current === payToken ? 400 : 0;
    probedTokenRef.current = payToken;
    const unknown = { applies: null, percent: null, key };
    const ask = setTimeout(async () => {
      let data = null;
      try {
        ({ data } = await sb.functions.invoke("portal-payments", {
          body: { action: "surcharge_probe", payToken, ...(probeZip ? { postal: probeZip } : {}) },
        }));
      } catch (_e) { /* answered as unknown below */ }
      if (alive) setSurcharge(data && !data.error ? { ...data, key } : unknown);
    }, wait);
    const giveUp = setTimeout(() => { if (alive) setSurcharge((s) => (s && s.key === key ? s : unknown)); }, wait + FEE_WAIT_MS);
    return () => { alive = false; clearTimeout(ask); clearTimeout(giveUp); };
  }, [payToken, method, probeZip]);
  const feeReady = !feeKey || !!(surcharge && surcharge.key === feeKey);

  // Card > Charge it now > Swipe, on an account that can take the card: the reader is what the
  // modal shows. The listeners and timers below read these through refs, so a key or a timer that
  // fires between renders sees the page as it is now.
  const swipeLive = payOpen && collect === "charge" && method === "card" && entry === "swipe"
    && !!(payOpts && payOpts.canCharge && payOpts.tokenizer);
  const swipeLiveRef = useRef(false);
  swipeLiveRef.current = swipeLive;
  const armedRef = useRef(false);
  armedRef.current = armed;
  const frameReadyRef = useRef(false);
  frameReadyRef.current = frameReady;
  // Set while the burst guard puts a box's old value back, so the amount box does not count that as
  // someone typing (amountAutoRef).
  const restoringRef = useRef(false);
  const isTextBox = (el) => !!el && (el.tagName === "TEXTAREA"
    || (el.tagName === "INPUT" && !/^(checkbox|radio|button|submit|reset|date|range|color|file)$/i.test(el.type || "")));

  // ⚠️ THE READER-BURST GUARD (2026-10-21). It replaces the focus trap that swallowed EVERY key on
  // the page while armed, which, with the reader now armed whenever it shows, would have made the
  // amount box untypeable. The VP3350 reader is a USB KEYBOARD: it types an encrypted blob into
  // whatever has focus, a character every ~1.2 ms, ending in two Enters. While the reader's frame
  // holds the focus, none of that reaches this document. A burst that DOES reach it missed the
  // frame: it would type into the amount box (autoFocus), or press a button with its Enter.
  // A person can't press READER_BURST_KEYS keys inside READER_BURST_WINDOW_MS (that is 80 keys a
  // second; a held key repeats at 30 at most), so that is the test; anything slower passes
  // untouched. On a burst the rest of it is swallowed, the box it began in gets its value from
  // before the burst back, the count (never the keys) is filed, and the reader is armed again.
  // Never echo, never buffer, never log those characters: they are card data.
  //   * Timed by the event's own timeStamp, when it arrived, not when it was handled: the first
  //     characters of a burst re-render the modal, and the keys queued behind that render are
  //     handled in a clump that says nothing about how fast they came.
  //   * A WINDOW, not "every gap under N ms": Windows stamps input on a coarse clock, and a key
  //     pressed on a 15.6 ms tick boundary would break a per-gap rule in the middle of a swipe.
  //   * Once recognised, the burst is followed BACK through keys under READER_KEY_GAP_MS apart to
  //     its first key, so the box gets back the value it had before ANY of it landed. Generous on
  //     purpose: the first characters of a burst each re-render the modal, and a slow machine spaces
  //     them out (a visible Chrome window did, 2026-10-21). Nobody types an amount and swipes a card
  //     inside 0.15 s, so a person's own typing is never part of it.
  //
  // ⚠️ NOTHING HERE FOCUSES THE FRAME (2026-10-13). iframe.focus() puts the frame's activeElement on
  // its BODY, not the card box, so a swipe vanished with no token, no error and no key on the page.
  // The frame focuses its own box (autofocus, on the reload every arming makes).
  const READER_BURST_KEYS = 4;
  const READER_BURST_WINDOW_MS = 50;
  const READER_KEY_GAP_MS = 150;
  useEffect(() => {
    if (!payOpen) return;
    // A real reader is a USB keyboard: each capital hex letter comes with its own Shift keydown.
    // Those are neither timed nor counted (only swallowed inside a burst), so the count is
    // characters. The names are compared, never kept.
    const MODIFIERS = ["Shift", "Control", "Alt", "Meta", "CapsLock"];
    // `recent`: the last few keys, each with its time, the box it went to and that box's value
    // BEFORE it (a value, compared and put back, never read for its content or kept past a burst).
    let recent = [], inBurst = false, burst = 0, burstFirstAt = 0, armedAtBurst = false;
    const restore = (s) => {
      // The native setter plus an input event, so React's onChange sees the old value come back.
      try {
        const proto = s.el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value").set.call(s.el, s.value);
        restoringRef.current = true;
        s.el.dispatchEvent(new Event("input", { bubbles: true }));
      } catch (_e) { /* the box is gone */ } finally { restoringRef.current = false; }
    };
    // One row per burst (warn): how many keys missed the reader's box, and whether it was armed.
    const endBurst = () => {
      landTimerRef.current = null;
      const keys = burst, firstAt = burstFirstAt;
      inBurst = false; burst = 0; burstFirstAt = 0; recent = [];
      const { ready, load } = swipeTimesRef.current;
      if (window.ssLogError) window.ssLogError("portal", "Reader keys reached the page, not the card box", "swipe_missed_frame",
        { keys, armed: armedAtBurst, readyToLoadMs: ready && load ? load - ready : null,
          loadToFirstKeyMs: load && firstAt ? firstAt - load : null,
          frameLoadedFirst: !!load && load <= firstAt, orderId: o.id }, "warn");
      if (swipeLiveRef.current && payTokenRef.current) {
        // A card is already read: it stays the one Charge takes. Dropping it for a read that missed
        // the reader would leave nothing to charge and no way to tell why.
        setTokenErr("Another card went to the page, not the card reader. To read a different card, choose Use another card.");
      } else if (swipeLiveRef.current) {
        setTokenErr("The card went to the page, not the card reader. Swipe, insert or tap it again.");
        armReader({ keepErr: true });
      } else {
        setReaderHint("That looked like the card reader. To take the card, choose Card, then Charge it now, then Swipe.");
      }
    };
    const onKey = (ev) => {
      if (MODIFIERS.includes(ev.key)) {
        if (inBurst) { ev.preventDefault(); ev.stopPropagation(); }
        return;
      }
      if (!inBurst) {
        const t = ev.timeStamp > 0 ? ev.timeStamp : performance.now();
        recent.push({ t, el: isTextBox(ev.target) ? ev.target : null, value: isTextBox(ev.target) ? ev.target.value : null });
        if (recent.length > 24) recent.shift();
        const last = recent.length - 1;
        if (recent.length < READER_BURST_KEYS || t - recent[last - READER_BURST_KEYS + 1].t > READER_BURST_WINDOW_MS) return;
        // A burst. Back to its first key; every key before this one is already on the page, so the
        // box that first key went to gets its value from before it back.
        let first = last - READER_BURST_KEYS + 1;
        while (first > 0 && recent[first].t - recent[first - 1].t <= READER_KEY_GAP_MS) first -= 1;
        inBurst = true; burstFirstAt = Date.now(); armedAtBurst = armedRef.current;
        burst = last - first; outsideKeysRef.current += last - first;
        noteFirstKey();
        if (recent[first].el) restore({ el: recent[first].el, value: recent[first].value });
        recent = [];
      }
      ev.preventDefault(); ev.stopPropagation();
      burst += 1; outsideKeysRef.current += 1;
      // The burst is over once the keys stop; the reader types its whole blob without a pause.
      if (landTimerRef.current) clearTimeout(landTimerRef.current);
      landTimerRef.current = setTimeout(endBurst, 400);
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (landTimerRef.current) { clearTimeout(landTimerRef.current); landTimerRef.current = null; }
    };
  }, [payOpen]);

  // An arming: a NEW reader frame (armCount is its key), whose autofocus puts the focus in its box,
  // and nothing left of the last read. `keepErr` keeps the sentence about the last try on screen.
  // `remount: false` arms the frame that is loading right now (just mounted, never loaded, so its
  // autofocus is still to come) instead of throwing it away for another.
  const armReader = ({ keepErr = false, remount = true } = {}) => {
    if (rearmTimerRef.current) { clearTimeout(rearmTimerRef.current); rearmTimerRef.current = null; }
    stopReadTimer();
    resetSwipeCounts(Date.now());
    focusOkRef.current = false;
    if (remount) { setArmCount((n) => n + 1); setFrameReady(false); }
    setReading(false);
    setPayToken(null); setPayExpiry(null);
    if (!keepErr) setTokenErr("");
    setArmed(true);
  };
  // After a refusal: the reader again in 1.5 s, with no click, at most READER_AUTO_REARMS times in
  // a row. Then "Reset reader": three refusals in a row is the card or the reader, and re-arming for
  // ever would only hide that.
  const rearmSoon = () => {
    if (rearmTimerRef.current) { clearTimeout(rearmTimerRef.current); rearmTimerRef.current = null; }
    if (rearmLeftRef.current <= 0) { setReaderStuck(true); return; }
    rearmLeftRef.current -= 1;
    rearmTimerRef.current = setTimeout(() => {
      rearmTimerRef.current = null;
      if (swipeLiveRef.current && !payTokenRef.current) armReader({ keepErr: true });
    }, 1500);
  };
  // A person asked for the reader (Reset reader, a click on its box): a fresh run of re-arms.
  const armReaderByHand = () => {
    rearmLeftRef.current = READER_AUTO_REARMS; setReaderStuck(false);
    armReader();
  };

  // Choosing Swipe arms the reader: no Ready press (Carolyn 2026-10-20). So does coming back to it
  // (Already collected, then Charge it now again), since a hidden frame has lost the focus and gets
  // a new one. A frame that has not loaded yet (the Swipe chip just mounted it) is armed as it is.
  useEffect(() => {
    if (!swipeLive) return;
    rearmLeftRef.current = READER_AUTO_REARMS; setReaderStuck(false);
    if (!payTokenRef.current) armReader({ remount: frameReadyRef.current });
    return () => { if (rearmTimerRef.current) { clearTimeout(rearmTimerRef.current); rearmTimerRef.current = null; } };
  }, [swipeLive]);

  // Where the focus is, while the reader shows. The frame's box can't be seen across origins, but the
  // frame ELEMENT is document.activeElement whenever the focus is anywhere inside it.
  //   * Focus that leaves the reader for a button or the bare page (a chip, the backdrop) is brought
  //     back with a fresh frame after 0.6 s. Never while someone is in a text box (they are typing),
  //     during a read, with a card in hand, or with a re-arm already on its way.
  //   * Only where this browser has let the CURRENT frame take the focus by itself (focusOkRef).
  //     Chrome may refuse a cross-origin frame the focus without a click; then the reader box says
  //     "Click here", and that click is the one the browser wants. Without this check a frame that
  //     never gets the focus would be reloaded every second, for ever.
  useEffect(() => {
    if (!swipeLive) { setReaderFocus(false); return; }
    let lostAt = 0;
    const tick = () => {
      const f = frameRef.current;
      const on = !!f && document.hasFocus() && document.activeElement === f;
      setReaderFocus(on);
      if (on) { focusOkRef.current = true; lostAt = 0; return; }
      const idle = armedRef.current && frameReadyRef.current && !payTokenRef.current && !readTimerRef.current && !rearmTimerRef.current;
      if (!idle || !focusOkRef.current || !document.hasFocus() || isTextBox(document.activeElement)) { lostAt = 0; return; }
      if (!lostAt) lostAt = Date.now();
      else if (Date.now() - lostAt >= 600) { lostAt = 0; armReader({ keepErr: true }); }
    };
    tick();
    const t = setInterval(tick, 250);
    return () => clearInterval(t);
  }, [swipeLive]);

  // What Charge takes: the amount box, held to the server's range (pay_options' minCents, the
  // balance, maxCents). portal-payments checks the same range again and charges this figure.
  const typedCents = centsFrom(amount);
  const canChargeHere = !!(payOpts && payOpts.canCharge);
  const owedNow = canChargeHere ? Number(payOpts.balanceCents) || 0 : 0;
  const chargeMost = canChargeHere ? Math.min(owedNow, Number(payOpts.maxCents) || owedNow) : 0;
  const chargeLeast = canChargeHere ? Number(payOpts.minCents) || 100 : 0;
  const amountProblem = !canChargeHere ? ""
    : !Number.isFinite(typedCents) ? "Enter the amount to charge."
    : typedCents < chargeLeast ? `The smallest payment is ${money(chargeLeast)}.`
    : typedCents > chargeMost
      ? (chargeMost === owedNow ? `That's more than the ${money(owedNow)} still owed.` : `A single payment can be at most ${money(chargeMost)}.`)
    : "";
  const chargeCents = canChargeHere && !amountProblem ? typedCents : 0;
  const feeCents = surcharge && surcharge.applies && surcharge.percent
    ? Math.round(chargeCents * (surcharge.percent / 100)) : 0;
  // CardSecure tokens keep the card number's last 4 digits, so the card can be named before it is
  // charged (Carolyn 2026-10-20: "**** **** **** 1234"). A card only; a bank token is not one.
  const cardLast4 = method === "card" && payToken ? ((/(\d{4})$/.exec(String(payToken)) || [])[1] || "") : "";
  // The box was typed in (or a chip picked): never refilled by the page after this.
  const typeAmount = (v) => { if (!restoringRef.current) amountAutoRef.current = false; setAmount(v); setReaderHint(""); };
  const pickAmount = (cents) => { amountAutoRef.current = false; setAmount((cents / 100).toFixed(2)); setReaderHint(""); };
  // Charge it now with an empty box: the figure due now (the deposit, or the balance). Never over
  // what is already there.
  const fillAmountForCharge = () => {
    if (String(amount).trim() || !canChargeHere || !payOpts.askCents) return;
    amountAutoRef.current = true; setAmount((payOpts.askCents / 100).toFixed(2));
  };

  const closePay = () => {
    setPayOpen(false); setCollect("recorded"); setPayToken(null); setPayExpiry(null);
    setTokenErr(""); setSurcharge(null); setArmed(false); setFrameReady(false); stopReadTimer(); setEntry("keyed"); clearAch();
    if (rearmTimerRef.current) { clearTimeout(rearmTimerRef.current); rearmTimerRef.current = null; }
    setReading(false); setReaderStuck(false); setReaderHint(""); amountAutoRef.current = true;
    resetSwipeCounts();
    setBillName(""); setBillStreet(""); setBillZip(""); setBillErr("");
  };

  // The card is spent, so the next Charge must carry a NEW one: a new, empty keyed frame (cardGen),
  // or for a swipe a new reader frame, armed. `why` is the sentence.
  const askForCardAgain = (why) => {
    setPayToken(null); setPayExpiry(null);
    if (entry !== "swipe") setCardGen((n) => n + 1);
    setTokenErr(why);
    if (entry === "swipe") armReader({ keepErr: true });
  };

  const chargeCard = async () => {
    if (!payToken) { setMsg({ err: "Enter the card details first." }); return; }
    // The button is off while the amount is out of range; this says why if it is pressed anyway.
    if (!chargeCents) { setMsg({ err: amountProblem || "There's nothing to charge on this order." }); return; }
    // Too old to still hold its CVV (CARD_TOKEN_MAX_MS): nothing is sent. Before the billing
    // check, which is not worth answering for a card that has to be entered again anyway.
    if (method === "card" && Date.now() - payTokenAtRef.current > CARD_TOKEN_MAX_MS) {
      askForCardAgain(entry === "swipe"
        ? "That card read has expired. Swipe, insert or tap the card again."
        : "The card details expired: the security code is only kept for 2 minutes. Key the card in again, then press Charge.");
      return;
    }
    // Required here, optional on the server: production's portal sends none of these yet.
    if (keyedCard && billProblem) { setBillErr(billProblem); return; }
    // The button is off until then (feeReady); this is the belt to that brace.
    if (!feeReady) return;
    setBusy(true); setMsg(null);
    const { data, error } = await sb.functions.invoke("portal-payments", {
      body: {
        action: "charge",
        orderId: o.id,
        rail: method === "ach" ? "ach" : "card",
        payToken,
        expiry: payExpiry || undefined,
        // A card only. The method chip resets `entry` to keyed on leaving Card, and this is the
        // second guard; the server ignores it off the card rail too. Before 2026-10-14 Card, then
        // Swipe, then Bank / ACH sent a bank payment marked "swipe" with no ecomind.
        ...(method === "card" ? { entry } : {}),
        // A keyed card only: a swipe carries its own name, and a bank payment's holder is named
        // by the server from the estimate.
        ...(keyedCard ? { name: billName.trim(), address: billStreet.trim(), postal: billZip.trim() } : {}),
        // The amount in the box (2026-10-21), and the echo that keeps two numbers provably
        // identical: what is on screen and what is charged. A server older than amountCents would
        // charge its own ask and refuse any other confirm, so it can't charge a figure nobody saw.
        amountCents: chargeCents,
        confirmChargeCents: chargeCents,
      },
    });
    setBusy(false);
    // The gateway SAW this card (a decline, or a partial approval that was voided), so its CVV is
    // spent and the same token, or a fresh one from the same filled-in frame, must not go again.
    // portal-payments says so with newCardNeeded; a 402 is the same thing from a server older than
    // that flag. A refusal before the gateway (409, 429, a business rule) does not carry it.
    const failed = (m, seen) => {
      // Said INSIDE the modal too (tokenErr): `msg` renders on the order behind the overlay,
      // so on its own the operator was left looking at a Charge button gone grey, no reason.
      setMsg({ err: m });
      if (method === "card" && seen) {
        askForCardAgain(`${m} ${entry === "swipe" ? "Swipe, insert or tap the card again." : "Key the card in again, then press Charge."}`);
        return;
      }
      setPayToken(null); setTokenErr(m);
      // The token is dropped, so the reader has to read the card again: get it ready for that.
      if (method === "card" && entry === "swipe") armReader({ keepErr: true });
    };
    if (error) {
      // A non-2xx from an edge function surfaces as a generic message; the real sentence —
      // the decline reason, or "do NOT try again" — is in the body.
      let m = "That payment didn't go through.";
      let seen = !!(error.context && error.context.status === 402);
      try { const ctx = await error.context.json(); if (ctx && ctx.error) m = ctx.error; if (ctx && ctx.newCardNeeded === true) seen = true; } catch (_e) {}
      failed(m, seen);
      return;
    }
    if (data && data.error) { failed(data.error, data.newCardNeeded === true); return; }
    closePay();
    setMsg({
      ok: data && data.pending
        ? `Bank payment submitted for ${money(data.amountCents)} — it clears in 2-3 business days.`
        : `Charged ${money(data.amountCents)}${data && data.last4 ? ` to the card ending ${data.last4}` : ""}.`,
    });
    onChanged();
  };

  // SS-mode orders (the design carries an SS quote) render the invoice-style order
  // document (migration 127), which needs the FULL design row (the list query stays
  // narrow), the signatures, the change orders, and the order_paperwork projection
  // (letterhead + colors + the service-role-only invoice_sends fields).
  const ssMode = !!(d && d.ss_quote_number);
  const [ssDoc, setSsDoc] = useState(null);
  const [ssReload, setSsReload] = useState(0);
  useEffect(() => {
    if (!ssMode || !o.short_code) return;
    let alive = true;
    (async () => {
      const [dRes, aRes, cRes, pRes, amRes] = await Promise.all([
        sb.functions.invoke("portal-settings", { body: { action: "orders_designs", shortCodes: [o.short_code], detail: true } })
          .then((r) => r.error ? { error: r.error, data: null } : { error: null, data: ((r.data && r.data.designs) || [])[0] || null }),
        // `revision` since migration 213: an amended order is signed AGAIN, so there is now
        // more than one subject='invoice' row and the highest revision is the one that
        // governs. Without the column the reader below picks whichever row came back first.
        // tax_rate / tax_amount / tax_jurisdiction / tax_source (migration 158) are the tax as the
        // customer agreed to it, frozen on the evidence row. The design's snapshot is the tax NOW,
        // and a change order or a re-stamp moves it — so "what they signed for" is read from here.
        sb.from("design_acceptances")
          .select("subject, revision, signer_name, accepted_at, total, method, recorded_by_name, tax_rate, tax_amount, tax_jurisdiction, tax_source")
          .eq("client_id", clientId).eq("short_code", o.short_code),
        sb.from("change_orders")
          .select("id, co_no, source, status, description, total_before_cents, total_after_cents, fee_cents, fee_tax_cents, raised_under, acknowledged_at")
          .eq("client_id", clientId).eq("short_code", o.short_code),
        sb.functions.invoke("portal-settings", { body: { action: "order_paperwork", shortCode: o.short_code } }),
        // Is this order open for change, under what authority, and what will it cost --
        // everything the Change Order button needs BEFORE it does anything. A read, gated at
        // change_orders:'view', so a rep who may not raise one is still shown why.
        sb.functions.invoke("portal-settings", { body: { action: "amendment_status", shortCode: o.short_code } }),
      ]);
      if (!alive) return;
      // A failed sub-read must NOT be coerced to "no data" — each coercion told its own
      // lie: designs failing left the card on "Loading the order…" forever (design:null
      // IS the loading sentinel), order_paperwork failing rendered "not yet invoiced"
      // plus a live "Create & send invoice" button on an order that may already be
      // awaiting signature (duplicate-send bait), and change_orders failing hid the
      // pending-CO invoice gate. Carry the first error on the payload instead; the
      // document card renders it with a Retry in place of the normal body.
      const loadError =
        dRes.error ? dRes.error.message
          : aRes.error ? aRes.error.message
            : cRes.error ? cRes.error.message
              : (pRes.data && pRes.data.error) ? pRes.data.error
                : pRes.error ? await fnError(pRes.error)
                  : null;
      if (!alive) return; // fnError awaits the response body — the unmount race reopens
      setSsDoc({
        error: loadError,
        design: dRes.data || null,
        acceptances: aRes.data || [],
        cos: cRes.data || [],
        paperwork: (pRes.data && !pRes.data.error) ? pRes.data : null,
        // Deliberately NOT folded into loadError. This read decides which BUTTON renders;
        // losing it should cost the amendment controls, not the whole order screen.
        amend: (amRes.data && !amRes.data.error) ? amRes.data : null,
      });
    })();
    return () => { alive = false; };
  }, [ssMode, o.short_code, clientId, ssReload]);
  const changedAll = () => { onChanged(); setSsReload((k) => k + 1); };
  // In-portal document viewer (Carolyn 2026-08-25: PDFs open in a popup, not another
  // tab). Browsers render PDFs (and images) natively in an iframe; the viewer's own
  // toolbar carries print/download, and an escape hatch opens the real tab.
  const [pdfView, setPdfView] = useState(null);   // { url, title } | null
  const ssDesign = ssDoc && ssDoc.design;
  const ssAcceptance = ssDoc && (ssDoc.acceptances || []).find((a) => a.subject === "quote");
  // Migration 136: the invoice carries its own acceptance row, and it is the signature
  // that closes the sale. The quote row above may be a click with no signature at all.
  //
  // THE HIGHEST REVISION GOVERNS (migration 213). An amended order is signed again — same
  // subject, revision = the change order's number — so `.find()` was returning whichever row
  // PostgREST happened to hand back first, which on a re-signed order is a coin toss between
  // the original signature and the current one. The table stays append-only; this is only
  // about which row is "the agreement" for display.
  const ssInvoiceAcceptance = ssDoc
    ? (ssDoc.acceptances || []).filter((a) => a.subject === "invoice")
        .sort((a, b) => (Number(b.revision) || 0) - (Number(a.revision) || 0)
          || String(b.accepted_at || "").localeCompare(String(a.accepted_at || "")))[0] || null
    : null;
  const ssInvoiceSigner = (ssInvoiceAcceptance && ssInvoiceAcceptance.signer_name) || "";
  const ssInvoice = ssDoc && ssDoc.paperwork && ssDoc.paperwork.invoice;

  const saveTotal = async () => {
    const cents = centsFrom(totalDraft);
    if (!Number.isFinite(cents) || cents <= 0) { setMsg({ err: "Enter a dollar amount, e.g. 9575.00" }); return; }
    setBusy(true); setMsg(null);
    const { error } = await sb.from("orders")
      .update({ total_cents: cents, total_source: "manual", updated_at: new Date().toISOString() }).eq("id", o.id);
    setBusy(false);
    if (error) { setMsg({ err: error.message }); return; }
    setEditTotal(false); onChanged();
  };

  const recordPayment = async () => {
    const cents = centsFrom(amount);
    if (!Number.isFinite(cents) || cents <= 0) { setMsg({ err: "Enter an amount greater than zero." }); return; }
    // The date input can be cleared to "" — new Date("T12:00:00") is Invalid, and
    // .toISOString() on it throws AFTER setBusy(true), wedging the button on
    // "Saving…" for the rest of the mount. Validate it up front like the amount.
    const received = new Date(when + "T12:00:00");
    if (!when || Number.isNaN(received.getTime())) { setMsg({ err: "Pick the date the payment was received." }); return; }
    setBusy(true); setMsg(null);
    let uid = null;
    try { const { data } = await sb.auth.getUser(); uid = data && data.user ? data.user.id : null; } catch (_e) {}
    const { error } = await sb.from("payments").insert({
      client_id: clientId, order_id: o.id, amount_cents: cents, method,
      reference: reference.trim() || null,
      received_at: received.toISOString(),
      created_by: uid,
    });
    setBusy(false);
    if (error) { setMsg({ err: error.message }); return; }
    // Everything closePay resets too (the Swipe choice, the reader's hint and stuck flag, the card),
    // so the next open starts clean (2026-10-23 promotion review), then this path's own.
    closePay(); setAmount(""); setReference(""); setMethod("cash");
    setMsg({ ok: "Payment recorded." });
    onChanged();
  };

  const voidPayment = async (p) => {
    if (!window.confirm(`Void this ${money(p.amount_cents)} payment? It stays in the history, marked voided.`)) return;
    const { error } = await sb.from("payments")
      .update({ voided_at: new Date().toISOString(), void_reason: "voided in portal" }).eq("id", p.id);
    if (error) { setMsg({ err: error.message }); return; }
    onChanged();
  };

  // A CardPointe payment cannot be voided from the browser — RLS refuses any update to a
  // row with a gateway, and rightly: the money is at the card network, and a local void
  // would leave the books saying one thing and the merchant account another. Its Refund opens
  // RefundModal, which asks the server to cancel or refund all or part of it; the row only
  // changes if the gateway agrees. (voidGatewayPayment's window.confirm lived here until 349.)
  const refundDone = (text) => {
    setRefundFor(null);
    setMsg({ ok: text });
    onChanged();
    setRefundsKey((k) => k + 1);
  };

  const unvoidPayment = async (p) => {
    const { error } = await sb.from("payments")
      .update({ voided_at: null, void_reason: null }).eq("id", p.id);
    if (error) { setMsg({ err: error.message }); return; }
    onChanged();
  };

  const kv = (k, v) => (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12.5, padding: "6px 0" }}>
      <span style={{ color: "#64748B" }}>{k}</span><span style={{ fontWeight: 700, textAlign: "right" }}>{v}</span>
    </div>
  );

  return (
    <div>
      <button type="button" onClick={onBack}
        style={{ background: "none", border: "none", color: ACCENT, fontSize: 12.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", padding: 0, marginBottom: 12 }}>← All orders</button>
      {msg && msg.err && <div style={S.err}>{msg.err}</div>}
      {msg && msg.ok && <div style={S.okMsg}>{msg.ok}</div>}
      {msg && msg.note && <div style={SS_TAX_NOTE_STYLE}>{msg.note}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.5fr) minmax(0,1fr)", gap: 14, alignItems: "start" }} className="ss-order-grid">
        <div>
          {ssMode ? (
            /* The invoice-style order document (migration 127) — letterhead, the priced
               lines with live roof/cladding/paint dropdowns, the amendment trail, and the
               action row. It replaces the old thin header card for SS orders. */
            <OrderDocumentCard clientId={clientId} o={o} st={st} doc={ssDoc} coOn={coOn} coApproveOn={coApproveOn}
              invoiceRequestedAt={(d && d.ss_invoice_requested_at) || null}
              busyExt={busy} onMsg={setMsg} onChanged={changedAll} onOpenDesign={onOpenDesign}
              onPreview={(url, title) => setPdfView({ url, title })}
              onRetry={() => { setSsDoc(null); setSsReload((k) => k + 1); }} />
          ) : (
            <div style={S.card}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 12 }}>
                <div>
                  <div style={S.h2}>Order #{o.order_no} · {nameOf(row)}</div>
                  <div style={{ fontSize: 12, color: "#64748B", marginTop: 3 }}>
                    Ordered {fmtDate(o.ordered_at)} · {bldgOf(row)}
                    {d && d.ghl_estimate_number ? ` · EST-${d.ghl_estimate_number}` : ""}
                  </div>
                  {/* THE BUILDING SERIAL (163). Carolyn, 2026-08-28 @59:25: "it'll be a serial
                      number. It's considered a serial number. They will literally write this
                      in the building. They can make tabs or something for the building."
                      Monospace and selectable because the whole job of this string is to be
                      copied onto a physical tag without a transcription error.

                      Since 316 it is issued when the order is created and frozen; absent means
                      no starting building number is set yet. */}
                  <div style={{ fontSize: 12, marginTop: 5 }}>
                    {o.building_serial ? (
                      <span title="This building's serial number — write this on the tag" style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontWeight: 700, letterSpacing: 0.5, color: "#0F172A", background: "#F1F5F9", border: "1px solid #E2E8F0", borderRadius: 6, padding: "3px 8px", userSelect: "all" }}>{o.building_serial}</span>
                    ) : (
                      <span style={{ color: "#94A3B8" }}>No serial yet — set your starting building number in Settings → Business Details.</span>
                    )}
                  </div>
                </div>
                <span style={{ marginLeft: "auto", background: st.bg, color: st.fg, borderRadius: 20, padding: "4px 12px", fontSize: 11.5, fontWeight: 700, whiteSpace: "nowrap" }}>{st.label}</span>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {d && d.image_url && (
                  <button type="button" onClick={() => setPdfView({ url: d.image_url, title: "Floor plan" })}
                    style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0", cursor: "pointer" }}>View floor plan (PDF)</button>
                )}
                {/* IN-PORTAL designer, never the public ?id= page (capture-lead/draft saves). */}
                {o.short_code && onOpenDesign && (
                  <a href={ssDesignHref(o.short_code)} onClick={ssNavClick(() => onOpenDesign(o.short_code))} data-ss-open-design="1"
                    style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0", cursor: "pointer", display: "inline-block", textDecoration: "none" }}>Open design</a>
                )}
              </div>
            </div>
          )}

          {/* SS-mode orders (the design carries an SS quote) get change orders. CRM-mode
              orders don't — the decision was SS-only (Carolyn 2026-08-23).
              coOn = the change_orders grant (2026-09-01): reps hold orders:edit so they can
              finalize the sale, but amending a signed agreement is handed out separately in
              Team settings.

              ⚠️ WHERE THE GATE ACTUALLY IS. This comment used to say "portal-settings refuses
              the three change-order actions on the same grant, so this is not the gate", and
              that was false for the three the card does itself: raising a CO, attesting a
              verbal acknowledgment and (until this change) voiding one all wrote
              `change_orders` straight over PostgREST and never reached an edge function at
              all. The real server gate is migration 188's restrictive change_orders_area_*
              policies, which put `change_orders = 'edit'` on INSERT and UPDATE where a
              browser tab cannot edit it out. Hiding the card stays the courtesy half. */}
          {ssMode && coOn && o.short_code && (
            <ChangeOrdersCard clientId={clientId} shortCode={o.short_code} orderId={o.id}
              currentTotalCents={o.total_cents} reloadKey={ssReload} onChanged={changedAll} />
          )}

          <div style={S.card}>
            <div style={{ ...S.h2, marginBottom: 8 }}>Payments</div>
            {/* "Nothing recorded yet." is a CLAIM, and `row.pays` is [] on every mount until
                the paged payments read lands — so a settled order announced that nobody had
                ever paid for it, then filled in. The skeleton says the same thing the header
                chip's "…" says. */}
            {!moneyReady ? (
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0" }}>
                <SkelBar w={26} h={26} style={{ borderRadius: "50%", flexShrink: 0 }} />
                <div style={{ flex: 1 }}>
                  <SkelBar w="38%" h={12} />
                  <SkelBar w="54%" h={9} style={{ marginTop: 6 }} />
                </div>
                <SkelBar w={68} h={12} style={{ flexShrink: 0 }} />
              </div>
            ) : row.pays.length === 0 ? (
              <p style={{ fontSize: 13, color: "#64748B", padding: "6px 0" }}>Nothing recorded yet.</p>
            ) : null}
            {row.pays.map((p) => {
              const dead = !!p.voided_at;
              // Refunds (migration 349): amount_cents is what is LEFT of the payment and refunded_cents
              // what went back, so the payment as taken is the two together. A payment refunded in
              // full reads amount 0 and voided; it shows the refunded figure, struck through, so the
              // row still says what was taken.
              const refundedC = Number(p.refunded_cents) || 0;
              const fullyRefunded = dead && refundedC > 0 && !(Number(p.amount_cents) > 0);
              const itsRefunds = refunds.filter((r) => r.payment_id === p.id && r.state !== "failed");
              const linkBtn = { background: "none", border: "none", color: "#94A3B8", cursor: "pointer", fontSize: 12, fontWeight: 700, fontFamily: "inherit", padding: 0 };
              return (
                <div key={p.id} data-ss-payment-row={p.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderBottom: "1px solid #F1F5F9", fontSize: 12.5, opacity: dead ? 0.65 : 1 }}>
                  <div style={{ width: 26, height: 26, borderRadius: "50%", background: dead ? "#F1F5F9" : "#DCFCE7", color: dead ? "#64748B" : "#166534", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    {dead
                      ? <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
                      : <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>}
                  </div>
                  <div>
                    <b style={{ textDecoration: dead ? "line-through" : "none" }}>{(PAY_METHODS.find((m) => m[0] === p.method) || [, p.method])[1]}</b>
                    {p.gateway === "ghl" && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.5, background: "#EDE9FE", color: "#5B21B6", borderRadius: 5, padding: "2px 6px" }}>Synergy/GHL</span>}
                    {p.gateway === "cardpointe" && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.5, background: "#DCFCE7", color: "#166534", borderRadius: 5, padding: "2px 6px" }}>Taken here</span>}
                    {p.funding_state === "pending" && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.5, background: "#FEF3C7", color: "#92400E", borderRadius: 5, padding: "2px 6px" }}>Clearing</span>}
                    {p.funding_state === "returned" && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.5, background: "#FFE4E6", color: "#9F1239", borderRadius: 5, padding: "2px 6px" }}>Returned</span>}
                    {dead && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.5, background: "#F1F5F9", color: "#64748B", borderRadius: 5, padding: "2px 6px" }}>{fullyRefunded ? "Refunded" : "Voided"}</span>}
                    {!dead && refundedC > 0 && <span data-ss-part-refunded="1" style={{ marginLeft: 6, fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.5, background: "#FFEDD5", color: "#9A3412", borderRadius: 5, padding: "2px 6px" }}>Part refunded</span>}
                    <div style={{ fontSize: 11, color: "#94A3B8" }}>
                      {fmtDate(p.received_at)}
                      {p.instrument_last4 ? ` · ••${p.instrument_last4}` : (p.reference ? ` · ${p.reference}` : "")}
                      {p.funding_state === "pending" ? " · clears in 2-3 business days" : ""}
                      {dead ? ` · ${fullyRefunded ? "refunded" : "voided"} ${fmtDate(p.voided_at)}` : ""}
                      {!dead && refundedC > 0 ? ` · ${money(refundedC)} of ${money(Number(p.amount_cents) + refundedC)} refunded` : ""}
                    </div>
                    {itsRefunds.map((r) => (
                      <div key={r.id} data-ss-refund-line={r.state} style={{ fontSize: 11, color: r.state === "done" ? "#9A3412" : "#B45309" }}>
                        ↩ {money(r.amount_cents)}
                        {r.state === "done"
                          ? ` refunded${r.kind === "manual" && r.method ? ` by ${((PAY_METHODS.find((m) => m[0] === r.method) || [, r.method])[1] || "").toLowerCase()}` : ""} · ${fmtDate(r.completed_at || r.created_at)}${r.reference ? ` · ${r.reference}` : ""}`
                          : " · checking with the card network…"}
                      </div>
                    ))}
                  </div>
                  <div style={{ marginLeft: "auto", fontWeight: 800, fontVariantNumeric: "tabular-nums", textDecoration: dead ? "line-through" : "none", color: dead || p.funding_state === "pending" ? "#94A3B8" : "#1E293B" }}>{money(fullyRefunded ? refundedC : p.amount_cents)}</div>
                  {/* GHL-imported payments stay read-only — GHL owns them, and a local void
                      would silently come back (or diverge) on the next sync. A CardPointe
                      payment is different: the money is at the card network, so voiding it
                      HAS to go through the edge function, which only marks the row voided
                      if the gateway agrees. (RLS enforces the same thing from below — the
                      browser cannot update a row where gateway IS NOT NULL.)

                      Void/Restore is a direct payments UPDATE, so it needs orders:edit —
                      without it the click returns the RLS refusal migration 188 installs,
                      rendered as a red banner. A viewer sees the payment and no control.
                      Refund goes through portal-payments, gated orders:edit the same way.

                      Refund (349) opens RefundModal on any live payment taken here or recorded
                      by hand. A payment refunded in full has nothing to restore (the database
                      refuses a zero payment back to life), so it shows no control. */}
                  {!ordersOn
                    ? <span title="You have view-only access to Orders" style={{ color: "#CBD5E1", fontSize: 12, fontWeight: 700 }}>—</span>
                    : p.gateway === "cardpointe"
                    ? (dead
                      ? <span title="Already reversed at the card network" style={{ color: "#CBD5E1", fontSize: 12, fontWeight: 700 }}>—</span>
                      : <button type="button" onClick={() => setRefundFor(p)} title="Cancel or refund all or part of this at the card network" data-ss-refund-open={p.id}
                          style={linkBtn}>Refund</button>)
                    : p.gateway
                    ? <span title="Recorded in Synergy/GHL — manage it there" style={{ color: "#CBD5E1", fontSize: 12, fontWeight: 700 }}>—</span>
                    : dead
                    ? (fullyRefunded
                      ? <span title="Refunded in full" style={{ color: "#CBD5E1", fontSize: 12, fontWeight: 700 }}>—</span>
                      : <button type="button" onClick={() => unvoidPayment(p)} title="Restore this payment" style={linkBtn}>Restore</button>)
                    : <span style={{ display: "inline-flex", gap: 10, flexShrink: 0 }}>
                        <button type="button" onClick={() => setRefundFor(p)} title="Record a refund of all or part of this payment" data-ss-refund-open={p.id} style={linkBtn}>Refund</button>
                        <button type="button" onClick={() => voidPayment(p)} title="Void this payment (it was never really taken)" style={linkBtn}>Void</button>
                      </span>}
                </div>
              );
            })}
            {refundFor && (
              <RefundModal p={refundFor} refundOwedCents={moneyReady && bal != null && bal < 0 ? -bal : null}
                onClose={() => setRefundFor(null)} onDone={refundDone} />
            )}
          </div>
        </div>

        <div>
          <div style={{ background: "linear-gradient(135deg, #3D3672 0%, #1B7895 100%)", color: "#FFF", borderRadius: 12, padding: "16px 18px", marginBottom: 14 }}>
            {/* ⏳ EVERY FIGURE IN THIS BLOCK IS PAID-DERIVED except the total. `row.paid` is 0
                and `bal` is therefore the whole total until the payments read lands, so a
                settled order painted "Balance due $84,000" and "$0.00 of $84,000 collected"
                for the length of that read and then corrected itself. The first number is the
                one someone reads out loud — the pale block is the honest one. */}
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6, color: "#CFE0EC" }}>{moneyReady && bal != null && bal < 0 ? "Refund owed" : "Balance due"}</div>
            <div style={{ fontSize: 29, fontWeight: 800, margin: "4px 0 2px", fontVariantNumeric: "tabular-nums", letterSpacing: -0.7 }}>
              {!moneyReady
                ? <SkelBar w={148} h={25} style={{ background: "rgba(255,255,255,0.26)", margin: "4px 0" }} />
                : bal == null ? "—" : bal < 0 ? money(-bal) : money(bal)}
            </div>
            <div style={{ fontSize: 11.5, color: "#D6E4F0" }}>
              {o.total_cents == null
                ? (ssMode ? "The total arrives when the customer signs the estimate" : "Set this order's total to track a balance")
                : !moneyReady
                  ? <SkelBar w={168} h={10} style={{ background: "rgba(255,255,255,0.22)", margin: "2px 0" }} />
                  : `${money(row.paid)} of ${money(o.total_cents)} collected`}
            </div>
            {ssMode && o.total_cents != null && (
              <div style={{ borderTop: "1px solid rgba(255,255,255,0.22)", marginTop: 10, paddingTop: 6 }}>
                {[
                  ["Total", money(o.total_cents)],
                  ["Paid", moneyReady ? money(row.paid) : <SkelBar w={72} h={10} style={{ background: "rgba(255,255,255,0.26)", display: "inline-block", verticalAlign: "middle" }} />],
                  ["Balance", !moneyReady ? <SkelBar w={72} h={10} style={{ background: "rgba(255,255,255,0.26)", display: "inline-block", verticalAlign: "middle" }} /> : bal == null ? "—" : money(bal)],
                ].map(([k, v]) => (
                  <div key={k} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "3px 0", color: "#D6E4F0" }}>
                    <span>{k}</span><span style={{ fontWeight: 700, color: "#FFF", fontVariantNumeric: "tabular-nums" }}>{v}</span>
                  </div>
                ))}
                <div style={{ fontSize: 10.5, color: "#B9CFE0", marginTop: 4, lineHeight: 1.45 }}>
                  Set by the accepted estimate and acknowledged change orders — no hand editing.
                </div>
              </div>
            )}
            {/* Two conditions, and neither is cosmetic.
                ordersOn — recording a payment INSERTs into `payments`, which fires
                  inventory_claim_on_payment and marks the linked unit sold. Migration 188
                  refuses that below orders:edit; this is the button not being there.
                moneyReady — DISABLED, not merely un-prefilled. The Balance beside it is
                  wrong until the payments read lands, so an empty amount box would still
                  invite someone to type a figure against a number that is about to change. */}
            {o.total_cents != null && ordersOn && (
              <button type="button" disabled={!moneyReady}
                title={moneyReady ? undefined : "Reading this order's payments…"}
                onClick={() => { amountAutoRef.current = true; setPayOpen(true); setAmount(bal > 0 ? (bal / 100).toFixed(2) : ""); }}
                style={{ ...S.btn("#75E6DA", "#22345B"), marginTop: 13, opacity: moneyReady ? 1 : 0.55, cursor: moneyReady ? "pointer" : "not-allowed" }}>Record a payment</button>
            )}
          </div>

          {/* SS orders derive their total (accept → CO acks → invoice); the hand-typed
              editor stays ONLY for design-less manual orders (Carolyn 2026-08-24).

              `ordersOn` decides whether the EDITOR appears, never whether the card does: the
              figures are the point of the Orders tab and a viewer keeps them. Typing a total
              is an orders UPDATE, which migration 188 puts behind orders:edit — and note that
              `editTotal` starts TRUE on an order with no total, so without this test a driver
              opening a manual order would land straight in an input box that cannot save. */}
          {!ssMode && (
            <div style={S.card}>
              <div style={{ ...S.h2, marginBottom: 8 }}>Order total</div>
              {editTotal && ordersOn ? (
                <>
                  <span style={S.lbl}>Total (from your estimate)</span>
                  <input style={S.input} value={totalDraft} onChange={(e) => setTotalDraft(e.target.value)} placeholder="9575.00" />
                  <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                    <button onClick={saveTotal} disabled={busy} style={{ ...S.btn(ACCENT, "#FFF"), opacity: busy ? 0.6 : 1 }}>{busy ? "Saving…" : "Save total"}</button>
                    {o.total_cents != null && <button onClick={() => { setEditTotal(false); setTotalDraft((o.total_cents / 100).toFixed(2)); }} style={S.btn("#F1F5F9", "#334155")}>Cancel</button>}
                  </div>
                  <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 8, lineHeight: 1.5 }}>
                    Totals fill in automatically from the accepted estimate. Type one here if it hasn't come through yet — your number always wins.
                  </div>
                </>
              ) : (
                <>
                  {kv("Total", money(o.total_cents))}
                  {kv("Paid", moneyReady ? money(row.paid) : <SkelBar w={72} h={10} style={{ display: "inline-block", verticalAlign: "middle" }} />)}
                  {kv("Balance", !moneyReady ? <SkelBar w={72} h={10} style={{ display: "inline-block", verticalAlign: "middle" }} /> : bal == null ? "—" : money(bal))}
                  <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 6 }}>
                    {o.total_source === "ghl" ? "From the accepted estimate" : o.total_source === "manual" ? "Entered by you" : "Not set yet"}
                    {ordersOn && <>{" · "}<button type="button" onClick={() => setEditTotal(true)} style={{ background: "none", border: "none", color: ACCENT, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", fontSize: 11, padding: 0 }}>Edit</button></>}
                  </div>
                </>
              )}
            </div>
          )}

          {/* THE DOCUMENT SECTION ARRIVES SECOND, AND SAYS SO. Everything above renders
              from the row the list already had; this needs `ssDoc` — four table reads plus
              an edge function. It used to be simply ABSENT until they all resolved, so the
              page grew by two cards under the reader's cursor. Reserving the shape is the
              "load at segments" half of what Carolyn asked for (36:09): the layout settles
              once, then fills in. */}
          {ssMode && !ssDoc && (
            <div style={{ ...S.card, padding: 12 }}>
              <SkelBar w="34%" h={11} />
              <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 10, marginTop: 10 }}>
                <SkelBar w="100%" h={280} style={{ borderRadius: 8 }} />
                <SkelBar w="100%" h={280} style={{ borderRadius: 8, opacity: 0.8 }} />
              </div>
            </div>
          )}

          {/* Floor plan + 3D as IMAGES, side by side in one card (Carolyn 2026-08-25).
              Thumbnails, not posters: capped height, natural aspect; the click opens the
              full-size plan/picture. Saved by the designer on every submit; older designs
              without one fall back to the plan PDF link. */}
          {ssMode && ssDesign && (
            <div style={{ ...S.card, padding: 12 }}>
              <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 10 }}>
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0 2px 6px" }}>
                    <span style={{ fontSize: 10.5, fontWeight: 700, color: "#94A3B8", letterSpacing: 0.5, textTransform: "uppercase" }}>Floor plan</span>
                    {ssDesign.image_url && (
                      <button type="button" onClick={() => setPdfView({ url: ssDesign.image_url, title: "Floor plan" })}
                        style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: 10.5, color: ACCENT, fontWeight: 700, fontFamily: "inherit" }}>Full ↗</button>
                    )}
                  </div>
                  {/* Both frames match at 280 tall (Carolyn 2026-08-25); clicks open the
                      in-portal viewer popup, never another tab. */}
                  {ssDesign.plan_image_url
                    ? <ThumbFrame src={ssDesign.plan_image_url} alt="Floor plan" title="Open the full plan"
                        onOpen={() => setPdfView({ url: ssDesign.image_url || ssDesign.plan_image_url, title: "Floor plan" })} />
                    : <div style={{ display: "flex", alignItems: "center", background: "#F8FAFC", border: "1px dashed #E2E8F0", borderRadius: 8, padding: 8, height: 280 }}>
                        <p style={{ fontSize: 11, color: "#94A3B8", lineHeight: 1.45 }}>Appears after the next estimate submit{ssDesign.image_url ? " — the PDF has it today" : ""}.</p>
                      </div>}
                </div>
                <div>
                  <div style={{ padding: "0 2px 6px" }}>
                    <span style={{ fontSize: 10.5, fontWeight: 700, color: "#94A3B8", letterSpacing: 0.5, textTransform: "uppercase" }}>3D view</span>
                  </div>
                  {ssDesign.view3d_image_url
                    ? <ThumbFrame src={ssDesign.view3d_image_url} alt="3D view" title="Open the 3D picture"
                        onOpen={() => setPdfView({ url: ssDesign.view3d_image_url, title: "3D view" })} />
                    : <div style={{ display: "flex", alignItems: "center", background: "#F8FAFC", border: "1px dashed #E2E8F0", borderRadius: 8, padding: 8, height: 280 }}>
                        <p style={{ fontSize: 11, color: "#94A3B8", lineHeight: 1.45 }}>Open the design, click 🧊 3D View, then resubmit to capture one.</p>
                      </div>}
                </div>
              </div>
            </div>
          )}

          <div style={S.card}>
            <div style={{ ...S.h2, marginBottom: 8 }}>Customer</div>
            {kv("Name", nameOf(row))}
            {kv("Phone", (d && d.contact && d.contact.phone) || "—")}
            {kv("Email", (d && d.contact && d.contact.email) || "—")}
            {ssMode && ssDesign && ssDesign.contact && (() => {
              const c = ssDesign.contact || {};
              const line2 = [c.city, c.state].filter(Boolean).join(", ") + (c.zip ? ` ${c.zip}` : "");
              const addr = [c.street, line2].filter((s) => s && String(s).trim()).join(", ");
              return (
                <>
                  {kv("Address", addr || "—")}
                  {ssInvoiceAcceptance
                    ? kv("Signed", `${fmtDate(ssInvoiceAcceptance.accepted_at)} · ${ssInvoiceAcceptance.signer_name || ""}`)
                    : ssAcceptance && (ssAcceptance.method === "rep"
                        ? kv("Invoice authorised", `${fmtDate(ssAcceptance.accepted_at)} · by ${ssAcceptance.recorded_by_name || "your team"}`)
                        : kv("Accepted", `${fmtDate(ssAcceptance.accepted_at)} · ${ssAcceptance.signer_name || ""}`))}
                  {addr && (
                    <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr)}`} target="_blank" rel="noopener"
                      style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0", textDecoration: "none", display: "block", textAlign: "center", marginTop: 8, fontSize: 12 }}>
                      📍 View property
                    </a>
                  )}
                </>
              );
            })()}
          </div>

          {ssMode && ssDesign && (
            <div style={S.card}>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: "#94A3B8", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 6 }}>Paper trail</div>
              {kv("Estimate", `${ssDesign.ss_quote_number}${ssDesign.ss_quote_sent_at ? ` · sent ${fmtDate(ssDesign.ss_quote_sent_at)}` : " · not emailed"}`)}
              {ssAcceptance && ssAcceptance.method === "rep"
                ? kv("Invoice authorised", `${fmtDate(ssAcceptance.accepted_at)} · by ${ssAcceptance.recorded_by_name || "your team"}`)
                : kv("Accepted", ssAcceptance ? fmtDate(ssAcceptance.accepted_at) : "not yet")}
              {/* The tax they agreed to, off the frozen evidence columns. The signed invoice
                  governs once there is one (the highest revision, as above); before that, the
                  quote acceptance. Absent when neither row carries tax. */}
              {(() => {
                const gov = ssInvoiceAcceptance && ssInvoiceAcceptance.tax_amount != null ? ssInvoiceAcceptance : ssAcceptance;
                const txt = ssSignedTaxText(gov);
                return txt ? kv(gov === ssInvoiceAcceptance ? "Tax signed" : "Tax accepted", txt.replace(/^incl\. /, "")) : null;
              })()}
              {kv("Change orders", (() => {
                const cs = (ssDoc && ssDoc.cos) || [];
                const acked = cs.filter((c) => c.status === "acknowledged").length;
                const pend = cs.filter((c) => c.status === "pending_ack").length;
                if (!cs.length) return "none";
                return `${acked} acknowledged${pend ? ` · ${pend} pending` : ""}`;
              })())}
              {kv("Invoice", ssInvoice && ssInvoice.invoice_number
                ? `${ssInvoice.invoice_number} · ${fmtDate(ssInvoice.updated_at || ssInvoice.created_at)}`
                : "not yet issued")}
              {/* The signature that actually closes the sale now lives on the invoice. */}
              {kv("Invoice signed", ssInvoice && ssInvoice.signed_at
                ? `${fmtDate(ssInvoice.signed_at)}${ssInvoiceSigner ? ` · ${ssInvoiceSigner}` : ""}`
                : (ssInvoice ? "awaiting the customer" : "not yet"))}
            </div>
          )}
        </div>
      </div>

      {/* ⚠️ PdfModal (01-core), NOT a private copy of it. This screen frames four URLs and one
          of them — designs.image_url — is written VERBATIM by the anon-granted save_design
          RPC (104), so a hostile caller can stash any address against a tenant's design and
          this modal framed it inside the authenticated portal, behind a button the owner has
          every reason to trust. 01-core's component runs both the iframe src and the "open in
          a new tab" href through ssSafeUrl (https on our own origin or our own Supabase
          storage host) and renders a refusal instead of a viewer when the URL is neither —
          the guard 02-sales and the designer already had, which this local copy predated and
          never received. Behaviour otherwise matches: same pop-up-never-a-tab rule, same
          escape hatch, plus Escape-to-close and the counted body scroll lock. Both server
          PDFs (ss_quote_pdf_url, invoice_pdf_url) live on the Supabase storage host, which
          ssSafeUrl admits. */}
      {pdfView && <PdfModal url={pdfView.url} title={pdfView.title} onClose={() => setPdfView(null)} />}

      {payOpen && ordersOn && (
        <div onClick={(e) => { if (reading) return; if (e.target === e.currentTarget) closePay(); }}
          style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.5)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, zIndex: 1200 }}>
{/* Scrolls inside itself (2026-10-12): with the card form plus the billing name, street and
              ZIP (2026-10-09) the box is taller than a laptop screen, and the centred, fixed backdrop
              clipped its foot, so the Charge button could not be reached. */}
          <div ref={modalRef} style={{ background: "#FFF", borderRadius: 14, maxWidth: 430, width: "100%", boxShadow: "0 24px 60px rgba(0,0,0,0.3)", overflowX: "hidden", overflowY: "auto", maxHeight: "calc(100vh - 40px)" }}>
            <div style={{ background: ACCENT, color: "#FFF", padding: "15px 18px", display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ fontSize: 15.5, fontWeight: 800 }}>{collect === "charge" ? "Take a payment" : "Record a payment"}</div>
              <button type="button" onClick={closePay} disabled={reading}
                style={{ marginLeft: "auto", background: "rgba(255,255,255,0.16)", border: "none", color: "#FFF", width: 26, height: 26, borderRadius: 7, cursor: reading ? "not-allowed" : "pointer", fontSize: 15, fontFamily: "inherit", lineHeight: 1, opacity: reading ? 0.4 : 1 }}>×</button>
            </div>
            <div style={{ padding: "17px 18px" }}>
              <span style={S.lbl}>Amount</span>
              {/* ONE box for both modes, typeable at any time (Carolyn 2026-10-20). Charge it now
                  takes what is in it, from $1 up to the balance; the server holds the same range
                  and charges exactly this figure. The page fills it (the balance, then the deposit
                  pay_options names) only until someone types or picks a chip. */}
              <input data-ss-amount="1" style={{ ...S.input, fontSize: 20, fontWeight: 800 }} value={amount}
                onChange={(e) => typeAmount(e.target.value)} placeholder="0.00" inputMode="decimal" autoComplete="off" autoFocus
                // Leaving the box with the reader showing and no card read: the reader gets the
                // focus back (a fresh frame), so the next swipe reaches it. Not when the whole window
                // lost the focus (another app): the browser hands it back to this box on return.
                onBlur={(e) => { if (swipeLive && !payToken && !reading && document.hasFocus() && !isTextBox(e.relatedTarget)) armReader({ keepErr: true }); }} />
              {(() => {
                // The chips use the server's figures where it gave them (the balance it will hold the
                // charge to), and the order's own balance otherwise.
                const full = canChargeHere ? owedNow : bal;
                if (!(full > 0)) return null;
                const chip = (label, cents, key) => (
                  <button key={key} type="button" onClick={() => pickAmount(cents)}
                    style={{ ...S.btn("#F1F5F9", "#334155"), padding: "4px 10px", fontSize: 11, border: "1px solid #E2E8F0" }}>{label}</button>
                );
                return (
                  <div style={{ display: "flex", gap: 6, marginTop: 7, flexWrap: "wrap" }}>
                    {canChargeHere && payOpts.askKind === "deposit" && payOpts.askCents > 0 && payOpts.askCents < full
                      && chip(`Deposit ${money(payOpts.askCents)}`, payOpts.askCents, "dep")}
                    {chip("Full balance", full, "full")}
                    {chip("Half", Math.round(full / 2), "half")}
                  </div>
                );
              })()}
              {collect === "charge" && amountProblem && (
                <div data-ss-amount-problem="1" style={{ fontSize: 11.5, color: "#B91C1C", marginTop: 7 }}>{amountProblem}</div>
              )}
              {readerHint && <div style={{ fontSize: 11.5, color: "#92400E", marginTop: 7 }}>{readerHint}</div>}
              <div style={{ marginTop: 13 }}><span style={S.lbl}>Method</span>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {PAY_METHODS.map(([id, label]) => (
                    <button key={id} type="button" onClick={() => {
                      setMethod(id);
                      // Choosing Card or Bank INSIDE a payment modal almost always means
                      // "take it now". Landing on Already collected made every card sale a
                      // two-click job and delayed the tokenizer load to the worst moment.
                      // This moves the TOGGLE only — nothing is charged until details are
                      // entered and Charge is pressed, and Already collected is one click away.
                      // Not where the server has already said this account can't charge: there
                      // is no toggle back from "charge" (see the effect beside pay_options).
                      const toCharge = (id === "card" || id === "ach") && !(payOpts && !payOpts.canCharge);
                      setCollect(toCharge ? "charge" : "recorded");
                      // Charge it now keeps the amount in the box; only an EMPTY box gets the figure
                      // due now. It used to swap any typed amount for the server's ask.
                      if (toCharge) fillAmountForCharge();
                      setPayToken(null); setTokenErr(""); setArmed(false); stopReadTimer(); clearAch(); setReaderHint("");
                      // Swipe is a card's choice: leaving Card drops it, so Card again starts on
                      // Key it in, and nothing else can carry a stale "swipe" (see chargeCard).
                      if (id !== "card") setEntry("keyed");
                    }}
                      style={{ flex: "1 1 auto", background: method === id ? "#EDE9FE" : "#F8FAFC", border: `1.5px solid ${method === id ? ACCENT : "#E2E8F0"}`, color: method === id ? ACCENT : "#475569", fontSize: 12, fontWeight: 700, borderRadius: 8, padding: "9px 6px", cursor: "pointer", fontFamily: "inherit" }}>{label}</button>
                  ))}
                </div>
              </div>
              {/* The fork, and it only appears where it can mean anything. Cash and a
                  cheque can only ever be recorded; a card or a bank account can be either
                  already collected elsewhere (a terminal, a phone call) or taken right
                  here. Making it an explicit choice is what keeps the two apart — one
                  cannot fail in a way that costs money and the other can. */}
              {chargeable && payOpts && payOpts.canCharge && (
                <div style={{ marginTop: 13 }}>
                  <span style={S.lbl}>{method === "ach" ? "Bank payment" : "Card"}</span>
                  <div style={{ display: "flex", gap: 6 }}>
                    {[["recorded", "Already collected"], ["charge", method === "ach" ? "Take it now" : "Charge it now"]].map(([id, label]) => (
                      <button key={id} type="button" onClick={() => { setCollect(id); if (id === "charge") fillAmountForCharge(); setPayToken(null); setTokenErr(""); setArmed(false); stopReadTimer(); clearAch(); }}
                        style={{ flex: 1, background: collect === id ? "#ECFDF5" : "#F8FAFC", border: `1.5px solid ${collect === id ? "#059669" : "#E2E8F0"}`, color: collect === id ? "#047857" : "#475569", fontSize: 12, fontWeight: 700, borderRadius: 8, padding: "9px 6px", cursor: "pointer", fontFamily: "inherit" }}>{label}</button>
                    ))}
                  </div>
                </div>
              )}
              {chargeable && payOpts && !payOpts.canCharge && payOpts.message && (
                <div style={{ marginTop: 10, fontSize: 11.5, color: "#92400E", background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 8, padding: "8px 11px" }}>
                  {payOpts.message} You can still record a payment taken elsewhere.
                </div>
              )}

              {/* BOTH branches render; the inactive one is hidden rather than unmounted.
                  That keeps the tokenizer iframe MOUNTED AND LOADING while the operator is
                  still reading the modal — unmounting it meant the cross-origin round trip
                  to CardPointe only began when "Charge it now" was pressed, which is the one
                  moment somebody is actually waiting on it. */}
              <div style={{ marginTop: 13, display: collect === "charge" ? "block" : "none" }}>
                  {method === "card" && (
                    <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                      {[["keyed", "Key it in"], ["swipe", "Swipe"]].map(([id, label]) => (
                        // The one already chosen does nothing: it reloads no frame, so dropping the
                        // arm (or the card) there left the reader typing into this button, unheard.
                        // Swipe arms itself once chosen (the effect beside armReader).
                        <button key={id} type="button" onClick={() => { if (entry === id) return; setEntry(id); setPayToken(null); setPayExpiry(null); setTokenErr(""); setArmed(false); setReading(false); setFrameReady(false); stopReadTimer(); resetSwipeCounts(); }}
                          style={{ flex: 1, background: entry === id ? "#EDE9FE" : "#F8FAFC", border: `1.5px solid ${entry === id ? ACCENT : "#E2E8F0"}`, color: entry === id ? ACCENT : "#475569", fontSize: 12, fontWeight: 700, borderRadius: 8, padding: "8px 6px", cursor: "pointer", fontFamily: "inherit" }}>{label}</button>
                      ))}
                    </div>
                  )}
                  {method !== "ach" && <span style={S.lbl}>{entry === "swipe" ? "Card reader" : "Card details"}</span>}
                  {/* The tokenizer URL is composed SERVER-SIDE and never appears in this
                      file: the repo is public, and it puts the test/production switch in a
                      secret rather than in code a customer can download. Card only: the
                      bank rail is the two boxes below, and with no iframe mounted the
                      message listener's frameRef test refuses anything posted meanwhile. */}
                  {method !== "ach" && payOpts && payOpts.tokenizer && (
                    <div style={{ position: "relative" }}>
                    <iframe
                      // A new key per arming is a NEW frame: an empty box (a failed read left
                      // its characters in the old one, and the next swipe was appended), and the
                      // frame's autofocus runs again. See armCount. The keyed frame's
                      // cardGen does the same once its card is spent (see CARD_TOKEN_MAX_MS): the
                      // new frame is empty, so the next token has to carry a freshly typed CVV.
                      key={entry === "swipe" ? "swipe-" + armCount : "card-" + cardGen}
                      ref={frameRef}
                      title="Payment details"
                      src={entry === "swipe" ? payOpts.tokenizer.swipeUrl : payOpts.tokenizer.cardUrl}
                      onLoad={() => { if (entry === "swipe" && !swipeTimesRef.current.load) swipeTimesRef.current.load = Date.now(); setFrameReady(true); }}
                      // Height is SERVED (cpTokenizerHeight) so this modal and my-quotes.html
                      // cannot drift. Too short is a dead form, not a cosmetic issue: at the
                      // original 128px the CVV sat below the fold of a non-scrolling frame. The
                      // reader's frame is one box (swipeHeight; an older server sends none).
                      style={{ width: "100%", display: "block", height: ((entry === "swipe" && payOpts.tokenizer.swipeHeight) || payOpts.tokenizer.cardHeight || 265), border: "1px solid #E2E8F0", borderRadius: 8, background: "#FFF" }}
                      frameBorder="0" scrolling="no"
                    />
                    {/* ⚠️ The reader's frame takes no click of its own. A click anywhere in it but
                        ON its box leaves the frame's focus on its BODY, where a swipe vanishes:
                        no token, no message, and no key reaches the page (2026-10-13). So a click
                        there arms the reader instead: a new frame, whose autofocus puts the focus
                        in the box. Ignored while that frame is still loading, during a read, and
                        with a card in hand (the panel's "Use another card" drops one on purpose).
                        Transparent: the frame stays in view, and its text is white (cpTokenizerUrl's
                        swipe css), so what the reader types never shows. */}
                    {entry === "swipe" && (
                      <div aria-hidden="true" data-ss-reader-cover="1"
                        onClick={() => { if (busy || reading || payToken || (armed && !frameReady)) return; armReaderByHand(); }}
                        style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0, cursor: payToken ? "default" : "pointer", background: "transparent" }} />
                    )}
                    </div>
                  )}
                  {keyedCard && payOpts && payOpts.tokenizer && (
                    // Name on card, billing street and ZIP: prefilled from the delivery address
                    // (billingPrefill), editable. autoComplete off: this is the BUILDER's browser,
                    // and what it would offer is the builder's own name and address.
                    <div data-ss-billing="1" style={{ marginTop: 10 }}>
                      <label style={{ display: "block" }}>
                        <span style={S.lbl}>Name on card</span>
                        <input style={S.input} value={billName} maxLength={60} autoComplete="off" spellCheck={false}
                          onChange={(e) => { setBillName(e.target.value); setBillErr(""); }} />
                      </label>
                      <label style={{ display: "block", marginTop: 10 }}>
                        <span style={S.lbl}>Billing street address</span>
                        <input style={S.input} value={billStreet} maxLength={60} autoComplete="off"
                          onChange={(e) => { setBillStreet(e.target.value); setBillErr(""); }} />
                      </label>
                      <label style={{ display: "block", marginTop: 10 }}>
                        <span style={S.lbl}>Billing ZIP code</span>
                        <input style={S.input} value={billZip} maxLength={10} inputMode="numeric" autoComplete="off"
                          onChange={(e) => { setBillZip(e.target.value); setBillErr(""); }} />
                      </label>
                      <div style={{ fontSize: 11, color: "#64748B", marginTop: 6, lineHeight: 1.45 }}>
                        {payOpts.billingPrefill && (payOpts.billingPrefill.street || payOpts.billingPrefill.zip)
                          ? "Filled in from the delivery address. Change it if the card is billed somewhere else."
                          : "Where the card's statement goes. The card's bank checks the street and ZIP."}
                      </div>
                      {billErr && <div style={{ fontSize: 11.5, color: "#B91C1C", marginTop: 7 }}>{billErr}</div>}
                    </div>
                  )}
                  {method === "ach" && payOpts && payOpts.canCharge && payOpts.tokenizer && (
                    // Routing and Checking as two boxes (Carolyn, 2026-09-02). Digits only, no
                    // autofill, nothing remembered — see achTokenize at the top of this file.
                    // Gated like the card iframe: an account that cannot charge is never asked
                    // for bank numbers it has no way to use.
                    <div>
                      <label style={{ display: "block" }}>
                        <span style={S.lbl}>Routing number</span>
                        <input style={S.input} value={achRouting} onChange={editAch("routing", achRouting, setAchRouting)} onBlur={() => leaveAch("routing")}
                          inputMode="numeric" pattern="[0-9]*" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} />
                      </label>
                      <label style={{ display: "block", marginTop: 10 }}>
                        <span style={S.lbl}>Checking account number</span>
                        <input style={S.input} value={achAccount} onChange={editAch("account", achAccount, setAchAccount)} onBlur={() => leaveAch("account")}
                          inputMode="numeric" pattern="[0-9]*" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} />
                      </label>
                      <div style={{ fontSize: 11, color: "#64748B", marginTop: 6, lineHeight: 1.45 }}>
                        Find both at the bottom of a check. Bank payments take 2-3 business days to clear.
                      </div>
                      {achProblem && <div style={{ fontSize: 11.5, color: "#B91C1C", marginTop: 7 }}>{achProblem}</div>}
                      {achChecking && !payToken && <div style={{ fontSize: 11.5, color: "#475569", marginTop: 7 }}>Checking the bank details…</div>}
                    </div>
                  )}
                  {method === "card" && entry === "swipe" && (() => {
                    // THE READER, IN WORDS, where the "Ready to swipe" button was (Carolyn 2026-10-20:
                    // no Ready press, never the reader's raw output, "**** **** **** 1234" once read).
                    // The frame above shows nothing a person can read: its text is white.
                    const st = payToken ? "card" : reading ? "reading" : readerStuck ? "stuck"
                      : !armed ? "between" : !frameReady ? "loading" : readerFocus ? "waiting" : "click";
                    const box = { marginTop: 8, border: "1px solid #E2E8F0", borderRadius: 8, padding: "11px 12px", fontSize: 12.5, fontWeight: 700, display: "flex", alignItems: "center", gap: 9, lineHeight: 1.4 };
                    const spinner = (
                      // SMIL, not a CSS keyframe: the portal has no stylesheet (see SkelBar).
                      <svg viewBox="0 0 24 24" width="16" height="16" style={{ flexShrink: 0 }} aria-hidden="true">
                        <circle cx="12" cy="12" r="9" fill="none" stroke="#CBD5E1" strokeWidth="3" />
                        <path d="M12 3a9 9 0 0 1 9 9" fill="none" stroke={ACCENT} strokeWidth="3" strokeLinecap="round">
                          <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.8s" repeatCount="indefinite" />
                        </path>
                      </svg>
                    );
                    const link = { background: "none", border: "none", padding: 0, color: ACCENT, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", textDecoration: "underline" };
                    if (st === "card") return (
                      <div data-ss-reader-state={st} style={{ ...box, background: "#ECFDF5", borderColor: "#A7F3D0", color: "#065F46", justifyContent: "space-between" }}>
                        <span>
                          <span style={{ fontSize: 16, letterSpacing: 1.5, fontFamily: "ui-monospace,Consolas,monospace" }}>{cardLast4 ? "**** **** **** " + cardLast4 : "Card read"}</span>
                          <span style={{ marginLeft: 8 }}>✓</span>
                        </span>
                        <button type="button" style={link} disabled={busy} onClick={armReaderByHand}>Use another card</button>
                      </div>
                    );
                    if (st === "reading") return (
                      <div data-ss-reader-state={st} style={{ ...box, background: "#F5F3FF", borderColor: "#DDD6FE", color: ACCENT }}>{spinner}Reading card…</div>
                    );
                    if (st === "stuck") return (
                      <div data-ss-reader-state={st} style={{ ...box, background: "#FFFBEB", borderColor: "#FDE68A", color: "#92400E", flexWrap: "wrap" }}>
                        <span style={{ flex: "1 1 200px" }}>The reader didn't take the card {READER_AUTO_REARMS + 1} times in a row. Check the card, or choose Key it in.</span>
                        <button type="button" onClick={armReaderByHand} style={{ ...S.btn("#FFF", "#92400E"), border: "1px solid #FDE68A", fontSize: 12, padding: "6px 12px" }}>Reset reader</button>
                      </div>
                    );
                    if (st === "between" || st === "loading") return (
                      <div data-ss-reader-state={st} style={{ ...box, color: "#475569" }}>{spinner}Getting the card reader ready…</div>
                    );
                    if (st === "click") return (
                      // The frame doesn't have the focus (a click elsewhere, or a browser that won't
                      // hand a frame the focus by itself): this click arms it, and counts as the
                      // click the browser wants.
                      <button type="button" data-ss-reader-state={st} onClick={armReaderByHand}
                        style={{ ...box, width: "100%", background: "#FFF7ED", borderColor: "#FED7AA", color: "#9A3412", cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
                        Click here, then swipe, insert or tap the card
                      </button>
                    );
                    return (
                      <div data-ss-reader-state={st} style={{ ...box, background: "#F0FDF4", borderColor: "#BBF7D0", color: "#166534" }}>
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#16A34A" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M3 10h18" /></svg>
                        Waiting for card — swipe, insert or tap
                      </div>
                    );
                  })()}
                  {tokenErr && <div data-ss-token-err="1" style={{ fontSize: 11.5, color: "#B91C1C", marginTop: 7 }}>{tokenErr}</div>}
                  {payToken && !tokenErr && !(method === "card" && entry === "swipe") && (
                    <div style={{ fontSize: 11.5, color: "#047857", marginTop: 7, fontWeight: 700 }}>
                      {method === "ach" ? "Bank details captured ✓" : `Card captured ✓${cardLast4 ? ` (**** ${cardLast4})` : ""}`}
                    </div>
                  )}
                  {/* Fiserv adds the surcharge itself and reports it back, so this is a
                      display of THEIR answer, never our arithmetic. It cannot be known
                      before the card is: the brands forbid surcharging debit. */}
                  {surcharge && surcharge.applies === true && feeCents > 0 && (
                    <div style={{ marginTop: 10, fontSize: 12, background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 8, padding: "9px 11px", color: "#92400E" }}>
                      A {surcharge.percent}% card fee applies to this card — the customer will be charged{" "}
                      <strong>{money(chargeCents + feeCents)}</strong>. {money(chargeCents)} goes to the balance.
                    </div>
                  )}
                  {surcharge && surcharge.applies === false && (
                    <div style={{ marginTop: 10, fontSize: 11.5, color: "#475569" }}>No card fee on this card.</div>
                  )}
              </div>
              <div style={{ display: collect === "charge" ? "none" : "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 13 }}>
                <div><span style={S.lbl}>Received on</span><input type="date" style={S.input} value={when} onChange={(e) => setWhen(e.target.value)} /></div>
                <div><span style={S.lbl}>Reference</span><input style={S.input} value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Check # / note" /></div>
              </div>

              <div style={{ display: "flex", gap: 8, alignItems: "flex-start", background: collect === "charge" ? "#ECFDF5" : "#F8FAFC", border: `1px solid ${collect === "charge" ? "#A7F3D0" : "#E2E8F0"}`, borderRadius: 8, padding: "9px 11px", fontSize: 11.5, color: collect === "charge" ? "#065F46" : "#475569", lineHeight: 1.45, marginTop: 12 }}>
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke={collect === "charge" ? "#059669" : "#64748B"} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}><circle cx="12" cy="12" r="9"/><path d="M12 8v5l3 2"/></svg>
                <div>
                  {collect === "charge"
                    ? (method === "ach"
                      ? "This debits the customer's bank account now. It won't count toward the balance until it clears."
                      : "This charges the customer's card now, for real.")
                    : "You're recording money you already collected — no card is charged here. To take a card now, choose Card or ACH above."}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 15 }}>
                {collect === "charge" ? (
                  <button data-ss-charge="1" onClick={chargeCard} disabled={busy || !payToken || !feeReady || !chargeCents} style={{ ...S.btn("#059669", "#FFF"), flex: 1, opacity: busy || !payToken || !feeReady || !chargeCents ? 0.55 : 1 }}>
                    {busy ? "Charging…" : !feeReady ? "Checking card fee…" : `Charge ${money(chargeCents + feeCents)}${cardLast4 ? ` to **** ${cardLast4}` : ""}`}
                  </button>
                ) : (
                  <button onClick={recordPayment} disabled={busy} style={{ ...S.btn("#059669", "#FFF"), flex: 1, opacity: busy ? 0.6 : 1 }}>{busy ? "Saving…" : "Record payment"}</button>
                )}
                <button onClick={closePay} disabled={reading} style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0", opacity: reading ? 0.5 : 1 }}>Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


// ─── Inventory tab (migration 075) ───
// One row per PHYSICAL building on a sales lot. The master design behind a unit is a
// designs row with status='inventory' (excluded from Designs/Contacts and from the GHL
// sync). All reads/writes go through portal-settings, so operator view-as works via the
// sb.functions targetClientId injection and writes get the server-side can_write gate.
const invMoney = (cents) => cents == null ? "—" :
  "$" + (cents / 100).toLocaleString(undefined, { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 });
// Estimate statuses that mean a customer has committed. Still used to spot which of a
// building's estimates is the buyer, and to warn on the others — but NOT to decide sold-ness
// any more: that is stored now (see invSold above the fold).
const INV_SOLD_EST = new Set(["accepted", "invoiced", "delivered"]);
// ── The Online Shop (migration 310, Carolyn 2026-10-17) ────────────────────────────────────
// Builders list lot buildings on a public, branded page (shop.html) their own website can embed.
// Brittney Weis (Midwest Mini Barns' marketer) asked for this on the 2026-10-12 call in place of
// a Shopify store, including the option NOT to show prices — so price is per building AND
// shop-wide. Every write goes through portal-settings; nothing here touches a schedule or a sale.
// The page and embed are served by whichever host the builder is on: beta previews beta, the app
// previews the app. A hard-coded production host showed "page not found" from beta until a
// promotion carried shop.html there (2026-10-17).
const shopPublicOrigin = () => (/^https:\/\/(app|beta)\.structurestudiosuite\.com$/.test(window.location.origin)
  ? window.location.origin : "https://app.structurestudiosuite.com");

// A person's public booking page, in THE SHORT FORM (Carolyn 2026-11-01: "Do we have to have
// these meeting links sooo long?"). `/book/<client>/<host>` says exactly what
// `?client=&with=` said, 12 characters shorter, and reads like an address rather than a
// query string. book.html takes either, and everything already sent — confirmations,
// calendar invites, builders' own sites — carries the query form, so this changes what we
// HAND OUT and never what resolves. One helper because two screens offer this link and a
// second copy of the shape is how they drift.
const ssBookUrl = (clientId, slug) =>
  `${shopPublicOrigin()}/book/${encodeURIComponent(clientId)}/${encodeURIComponent(slug)}`;

function ShopSettingsPanel({ clientId, canEdit }) {
  const [s, setS] = useState(null);
  const [paymentsLive, setPaymentsLive] = useState(false);
  const [msg, setMsg] = useState(null);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(null);
  useEffect(() => {
    let live = true;
    (async () => {
      const { data, error } = await sb.functions.invoke("portal-settings", { body: { action: "shop_settings" } });
      if (!live) return;
      if (error || !data || data.error) { setMsg({ err: (data && data.error) || (error ? await fnError(error) : "Could not load your shop settings.") }); return; }
      setS(data.settings); setPaymentsLive(!!data.paymentsLive);
    })();
    return () => { live = false; };
  }, [clientId]);
  if (!s) return msg && msg.err ? <div style={S.err}>{msg.err}</div> : <div style={{ fontSize: 13, color: "#94A3B8", padding: 8 }}>Loading shop settings…</div>;
  const set = (k, v) => setS((x) => ({ ...x, [k]: v }));
  const save = async () => {
    setSaving(true); setMsg(null);
    const { data, error } = await sb.functions.invoke("portal-settings", { body: { action: "save_shop_settings", settings: s } });
    setSaving(false);
    if (error || !data || data.error) { setMsg({ err: (data && data.error) || (error ? await fnError(error) : "That didn't save.") }); return; }
    setMsg({ ok: s.enabled ? "Saved. Your Online Inventory is live." : "Saved. Your Online Inventory is switched off." });
  };
  const shopUrl = `${shopPublicOrigin()}/shop?client=${encodeURIComponent(clientId)}`;
  const embed = `<div data-ss-shop="${clientId}"></div>\n<script src="${shopPublicOrigin()}/shop-embed.js" async></script>`;
  const copy = async (what, text) => {
    try { await navigator.clipboard.writeText(text); setCopied(what); setTimeout(() => setCopied(null), 1600); } catch (_e) { window.prompt("Copy this:", text); }
  };
  const lbl = { fontSize: 12, fontWeight: 700, color: "#334155", display: "block", marginBottom: 4 };
  const row = { display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 12 };
  const check = (k, text, hint) => (
    <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13, color: "#334155", marginBottom: 8, cursor: canEdit ? "pointer" : "default" }}>
      <input type="checkbox" checked={!!s[k]} disabled={!canEdit} onChange={(e) => set(k, e.target.checked)} style={{ marginTop: 2 }} />
      <span><strong>{text}</strong>{hint ? <span style={{ color: "#64748B" }}> — {hint}</span> : null}</span>
    </label>
  );
  return (
    <div style={{ background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 12, padding: "14px 16px", marginBottom: 14 }}>
      {check("enabled", "Online Inventory is live", "show buildings marked “List online” on your public page")}
      {check("hideAllPrices", "Hide all prices", "every building shows “Call for price” and an inquiry form instead of a price")}
      <div style={row}>
        <div style={{ flex: "1 1 240px" }}>
          <span style={lbl}>Heading</span>
          <input value={s.heading} disabled={!canEdit} maxLength={120} onChange={(e) => set("heading", e.target.value)}
            placeholder="Buildings ready to deliver" style={{ ...S.input, width: "100%", boxSizing: "border-box" }} />
        </div>
        <div style={{ flex: "1 1 160px" }}>
          <span style={lbl}>Google Tag Manager ID</span>
          <input value={s.gtmContainerId} disabled={!canEdit} onChange={(e) => set("gtmContainerId", e.target.value)}
            placeholder="GTM-XXXXXXX" style={{ ...S.input, width: "100%", boxSizing: "border-box" }} />
        </div>
      </div>
      <div style={{ marginBottom: 12 }}>
        <span style={lbl}>Intro</span>
        <textarea value={s.intro} disabled={!canEdit} maxLength={1000} rows={2} onChange={(e) => set("intro", e.target.value)}
          placeholder="Every building on our lot is built and ready. Ask about delivery to your yard."
          style={{ ...S.input, width: "100%", boxSizing: "border-box", resize: "vertical" }} />
      </div>
      <div style={row}>
        <div style={{ flex: "1 1 220px" }}>
          <span style={lbl}>Deposit at online checkout</span>
          <div style={{ display: "flex", gap: 6 }}>
            <select value={s.depositMode} disabled={!canEdit} onChange={(e) => set("depositMode", e.target.value)} style={{ ...S.input }}>
              <option value="percent">Percent of price</option>
              <option value="flat">Flat amount ($)</option>
              <option value="full">Pay in full</option>
            </select>
            {s.depositMode !== "full" && (
              <input type="number" min="0" step="1" value={s.depositValue} disabled={!canEdit}
                onChange={(e) => set("depositValue", e.target.value)} style={{ ...S.input, width: 90 }} />
            )}
          </div>
        </div>
        <div style={{ flex: "1 1 240px" }}>
          <span style={lbl}>Terms link (https://)</span>
          <input value={s.termsUrl} disabled={!canEdit} onChange={(e) => set("termsUrl", e.target.value)}
            placeholder="https://yourbusiness.com/terms" style={{ ...S.input, width: "100%", boxSizing: "border-box" }} />
        </div>
      </div>
      {s.depositMode !== "full" && check("allowPayInFull", "Let buyers choose to pay in full")}
      <div style={{ fontSize: 12, color: "#64748B", marginBottom: 12 }}>
        {paymentsLive
          ? "Online card payments are on for your account, so buyers will be able to check out and pay the deposit once checkout launches."
          : "Online card payments aren't set up for your account yet, so checkout will send you a purchase request instead of taking payment. Ask CSM Synergy to set up payments."}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {canEdit && <button type="button" disabled={saving} onClick={save} style={S.btn(ACCENT, "#FFF")}>{saving ? "Saving…" : "Save"}</button>}
        <a href={shopUrl} target="_blank" rel="noopener" style={{ ...S.btn("#F1F5F9", "#334155"), textDecoration: "none" }}>Preview ↗</a>
        <button type="button" onClick={() => copy("link", shopUrl)} style={S.btn("#F1F5F9", "#334155")}>{copied === "link" ? "Copied ✓" : "Copy link"}</button>
        <button type="button" onClick={() => copy("embed", embed)} style={S.btn("#F1F5F9", "#334155")}>{copied === "embed" ? "Copied ✓" : "Copy website embed code"}</button>
      </div>
      {msg && msg.ok && <div style={{ color: "#15803D", fontSize: 13, fontWeight: 600, marginTop: 10 }}>{msg.ok}</div>}
      {msg && msg.err && <div style={{ ...S.err, marginTop: 10 }}>{msg.err}</div>}
    </div>
  );
}

// Purchase requests from the shop's cart (migration 311). A shopper checked out without paying
// (online payment is phase 4): the builder calls them, then sends the estimate from the row below.
function ShopRequestsCard({ clientId, canEdit, refreshKey }) {
  const [rows, setRows] = useState(null);
  const [showHandled, setShowHandled] = useState(false);
  const [busy, setBusy] = useState(null);
  const load = useCallback(async () => {
    const { data } = await sb.functions.invoke("portal-settings", { body: { action: "list_shop_requests" } });
    setRows((data && data.requests) || []);
  }, [clientId]);
  useEffect(() => { load(); }, [load, refreshKey]);
  if (!rows || rows.length === 0) return null;
  const open = rows.filter((r) => r.status === "new");
  const list = showHandled ? rows : open;
  const money = (c) => (c == null ? "—" : "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const mark = async (r, handled) => {
    setBusy(r.id);
    await sb.functions.invoke("portal-settings", { body: { action: "mark_shop_request", id: r.id, handled } });
    setBusy(null); load();
  };
  return (
    <div style={{ background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 12, padding: "12px 14px", marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <strong style={{ fontSize: 14, color: "#92400E" }}>🛒 Online Inventory purchases &amp; requests{open.length ? ` — ${open.length} new` : ""}</strong>
        <button type="button" onClick={() => setShowHandled((v) => !v)}
          style={{ marginLeft: "auto", background: "none", border: "none", color: "#92400E", fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
          {showHandled ? "Hide handled" : "Show handled"}
        </button>
      </div>
      {list.length === 0 && <div style={{ fontSize: 13, color: "#92400E" }}>Nothing new. Handled requests stay here for 30 days.</div>}
      {list.map((r) => (
        <div key={r.id} style={{ background: "#FFF", border: "1px solid #FDE68A", borderRadius: 10, padding: "10px 12px", marginTop: 8, opacity: r.status === "handled" ? 0.6 : 1 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "baseline" }}>
            {r.kind === "purchase"
              ? <span style={{ background: "#DCFCE7", color: "#166534", borderRadius: 10, fontSize: 11, fontWeight: 800, padding: "2px 8px" }}>PAID ONLINE</span>
              : <span style={{ background: "#FEF3C7", color: "#92400E", borderRadius: 10, fontSize: 11, fontWeight: 800, padding: "2px 8px" }}>REQUEST</span>}
            <strong>{r.name}</strong>
            <a href={"tel:" + r.phone} style={{ color: ACCENT, fontWeight: 700 }}>{r.phone}</a>
            {r.email && <a href={"mailto:" + r.email} style={{ color: ACCENT }}>{r.email}</a>}
            <span style={{ color: "#64748B", fontSize: 12 }}>{fmtDate(r.created_at)}</span>
            {canEdit && (
              <button type="button" disabled={busy === r.id} onClick={() => mark(r, r.status !== "handled")}
                style={{ ...S.btn(r.status === "handled" ? "#F1F5F9" : ACCENT, r.status === "handled" ? "#334155" : "#FFF"), marginLeft: "auto", padding: "5px 11px", fontSize: 12 }}>
                {r.status === "handled" ? "Reopen" : "Mark handled"}
              </button>
            )}
          </div>
          <div style={{ fontSize: 12.5, color: "#475569", marginTop: 4 }}>
            Deliver to {[r.street, r.city, r.state, r.zip].filter(Boolean).join(", ")}
          </div>
          {(r.items || []).map((it) => (
            <div key={it.unitId} style={{ fontSize: 13, marginTop: 4 }}>
              <strong>{it.label}</strong>{it.lotName ? <span style={{ color: "#94A3B8" }}> · {it.lotName}</span> : null}
              {" — "}{money(it.priceCents)}
              {it.deliveryCents != null ? <> + delivery {money(it.deliveryCents)}</> : null}
              {it.taxCents != null ? <> + tax {money(it.taxCents)}</> : null}
              {" = "}<strong>{money(it.totalCents)}</strong>
            </div>
          ))}
          {r.kind === "purchase" ? (
            <div style={{ fontSize: 13, marginTop: 6 }}>
              Total <strong>{money(r.total_cents)}</strong> · <strong style={{ color: "#166534" }}>paid {money(r.paid_cents)} by card</strong>
              <span style={{ color: "#64748B" }}> · the invoice is waiting for your approval in Orders — approve it and the customer gets it to sign</span>
            </div>
          ) : (
            <div style={{ fontSize: 13, marginTop: 6 }}>
              Total <strong>{money(r.total_cents)}</strong> · {r.pay_in_full ? "wants to pay in full" : <>deposit <strong>{money(r.due_now_cents)}</strong></>}
              <span style={{ color: "#94A3B8" }}> · nothing charged</span>
            </div>
          )}
          {r.message && <div style={{ fontSize: 13, color: "#334155", marginTop: 4, fontStyle: "italic" }}>“{r.message}”</div>}
        </div>
      ))}
    </div>
  );
}

function InventoryListingEditor({ unit, canEdit, onChanged }) {
  const [listed, setListed] = useState(!!unit.listed);
  const [showPrice, setShowPrice] = useState(unit.showPriceOnline !== false);
  const [title, setTitle] = useState(unit.publicTitle || "");
  const [desc, setDesc] = useState(unit.publicDescription || "");
  const [photos, setPhotos] = useState(unit.photos || []);
  const [busy, setBusy] = useState(null);       // "save" | "upload" | photo id
  const [msg, setMsg] = useState(null);
  const [dragId, setDragId] = useState(null);
  const fileRef = useRef(null);

  const call = async (body) => {
    const { data, error } = await sb.functions.invoke("portal-settings", { body });
    if (error || !data || data.error) { setMsg({ err: (data && data.error) || (error ? await fnError(error) : "That didn't save.") }); return null; }
    return data;
  };
  const saveListing = async () => {
    setBusy("save"); setMsg(null);
    const r = await call({ action: "save_inventory_listing", unitId: unit.id, listed, showPriceOnline: showPrice, publicTitle: title, publicDescription: desc });
    setBusy(null);
    if (r) { setMsg({ ok: listed ? "Saved — this building is listed online." : "Saved." }); onChanged && onChanged(); }
  };
  const savePhotos = async (patch) => {
    const r = await call({ action: "save_inventory_photos", unitId: unit.id, ...patch });
    if (r) { setPhotos(r.photos || []); onChanged && onChanged(); }
    return r;
  };
  const upload = async (fileList) => {
    const files = Array.from(fileList || []).filter((f) => /^image\/(jpeg|png|webp)$/.test(f.type));
    if (!files.length) { setMsg({ err: "Pick JPG, PNG or WEBP photos." }); return; }
    setBusy("upload"); setMsg(null);
    const fitted = [];
    for (const f of files) fitted.push(await ssFitImageForUpload(f, 2_800_000, 2000));
    const added = [];
    for (const f of fitted) {
      const r = await call({ action: "inventory_photo_upload_url", unitId: unit.id, contentType: f.type || "image/jpeg", count: 1 });
      const up = r && r.uploads && r.uploads[0];
      if (!up) break;
      const { error } = await sb.storage.from("inventory-photos").uploadToSignedUrl(up.key, up.token, f, { contentType: f.type || "image/jpeg" });
      if (error) { setMsg({ err: "A photo didn't upload: " + (error.message || "try again") }); break; }
      added.push(up.key);
    }
    if (added.length) {
      const r = await savePhotos({ add: added });
      if (r) setMsg({ ok: `${added.length} photo${added.length === 1 ? "" : "s"} added.` });
    }
    setBusy(null);
    if (fileRef.current) fileRef.current.value = "";
  };
  const remove = async (p) => {
    if (!window.confirm("Remove this photo?")) return;
    setBusy(p.id); await savePhotos({ remove: [p.id] }); setBusy(null);
  };
  const move = async (fromId, toId) => {
    if (!fromId || fromId === toId) return;
    const ids = photos.map((p) => p.id);
    const from = ids.indexOf(fromId), to = ids.indexOf(toId);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    setPhotos(ids.map((id) => photos.find((p) => p.id === id)));
    await savePhotos({ order: ids });
  };
  const makeCover = (p) => move(p.id, photos[0] && photos[0].id);

  // ── AI background change (migration 312, FramedUp's recipe) ──
  // One at a time: the wallet allows a single live hold per builder for this meter.
  const [bg, setBg] = useState(null);           // { photo, scene, preset, running, err, jobId }
  const [bgInfo, setBgInfo] = useState(null);   // { ready, priceCents, exempt, reason }
  useEffect(() => {
    if (!canEdit) return;
    let live = true;
    sb.functions.invoke("portal-settings", { body: { action: "photo_bg_info" } })
      .then(({ data }) => { if (live && data && data.ok) setBgInfo(data); }).catch(() => {});
    return () => { live = false; };
  }, [canEdit]);
  const BG_PRESETS = [
    ["Green backyard", "a well-kept green suburban backyard lawn with a wooden privacy fence and mature trees"],
    ["Gravel pad", "a level crushed-gravel pad in a tidy rural yard with a farmhouse and trees in the distance"],
    ["Farm field", "the edge of an open farm field at golden hour with a clear sky"],
    ["Wooded lot", "a clearing in a hardwood forest with dappled sunlight and fallen leaves"],
    ["Snowy yard", "a snowy backyard on a bright winter day with evergreen trees"],
    ["Plain studio", "a seamless plain light-grey photo studio backdrop with soft even lighting"],
  ];
  const bgPrice = bgInfo ? (bgInfo.exempt ? "free on your account" : (bgInfo.priceCents != null ? `$${(bgInfo.priceCents / 100).toFixed(2)} from your wallet` : "")) : "";
  const runBg = async () => {
    const scene = (bg.scene || "").trim();
    if (!scene) { setBg((b) => ({ ...b, err: "Pick a background or describe one." })); return; }
    const key = "bg" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    setBg((b) => ({ ...b, running: true, err: null }));
    const { data, error } = await sb.functions.invoke("portal-settings", { body: { action: "photo_bg_start", photoId: bg.photo.id, scene, idempotencyKey: key } });
    if (error || !data || !data.jobId) {
      const why = (data && data.error) || (error ? await fnError(error) : "That didn't start.");
      setBg((b) => ({ ...b, running: false, err: why }));
      return;
    }
    const jobId = data.jobId;
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const { data: st } = await sb.functions.invoke("portal-settings", { body: { action: "photo_bg_status", jobId } });
      if (!st || st.status === "working") continue;
      if (st.status === "done") {
        // Refresh the photo list from the server, which knows where the new one sits.
        const r = await savePhotos({});
        setBg(null);
        setMsg({ ok: r ? "New background added beside the original. Make it the cover with ★ if you like it." : "New background added." });
        return;
      }
      setBg((b) => b && ({ ...b, running: false, err: st.error || "That change didn't work. You weren't charged." }));
      return;
    }
    setBg((b) => b && ({ ...b, running: false, err: "Still working — check back in a minute." }));
  };

  return (
    <div style={{ background: "#F8FAFC", border: "1px solid #EDF1F6", borderRadius: 10, padding: "12px 14px" }}>
      <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.5, color: "#94A3B8", textTransform: "uppercase", marginBottom: 9 }}>
        Online listing — building #{unit.serial}
      </div>
      <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginBottom: 10 }}>
        <label style={{ display: "flex", gap: 7, alignItems: "center", fontSize: 13, fontWeight: 700, color: "#334155" }}>
          <input type="checkbox" checked={listed} disabled={!canEdit} onChange={(e) => setListed(e.target.checked)} /> List online
        </label>
        <label style={{ display: "flex", gap: 7, alignItems: "center", fontSize: 13, fontWeight: 700, color: "#334155" }}>
          <input type="checkbox" checked={showPrice} disabled={!canEdit} onChange={(e) => setShowPrice(e.target.checked)} />
          Show price online <span style={{ fontWeight: 500, color: "#64748B" }}>(off = “Call for price”)</span>
        </label>
      </div>
      <input value={title} disabled={!canEdit} maxLength={120} onChange={(e) => setTitle(e.target.value)}
        placeholder={`Title — e.g. ${[titleCase(unit.style || ""), unit.size].filter(Boolean).join(" ") || "12x16 Lofted Barn"}`}
        style={{ ...S.input, width: "100%", boxSizing: "border-box", marginBottom: 8 }} />
      <textarea value={desc} disabled={!canEdit} maxLength={4000} rows={3} onChange={(e) => setDesc(e.target.value)}
        placeholder="Description — what makes this building a good buy, options included, ready-to-deliver notes…"
        style={{ ...S.input, width: "100%", boxSizing: "border-box", resize: "vertical", marginBottom: 10 }} />
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
        {photos.map((p, i) => (
          <div key={p.id} draggable={canEdit} onDragStart={() => setDragId(p.id)} onDragOver={(e) => e.preventDefault()}
            onDrop={() => { move(dragId, p.id); setDragId(null); }}
            style={{ position: "relative", width: 112, height: 84, borderRadius: 8, overflow: "hidden", border: i === 0 ? `2px solid ${ACCENT}` : "1px solid #E2E8F0", background: "#FFF", cursor: canEdit ? "grab" : "default", opacity: busy === p.id ? 0.4 : 1 }}>
            <img src={p.url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
            {i === 0 && <span style={{ position: "absolute", left: 4, top: 4, background: ACCENT, color: "#FFF", fontSize: 9.5, fontWeight: 800, borderRadius: 6, padding: "1px 6px" }}>COVER</span>}
            {p.aiEdited && <span style={{ position: "absolute", left: 4, bottom: 4, background: "rgba(15,23,42,.75)", color: "#FFF", fontSize: 9.5, fontWeight: 700, borderRadius: 6, padding: "1px 6px" }}>AI background</span>}
            {canEdit && (
              <div style={{ position: "absolute", right: 3, top: 3, display: "flex", gap: 3 }}>
                {bgInfo && <button type="button" title="Change the background (AI)" onClick={() => setBg({ photo: p, scene: "", preset: null, running: false, err: null })} style={{ border: "none", borderRadius: 5, background: "rgba(255,255,255,.92)", fontSize: 11, cursor: "pointer", padding: "1px 5px" }}>✨</button>}
                {i > 0 && <button type="button" title="Make cover photo" onClick={() => makeCover(p)} style={{ border: "none", borderRadius: 5, background: "rgba(255,255,255,.92)", fontSize: 11, cursor: "pointer", padding: "1px 5px" }}>★</button>}
                <button type="button" title="Remove photo" onClick={() => remove(p)} style={{ border: "none", borderRadius: 5, background: "rgba(255,255,255,.92)", fontSize: 11, cursor: "pointer", padding: "1px 5px" }}>✕</button>
              </div>
            )}
          </div>
        ))}
        {canEdit && photos.length < 12 && (
          <button type="button" disabled={busy === "upload"} onClick={() => fileRef.current && fileRef.current.click()}
            style={{ width: 112, height: 84, borderRadius: 8, border: "1.5px dashed #CBD5E1", background: "#FFF", color: "#64748B", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
            {busy === "upload" ? "Uploading…" : "+ Add photos"}
          </button>
        )}
        <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" multiple style={{ display: "none" }}
          onChange={(e) => upload(e.target.files)} />
      </div>
      {photos.length > 1 && canEdit && <div style={{ fontSize: 11.5, color: "#94A3B8", marginBottom: 8 }}>Drag photos to reorder. The first one is the cover.{bgInfo ? " ✨ changes a photo's background." : ""}</div>}
      {bg && (
        <div style={{ background: "#FFF", border: "1px solid #E2E8F0", borderRadius: 10, padding: 12, marginBottom: 10 }}>
          <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
            <img src={bg.photo.url} alt="" style={{ width: 140, height: 105, objectFit: "cover", borderRadius: 8 }} />
            <div style={{ flex: "1 1 260px" }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: "#334155", marginBottom: 6 }}>✨ Change the background{bgPrice ? <span style={{ fontWeight: 500, color: "#64748B" }}> — {bgPrice}</span> : null}</div>
              {!bgInfo.ready ? (
                <div style={{ fontSize: 13, color: "#B45309" }}>
                  {bgInfo.reason === "not_configured" ? "Background changes aren't set up yet — CSM Synergy is finishing the setup." : "Background changes aren't switched on yet — CSM Synergy is finishing the setup."}
                </div>
              ) : (
                <>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
                    {BG_PRESETS.map(([label, text]) => (
                      <button key={label} type="button" disabled={bg.running} onClick={() => setBg((b) => ({ ...b, scene: text, preset: label, err: null }))}
                        style={{ fontFamily: "inherit", fontSize: 12, fontWeight: 700, borderRadius: 14, padding: "4px 10px", cursor: "pointer",
                          background: bg.preset === label ? "#1E293B" : "#F1F5F9", color: bg.preset === label ? "#FFF" : "#334155", border: "none" }}>{label}</button>
                    ))}
                  </div>
                  <input value={bg.scene} disabled={bg.running} maxLength={400} onChange={(e) => setBg((b) => ({ ...b, scene: e.target.value, preset: null }))}
                    placeholder="…or describe it: a gravel driveway beside a red barn on an overcast day"
                    style={{ ...S.input, width: "100%", boxSizing: "border-box", marginBottom: 8 }} />
                  <div style={{ fontSize: 11.5, color: "#94A3B8", marginBottom: 8 }}>The building is kept exactly as it is; only the background changes. The new photo is added beside the original, which is never replaced. Takes about a minute.</div>
                </>
              )}
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                {bgInfo.ready && <button type="button" disabled={bg.running} onClick={runBg} style={S.btn(ACCENT, "#FFF")}>{bg.running ? "Working… (about a minute)" : "Change background"}</button>}
                <button type="button" disabled={bg.running} onClick={() => setBg(null)} style={S.btn("#F1F5F9", "#334155")}>Cancel</button>
                {bg.err && <span style={{ color: "#B91C1C", fontSize: 13, fontWeight: 600 }}>{bg.err}</span>}
              </div>
            </div>
          </div>
        </div>
      )}
      {listed && photos.length === 0 && <div style={{ fontSize: 12, color: "#B45309", marginBottom: 8 }}>Add at least one photo — listings without photos get far fewer inquiries.</div>}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        {canEdit && <button type="button" disabled={busy === "save"} onClick={saveListing} style={S.btn(ACCENT, "#FFF")}>{busy === "save" ? "Saving…" : "Save listing"}</button>}
        {msg && msg.ok && <span style={{ color: "#15803D", fontSize: 13, fontWeight: 600 }}>{msg.ok}</span>}
        {msg && msg.err && <span style={{ color: "#B91C1C", fontSize: 13, fontWeight: 600 }}>{msg.err}</span>}
      </div>
    </div>
  );
}

function InventoryTable({
  clientId, refreshKey = 0, isAdmin = false, access = null,
  onOpenDesign = null, onSendEstimate = null, onNew = null, onQuoteNewBuild = null,
}) {
  // The Online Shop's listing tools are inventory:edit (portal-settings GATES agrees).
  const canEditShop = isAdmin || !!(access && access.inventory === "edit");
  const [listingOpen, setListingOpen] = useState({});   // unit id -> listing editor open
  // A STATUS VIEW, deliberately (Carolyn 2026-08-08): "NO SCHEDULING EVER HAPPENS FROM THE
  // INVENTORY PAGE. It should only state the status." The build status follows the Build and
  // Delivery schedules; the sale follows the customer's invoice (or a recorded payment). The
  // first build of this page had Queue build / Add to a load / Mark sold buttons here — every
  // one of them was a second place to do something that already had a home, and the sell
  // button let a building be sold with no invoice behind it. The one write left on this page
  // is the admin-only Release under a SOLD chip, because a sale correction IS a status
  // change and there is no invoice-void anywhere in this product to do it for us.
  // Seed from the tab cache in the INITIALIZER, not an effect: this component is unmounted
  // every time the tab is left, so a revisit starts from scratch. Reading here means the
  // first render already has rows and the skeleton never appears for data we still hold;
  // load() below refreshes it in the background. An initializer also adds no hook, which
  // keeps clear of this file's early-return/hook-order hazard.
  const [rows, setRows] = useState(() => {
    const c = ssCacheGet("portal-settings", "list_inventory", clientId);
    return c ? (c.units || []) : null;         // null = loading
  });
  const [locations, setLocations] = useState(() => {
    const c = ssCacheGet("portal-settings", "list_inventory", clientId);
    return c ? (c.locations || []) : [];
  });
  const [error, setError] = useState(null);
  const [query, setQuery] = useState("");
  // One filter object rather than three loose states, so "no contradictory combination is
  // reachable" is enforceable in one place (see setBucket / setStage below).
  const [filt, setFilt] = useState({ bucket: "all", stage: "all", sale: "any" });
  const [locFilter, setLocFilter] = useState("all");
  const [expanded, setExpanded] = useState({});  // unit id -> estimates drawer open
  const [busyId, setBusyId] = useState(null);
  const [msg, setMsg] = useState(null);          // { ok } | { err }

  const load = useCallback(async () => {
    setError(null);
    const { data, error: err } = await sb.functions.invoke("portal-settings", { body: { action: "list_inventory" } });
    if (err || !data || data.error) {
      setError((data && data.error) || (err ? await fnError(err) : "Could not load inventory."));
      setRows([]); return;
    }
    const units = data.units || [];
    setRows(units);
    setLocations(data.locations || []);
    ssCachePut("portal-settings", "list_inventory", clientId, data);
    // list_inventory reports each estimate's CACHED designs.status, and nothing else on this
    // tab talks to GHL. sync-design-status is ALSO the safety-net sale path: an invoice the
    // tenant raised directly in GoHighLevel (or a GHL "paid") is what it notices and records.
    //
    // ⚠️ THE ORDERING IS LOAD-BEARING: the setRows above sits IN FRONT of this leg and must
    // stay there. sync-design-status is the same eight-second call that held Contacts on
    // "Loading…" for eight of its 9.7 seconds — awaiting it before the first paint is
    // exactly the mistake that made this tab feel broken. There is no paint() closure here
    // the way LeadsTable has one, and none is needed: every derivation on this tab
    // (bucketOf, counts, filtered, statusCell) runs in render off `rows`, so setRows IS the
    // repaint.
    //
    // What the sync leg does with its answer changed on 2026-08-28. It used to re-read the
    // ENTIRE list_inventory payload — four waves of joins across five tables — to pick up
    // status chips that the sync's own response already contained. Now the statuses are
    // merged locally and the full re-read is kept for the one case that genuinely needs the
    // server: a sale the sync just recorded (see below).
    const codes = units.flatMap((u) => (u.estimates || []).map((e) => e.shortCode)).filter(Boolean);
    if (codes.length) {
      try {
        const { data: sync } = await sb.functions.invoke("sync-design-status", { body: { shortCodes: codes } });
        if (sync && sync.statuses) {
          // The statuses come back in the sync's own response, so merge them into the rows
          // already on screen instead of re-reading the entire multi-table payload for a
          // handful of chips. `statuses` is keyed by estimate short code, which is exactly
          // what each unit's estimates carry.
          const merged = units.map((u) => {
            const ests = (u.estimates || []).map((e) => {
              const next = sync.statuses[e.shortCode];
              return (next && next !== e.status) ? { ...e, status: next } : e;
            });
            return ests.some((e, i) => e !== (u.estimates || [])[i]) ? { ...u, estimates: ests } : u;
          });
          setRows(merged);
          ssCachePut("portal-settings", "list_inventory", clientId, { ...data, units: merged });
          // The ONE thing a status map cannot carry: the safety-net SALE. When an unsold
          // unit's estimate has just reached invoiced/delivered, the sync may have claimed
          // the unit server-side — writing sale_state, the buyer's first name and a
          // recomputed stage, none of which are in `statuses`. That has to be re-read, so
          // this keeps the full refetch for exactly that case and skips it otherwise. The
          // threshold mirrors the server's own trigger; widening it here would just restore
          // the second read for everyone.
          const saleMayHaveLanded = units.some((u) => !invSold(u) && (u.estimates || []).some((e) => {
            const s = sync.statuses[e.shortCode];
            return s === "invoiced" || s === "delivered";
          }));
          if (saleMayHaveLanded) {
            const { data: fresh } = await sb.functions.invoke("portal-settings", { body: { action: "list_inventory" } });
            if (fresh && fresh.units) {
              setRows(fresh.units);
              setLocations(fresh.locations || []);
              ssCachePut("portal-settings", "list_inventory", clientId, fresh);
            }
          }
        }
      } catch (_e) { /* what we already rendered stands */ }
    }
  }, [clientId]);
  useEffect(() => { load(); }, [load, refreshKey]);

  // Three semantic buckets. A rep's real questions are "what can I sell today", "what's
  // coming", "what's spoken for" — the full-stage detail lives one control away.
  const bucketOf = (u) => invSold(u) ? "sold" : (invSellable(u) ? "sellable" : "production");
  const counts = (rows || []).reduce((a, u) => {
    a[bucketOf(u)] = (a[bucketOf(u)] || 0) + 1;
    a.stage[invStage(u)] = (a.stage[invStage(u)] || 0) + 1;
    return a;
  }, { stage: {} });
  const anyFilterOn = filt.bucket !== "all" || filt.stage !== "all" || filt.sale !== "any"
    || locFilter !== "all" || !!query.trim();
  const clearFilters = () => { setFilt({ bucket: "all", stage: "all", sale: "any" }); setLocFilter("all"); setQuery(""); };
  // Picking a stage clears the bucket and vice versa: they are two views of the same axis, so
  // holding both at once is how you get an empty table that looks like a bug.
  const setBucket = (b) => setFilt((f) => ({ ...f, bucket: b, stage: "all" }));
  const setStage = (s) => setFilt((f) => ({ ...f, stage: s, bucket: "all" }));

  const filtered = (rows || []).filter((u) => {
    if (filt.bucket !== "all" && bucketOf(u) !== filt.bucket) return false;
    if (filt.stage !== "all" && invStage(u) !== filt.stage) return false;
    if (filt.sale === "for_sale" && invSold(u)) return false;
    if (filt.sale === "sold" && !invSold(u)) return false;
    if (locFilter !== "all" && String(u.locationId || "") !== locFilter) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    const hay = ["#" + u.serial, String(u.serial), u.fullSerial || "", titleCase(u.style || ""), u.size || "", u.locationName || "",
      u.roofType || "", u.roofColor || "", u.bodyColor || "", u.trimColor || "", u.soldFirstName || "",
      ...(u.estimates || []).map((e) => (e.name || "") + " " + (e.estimateNumber ? "EST-" + e.estimateNumber : ""))].join(" ").toLowerCase();
    return hay.includes(q);
  });

  // Paging is the LAST step, over the already-filtered list, so the CardHead count, the four
  // bucket chips and the per-stage counts still read `rows`/`filtered` and still describe the
  // whole lot — "12 of 340" stays true. There is no SortTh on this tab, so `filtered` is still
  // in list_inventory's created_at DESC order and the slice preserves it. `expanded` is keyed
  // by unit id, so a drawer left open on page 2 is still open when you come back to it.
  const [pageSize, setPageSize] = usePageSize("inventory");
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [query, filt.bucket, filt.stage, filt.sale, locFilter]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const curPage = Math.min(page, pageCount);
  const paged = filtered.slice((curPage - 1) * pageSize, curPage * pageSize);

  const invoke = async (body, okMsg) => {
    const { data, error: err } = await sb.functions.invoke("portal-settings", { body });
    if (err || !data || data.error) {
      setMsg({ err: (data && data.error) || (err ? await fnError(err) : "That didn't save.") });
      return false;
    }
    if (okMsg) setMsg({ ok: okMsg });
    return data;
  };
  // The one correction path for a sale. It exists because there is NO invoice-void anywhere
  // in this product — a CRM-side void is invisible to us — so without it one mis-clicked
  // invoice would take a building out of sellable stock permanently. The server records which
  // design it was released from and refuses to auto-re-sell from that same design; a new
  // estimate can still sell the building, which is the real re-sale case anyway.
  const release = async (u) => {
    const reason = window.prompt(
      `Put building #${u.serial} back on the market?\n\n`
      + `This does NOT void or change the invoice in your CRM — there is no way to do that from `
      + `here. It only makes the building available to sell again.\n\nWhy is it being released?`);
    if (reason === null) return;                      // cancelled
    if (!reason.trim()) { setMsg({ err: "Releasing a sold building needs a reason." }); return; }
    setBusyId(u.id); setMsg(null);
    await invoke({ action: "unsell_inventory", unitId: u.id, reason: reason.trim() },
      `#${u.serial} is available again.`);
    setBusyId(null); load();
  };
  const del = async (u) => {
    if (!window.confirm(`Delete building #${u.serial}? Its floor plan and version history are removed. Estimates already sent to customers are kept (they just lose the Inventory label).`)) return;
    setBusyId(u.id); setMsg(null);
    // ONE call: delete_inventory removes the unit AND its master design (row, versions,
    // PDFs) server-side. Two calls meant a failed/abandoned second request stranded an
    // invisible orphan master that no screen could ever list or clean up.
    const r = await invoke({ action: "delete_inventory", unitId: u.id });
    if (r) {
      setMsg(r.masterDeleted === false
        ? { err: `Building #${u.serial} was removed from inventory, but its saved floor plan could not be deleted — support has been notified.` }
        : { ok: `Building #${u.serial} deleted.` });
    }
    setBusyId(null); load();
  };

  // ALWAYS rendered, even at zero. The old version hid a chip whose count was 0 while the
  // filter stayed applied — so clearing the last sold building while filtered to Sold made the
  // chip vanish and left the table stuck on "No buildings match" with no control to undo it.
  // These are fixed categories, not data-derived keys: a zero on "For sale" is real
  // information about the lot, not a dead feature.
  const chip = (k, label, n, on) => (
    <button key={k} type="button" aria-pressed={on} onClick={() => setBucket(k)}
      style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer", fontFamily: "inherit",
        fontSize: 12, fontWeight: 700, borderRadius: 16, padding: "5px 12px",
        background: on ? "#1E293B" : "#FFF", color: on ? "#FFF" : "#475569",
        border: `1px solid ${on ? "#1E293B" : "#E2E8F0"}` }}>
      {label}<span style={{ fontSize: 10.5, opacity: 0.75 }}>{n}</span>
    </button>
  );
  const selStyle = { fontSize: 12, fontWeight: 700, color: "#334155", border: "1px solid #E2E8F0",
    background: "#FFF", borderRadius: 9, padding: "6px 10px" };
  const linkBtn = (extra) => ({ background: "none", border: "none", padding: 0, cursor: "pointer",
    fontFamily: "inherit", fontSize: "inherit", fontWeight: 700, marginRight: 10, ...extra });
  const tag = { background: "#DBEAFF", color: "#3D3672", borderRadius: 12, fontSize: 10.5, fontWeight: 800, padding: "2px 9px", whiteSpace: "nowrap" };

  // ── The Status cell: the ENTIRE state of a building, and the page's whole job ───────
  // One lifecycle chip (pure projection of the Build/Delivery schedules — there is no
  // hand-set value to annotate any more), a SOLD — Dave chip when an invoice or payment has
  // claimed it, and — admin only — the Release link under it. Nothing on this page writes to
  // any schedule, so this cell can never disagree with the boards: it is the same facts.
  const statusCell = (u) => {
    const meta = invStageMeta(u);
    const c = INV_GROUP_COLORS[meta.group];
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <span title={INV_STAGE_LONG[invStage(u)]}
            style={{ background: c.bg, color: c.fg, borderRadius: 20, padding: "4px 12px",
              fontSize: 12, fontWeight: 700, whiteSpace: "nowrap" }}>
            {meta.label}
          </span>
          {u.listed && (
            <span title={u.showPriceOnline === false ? "Listed in your Online Inventory (price hidden)" : "Listed in your Online Inventory"}
              style={{ background: "#ECFDF5", color: "#047857", borderRadius: 14, padding: "3px 9px",
              fontSize: 10.5, fontWeight: 800, letterSpacing: 0.4, whiteSpace: "nowrap" }}>
              ONLINE{(u.photos || []).length ? ` · ${(u.photos || []).length} 📷` : ""}
            </span>
          )}
          {invSold(u) && (
            <span title={u.soldAt ? "Sold " + fmtDate(u.soldAt) : undefined}
              style={{ background: INV_SALE_COLORS.bg, color: INV_SALE_COLORS.fg, borderRadius: 14,
              padding: "3px 9px", fontSize: 10.5, fontWeight: 800, letterSpacing: 0.4, whiteSpace: "nowrap" }}>
              {invSoldLabel(u)}
            </span>
          )}
        </div>
        {invSold(u) && isAdmin && (
          <button type="button" disabled={busyId === u.id} onClick={() => release(u)}
            title="Put this building back on the market. Does not touch the invoice in your CRM."
            style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit",
              fontSize: 11, fontWeight: 700, color: "#94A3B8", textAlign: "left" }}>
            Release
          </button>
        )}
      </div>
    );
  };

  return (
    <div style={S.card}>
      {/* `count` follows the DesignsTable precedent: it must agree with the table, and the
          `rows ?` guard kills the phantom 0 that used to render during load. */}
      <CardHead title="Inventory"
        count={rows ? (anyFilterOn ? `${filtered.length} of ${rows.length}` : rows.length) : null}
        right={<>
          <button type="button" onClick={load} style={S.btn("#F1F5F9", "#334155")}>↻ Refresh</button>
          {/* Settings live under Settings (Carolyn 2026-10-17) — this is only a shortcut there. */}
          <a href="/settings/online-inventory" style={{ ...S.btn("#F1F5F9", "#334155"), textDecoration: "none" }}>🛒 Online Inventory settings</a>
          {onNew && <button type="button" onClick={onNew} style={S.btn(ACCENT, "#FFF")}>+ New building request</button>}
        </>} />
      <ShopRequestsCard clientId={clientId} canEdit={canEditShop} refreshKey={refreshKey} />
      <input value={query} onChange={(e) => setQuery(e.target.value)}
        placeholder="Search inventory — serial #, building, location, customer…"
        style={{ ...S.input, width: "100%", boxSizing: "border-box", marginBottom: 11 }} />
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 13, alignItems: "center" }}>
        {chip("all", "All", (rows || []).length, filt.bucket === "all" && filt.stage === "all")}
        {chip("sellable", "For sale", counts.sellable || 0, filt.bucket === "sellable")}
        {chip("production", "In production", counts.production || 0, filt.bucket === "production")}
        {chip("sold", "Sold", counts.sold || 0, filt.bucket === "sold")}
        {/* The full-stage detail, one control away from the buckets. A zero-count stage
            renders disabled rather than disappearing — "none right now" is information. */}
        <select value={filt.stage} onChange={(e) => setStage(e.target.value)} style={selStyle}>
          <option value="all">All stages</option>
          {Object.keys(INV_STAGES).map((k) => (
            <option key={k} value={k} disabled={!(counts.stage[k] || 0)}>
              {INV_STAGE_LONG[k]}{counts.stage[k] ? ` (${counts.stage[k]})` : ""}
            </option>
          ))}
        </select>
        <select value={filt.sale} onChange={(e) => setFilt((f) => ({ ...f, sale: e.target.value }))} style={selStyle}>
          <option value="any">Sold or not</option>
          <option value="for_sale">Not sold</option>
          <option value="sold">Sold</option>
        </select>
        {anyFilterOn && (
          <button type="button" onClick={clearFilters}
            style={{ ...linkBtn({ color: "#64748B", fontSize: 12 }), marginRight: 0 }}>Clear filters</button>
        )}
        {locations.length > 0 && (
          <select value={locFilter} onChange={(e) => setLocFilter(e.target.value)}
            style={{ ...selStyle, marginLeft: "auto" }}>
            <option value="all">📍 All locations</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        )}
      </div>
      {msg && msg.ok && <div style={{ background: "#F0FDF4", border: "1px solid #BBF7D0", color: "#15803D", borderRadius: 8, padding: "8px 12px", fontSize: 13, fontWeight: 600, marginBottom: 10 }}>{msg.ok}</div>}
      {msg && msg.err && <div style={{ ...S.err, marginBottom: 10 }}>{msg.err}</div>}
      {error && <div style={S.err}>{error}</div>}
      {/* Grey blocks in the real column shape, not the word "Loading" on an empty card — see
          SkelRows. The header row, the ten columns and the location select used to arrive all
          at once when list_inventory landed; the read is no faster, but the tab stops reading
          as broken while it is in flight. `!error` mirrors LeadsTable: a failed read must show
          S.err above, not a skeleton that never resolves. The card head, search box and bucket
          chips deliberately stay put rather than being swapped out the way OrdersView replaces
          its whole card — they already render during the load, and hiding them would introduce
          exactly the jump this skeleton exists to prevent. */}
      {rows === null && !error && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              {["Serial #", "Building", "Roof", "Colors", "Location", "Asking price", "Estimates", "Added", "Status", "Actions"].map((h) => (
                <th key={h} style={S.th}>{h}</th>
              ))}
            </tr></thead>
            <tbody><SkelRows cols={10} rows={6} widths={["38%", "70%", "58%", "64%", "60%", "44%", "52%", "46%", "56%", "60%"]} /></tbody>
          </table>
        </div>
      )}
      {rows && rows.length === 0 && !error && (
        <p style={{ fontSize: 13, color: "#64748B", padding: 12 }}>
          Nothing on the lot yet. Design a building in the <strong>Shed Designer</strong> and click <strong>Request this build</strong> — it takes the next serial number automatically and lands here. Put it on the <strong>Build Schedule</strong> when you're ready to make it.
        </p>
      )}
      {rows && rows.length > 0 && filtered.length === 0 && (
        <p style={{ fontSize: 13, color: "#64748B", padding: 12 }}>
          No buildings match{query ? <> “{query}”</> : null}.{" "}
          <button type="button" onClick={clearFilters} style={{ ...linkBtn({ color: ACCENT }), marginRight: 0 }}>Clear filters</button>
        </p>
      )}
      {rows && filtered.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              {["Serial #", "Building", "Roof", "Colors", "Location", "Asking price", "Estimates", "Added", "Status", "Actions"].map((h) => (
                <th key={h} style={S.th}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {paged.map((u) => {
                const sold = invSold(u);
                const ests = u.estimates || [];
                const isOpen = !!expanded[u.id];
                // The buyer is a RECORDED fact — the design the invoice (or payment) named —
                // never a guess from estimate ordering.
                const winner = ests.find((e) => e.shortCode === u.soldDesignShortCode);
                return (
                  <React.Fragment key={u.id}>
                    <tr>
                      <td style={{ ...S.td, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>
                        #{u.serial}
                        {/* The full serial (316) — what goes on the building's tag. */}
                        {u.fullSerial && <div title="Full serial number — write this on the tag"
                          style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 11, fontWeight: 700, color: "#475569", whiteSpace: "nowrap", userSelect: "all", marginTop: 2 }}>{u.fullSerial}</div>}
                      </td>
                      <td style={S.td}><strong>{[titleCase(u.style || ""), u.size].filter(Boolean).join(" ") || "—"}</strong></td>
                      <td style={S.td}>{u.roofType ? <>{u.roofType}{u.roofColor ? <span style={{ color: "#94A3B8" }}> · {u.roofColor}</span> : null}</> : <span style={{ color: "#94A3B8" }}>—</span>}</td>
                      <td style={S.td}>{(u.bodyColor || u.trimColor) ? <>{u.bodyColor || "—"}<span style={{ color: "#94A3B8" }}> / {u.trimColor || "—"}</span></> : <span style={{ color: "#94A3B8" }}>—</span>}</td>
                      <td style={S.td}>{u.locationName ? <>{u.locationName}{u.locationCity ? <span style={{ color: "#94A3B8" }}> · {u.locationCity}</span> : null}</> : <span style={{ color: "#94A3B8" }}>—</span>}</td>
                      <td style={S.td}><strong>{invMoney(u.askingPriceCents)}</strong></td>
                      <td style={S.td}>
                        {ests.length === 0 ? <span style={{ color: "#94A3B8" }}>—</span> : (
                          <button type="button" onClick={() => setExpanded((x) => ({ ...x, [u.id]: !x[u.id] }))}
                            style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit", fontSize: "inherit", color: ACCENT, fontWeight: 700 }}>
                            {ests.length} {ests.length === 1 ? "estimate" : "estimates"} {isOpen ? "▾" : "▸"}
                          </button>
                        )}
                      </td>
                      <td style={{ ...S.td, whiteSpace: "nowrap", color: "#64748B" }}>{fmtDate(u.createdAt)}</td>
                      <td style={S.td}>{statusCell(u)}</td>
                      <td style={{ ...S.td, whiteSpace: "nowrap" }}>
                        {/* Open the building's own design. Sell it by sending an estimate and
                            invoicing that estimate — the sale records itself. Nothing here
                            touches the Build or Delivery schedules. */}
                        <button type="button" disabled={busyId === u.id}
                          onClick={() => onOpenDesign && onOpenDesign(u.shortCode, null, { unit: { unitId: u.id, askingPriceCents: u.askingPriceCents, locationId: u.locationId, lifecycle: u.lifecycle } })}
                          style={linkBtn({ color: ACCENT })}>Open</button>
                        {/* Sold ⇒ not sellable, at EVERY stage. Hiding this is a courtesy;
                            link_design_to_unit refuses the link server-side, because anyone
                            can call that endpoint directly with a valid session. */}
                        {!sold && (
                          <button type="button" disabled={busyId === u.id}
                            onClick={() => onSendEstimate && onSendEstimate(u)}
                            style={linkBtn({ color: ACCENT })}>Send estimate</button>
                        )}
                        <button type="button" onClick={() => setListingOpen((x) => ({ ...x, [u.id]: !x[u.id] }))}
                          style={linkBtn({ color: ACCENT })}>{listingOpen[u.id] ? "Close listing" : "Online"}</button>
                        {u.imageUrl && ssSafeUrl(u.imageUrl) && <a href={u.imageUrl} target="_blank" rel="noopener" style={{ color: "#334155", fontWeight: 700, textDecoration: "none", marginRight: 10 }}>PDF</a>}
                        {isAdmin && <button type="button" disabled={busyId === u.id} onClick={() => del(u)}
                          style={linkBtn({ color: "#CBD5E1", marginRight: 0 })}>Delete</button>}
                      </td>
                    </tr>
                    {listingOpen[u.id] && (
                      <tr><td colSpan={10} style={{ padding: "2px 8px 12px" }}>
                        <InventoryListingEditor unit={u} canEdit={canEditShop} onChanged={load} />
                      </td></tr>
                    )}
                    {isOpen && ests.length > 0 && (
                      <tr><td colSpan={10} style={{ padding: "2px 8px 12px" }}>
                        <div style={{ background: "#F8FAFC", border: "1px solid #EDF1F6", borderRadius: 10, padding: "12px 14px" }}>
                          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.5, color: "#94A3B8", textTransform: "uppercase", marginBottom: 9 }}>
                            Estimates on building #{u.serial}
                          </div>
                          {ests.map((e) => {
                            const es = normStatus(e.status);
                            const c = STATUS_COLORS[es] || STATUS_COLORS.sent;
                            const isWinner = winner && winner.shortCode === e.shortCode;
                            return (
                              <div key={e.shortCode} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", fontSize: 13, flexWrap: "wrap" }}>
                                <span style={tag}>Inventory</span>
                                <strong>{e.name || "—"}</strong>
                                <span style={{ color: "#94A3B8", fontSize: 12 }}>{e.estimateNumber ? `EST-${e.estimateNumber} · ` : ""}{fmtDate(e.createdAt)}</span>
                                <span style={{ background: c.bg, color: c.fg, borderRadius: 14, padding: "2.5px 10px", fontSize: 11, fontWeight: 700 }}>
                                  {STATUS_LABELS[es]}{isWinner ? " — buyer" : ""}
                                </span>
                                {/* The customer who lost the building is the one worth saving,
                                    so the prompt carries the action: it reopens their design in
                                    the Designer untied from this unit, so the next submit is a
                                    fresh build for them. */}
                                {sold && !isWinner && (
                                  <>
                                    <span style={{ background: "#FEF3C7", color: "#92400E", borderRadius: 12, fontSize: 11, fontWeight: 700, padding: "3px 10px" }}>⚠ Building sold</span>
                                    {onQuoteNewBuild && (
                                      <button type="button" onClick={() => onQuoteNewBuild(e)}
                                        style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit", fontSize: 12, color: ACCENT, fontWeight: 700 }}>
                                        Start a new estimate for this customer →
                                      </button>
                                    )}
                                  </>
                                )}
                                <button type="button" onClick={() => onOpenDesign && onOpenDesign(e.shortCode, null, null)}
                                  style={{ marginLeft: "auto", background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit", fontSize: "inherit", color: ACCENT, fontWeight: 700 }}>Open</button>
                              </div>
                            );
                          })}
                        </div>
                      </td></tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
          <PageBar size={pageSize} onSize={setPageSize} page={curPage} onPage={setPage} total={filtered.length} noun="building" />
        </div>
      )}
    </div>
  );
}

