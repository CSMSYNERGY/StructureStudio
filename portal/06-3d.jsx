// ─── In-portal Designer tab ───
// Mounts the shared designer module (structure-studio.component.js, loaded before this
// block) with `embedded` chrome-suppression/gate-bypass and the tenant passed as a prop
// — the loader then skips URL parsing entirely and can never hit its bare-root
// /portal.html redirect (which would loop the portal).
// ── Photo straightening for fixture images ──────────────────────────────────────────
// A door photo taken on a phone is never square-on, and in 3D that photo is stretched
// flat onto the door slab: every degree of camera tilt shows up as a leaning door on the
// customer's building. Carolyn's ask was explicit -- the builder supplies the photo, and
// we straighten it a little rather than sending them away to reshoot ("nobody's going to
// get them perfect").
//
// A 2D canvas transform is affine and CANNOT do this: mapping an arbitrary quadrilateral
// to a rectangle needs a projective transform. So we solve the homography ourselves (8
// unknowns, 4 point pairs) and resample. No library: this is ~40 lines and adding a
// dependency to a buildless page costs more than it saves.
//
// Solves for H mapping DEST(rect) -> SRC(quad), so each output pixel can look up where
// it came from -- the inverse direction is what resampling needs.
function ssSolveHomography(dst, src) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = dst[i], [u, v] = src[i];
    A.push([x, y, 1, 0, 0, 0, -x * u, -y * u]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -x * v, -y * v]); b.push(v);
  }
  // Gaussian elimination with partial pivoting.
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-12) return null;      // degenerate quad (collinear corners)
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      if (!f) continue;
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const h = b.map((val, i) => val / A[i][i]);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

// Warp the quad the user marked out into a straight-on rectangle of the given aspect.
function ssWarpQuad(img, quad, aspect, maxPx) {
  const ratio = aspect > 0 ? aspect : 1;
  let w = Math.min(maxPx, img.naturalWidth || img.width);
  let h = Math.round(w / ratio);
  if (h > maxPx) { h = maxPx; w = Math.round(h * ratio); }
  // The SOURCE is bounded too, not only the maxPx output. Reading the photo at natural
  // size into ImageData breaks on exactly the phones this feature is for: a 24/48MP
  // iPhone default blows Safari's ~16.7M-pixel canvas cap — drawImage silently no-ops,
  // every sample reads fill colour, and the sanity check below hands back the crooked
  // original — while the full-res buffers can OOM the tab on big Android sensors.
  // 2×maxPx on the long edge keeps every pixel the bilinear resample can actually use.
  // The quad corners arrive in natural-image pixels, so they scale down with the source
  // (audit 2026-08-20).
  const natW = img.naturalWidth || img.width, natH = img.naturalHeight || img.height;
  const srcScale = Math.min(1, (maxPx * 2) / Math.max(natW, natH));
  const src = document.createElement("canvas");
  src.width = Math.max(1, Math.round(natW * srcScale));
  src.height = Math.max(1, Math.round(natH * srcScale));
  src.getContext("2d").drawImage(img, 0, 0, src.width, src.height);
  const sd = src.getContext("2d").getImageData(0, 0, src.width, src.height);
  const sq = quad.map(([x, y]) => [x * srcScale, y * srcScale]);
  // Reject a quad that is not a sane convex shape before doing any work. The matrix solve
  // alone does not catch these: a bow-tie (self-crossing) or near-zero-area quad solves
  // fine and warps the photo into garbage, and a hair-thin one samples almost nothing.
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  let area = 0;
  for (let i = 0; i < 4; i++) { const p = sq[i], q = sq[(i + 1) % 4]; area += p[0] * q[1] - q[0] * p[1]; }
  area = Math.abs(area) / 2;
  const signs = [0, 1, 2, 3].map((i) => Math.sign(cross(sq[i], sq[(i + 1) % 4], sq[(i + 2) % 4])));
  const convex = signs.every((s) => s > 0) || signs.every((s) => s < 0);
  const minSide = Math.min(...[0, 1, 2, 3].map((i) => Math.hypot(sq[(i + 1) % 4][0] - sq[i][0], sq[(i + 1) % 4][1] - sq[i][1])));
  if (!convex || minSide < 8 || area < (src.width * src.height) * 0.005) return null;
  const H = ssSolveHomography([[0, 0], [w, 0], [w, h], [0, h]], sq);
  if (!H) return null;
  const out = document.createElement("canvas"); out.width = w; out.height = h;
  const octx = out.getContext("2d");
  // Paint the door colour first: the result is encoded as JPEG, which has no alpha, so any
  // pixel left transparent would flatten to BLACK. Sampling outside the photo now lands on
  // a plausible door tone instead of a black wedge.
  octx.fillStyle = "#77664C";
  octx.fillRect(0, 0, w, h);
  const od = octx.getImageData(0, 0, w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = H[6] * x + H[7] * y + H[8];
      const fu = (H[0] * x + H[1] * y + H[2]) / d;
      const fv = (H[3] * x + H[4] * y + H[5]) / d;
      const o = (y * w + x) * 4;
      // Bilinear, not nearest-neighbour: a 4000px phone photo lands on a <=1024px output,
      // and point-sampling that ratio aliases every straight edge into a staircase.
      const u0 = Math.floor(fu), v0 = Math.floor(fv);
      if (u0 < 0 || v0 < 0 || u0 >= src.width || v0 >= src.height) continue;   // outside: keep the fill
      // Clamp the far neighbour rather than skipping the pixel: a quad drawn right to the
      // photo edge used to lose its last row/column to a 1px line of fill colour.
      const u1 = Math.min(u0 + 1, src.width - 1), v1 = Math.min(v0 + 1, src.height - 1);
      const au = fu - u0, av = fv - v0;
      for (let c = 0; c < 4; c++) {
        const p00 = sd.data[(v0 * src.width + u0) * 4 + c], p10 = sd.data[(v0 * src.width + u1) * 4 + c];
        const p01 = sd.data[(v1 * src.width + u0) * 4 + c], p11 = sd.data[(v1 * src.width + u1) * 4 + c];
        od.data[o + c] = (p00 * (1 - au) + p10 * au) * (1 - av) + (p01 * (1 - au) + p11 * au) * av;
      }
      // The source may itself be a cut-out PNG; anything see-through composites onto the
      // door colour rather than carrying alpha into a format that cannot hold it.
      const a = od.data[o + 3] / 255;
      if (a < 1) {
        od.data[o] = od.data[o] * a + 0x77 * (1 - a);
        od.data[o + 1] = od.data[o + 1] * a + 0x66 * (1 - a);
        od.data[o + 2] = od.data[o + 2] * a + 0x4C * (1 - a);
      }
      od.data[o + 3] = 255;
    }
  }
  octx.putImageData(od, 0, 0);
  // Sanity-check the result. A source the browser refused to decode reads as fully
  // transparent, which the fill above turns into a flat door-coloured rectangle: better
  // than the old all-black JPEG, but still not the builder's photo. If almost nothing was
  // sampled, report failure so the caller keeps the original file.
  let sampled = 0;
  for (let i = 0; i < od.data.length; i += 4 * 97) {
    if (!(od.data[i] === 0x77 && od.data[i + 1] === 0x66 && od.data[i + 2] === 0x4C)) sampled++;
  }
  if (sampled < Math.ceil((od.data.length / (4 * 97)) * 0.02)) return null;
  return out;
}

// Drag the four corners onto the door/window itself, then straighten. "Use as-is" exists
// because a photo that is already square-on needs nothing, and forcing a four-corner
// ritual on every upload would be its own reason not to upload.
// Guarantee an upload fits the server's 3MB cap. The file picker deliberately accepts a
// big original now (a modern phone photo is 4-12MB and the straightener shrinks it to a
// couple of hundred KB), but 'Use as-is' hands the original straight through -- so the
// last step before upload re-encodes anything still too large. Longest edge 1600px is
// well above the 1024px the 3D texture cache downsamples to anyway.
async function ssFitImageForUpload(file, maxBytes = 2_800_000, maxPx = 1600) {
  if (!file || file.size <= maxBytes) return file;
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('decode failed')); i.src = url; });
    const scale = Math.min(1, maxPx / Math.max(img.naturalWidth, img.naturalHeight));
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(img.naturalWidth * scale));
    cv.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const g = cv.getContext('2d');
    // Flatten onto white: JPEG has no alpha, and a transparent PNG would otherwise
    // encode its see-through areas as black.
    g.fillStyle = '#FFFFFF'; g.fillRect(0, 0, cv.width, cv.height);
    g.drawImage(img, 0, 0, cv.width, cv.height);
    for (const q of [0.9, 0.8, 0.7]) {
      const blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', q));
      if (blob && blob.size <= maxBytes) return new File([blob], 'photo.jpg', { type: 'image/jpeg' });
    }
    return file;   // could not get it under the cap; let the server say so
  } catch (_e) {
    return file;
  } finally { URL.revokeObjectURL(url); }
}

function SSStraightenPhoto({ file, aspect, onCancel, onDone }) {
  const [img, setImg] = useState(null);
  const [quad, setQuad] = useState(null);        // [[x,y]×4] in natural image pixels
  const [drag, setDrag] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const boxRef = useRef(null);
  const VIEW = 460;

  useEffect(() => {
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => {
      setImg(im);
      const w = im.naturalWidth, h = im.naturalHeight;
      const ix = w * 0.08, iy = h * 0.08;        // start slightly inside, so the handles are grabbable
      setQuad([[ix, iy], [w - ix, iy], [w - ix, h - iy], [ix, h - iy]]);
    };
    im.onerror = () => { setErr("That image could not be opened — try a JPG or PNG straight from the camera."); };
    im.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // The box is sized to the viewport, not to a fixed 460px: this is a step a builder does
  // on the phone they took the photo with, and a hard-coded width pushed two of the four
  // corner handles off a phone screen entirely.
  const view = Math.max(220, Math.min(VIEW, (typeof window !== "undefined" ? window.innerWidth : VIEW) - 96));
  const scale = img ? view / Math.max(img.naturalWidth, img.naturalHeight) : 1;
  const dispW = img ? img.naturalWidth * scale : 0, dispH = img ? img.naturalHeight * scale : 0;

  // Pointer events, not mouse events: the handles were undraggable on every phone and
  // tablet — the exact devices this feature is for.
  const moveTo = (e) => {
    if (drag == null || !boxRef.current || !img) return;
    const t = (e.touches && e.touches[0]) ? e.touches[0] : e;
    if (t.clientX == null) return;
    if (e.cancelable) e.preventDefault();          // stop the page scrolling under the drag
    const r = boxRef.current.getBoundingClientRect();
    const px = Math.max(0, Math.min(img.naturalWidth, (t.clientX - r.left) / scale));
    const py = Math.max(0, Math.min(img.naturalHeight, (t.clientY - r.top) / scale));
    setQuad((q) => q.map((pt, i) => (i === drag ? [px, py] : pt)));
  };
  // A release outside the modal (or outside the window) must still end the drag, or a
  // handle stays glued to the cursor.
  useEffect(() => {
    if (drag == null) return;
    const end = () => setDrag(null);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("touchend", end);
    window.addEventListener("blur", end);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("touchend", end);
      window.removeEventListener("blur", end);
    };
  }, [drag]);

  const finish = async (straighten) => {
    setBusy(true);
    try {
      if (!straighten) { onDone(file); return; }
      const out = ssWarpQuad(img, quad, aspect, 1024);
      // A quad the solver refuses (collinear/duplicate corners) or a warp that produced
      // nothing usable falls back to the original photo rather than uploading a ruined one.
      if (!out) { onDone(file); return; }
      const blob = await new Promise((res) => out.toBlob(res, "image/jpeg", 0.9));
      // JPEG, not WEBP: Safari's canvas WEBP encoder support is patchy and a silent
      // null blob here would look like a broken upload.
      onDone(blob ? new File([blob], "straightened.jpg", { type: "image/jpeg" }) : file);
    } finally { setBusy(false); }
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.75)", zIndex: 1200, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
      onPointerMove={moveTo} onPointerUp={() => setDrag(null)} onTouchMove={moveTo} onTouchEnd={() => setDrag(null)}>
      <div style={{ background: "#FFF", borderRadius: 14, padding: 18, maxWidth: 560, width: "100%", maxHeight: "92vh", overflowY: "auto" }}>
        <div style={{ fontWeight: 800, fontSize: 16, color: "#0F172A", marginBottom: 4 }}>Straighten this photo</div>
        <p style={{ margin: "0 0 12px", fontSize: 12.5, color: "#475569", lineHeight: 1.5 }}>
          Drag the four dots onto the corners of the door itself. We'll square it up so it sits flat on the building in 3D.
          If the photo is already straight on, just use it as-is.
        </p>
        {err && <div style={{ fontSize: 13, color: "#DC2626", fontWeight: 600 }}>{err}</div>}
        {!img && !err && <div style={{ fontSize: 13, color: "#64748B" }}>Loading photo…</div>}
        {img && (
          <div ref={boxRef} style={{ position: "relative", width: dispW, height: dispH, margin: "0 auto", userSelect: "none", touchAction: "none" }}>
            <img src={img.src} alt="" style={{ width: dispW, height: dispH, display: "block", borderRadius: 6 }} draggable={false} />
            <svg viewBox={`0 0 ${dispW} ${dispH}`} style={{ position: "absolute", inset: 0, width: dispW, height: dispH, pointerEvents: "none" }}>
              <polygon points={quad.map(([x, y]) => `${x * scale},${y * scale}`).join(" ")} fill="rgba(124,58,237,0.16)" stroke="#7C3AED" strokeWidth="2" />
            </svg>
            {quad.map(([x, y], i) => (
              <div key={i} onPointerDown={(e) => { if (e.currentTarget.setPointerCapture && e.pointerId != null) { try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_e) {} } setDrag(i); }} onTouchStart={() => setDrag(i)}
                style={{ position: "absolute", left: x * scale - 9, top: y * scale - 9, width: 18, height: 18, borderRadius: "50%", background: "#7C3AED", border: "2px solid #FFF", boxShadow: "0 1px 4px rgba(0,0,0,0.4)", cursor: "grab" }} />
            ))}
          </div>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14, flexWrap: "wrap" }}>
          <button type="button" onClick={onCancel} disabled={busy} style={S.btn("#F1F5F9", "#334155")}>Cancel</button>
          <button type="button" onClick={() => finish(false)} disabled={busy} style={S.btn("#F1F5F9", "#334155")}>Use as-is</button>
          <button type="button" onClick={() => finish(true)} disabled={busy || !img}
            style={{ background: busy ? "#9CA3AF" : "#7C3AED", color: "#FFF", border: "none", borderRadius: 8, padding: "8px 16px", fontSize: 13, fontWeight: 800, cursor: busy ? "wait" : "pointer" }}>
            {busy ? "Working…" : "Straighten & use"}
          </button>
        </div>
      </div>
    </div>
  );
}

// 3D Design tab. Replaced a "3rd Qtr" coming-soon panel: 3D ships, so this reports the
// only thing a builder can act on — which of their styles has a 3D look of its own, and
// which is still falling back to a generic shape. Read-only by design; setting a look
// needs the live 3D preview, which lives in Settings -> Designer -> 3D.
function Studio3DStatus({ clientId, canAdmin, navigate }) {
  const [state, setState] = useState({ loading: true, err: null, styles: [] });
  useEffect(() => {
    let dead = false;
    // The catalog action is gated settings_structures:view (portal-settings GATES), which a
    // sales rep or driver does not hold. Before this guard, every non-admin staff member of
    // a 3D-granted tenant opened this tab onto a bare 403 message (audit 2026-08-19) -- the
    // status list is an ADMIN calibration surface, so skip the fetch entirely for everyone
    // else and let the static copy below stand on its own.
    if (!canAdmin) { setState({ loading: false, err: null, styles: [] }); return () => { dead = true; }; }
    (async () => {
      try {
        const { data, error } = await sb.functions.invoke("portal-settings", { body: { action: "catalog" } });
        if (error) throw new Error(error.message || "Could not load your styles.");
        if (!data || !data.ok) throw new Error((data && data.error) || "Could not load your styles.");
        if (!dead) setState({ loading: false, err: null, styles: data.styles || [] });
      } catch (e) {
        if (!dead) setState({ loading: false, err: e.message, styles: [] });
      }
    })();
    return () => { dead = true; };
  }, [clientId]);

  const done = state.styles.filter((s) => s.d3).length;
  return (
    <div style={{ maxWidth: 860, margin: "0 auto", width: "100%" }}>
      <h2 style={{ margin: "0 0 6px", fontSize: 20, fontWeight: 800, color: "#0F172A" }}>3D Design</h2>
      <p style={{ margin: "0 0 16px", fontSize: 13.5, color: "#475569", lineHeight: 1.5 }}>
        Customers can spin their design in 3D and see their own size, colors, doors and windows on the building.
        Photos you upload for a door or window are shown on that door in 3D, so it looks like the one you actually sell.
        Give each building style its own 3D look below and the shape matches your real buildings too.
      </p>
      {/* Grey blocks in the shape of the answer, not the word "Loading your styles…" over an
          empty page. Getting to that answer costs TWO serial round-trips and neither is
          short: this component only mounts once `view3dUnlocked` resolves, which is an
          await on portal-billing action:"status" (09-shell.jsx), and only THEN does the
          catalog fetch above start — one edge call that fans out ten table reads plus a
          second wallet round-trip, of which this component reads `data.styles` and nothing
          else. The heading and the explainer already paint immediately; this stops the part
          that actually answers the question from reading as broken while it arrives.
          Card grid, not SkelRows — there is no table here. The widths and the card's own
          background/border/padding mirror the real row below, so nothing shifts on arrival.
          Admin-gated to match the fetch's own guard at the top of the effect: a sales rep
          never starts that request, so they must never be shown a list coming that isn't. */}
      {state.loading && canAdmin && (
        <>
          <SkelBar w={190} h={10} style={{ marginBottom: 8 }} />
          <div style={{ display: "grid", gap: 8 }}>
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, background: "#FFF", border: "1px solid #E2E8F0", borderRadius: 10, padding: "10px 12px" }}>
                <SkelBar w={48} h={36} style={{ borderRadius: 6, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <SkelBar w="38%" h={12} />
                  <SkelBar w="60%" h={10} style={{ marginTop: 7 }} />
                </div>
                <SkelBar w={86} h={28} style={{ borderRadius: 8, flexShrink: 0 }} />
              </div>
            ))}
          </div>
        </>
      )}
      {state.err && <div style={{ fontSize: 13, color: "#DC2626", fontWeight: 600 }}>{state.err}</div>}
      {!canAdmin && !state.loading && (
        <div style={{ fontSize: 13, color: "#64748B" }}>
          Your customers see 3D on the designer already. Setting up each style's 3D look is an
          admin job — ask an admin or the owner if a style looks off.
        </div>
      )}
      {canAdmin && !state.loading && !state.err && state.styles.length === 0 && (
        <div style={{ fontSize: 13, color: "#64748B" }}>No building styles yet — add one in Settings → Structures first.</div>
      )}
      {canAdmin && !state.loading && !state.err && state.styles.length > 0 && (
        <>
          <div style={{ fontSize: 12.5, color: "#475569", fontWeight: 700, marginBottom: 8 }}>
            {done} of {state.styles.length} styles have their own 3D look
          </div>
          <div style={{ display: "grid", gap: 8 }}>
            {state.styles.map((s) => {
              const photos = Array.isArray(s.d3_photos) ? s.d3_photos.filter(Boolean).length : 0;
              return (
                <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 12, background: "#FFF", border: "1px solid #E2E8F0", borderRadius: 10, padding: "10px 12px" }}>
                  {s.image_url
                    ? <img src={s.image_url} alt="" style={{ width: 48, height: 36, objectFit: "cover", borderRadius: 6, border: "1px solid #E2E8F0", flexShrink: 0 }} />
                    : <div style={{ width: 48, height: 36, borderRadius: 6, border: "1px solid #E2E8F0", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>🏠</div>}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 14, color: "#0F172A" }}>{s.label}{!s.active && <span style={{ color: "#94A3B8", fontWeight: 400 }}> — hidden</span>}</div>
                    <div style={{ fontSize: 12, color: s.d3 ? "#047857" : "#94A3B8", fontWeight: 600 }}>
                      {s.d3
                        ? `3D look set${s.d3.roof && s.d3.roof.type ? ` — ${s.d3.roof.type} roof` : ""}${photos ? ` · ${photos} reference photo${photos === 1 ? "" : "s"}` : ""}`
                        : "Using a generic shape — set its 3D look to match your real building"}
                    </div>
                  </div>
                  {canAdmin && (
                    <button type="button" onClick={() => navigate("settings", "designer")}
                      style={{ flexShrink: 0, background: s.d3 ? "#F1F5F9" : "#7C3AED", color: s.d3 ? "#334155" : "#FFF", border: s.d3 ? "1px solid #E2E8F0" : "none", borderRadius: 8, padding: "7px 13px", fontSize: 12.5, fontWeight: 800, cursor: "pointer" }}>
                      {s.d3 ? "Adjust" : "Set up 3D"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          {canAdmin && (
            <p style={{ margin: "14px 0 0", fontSize: 12.5, color: "#64748B", lineHeight: 1.5 }}>
              Setting a style's 3D look happens in <strong>Settings → Designer → 3D</strong> —
              it needs the live 3D preview so you can see each change on a real building as you make it.
            </p>
          )}
        </>
      )}
    </div>
  );
}

// Settings -> Designer. Everything that CONFIGURES the designer, as opposed to using it.
// Today that is one section: 3D Style Calibration, which used to ride at the top of the
// Designer tab as a full-bleed yellow bar sitting over every design anyone opened. It is a
// setup surface -- done once per style, then never again -- so it belongs with the rest of
// the setup rather than over the tool the sales team uses all day (Ahsan, 2026-08-21).
//
// The panel itself still lives INSIDE the designer component, because it needs the live 3D
// preview and the resolved style list. `calibrationOnly` mounts that component for this one
// surface: no toolbar, no canvas, no estimate. `setup3d` is the same contract PortalApp
// already builds -- it is null unless the caller may administer the tenant AND the tenant
// holds the view_3d grant, so this tab degrades to an explanation rather than an empty box.
// ── The designer module, on demand ───────────────────────────────────────────────────────
// It is no longer a <script> in portal.html (see the ss/designer-src note there): 437 KB that
// backs one tab was being downloaded, parsed and executed on every Orders, Billing and
// Settings page load. window.ssLoadDesigner() injects it the first time a designer surface
// renders, and 01-core prefetches it once the portal is idle, so this hook is normally
// answering from cache rather than starting a download.
//
// THREE states, not two. `null` while it is coming is NOT the same as "it failed", and
// rendering the old "the designer failed to load — refresh the page" message during a normal
// load would tell every user their designer is broken for as long as the fetch takes.
//
// ⚠️ THIS MUST BE CALLED BEFORE ANY EARLY RETURN in its component. Both callers below used to
// guard on `if (!SS) return ...` as their first statement; a hook underneath that guard runs
// on some renders and not others, which is React error #310 and a white screen for the whole
// page — this repo has shipped that bug before.
function useDesigner() {
  const [state, setState] = useState(() => (window.StructureStudio ? "ready" : "loading"));
  useEffect(() => {
    if (window.StructureStudio) return;
    let alive = true;
    window.ssLoadDesigner()
      .then(() => { if (alive) setState("ready"); })
      .catch(() => { if (alive) setState("failed"); });
    return () => { alive = false; };
  }, []);
  // Read the global rather than closing over the resolved value: it is the same object, and
  // this keeps the "already loaded" first render free of any promise at all.
  return { SS: state === "ready" ? window.StructureStudio : null, failed: state === "failed" };
}

// Shown while the module is in flight. Deliberately plain text and no spinner animation: on a
// warm cache this is on screen for a frame or two, and a spinner that flashes reads as
// breakage.
function DesignerLoading() {
  return <div style={{ padding: 40, textAlign: "center", color: "#64748B", fontSize: 14 }}>Loading the designer…</div>;
}

function DesignerSettings({ clientId, setup3d = null }) {
  const { SS, failed } = useDesigner();
  const card = { background: "#FFF", border: "1px solid #E2E8F0", borderRadius: 12, padding: "16px 18px", marginBottom: 14 };
  return (
    // 1240 matches .ss-inner's own cap (portal.html), so this reads "as wide as every other
    // settings page" rather than a number of its own. It was 1080, which cost the calibration
    // form ~160px it now needs: since 2026-08-22 the 3D preview docks BESIDE the form.
    <div style={{ maxWidth: 1240 }}>
      <div style={card}>
        <div style={{ fontSize: 15, fontWeight: 800, color: "#0F172A", marginBottom: 4 }}>3D</div>
        <p style={{ margin: "0 0 14px", fontSize: 12.5, color: "#64748B", lineHeight: 1.55 }}>
          Give each building style its own 3D look so what customers spin on screen matches the
          buildings you actually sell. Set once per style — the designer picks it up everywhere.
        </p>
        {!SS && !failed && (
          <div style={{ fontSize: 13, color: "#64748B" }}>Loading the designer…</div>
        )}
        {failed && (
          <div style={{ fontSize: 13, color: "#64748B" }}>
            The designer failed to load — refresh the page. (structure-studio.component.js must be served alongside portal.html.)
          </div>
        )}
        {SS && !setup3d && (
          <div style={{ fontSize: 13, color: "#64748B", lineHeight: 1.55 }}>
            3D isn't turned on for this account yet. Once it is, each of your building styles can be
            tuned here against a live 3D preview.
          </div>
        )}
        {/* No wrapper here on purpose. The calibration row's 3D column is position:sticky, and
            an overflow:hidden ancestor becomes that child's SCROLLPORT — which never scrolls,
            so sticky silently does nothing at all and the panel just scrolls away with the
            form. The card above already frames this section, and the panel supplies its own
            #FFFBEB fill and #FCD34D bottom rule. */}
        {SS && setup3d && <SS clientId={clientId} embedded calibrationOnly setup3d={setup3d} view3d />}
      </div>
    </div>
  );
}

function DesignerTab({ clientId, onSaved, openDesign = null, setup3d = null, view3d = false, onOpenOrder = null, canPushInvoice = false }) {
  // Hook FIRST — see useDesigner's note. The two returns below are exactly the early guards
  // that make putting anything stateful under them a white screen.
  const { SS, failed } = useDesigner();
  if (!SS) {
    return failed
      ? <div style={{ padding: 40, textAlign: "center", color: "#64748B", fontSize: 14 }}>The designer failed to load — refresh the page. (structure-studio.component.js must be served alongside portal.html.)</div>
      : <DesignerLoading />;
  }
  return (
    <div style={{ maxWidth: 1080, margin: "0 auto", width: "100%" }}>
      {/* onOpenOrder/canPushInvoice power Push to Invoice on the success screen. The host
          owns both on purpose: only the shell knows this user's Orders access, and only it
          can navigate without unmounting the designer (which would discard the design). */}
      <SS clientId={clientId} embedded onSaved={onSaved} openDesign={openDesign} setup3d={setup3d} view3d={view3d}
        onOpenOrder={onOpenOrder} canPushInvoice={canPushInvoice} />
    </div>
  );
}

