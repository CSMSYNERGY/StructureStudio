// Drives Settings -> Designer -> 3D in a REAL browser against the SHIPPED compiled portal,
// with no Supabase account and no login.
//
// WHY THIS EXISTS. Every earlier attempt to verify this panel needed a magic-link token, and
// minting one is refused by the permission gate - so the calibration surface has historically
// shipped compiled-and-linted but never driven. Stubbing Supabase at the NETWORK layer removes
// the need for auth entirely while still exercising portal.app.compiled.js and
// structure-studio.component.compiled.js, which are the artifacts the browser actually runs. If
// a change sits in portal/*.jsx or StructureStudio.jsx and was never compiled, this harness
// cannot see it - and that is a feature, not a gap.
//
//   1. python -m http.server 8123 --bind 127.0.0.1 --directory <repo root>
//   2. node dev/verify-cal3d.mjs
//
// Exit code 0 = every assertion held and no uncaught page error was raised.
import { chromium } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'

// The walk-around fixture is GENERATED, not committed. dev/ is uploaded to the Workers asset
// bundle (it is not in .assetsignore, unlike tests/), so a checked-in clip would be a public
// 113KB download on every tenant's site to serve one local harness. ffmpeg is already on this
// machine; a run without it skips the video half rather than failing the whole harness.
const CLIP = 'dev/scan-fixtures/walk-around-stub.mp4'
function ensureClip() {
  if (existsSync(CLIP)) return true
  try {
    mkdirSync('dev/scan-fixtures', { recursive: true })
    // 8 seconds: ssExtractOrbitFrames refuses anything under 4. The hue sweep gives the frame
    // chooser real luma change to spread its picks across, which is what it does on a lap.
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=15:duration=8',
      '-vf', 'hue=H=2*PI*t/8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', CLIP])
    return true
  } catch (_e) {
    return false
  }
}

// An oversized, INCOMPRESSIBLE photo at a real phone resolution. Noise, not a test pattern: a
// gradient compresses to a few hundred KB at any size and so never reaches the fallback this
// fixture exists to catch. Lands around 8.8MB, which is what a 12MP camera actually produces.
const BIG = 'dev/scan-fixtures/big-photo.jpg'
function ensureBig() {
  if (existsSync(BIG)) return true
  try {
    mkdirSync('dev/scan-fixtures', { recursive: true })
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi',
      '-i', 'nullsrc=size=4032x3024,geq=random(1)*255:128:128', '-frames:v', '1', '-q:v', '1', BIG])
    return true
  } catch (_e) { return false }
}

const BASE = process.env.SS_BASE || 'http://127.0.0.1:8123'
const REF = 'jzeamjbhdrsbygdnphbm'
const CLIENT = 'pw-demo-barns'

const results = []
const ok = (name, pass, note) => {
  results.push({ name, pass, note })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${note ? '   [' + note + ']' : ''}`)
}

// A session in the exact shape supabase-js keeps in localStorage. The JWT is never verified by
// anything in this run - every call that would carry it is intercepted below - but it has to
// PARSE, because the client decodes `exp` to decide whether to refresh mid-run.
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (p) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(p)}.c3R1Yg`
const EXP = 4102444800 // 2100-01-01
const SESSION = {
  access_token: jwt({ sub: '00000000-0000-4000-8000-000000000001', role: 'authenticated', email: 's@e.com', exp: EXP }),
  token_type: 'bearer', expires_in: 999999999, expires_at: EXP, refresh_token: 'r',
  user: { id: '00000000-0000-4000-8000-000000000001', aud: 'authenticated', role: 'authenticated', email: 's@e.com', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' },
}

// The tenant's one style, deliberately with NO photos and NO video frames, so the run starts at
// the gate's most-closed state and every step of the unlock has to be earned.
const STYLE_ROW = {
  id: 's1', key: 'barn', label: 'Barn', code: 'BRN', image_url: null, active: true, updated_at: '2026-09-14T10:00:00.000+00:00',
  show_image_on_estimate: true, d3: null, d3_photos: [], d3_video_frames: [],
  model_url: null, model_status: 'none', model_uploaded_at: null, model_locked_at: null,
  model_meta: null, taxable: true,
}

const CONFIG = {
  branding: { companyName: 'PW Demo Barns', accentColor: '#8B4513', headerBg: '#FFFFFF' },
  contactFields: [{ key: 'name', label: 'Name', required: true }],
  buildingStyles: [
    { value: 'barn', label: 'Barn', sizes: [{ label: '12x16', w: 12, h: 16, price: 5000 }] },
    { value: 'shed', label: 'Shed', sizes: [{ label: '10x12', w: 10, h: 12, price: 3000 }] },
    { value: 'cabin', label: 'Cabin', sizes: [{ label: '12x20', w: 12, h: 20, price: 7000 }] },
  ],
  defaultSizes: [{ label: '12x16', w: 12, h: 16, price: 5000 }],
  options: [],
  layoutItems: { door: { label: 'Door', icon: 'D', color: '#8B4513', width: 40, height: 12, shortLabel: 'D' } },
  wallHeightFt: 7,
}

// A SECOND style, already carrying a saved walk-around and photos. It exists for one reason:
// the refetch race can only be seen with two styles, because the symptom is style A's frames
// landing in style B.
const STYLE_ROW2 = {
  id: 's2', key: 'shed', label: 'Shed', code: 'SHD', image_url: null, active: true, updated_at: '2026-09-14T10:00:00.000+00:00',
  show_image_on_estimate: true, d3: null,
  d3_photos: ['http://127.0.0.1:8123/__stub/img-90.png', 'http://127.0.0.1:8123/__stub/img-91.png', 'http://127.0.0.1:8123/__stub/img-92.png', 'http://127.0.0.1:8123/__stub/img-93.png'],
  d3_video_frames: ['http://127.0.0.1:8123/__stub/img-94.png', 'http://127.0.0.1:8123/__stub/img-95.png', 'http://127.0.0.1:8123/__stub/img-96.png', 'http://127.0.0.1:8123/__stub/img-97.png', 'http://127.0.0.1:8123/__stub/img-98.png'],
  model_url: null, model_status: 'none', model_uploaded_at: null, model_locked_at: null,
  model_meta: null, taxable: true,
}

// A THIRD style: a saved walk-around and NO photos (review, 2026-09-16). Since photos became
// optional this is a complete input on its own, and nothing else covers it: Barn has four photos
// by the time it is reopened, and Shed was saved with four. Only ever opened at the very end of
// the run, and never saved, so no earlier block sees it.
const STYLE_ROW3 = {
  id: 's3', key: 'cabin', label: 'Cabin', code: 'CBN', image_url: null, active: true, updated_at: '2026-09-14T10:00:00.000+00:00',
  show_image_on_estimate: true, d3: null,
  d3_photos: [],
  d3_video_frames: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => `${BASE}/__stub/img-c${i}.png`),
  model_url: null, model_status: 'none', model_uploaded_at: null, model_locked_at: null,
  model_meta: null, taxable: true,
}

// Set to a millisecond count to hold the NEXT catalog answer back, which is what turns the
// refetch race from a timing accident into a test.
// `failNext` makes the NEXT n upload attempts reject at the transport layer (a dropped
// connection, not a status), which is what FunctionsFetchError means and what a bad uplink
// actually does. `attempts` counts every attempt including retries.
// `stallPuts` makes the next n signed PUTs HANG - no answer at all, which is what a dead
// connection looks like from the page and what the upload watchdog exists to notice.
const delay = { catalogMs: 0, uploadMs: 0, failNext: 0, noSignedUrl: false, stallPuts: 0, stallMints: 0, stallSaves: 0, stallAllSaves: false, conflictSaves: 0, mediaMs: 0, stallMedia: 0 }
// What the stub hands back as the row's CURRENT spec when a save is refused as stale.
const CONFLICT_D3 = { roof: { type: 'gable', pitch: 0.33 }, wallHeightFt: 8 }
const CONFLICT_VERSION = "2026-09-14T11:11:11.111+00:00"
// Counted separately so a test can prove WHICH route an upload took. The signed route is the
// fast one (raw bytes straight to storage); base64 through the edge function is the fallback.
const attempts = { upload: 0, signedMint: 0, signedPut: 0, stalledPut: 0 }
// Raw bytes of each signed PUT. With the base64 route gone this is the wire measurement.
const putBytes = []
// The HOST of every PUT attempt, stalled ones included, so a test can prove where a retry went.
const putHosts = []
// The HOST of every mint, so a test can prove a stalled one retried through the functions side door.
const mintHosts = []
// The host of every save_style_d3 attempt, and how many media saves were ever in flight at once.
const saveHosts = []
let mediaInFlight = 0, mediaMaxInFlight = 0
// MONOTONIC, never reset. attempts.signedMint is zeroed by individual tests to count one block's
// calls, and reusing it for the URL handed back the same path twice — which calTrimPhotos then
// correctly DE-DUPLICATED, so the image silently never appeared and the test looked like an
// upload failure. The stub must mint a genuinely new URL every time, like the real server does.
let signedSeq = 0
// Uploads by EITHER route, counted MONOTONICALLY and never reset. The pre-existing assertions
// ask "did an image get stored", which is route-agnostic.
//
// ⚠️ IT COUNTS STORES, NOT MINTS, and that distinction arrived the hard way twice. Counting only
// base64 turned these into no-ops the day the signed path landed; then counting MINTS broke them
// again the day minting went bulk, because one mint now covers a whole batch. A PUT is the only
// event that means "an image was stored", so that is what this counts. It is also separate from
// `attempts`, which individual blocks zero to measure themselves.
let storedCount = 0
const uploadCount = () => storedCount
const saveBodies = []
const mediaSaves = []
const saved = {}
const generateCalls = []
const uploads = []

async function main() {
  const hasClip = ensureClip()
  const bigPhoto = ensureBig()
  // channel: "chrome" for the reason playwright.config.mjs already gives - `npx playwright
  // install chromium` has failed repeatedly on this machine, stalling mid-extract and leaving a
  // stale __dirlock that breaks every LATER install. Use the Chrome that is already here.
  const browser = await chromium.launch({
    channel: 'chrome',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  })
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1100 } })
  await ctx.addInitScript(([ref, s]) => {
    try { window.localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)) } catch (_e) {}
  }, [REF, SESSION])
  const page = await ctx.newPage()

  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(e.message))

  const json = (route, body) => route.fulfill({
    status: 200, contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body),
  })

  const apiHandler = async (route) => {
    const req = route.request()
    const url = req.url()
    if (req.method() === 'OPTIONS') {
      return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }, body: '' })
    }
    let body = {}
    try { body = JSON.parse(req.postData() || '{}') } catch (_e) {}

    // A plain BUILDER, not an operator: is_operator false means view3dUnlocked has to come from
    // the entitlement grant, which is the path a real customer takes.
    if (url.includes('/rest/v1/rpc/get_config')) return json(route, CONFIG)
    if (url.includes('/rest/v1/rpc/get_fixtures')) return json(route, [])
    if (url.includes('/rest/v1/rpc/')) return json(route, false)
    if (url.includes('/rest/v1/client_users')) return json(route, [{ client_id: CLIENT, role: 'owner' }])
    if (url.includes('/rest/v1/')) return json(route, [])
    if (url.includes('/auth/v1/user')) return json(route, SESSION.user)
    if (url.includes('/auth/v1/')) return json(route, SESSION)
    if (url.includes('/portal-billing')) {
      // `granted`, not `features` - view3dUnlocked reads granted specifically, and the comment
      // above it in 12-shell.jsx explains why a blanket must never be able to widen it.
      return json(route, { ok: true, entitlement: { granted: ['view_3d'], features: { view_3d: true }, status: 'active' } })
    }
    if (url.includes('/portal-settings')) {
      const a = body.action
      if (a === 'status') {
        return json(route, {
          ok: true, clientId: CLIENT, role: 'owner',
          settings: { business_name: 'PW Demo Barns' },
          config: { company_name: 'PW Demo Barns', accent_color: '#8B4513' },
          access: null, prefs: null,
        })
      }
      if (a === 'catalog') {
        const hold = delay.catalogMs
        delay.catalogMs = 0
        if (hold) await new Promise((r) => setTimeout(r, hold))
        return json(route, { ok: true, aiReady: true, styles: [STYLE_ROW, STYLE_ROW2, STYLE_ROW3], sizes: [], layoutItems: [], fixtures: [], colors: [] })
      }
      if (a === 'style_photo_upload_url') {
        attempts.signedMint++
        mintHosts.push(new URL(url).host)
        if (delay.stallMints > 0 && new URL(url).host === `${REF}.supabase.co`) {
          delay.stallMints--
          setTimeout(() => { route.abort('timedout').catch(() => {}) }, 8000)
          return
        }
        if (delay.noSignedUrl) return json(route, { ok: false, error: 'signed urls off for this test' })
        // BULK. `count` is the whole point of the 2026-09-12 change: one mint for the batch.
        // The single-object fields are still returned alongside, because an older bundle can be
        // talking to this function mid-deploy.
        const want = Math.max(1, Math.min(20, Number(body.count) || 1))
        const uploads = []
        for (let i = 0; i < want; i++) {
          const n = ++signedSeq
          uploads.push({ path: `${CLIENT}/style-photo-${n}.jpg`, token: `tok-${n}`, url: `${BASE}/__stub/img-s${n}.png` })
        }
        return json(route, { ok: true, uploads, path: uploads[0].path, token: uploads[0].token, url: uploads[0].url })
      }
      if (a === 'upload_style_photo') {
        attempts.upload++
        storedCount++
        if (delay.failNext > 0) {
          delay.failNext--
          storedCount--   // that attempt is about to be aborted; it stored nothing
          // route.abort() rejects the fetch, which is exactly how supabase-js produces
          // FunctionsFetchError. Returning a 500 would produce FunctionsHttpError instead and
          // would NOT exercise the retry path.
          return route.abort('connectionfailed')
        }
        // The BASE64 LENGTH is the number that matters: it is what actually crosses the wire,
        // and an upload that times out does so because this is enormous.
        uploads.push({ b64len: (body.imageBase64 || '').length, type: body.imageContentType })
        if (delay.uploadMs) await new Promise((r) => setTimeout(r, delay.uploadMs))
        return json(route, { ok: true, url: `${BASE}/__stub/img-${uploads.length}.png` })
      }
      if (a === 'calibrate_style_ai') {
        generateCalls.push(body)
        const n = (body.photoUrls || []).length
        // A DIFFERENT colour per source, so the video-only run and the combined run each prove
        // their OWN draft reached the spec, rather than the second one reading the first's red.
        return json(route, {
          ok: true,
          d3: { roof: { type: 'gambrel', pitch: 0.5, overhang: 0.8 }, wallHeightFt: 7.5, siding: null, colors: { body: body.source === 'video' ? '#00ff00' : '#ff0000' } },
          frames: n, dropped: 0,
          observed: { roofNote: 'Gambrel, read from the ground.', eave: 'open rafter tails', doors: 'one double, gable end', windows: 'two', vents: 'gable vents', confidence: 'medium' },
          balanceCents: 18000,
        })
      }
      if (a === 'save_style_media') {
        // Mirrors the real action: writes ONLY the media columns, leaves d3 alone, and treats an
        // ABSENT key as "leave that column" rather than as an empty array.
        // Hung, on whichever host: a stalled media save never reaches `mediaSaves`.
        if (delay.stallMedia > 0) {
          delay.stallMedia--
          setTimeout(() => { route.abort('timedout').catch(() => {}) }, 8000)
          return
        }
        mediaSaves.push(body)
        mediaInFlight++
        mediaMaxInFlight = Math.max(mediaMaxInFlight, mediaInFlight)
        if (delay.mediaMs) await new Promise((r) => setTimeout(r, delay.mediaMs))
        mediaInFlight--
        const row = body.styleValue === 'shed' ? STYLE_ROW2 : STYLE_ROW
        if (Array.isArray(body.d3Photos)) row.d3_photos = body.d3Photos
        if (Array.isArray(body.d3VideoFrames)) row.d3_video_frames = body.d3VideoFrames
        // The real action stamps updated_at and echoes it: that version is the portal's next base.
        row.updated_at = new Date().toISOString()
        return json(route, { ok: true, updatedAt: row.updated_at, ...(Array.isArray(body.d3Photos) ? { d3Photos: body.d3Photos } : {}), ...(Array.isArray(body.d3VideoFrames) ? { d3VideoFrames: body.d3VideoFrames } : {}) })
      }
      if (a === 'save_style_d3') {
        const saveHost = new URL(url).host
        saveHosts.push(saveHost)
        if (delay.stallAllSaves || (delay.stallSaves > 0 && saveHost === `${REF}.supabase.co`)) {
          if (!delay.stallAllSaves) delay.stallSaves--
          setTimeout(() => { route.abort('timedout').catch(() => {}) }, 8000)
          return
        }
        if (delay.conflictSaves > 0) {
          delay.conflictSaves--
          saveBodies.push(body)
          return route.fulfill({
            status: 409, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
            body: JSON.stringify({ error: 'This style was changed after you opened it.', conflict: true, stale: ['d3'], current: { updatedAt: CONFLICT_VERSION, d3: CONFLICT_D3, d3Photos: STYLE_ROW.d3_photos || [], d3VideoFrames: STYLE_ROW.d3_video_frames || [] } }),
          })
        }
        saveBodies.push(body)
        saved.d3Photos = body.d3Photos || null
        saved.d3VideoFrames = body.d3VideoFrames || null
        STYLE_ROW.d3_photos = saved.d3Photos || []
        STYLE_ROW.d3_video_frames = saved.d3VideoFrames || []
        STYLE_ROW.updated_at = new Date().toISOString()
        return json(route, { ok: true, updatedAt: STYLE_ROW.updated_at, d3: body.d3, d3Photos: saved.d3Photos, d3VideoFrames: saved.d3VideoFrames })
      }
      return json(route, { ok: true })
    }
    return json(route, { ok: true })
  }
  await page.route(`**/${REF}.supabase.co/**`, apiHandler)
  // The edge-function side door: onUploadPhotoBatch mints through it when the main host stalls.
  await page.route(`**/${REF}.functions.supabase.co/**`, apiHandler)

  // The signed-URL PUT, on EITHER storage host. Since 2026-09-14 the portal sends it by XHR and
  // retries a stalled one on `<ref>.storage.supabase.co`, Supabase's direct storage hostname, so
  // both must be stubbed or a retry sails out to the real internet with a fake token.
  const putHandler = (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') {
      return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }, body: '' })
    }
    putHosts.push(new URL(req.url()).host)
    if (delay.stallPuts > 0) {
      delay.stallPuts--
      attempts.stalledPut++
      // Never answered. Released later only so the route does not dangle past the run; by then
      // the page has long since aborted it.
      setTimeout(() => { route.abort('timedout').catch(() => {}) }, 8000)
      return
    }
    attempts.signedPut++
    storedCount++
    try { putBytes.push((req.postDataBuffer() || Buffer.alloc(0)).length) } catch (_e) { putBytes.push(0) }
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ Key: 'branding/x' }) })
  }
  await page.route(`**/${REF}.supabase.co/storage/v1/object/upload/sign/**`, putHandler)
  await page.route(`**/${REF}.storage.supabase.co/storage/v1/object/upload/sign/**`, putHandler)

  // A real 1x1 PNG for every uploaded image, so nothing 404s in the thumbnail strips and the
  // <img> elements the assertions count are genuinely rendering something.
  await page.route('**/__stub/img-s*.png', (route) => route.fulfill({
    status: 200, contentType: 'image/png',
    body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
  }))
  await page.route('**/__stub/img-*.png', (route) => route.fulfill({
    status: 200, contentType: 'image/png',
    body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
  }))

  // CLICKED, not deep-linked. python -m http.server serves files, not the Workers routes, so
  // /portal/settings/designer 404s on this harness even though it is a real URL on the live
  // site - the app owns that path client-side. Walk the shell the way a builder does.
  await page.goto(`${BASE}/portal.html`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !document.body.innerText.includes('Loading your business'), { timeout: 40000 })
  await page.getByText('Settings', { exact: true }).last().click()
  await page.waitForTimeout(1500)
  // Two elements say "Designer": the workspace nav item and the Settings sub-page. The last one
  // in document order is the sub-page - clicking the first opens the DESIGNER TAB instead, which
  // renders a config error and looks exactly like this harness being broken.
  await page.getByText('Designer', { exact: true }).last().click()
  await page.waitForFunction(() => document.body.innerText.includes('3D Style Calibration'), { timeout: 40000 })

  const text = () => page.evaluate(() => document.body.innerText)
  // The image count as the page currently shows it. Waits are written against THIS rather than
  // a literal, because earlier blocks add and remove images and a hardcoded "more than 4"
  // silently becomes a wait that can never be satisfied.
  const imgCount = async () => Number(((await text()).match(/(\d+) of 12 used/) || [])[1] || 0)
  const waitForImages = async (n) => page.waitForFunction(
    (want) => { const m = document.body.innerText.match(/(\d+) of 12 used/); return m && Number(m[1]) === want },
    n, { timeout: 60000 })
  const line = async (starts) => (await text()).split('\n').find((l) => l.trim().startsWith(starts)) || ''

  ok('calibration panel renders', (await text()).includes('3D Style Calibration'))

  await page.getByRole('button', { name: 'Barn', exact: true }).first().click()
  await page.waitForTimeout(1200)

  let t = await text()
  ok('step 1 is the video section', t.includes('Step 1') && t.includes('Walk-around video'))
  ok('step 2 is a SEPARATE images section', t.includes('Step 2') && t.includes('Photos of the same building'))
  // VIDEO REQUIRED, PHOTOS OPTIONAL (2026-09-16). Ahsan: "make video compulsory and images
  // optional to generate the 3d model". Until then these read "needed" and "0 of 4 added", and
  // the gate line asked for both.
  ok('the video reads as REQUIRED', (await page.getByText('required', { exact: true }).count()) === 1)
  ok('the photos read as OPTIONAL, not as a count still owed',
    (await page.getByText('optional', { exact: true }).count()) === 1 && !/of 4 added|is the minimum|\d+ minimum/.test(t),
    (await line('Pick several')).trim())
  ok('the four named slots are GONE', !t.includes('Left side') && !t.includes('Right side'), 'no Front/Left side/Right side/Back labels')

  const gen = page.getByRole('button', { name: /Generate the 3D model/ })
  // A BOUNDED wait for the button to unlock that answers true or false instead of throwing
  // (review, 2026-09-16). An unbounded wait on something the gate never allows dies as a
  // TimeoutError, and a harness that dies before its named FAIL does not say what broke.
  const genUnlocks = (ms = 15000) => page.waitForFunction(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => /Generate the 3D model/.test(x.textContent || ''))
    return Boolean(b) && !b.disabled
  }, null, { timeout: ms }).then(() => true, () => false)
  ok('generate button is RENDERED, never hidden', (await gen.count()) === 1)
  ok('generate disabled with nothing supplied', await gen.first().isDisabled())
  ok('with nothing supplied, the gate asks for the VIDEO and calls photos optional',
    (await line('Add a walk-around video in step 1 — it is the one thing a generation needs. Photos in step 2 are optional.')).length > 0,
    (await line('Add a walk-around')).trim())

  // ── VIDEO ONLY: the walk-around on its own unlocks Generate (2026-09-16) ─────────────────
  // The case the 09-10 gate refused and the whole point of this change. Staged BEFORE any photo
  // exists, so nothing else on the page can be what unlocked the button.
  let soloFrames = 0
  if (hasClip) {
    const g0 = generateCalls.length
    await page.locator('input[type=file][accept="video/*"]').setInputFiles(CLIP)
    await page.waitForFunction(() => /\d+ views ready/.test(document.body.innerText), null, { timeout: 60000 })
    // THE UNLOCK IS RECORDED BEFORE ANYTHING ELSE IS WAITED ON (review, 2026-09-16). This block
    // used to wait for the Ready line first, so against a bundle with the old gate the run died
    // on a TimeoutError and never printed the FAIL below. Everything that needs the button
    // unlocked is skipped, as one named FAIL, when it never unlocks.
    const soloUnlocked = await genUnlocks()
    t = await text()
    soloFrames = Number((t.match(/(\d+) views ready/) || [])[1] || 0)
    // The walk-around strip is alt="View N", in walk order - the order the set must be sent in.
    const frameSrcs = await page.evaluate(() => Array.from(document.querySelectorAll('img[alt^="View "]')).map((i) => i.getAttribute('src')))
    ok('VIDEO ONLY, NO PHOTOS: GENERATE IS UNLOCKED',
      soloUnlocked && soloFrames >= 4 && (await imgCount()) === 0,
      `${soloFrames} frames, ${await imgCount()} photos`)
    if (!soloUnlocked) {
      ok('the video-only press and the video + one photo run', false, 'skipped: Generate never unlocked with a video alone')
    } else {
      await page.waitForFunction(() => /^Ready —/m.test(document.body.innerText), null, { timeout: 30000 }).catch(() => {})
      ok('the ready line counts the walk-around and calls photos optional',
        (await line('Ready —')).trim() === `Ready — one generation, reading the ${soloFrames} walk-around views. Photos in step 2 are optional.`,
        (await line('Ready —')).trim())
      ok('staging the walk-around charged nothing', generateCalls.length === g0, `${generateCalls.length - g0} generations`)

      await gen.first().click()
      await page.waitForFunction(() => / views? from your walk-around\./.test(document.body.innerText), null, { timeout: 30000 })
      t = await text()
      const solo = generateCalls[g0] || {}
      ok('ONE PRESS, ONE GENERATION, from the video alone', generateCalls.length === g0 + 1, `${generateCalls.length - g0}`)
      // "video", not "combined": combinedShapePrompt opens "from two sources", which is false with
      // no photos beside the walk. VIDEO_SHAPE_PROMPT describes a frames-only set exactly.
      ok('A WALK ON ITS OWN IS SENT AS source "video"', solo.source === 'video', String(solo.source))
      ok('IT CARRIES ONLY THE FRAMES, in walk order',
        (solo.photoUrls || []).length === soloFrames && (solo.photoUrls || []).every((u, i) => u === frameSrcs[i]),
        `${(solo.photoUrls || []).length} urls for ${soloFrames} frames`)
      ok('and videoCount is the whole set', solo.videoCount === soloFrames, `videoCount=${solo.videoCount}`)
      ok('the result reads from the walk-around, and invents no photos',
        t.includes(`Read ${soloFrames} views from your walk-around.`) && !t.includes('of your own photos'),
        (await line('Read ')).trim().slice(0, 110))
      ok('the colour sentence credits the views, not photos that were never sent',
        t.includes('Colours are set where the views show them clearly') && !t.includes('Colours are set from the photos'))
      const soloColors = await page.evaluate(() => Array.from(document.querySelectorAll('input[placeholder="#hex or blank"]')).map((el) => el.value || ''))
      ok('A COLOUR READ FROM THE WALK-AROUND ALONE REACHES THE SPEC', soloColors.some((c) => c.toLowerCase() === '#00ff00'), soloColors.filter(Boolean).join(',') || 'none set')
      ok('the observed notes render for a video-only run', t.includes('What the model saw') && t.includes('Gambrel, read from the ground.'))

      // ── VIDEO + ONE PHOTO: still unlocked, and the photo rides after the frames ────────────
      await page.locator('input[type=file][accept="image/*"]').setInputFiles([{ name: 'one.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('one-photo') }])
      await waitForImages(1)
      await page.waitForFunction(() => /^Ready — .* and 1 of your photos\.$/m.test(document.body.innerText), null, { timeout: 30000 })
      const onePhoto = await page.evaluate(() => Array.from(document.querySelectorAll('img[alt^="Image "]')).map((i) => i.getAttribute('src')))
      ok('VIDEO + ONE PHOTO: GENERATE IS STILL UNLOCKED', !(await gen.first().isDisabled()))
      ok('the ready line counts both sources',
        (await line('Ready —')).trim() === `Ready — one generation, reading ${soloFrames + 1} views: ${soloFrames} from the walk-around and 1 of your photos.`,
        (await line('Ready —')).trim())
      const g1 = generateCalls.length
      await gen.first().click()
      await page.waitForFunction(() => /from your walk-around and 1 of your own photos/.test(document.body.innerText), null, { timeout: 30000 })
      const withOne = generateCalls[g1] || {}
      ok('ONE PRESS, ONE GENERATION, with one photo', generateCalls.length === g1 + 1, `${generateCalls.length - g1}`)
      ok('WITH A PHOTO BESIDE THE WALK, THE SOURCE IS "combined"', withOne.source === 'combined', String(withOne.source))
      ok('FRAMES FIRST, THEN THE ONE PHOTO',
        (withOne.photoUrls || []).length === soloFrames + 1
          && (withOne.photoUrls || []).slice(0, soloFrames).every((u, i) => u === frameSrcs[i])
          && (withOne.photoUrls || [])[soloFrames] === onePhoto[0]
          && withOne.videoCount === soloFrames,
        `${(withOne.photoUrls || []).length} urls, videoCount=${withOne.videoCount}`)

      // Back to nothing at all, so the photos-only block below starts from the state it describes.
      await page.locator('button[title="Remove this image"]').last().click()
      // Not waitForImages(0): with no photos the counter reads "Pick several at once", so there is
      // no "0 of 12 used" for it to find.
      await page.waitForFunction(() => /Pick several at once/.test(document.body.innerText), null, { timeout: 15000 })
    }
    await page.getByRole('button', { name: 'Remove the video', exact: true }).click()
    await page.waitForFunction(() => !/\d+ views ready/.test(document.body.innerText), null, { timeout: 15000 })
    await page.waitForTimeout(600)
    ok('with the video removed again, Generate locks', await gen.first().isDisabled())
  }

  // ── four photos, still no video ───────────────────────────────────────────────────────
  // ONE picker interaction, FOUR files -- the whole point of the 2026-09-10 change. Setting
  // four files on one input is exactly what a builder shift-selecting four photos produces.
  attempts.signedMint = 0; attempts.signedPut = 0
  const gPhotos = generateCalls.length
  const upPhotos = uploadCount()
  const picker = page.locator('label', { hasText: /Choose images/ }).locator('input[type=file]')
  ok('the image input accepts multiple', await picker.evaluate((el) => el.multiple))
  await picker.setInputFiles([0, 1, 2, 3].map((i) => ({ name: `p${i}.jpg`, mimeType: 'image/jpeg', buffer: Buffer.from(`stub-photo-${i}`) })))
  // The counter is the readout now — the per-batch "N images added" message went when step 2
  // stopped sharing adminCalMsg with the video path and the generation.
  await page.waitForFunction(() => /4 of 12 used/.test(document.body.innerText), { timeout: 30000 })
  await page.waitForTimeout(400)
  t = await text()
  ok('FOUR IMAGES UPLOADED IN ONE GO', t.includes('4 of 12 used'), (await line('4 of 12')).trim())
  // THE SPEED CLAIM, asserted as a COUNT rather than a stopwatch. Four images used to cost four
  // mints plus four PUTs; bulk minting makes it one plus four. A wall-clock assertion would be
  // flaky on a loaded machine and would not say WHY it got faster.
  ok('FOUR IMAGES COST ONE MINT, NOT FOUR', attempts.signedMint === 1, `${attempts.signedMint} mint(s) for ${attempts.signedPut} PUTs`)
  ok('and every one of them was PUT', attempts.signedPut === 4, `${attempts.signedPut} PUTs`)
  ok('four thumbnails render', (await page.locator('img[alt^="Image "]').count()) === 4, `${await page.locator('img[alt^="Image "]').count()} thumbs`)
  ok('thumbnails are numbered, not side-named', (await page.locator('img[alt="Image 2 of 4"]').count()) === 1)
  // Photos are optional, never SUFFICIENT: the 2026-09-16 change must not have opened this.
  ok('PHOTOS ALONE DO NOT UNLOCK GENERATE', await gen.first().isDisabled())
  ok('the gate asks for the video, and says the photos will be read with it',
    (await line('Add a walk-around video in step 1 — a generation needs one. Your 4 images will be read alongside it.')).length > 0,
    (await line('Add a walk-around')).trim())
  // PRESSED ANYWAY, PAST THE ATTRIBUTE (review, 2026-09-16). This was a `click({ force: true })`,
  // and a browser fires no click on a disabled button, so it proved the attribute and nothing
  // else: calGenerate's own refusal never ran. React keeps each element's props on the element,
  // and the Generate button's onClick IS calGenerate, so calling it is exactly the press the
  // attribute would have stopped.
  const handlerPress = await page.evaluate(async () => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => /Generate the 3D model/.test(x.textContent || ''))
    const k = b && Object.keys(b).find((x) => x.startsWith('__reactProps$'))
    if (!k || typeof b[k].onClick !== 'function') return 'no React onClick on the button'
    await b[k].onClick()
    return 'called'
  })
  await page.waitForTimeout(700)
  const gateWords = 'Add a walk-around video in step 1 — a generation needs one. Your 4 images will be read alongside it.'
  ok('A PRESS THAT GETS PAST THE DISABLED ATTRIBUTE SENDS NOTHING', handlerPress === 'called' && generateCalls.length === gPhotos,
    `${handlerPress}; ${generateCalls.length - gPhotos} calls`)
  ok('and calGenerate answers it in the gate\'s own words',
    (await text()).split('\n').filter((l) => l.trim() === gateWords).length === 2, 'hint line plus the message under Save')
  // AND THE HOST'S REFUSAL, the last line before the paid call: onDraftFromCombined in
  // portal/12-shell.jsx throws on a set with no walk-around frames. Reached by walking up from the
  // button to the component the portal handed `setup3d`, and called with the staged photos, which
  // is precisely the set that must never be sent.
  const hostRefusal = await page.evaluate(async () => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => /Generate the 3D model/.test(x.textContent || ''))
    const k = b && Object.keys(b).find((x) => x.startsWith('__reactFiber$'))
    let f = k ? b[k] : null
    while (f && !(f.memoizedProps && f.memoizedProps.setup3d && f.memoizedProps.setup3d.onDraftFromCombined)) f = f.return
    if (!f) return null
    const photos = Array.from(document.querySelectorAll('img[alt^="Image "]')).map((i) => i.getAttribute('src'))
    const attempt = async (videoCount) => {
      try { await f.memoizedProps.setup3d.onDraftFromCombined(photos, 'barn', videoCount); return 'SENT' } catch (e) { return String((e && e.message) || e) }
    }
    return { photos: photos.length, zero: await attempt(0), absent: await attempt(undefined) }
  })
  await page.waitForTimeout(500)
  ok('THE PORTAL HOST REFUSES A SET WITH NO WALK-AROUND, BEFORE ANY REQUEST',
    Boolean(hostRefusal) && hostRefusal.photos === 4
      && /walk-around video is required/.test(hostRefusal.zero) && /walk-around video is required/.test(hostRefusal.absent)
      && generateCalls.length === gPhotos,
    `${JSON.stringify(hostRefusal)}; ${generateCalls.length - gPhotos} calls`)
  ok('adding photos charged no generation', generateCalls.length === gPhotos, `${generateCalls.length - gPhotos} calls`)
  ok('four photo uploads went through the host', uploadCount() - upPhotos === 4, `${uploadCount() - upPhotos} uploads`)

  // ── NINE PHOTOS, NO VIDEO: the hint counts what a walk-around will leave room for ────────
  // Review, 2026-09-16: it said "Your N images will be read alongside it" for any N, but once a
  // lap arrives calGenerateSet keeps at least four frames inside the twelve, so only eight photos
  // are read. Nine is the smallest count where the old sentence was wrong.
  {
    await page.locator('input[type=file][accept="image/*"]').setInputFiles([4, 5, 6, 7, 8].map((i) => ({ name: `p${i}.jpg`, mimeType: 'image/jpeg', buffer: Buffer.from(`stub-photo-${i}`) })))
    await waitForImages(9)
    await page.waitForTimeout(400)
    const nine = 'Add a walk-around video in step 1 — a generation needs one. 8 of your 9 images will be read alongside it, since the walk-around keeps at least 4 of the 12 views.'
    ok('PAST EIGHT PHOTOS, THE HINT PROMISES ONLY THE EIGHT A WALK LEAVES ROOM FOR',
      (await line(nine)).trim() === nine && !(await text()).includes('Your 9 images will be read'),
      (await line('Add a walk-around video in step 1 — a generation needs one. 8')).trim() || (await line('Add a walk-around')).trim())
    ok('nine photos still do not unlock Generate', await gen.first().isDisabled())
    // Back to the four the blocks below describe.
    for (let n = 9; n > 4; n--) {
      await page.locator('button[title="Remove this image"]').last().click()
      await waitForImages(n - 1)
    }
    await page.waitForTimeout(600)
  }

  // ── REGRESSION: the two steps must not block each other ─────────────────────────────────
  // Ahsan hit this with a screenshot: step 1 read "Sending view 2 of 8..." while step 2's button
  // read "Working..." and was disabled. calStageVideo raised the SHARED adminCalBusy flag, which
  // greys out the image picker, so a builder could do nothing for the whole 8-frame upload.
  {
    delay.uploadMs = 900
    const before = uploads.length
    const vidInput = page.locator('label', { hasText: /Choose a different video|Choose a walk-around video/ }).locator('input[type=file]')
    await vidInput.setInputFiles(CLIP)                       // starts a long upload
    await page.waitForFunction(() => /Sent \d+ of \d+ views/.test(document.body.innerText), { timeout: 60000 })
    // Selected on the accept attribute, not the label text: mid-upload BOTH labels contain
    // "Sent N of ...", so a text filter matches the video input too and Playwright refuses.
    const picker2 = page.locator('input[type=file][accept="image/*"]')
    ok('STEP 2 IS USABLE WHILE THE VIDEO UPLOADS', !(await picker2.isDisabled()), 'image input not disabled mid-video')
    // And prove it by actually using it: one more image goes in while frames are still flying.
    const cStart = await imgCount()
    await picker2.setInputFiles([{ name: 'concurrent.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('c') }])
    await waitForImages(cStart + 1)
    ok('an image really uploads DURING a video upload', (await imgCount()) === cStart + 1, `${cStart} -> ${await imgCount()}`)
    await page.waitForFunction(() => /views ready/.test(document.body.innerText), { timeout: 90000 })
    ok('the video still finishes cleanly alongside it', /views ready/.test(await text()), (await line('')).slice(0, 0) || 'ok')
    // Concurrency: with 900ms per upload, 6 frames strictly sequential is >= 5.4s. The pool runs
    // three lanes, so this is a real speed assertion and not just "it finished".
    delay.uploadMs = 0
    ok('every frame of the lap uploaded', uploadCount() - before >= 6, `${uploadCount() - before} uploads`)
    // Put the state back to 4 images so the assertions below still describe what they say.
    await page.locator('img[alt^="Image "]').last().locator('xpath=following-sibling::button').click().catch(async () => {
      await page.locator('button[title="Remove this image"]').last().click()
    })
    await page.waitForTimeout(600)
  }

  // ── REGRESSION: uploads survive a style switch ──────────────────────────────────────────
  // Ahsan: "if i change the tab it losses the progress". openCalEditor re-seeds from the SAVED
  // row, so anything uploaded before the deliberate Save used to be thrown away by one click on
  // another style. Media is persisted as it is added now — WITHOUT committing the d3 spec, which
  // during uploading is a draft nobody has approved.
  {
    const before = mediaSaves.length
    const startCount = await imgCount()
    await page.locator('input[type=file][accept="image/*"]').setInputFiles([{ name: 'keepme.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('keep') }])
    await waitForImages(startCount + 1)
    await page.waitForTimeout(900)
    ok('an upload persists its media immediately', mediaSaves.length > before, `${mediaSaves.length - before} media saves`)
    const last = mediaSaves[mediaSaves.length - 1] || {}
    ok('and it writes ONLY the media, never the spec', !('d3' in last), Object.keys(last).join(','))
    const kept = startCount + 1
    // Switch away and back. The draft is discarded on both hops; only what was persisted returns.
    await page.getByRole('button', { name: 'Shed', exact: true }).first().click()
    await page.waitForTimeout(1200)
    await page.getByRole('button', { name: 'Barn', exact: true }).first().click()
    await page.waitForTimeout(1800)
    ok('THE IMAGES SURVIVE A STYLE SWITCH', (await imgCount()) === kept, `${kept} before, ${await imgCount()} after`)
    await page.locator('button[title="Remove this image"]').last().click()
    await page.waitForTimeout(900)
  }

  // ── REGRESSION: the FAST path is the one actually used ──────────────────────────────────
  // A style photo must go straight into the bucket on a signed URL, not as base64 through an
  // edge function. base64 inflates every byte by 4/3 and hands the caller one all-or-nothing
  // POST with no resume, which is what cost a builder on a ~42KB/s uplink six of nine photos.
  {
    const b64before = attempts.upload
    const startCount = await imgCount()
    attempts.signedMint = 0; attempts.signedPut = 0
    await page.locator('input[type=file][accept="image/*"]').setInputFiles([{ name: 'fast.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('fast-photo') }])
    await waitForImages(startCount + 1)
    ok('A PHOTO GOES STRAIGHT TO STORAGE, NOT THROUGH BASE64', attempts.signedMint === 1 && attempts.signedPut === 1, `${attempts.signedMint} mint, ${attempts.signedPut} put`)
    ok('and the base64 fallback was NOT used', attempts.upload === b64before, `${attempts.upload - b64before} base64 uploads`)
    await page.locator('button[title="Remove this image"]').last().click()
    await page.waitForTimeout(500)
  }

  // ── REGRESSION: the fallback still works when signed URLs cannot be minted ──────────────
  // Minting is itself an invoke, so a connection bad enough to lose it must not lose the
  // feature. Both routes end at the same object in the same bucket.
  {
    const b64before = attempts.upload
    const startCount = await imgCount()
    delay.noSignedUrl = true
    await page.locator('input[type=file][accept="image/*"]').setInputFiles([{ name: 'fallback.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('fallback-photo') }])
    await waitForImages(startCount + 1)
    ok('WHEN SIGNED URLS FAIL, THE OLD PATH STILL LANDS IT', attempts.upload > b64before, `${attempts.upload - b64before} base64 upload(s)`)
    ok('and the builder sees no error', !(await text()).includes('failed:'))
    delay.noSignedUrl = false
    await page.locator('button[title="Remove this image"]').last().click()
    await page.waitForTimeout(500)
  }

  // ── REGRESSION: a flaky uplink must be retried, not surfaced as a failure ───────────────
  // THE BUG THIS GUARDS. `FunctionsFetchError` means the fetch REJECTED — the request never
  // reached the function — so nothing was done twice and retrying is free. Ahsan's link measured
  // about 42KB/s and dropped requests; the pool reported every drop as a permanent failure
  // ("1 of 9 uploaded. 8 failed"), when the old sequential loop had simply STOPPED at the first
  // one and so only ever reported a single failure. The failures were always there; the pool
  // made them visible and then gave up on them.
  {
    const before = uploadCount()
    const startCount = await imgCount()
    const b64start = attempts.upload
    // FORCE THE FALLBACK ROUTE, because that is where the retry actually lives. A signed-URL
    // failure does not throw — onUploadPhoto catches it and falls through to base64 — so with
    // the fast path available this test would drop two attempts nothing was making and pass
    // while proving nothing. Retries guard the LAST route standing.
    delay.noSignedUrl = true
    delay.failNext = 2                       // drop the first two attempts, then let it through
    await page.locator('input[type=file][accept="image/*"]').setInputFiles([{ name: 'flaky.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('flaky-photo') }])
    await waitForImages(startCount + 1)
    ok('A DROPPED UPLOAD IS RETRIED, NOT REPORTED AS FAILED', (await imgCount()) === startCount + 1, `${startCount} -> ${await imgCount()}`)
    ok('it took three attempts to get there', attempts.upload - b64start === 3, `${attempts.upload - b64start} attempts`)
    ok('and no error was shown to the builder', !(await text()).includes('failed:'), (await line('0 of')) || 'clean')
    delay.noSignedUrl = false
    void before
    await page.locator('button[title="Remove this image"]').last().click()
    await page.waitForTimeout(500)
  }

  // ── REGRESSION: a STALLED upload is noticed and retried on the other storage host ────────
  // Ahsan, 2026-09-14: "style photo batch: 0/9 in 485.5s". The connection stopped moving bytes
  // without closing, nothing had a stall timeout, and every retry rode the same dead HTTP/2
  // connection back into the same stall. The watchdog must give up on a silent PUT, and the retry
  // must go to the OTHER hostname, which cannot share that connection.
  {
    const startCount = await imgCount()
    await page.evaluate(() => { window.__ssUploadStallMs = 1500 })
    putHosts.length = 0
    attempts.stalledPut = 0
    delay.stallPuts = 1
    const t = Date.now()
    await page.locator('input[type=file][accept="image/*"]').setInputFiles([{ name: 'stall.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('stall-photo') }])
    await waitForImages(startCount + 1)
    ok('A STALLED UPLOAD IS ABANDONED AND RETRIED', (await imgCount()) === startCount + 1 && attempts.stalledPut === 1,
      `${startCount} -> ${await imgCount()}, ${attempts.stalledPut} stalled, ${Math.round((Date.now() - t) / 100) / 10}s`)
    ok('UPLOADS START ON THE STORAGE HOST, AND A STALL RETRIES ON THE MAIN ONE',
      putHosts.length === 2 && putHosts[0] === `${REF}.storage.supabase.co` && putHosts[1] === `${REF}.supabase.co`, putHosts.join(' -> '))
    ok('and the builder sees no error after a recovered stall', !(await text()).includes('failed:'))
    await page.locator('button[title="Remove this image"]').last().click()
    await page.waitForTimeout(500)
  }

  // ── REGRESSION: a stalled MINT retries through the functions side door ─────────────────
  // The upload URL is minted through the main host, so a wedged main connection used to stop the
  // whole batch before a single byte moved. The second try goes to <ref>.functions.supabase.co.
  {
    const startCount = await imgCount()
    await page.evaluate(() => { window.__ssUploadMintMs = 1500 })
    mintHosts.length = 0
    delay.stallMints = 1
    await page.locator('input[type=file][accept="image/*"]').setInputFiles([{ name: 'mintstall.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('mint-stall') }])
    await waitForImages(startCount + 1)
    ok('A STALLED MINT RETRIES ON THE FUNCTIONS HOST',
      mintHosts.length === 2 && mintHosts[0] === `${REF}.supabase.co` && mintHosts[1] === `${REF}.functions.supabase.co`, mintHosts.join(' -> '))
    ok('and that image still lands with no error', !(await text()).includes('failed:'))
    delay.stallMints = 0
    await page.evaluate(() => { window.__ssUploadMintMs = undefined })
    await page.locator('button[title="Remove this image"]').last().click()
    await page.waitForTimeout(500)
  }

  // ── REGRESSION: a DEAD link fails the batch fast, and says what to do ───────────────────
  // When nothing gets through at all, the batch must stop after two rounds over both hosts rather
  // than walking every image through its own retries - the eight-minute wait, again.
  {
    const startCount = await imgCount()
    putHosts.length = 0
    attempts.stalledPut = 0
    delay.stallPuts = 99
    const t = Date.now()
    await page.locator('input[type=file][accept="image/*"]').setInputFiles([
      { name: 'dead1.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('dead-1') },
      { name: 'dead2.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('dead-2') },
      { name: 'dead3.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('dead-3') },
    ])
    await page.waitForFunction(() => /0 of 3 uploaded/.test(document.body.innerText), null, { timeout: 90000 })
    const secs = Math.round((Date.now() - t) / 100) / 10
    ok('A DEAD LINK FAILS THE BATCH IN SECONDS, NOT MINUTES', secs < 25, `${secs}s with a 1.5s stall budget`)
    ok('it gave up after two rounds, not every retry of every image', attempts.stalledPut <= 7, `${attempts.stalledPut} PUT attempts`)
    ok('and it tells the builder nothing was saved', (await text()).includes('Nothing was saved'), (await line('0 of 3')) || '(no line)')
    ok('no image was added by a dead batch', (await imgCount()) === startCount, `${startCount} -> ${await imgCount()}`)
    delay.stallPuts = 0
    await page.evaluate(() => { window.__ssUploadStallMs = undefined })
  }

  // ── REGRESSION: an oversized phone photo must be SHRUNK, never sent whole ───────────────
  // ssFitImageForUpload returns the ORIGINAL when its fixed-1600px quality loop cannot reach the
  // byte cap, so lowering that cap from 2.8MB to 900KB made a big photo MORE likely to be sent
  // untouched. Ahsan saw it as "1 of 9 uploaded. 8 failed" and then, decisively, "0 of 1
  // uploaded. 1 failed: That upload timed out after 90 seconds" — one image, one lane.
  if (bigPhoto) {
    const before = uploadCount()
    const startCount = await imgCount()
    putBytes.length = 0
    await page.locator('input[type=file][accept="image/*"]').setInputFiles(BIG)
    await waitForImages(startCount + 1)
    // RAW bytes now, not base64 — the signed route sends the file itself. 900KB is the cap the
    // shrink promises; anything near the 8.8MB original means it fell back to the untouched file.
    const sentBytes = putBytes.length ? putBytes[putBytes.length - 1] : 0
    ok('AN 8.8MB PHOTO IS SHRUNK BEFORE SENDING', sentBytes > 0 && sentBytes <= 950_000,
      `${Math.round(sentBytes / 1024)}KB on the wire (original is 8657KB)`)
    ok('exactly one upload for one file', uploadCount() - before === 1, `${uploadCount() - before}`)
    // Back to four so the assertions below still describe what they say.
    await page.locator('button[title="Remove this image"]').last().click()
    await page.waitForTimeout(500)
  }

  const photoUrlsBefore = await page.evaluate(() => Array.from(document.querySelectorAll('img[alt^="Image "]')).map((i) => i.getAttribute('src')))

  // ── the walk-around ───────────────────────────────────────────────────────────────────
  if (!hasClip) {
    console.log('\nSKIPPED the video half: ffmpeg is not on PATH, so dev/scan-fixtures/walk-around-stub.mp4 could not be generated.')
    await browser.close()
    const f0 = results.filter((r) => !r.pass)
    console.log(`\n${results.length - f0.length}/${results.length} assertions passed (video half skipped)`)
    process.exit(f0.length || pageErrors.length ? 1 : 0)
  }
  // A REAL h264 clip, not a stub buffer: ssExtractOrbitFrames decodes it in the page, refuses
  // anything under 4s, seeks ~15 times and reads pixels off a canvas. Nothing about that path
  // is exercised by a fake File.
  // By accept attribute, not label text: the button reads "Choose a different video" once a lap
  // has been staged, and mid-upload BOTH labels contain "Sent N of ...".
  const uploadsBeforeVideo = uploadCount()
  const gBeforeVideo = generateCalls.length
  await page.locator('input[type=file][accept="video/*"]').setInputFiles(CLIP)
  await page.waitForFunction(() => /\d+ views ready/.test(document.body.innerText), { timeout: 60000 })
  // Long enough for the busy flags to clear and the gate line to re-render. The badge appears on
  // `calVideoReady && !busy`, but the Generate button reads adminCalPhotos.busy too.
  await page.waitForTimeout(1200)

  t = await text()
  const framesRead = Number((t.match(/(\d+) views ready/) || [])[1] || 0)
  ok('video frames were cut and staged', framesRead >= 4, `${framesRead} frames`)
  // RELATIVE, not absolute: the concurrency block above already staged a lap and an extra image,
  // so a hard-coded total silently becomes wrong the moment a step is added ahead of it.
  ok('frames were uploaded, photos were not re-uploaded', uploadCount() - uploadsBeforeVideo === framesRead, `${uploadCount() - uploadsBeforeVideo} new uploads for ${framesRead} frames`)
  ok('STAGING THE VIDEO CHARGED NOTHING', generateCalls.length === gBeforeVideo, `${generateCalls.length - gBeforeVideo} generations`)

  // The uploaded images carry alt="Image N of M"; the walk-around strip carries alt="View N".
  // Selecting on that rather than on a pixel width means a style tweak cannot quietly turn this
  // assertion into a no-op.
  const photoUrlsAfter = await page.evaluate(() => Array.from(document.querySelectorAll('img[alt^="Image "]')).map((i) => i.getAttribute('src')))
  ok('THE VIDEO DID NOT OVERWRITE THE FOUR PHOTOS',
    photoUrlsAfter.length === 4 && photoUrlsAfter.every((u) => photoUrlsBefore.includes(u)),
    photoUrlsAfter.join(',').slice(0, 90))

  ok('generate is now UNLOCKED', !(await gen.first().isDisabled()))
  ok('gate line flips to ready', (await line('Ready —')).length > 0, (await line('Ready —')).trim())

  // ── one press, one generation ─────────────────────────────────────────────────────────
  await gen.first().click()
  await page.waitForFunction(() => document.body.innerText.includes('from your walk-around and'), { timeout: 30000 })
  t = await text()

  // RELATIVE: the video-only and one-photo runs above already generated twice.
  ok('EXACTLY ONE generation was requested', generateCalls.length === gBeforeVideo + 1, `${generateCalls.length - gBeforeVideo}`)
  const call = generateCalls[gBeforeVideo] || {}
  ok('it is the combined source', call.source === 'combined', String(call.source))
  ok('it carries videoCount', call.videoCount === framesRead, `videoCount=${call.videoCount} frames=${framesRead}`)
  ok('it sends frames AND photos, within the 12 cap',
    (call.photoUrls || []).length === Math.min(12, framesRead + 4) && (call.photoUrls || []).length <= 12,
    `${(call.photoUrls || []).length} urls`)
  ok('frames lead the array, photos follow',
    (call.photoUrls || []).slice(0, call.videoCount).every((u) => !photoUrlsBefore.includes(u))
    && (call.photoUrls || []).slice(call.videoCount).every((u) => photoUrlsBefore.includes(u)))
  ok('the observed notes render', t.includes('What the model saw') && t.includes('Gambrel, read from the ground.'))
  // ── REGRESSION: the read COLOURS reach the building, the read SIDING does not ────────────
  // The stub replies with colors.body #ff0000 and siding: null — exactly the shape the real
  // sanitiser produces, because it copies only colour keys that pass a hex test but ALWAYS
  // emits siding, collapsing anything unrecognised to null. So applying colours is safe and
  // applying siding would silently reset every builder's cladding to plain.
  //
  // Ahsan filmed a brown building with tan trim and got back near-black with white trim: the
  // model read the colours, the server returned them, and applyDraftedShape discarded them.
  const specColors = await page.evaluate(() => {
    const hex = (el) => (el && el.value) || ''
    const boxes = Array.from(document.querySelectorAll('input[placeholder="#hex or blank"]'))
    return boxes.map(hex)
  })
  ok('A COLOUR THE MODEL READ REACHES THE SPEC', specColors.some((c) => (c || '').toLowerCase() === '#ff0000'), specColors.filter(Boolean).join(',') || 'none set')
  ok('and the message says where the colours came from', t.includes('Colours are set where the views show them clearly'), (await line('Read ')).slice(0, 120))
  ok('the result says what came from where', /\d+ from your walk-around and \d+ of your own photos/.test(t), (await line('Read ')).trim().slice(0, 110))

  // ── save, then reopen ────────────────────────────────────────────────────────────────
  await page.getByRole('button', { name: /Save 3D look/ }).first().click()
  await page.waitForFunction(() => document.body.innerText.includes('Saved.'), { timeout: 20000 })
  ok('save persists the four photos', (saved.d3Photos || []).length === 4, `${(saved.d3Photos || []).length}`)
  ok('SAVE PERSISTS THE WALK-AROUND FRAMES', (saved.d3VideoFrames || []).length === framesRead, `${(saved.d3VideoFrames || []).length}`)

  // Reopening the style re-seeds from the stubbed catalog, which now holds what was saved.
  await page.getByRole('button', { name: 'Barn', exact: true }).first().click()
  await page.waitForTimeout(2000)
  t = await text()
  ok('reopen restores the photos', /✓ 4 images/.test(t), (t.match(/✓ \d+ images?/) || ['none'])[0])
  ok('REOPEN RESTORES THE VIDEO - no re-filming', /\d+ views ready/.test(t), (await line('')).trim().slice(0, 40))
  ok('generate is still unlocked after a reopen', !(await gen.first().isDisabled()))

  // ── THE SAVE TIMEOUT AND THE LATE-SAVE GUARD (2026-09-14) ──────────────────────────────
  // Ahsan's real Save sat on "Saving…" for ~168s: save_style_d3 went through the main hostname
  // with no deadline, the same stall the uploads had. And because a stalled request can still
  // land minutes later, every guarded save carries the version it was edited from.
  {
    const last = saveBodies[saveBodies.length - 1] || {}
    ok('A SAVE CARRIES THE VERSION IT WAS EDITING', typeof last.baseVersion === 'string' && last.baseVersion.length > 0, `baseVersion ${JSON.stringify(last.baseVersion)}`)
    // Review wf_5199a3e0-d65 (high): with the key absent, 01-core's wrapper injects whatever view-as
    // target is armed when a QUEUED save finally runs. Present-and-null is what stops that.
    ok('AND NAMES ITS TENANT EXPLICITLY, SO A LATER VIEW-AS CANNOT BE INJECTED', 'targetClientId' in last && last.targetClientId === null, `targetClientId ${JSON.stringify(last.targetClientId)}`)
    const savedClick = async () => {
      await page.getByRole('button', { name: /Save 3D look/ }).first().click()
      await page.waitForFunction(() => !document.body.innerText.includes('Saved.'), null, { timeout: 10000 }).catch(() => {})
    }

    await page.evaluate(() => { window.__ssSaveDeadlineMs = 1500 })
    saveHosts.length = 0
    delay.stallSaves = 1
    await savedClick()
    await page.waitForFunction(() => document.body.innerText.includes('Saved.'), null, { timeout: 30000 })
    ok('A STALLED SAVE RETRIES THROUGH THE FUNCTIONS HOST',
      saveHosts.length === 2 && saveHosts[0] === `${REF}.supabase.co` && saveHosts[1] === `${REF}.functions.supabase.co`, saveHosts.join(' -> '))

    saveBodies.length = 0
    saveHosts.length = 0
    delay.conflictSaves = 1
    await savedClick()
    await page.waitForFunction(() => document.body.innerText.includes('Saved.'), null, { timeout: 30000 })
    ok('A CONFLICT IS RESENT ONCE, ON THE CURRENT VERSION',
      saveBodies.length === 2 && saveBodies[1].baseVersion === CONFLICT_VERSION, `${saveBodies.length} bodies; second base ${JSON.stringify(saveBodies[1] && saveBodies[1].baseVersion)}`)
    // Both of those calls came moments after the stall above, so neither should have waited on the
    // main host again.
    ok('AFTER A STALL, THE NEXT SAVES SKIP THE STALLED HOST FOR A WHILE',
      saveHosts.length === 2 && saveHosts.every((h) => h === `${REF}.functions.supabase.co`), saveHosts.join(' -> '))

    delay.stallAllSaves = true
    const t0 = Date.now()
    await page.getByRole('button', { name: /Save 3D look/ }).first().click()
    await page.waitForFunction(() => /Saving didn.t go through/.test(document.body.innerText), null, { timeout: 30000 })
    const secs = Math.round((Date.now() - t0) / 100) / 10
    ok('WHEN BOTH HOSTS STALL, THE SAVE SAYS SO IN SECONDS', secs < 12, `${secs}s with a 1.5s deadline`)
    await page.evaluate(() => { if (window.__ssForgetStalledHosts) window.__ssForgetStalledHosts() })
    delay.stallAllSaves = false
    await page.evaluate(() => { window.__ssSaveDeadlineMs = undefined })

    // Two media writes back to back: remove a photo, then add one while the first is still held.
    const before = await imgCount()
    delay.mediaMs = 900
    mediaMaxInFlight = 0
    const mediaStart = mediaSaves.length
    await page.locator('button[title="Remove this image"]').last().click()
    await page.waitForTimeout(150)
    await page.locator('input[type=file][accept="image/*"]').setInputFiles([{ name: 'queued.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('queued-photo') }])
    await waitForImages(before)
    await page.waitForTimeout(2600)
    ok('MEDIA SAVES NEVER OVERLAP', mediaMaxInFlight === 1 && mediaSaves.length - mediaStart >= 2, `max in flight ${mediaMaxInFlight}, ${mediaSaves.length - mediaStart} saves`)
    const lastMedia = mediaSaves[mediaSaves.length - 1] || {}
    ok('and the last one written is the latest list', (lastMedia.d3Photos || []).length === before, `${(lastMedia.d3Photos || []).length} photos, ${before} on screen`)
    delay.mediaMs = 0
  }

  // ── A MEDIA SAVE LOST TO A STALL IS REPLAYED (final check wf_0e1e9235-8e5) ──────────────────
  // Media saves show no error, and the guard refuses a late copy of an OLDER list, so a newest list
  // that is simply abandoned lets an older copy become the last write. Remove a photo while both
  // hosts hang for that save; once they recover, the removal must still land.
  {
    await page.evaluate(() => {
      window.__ssSaveDeadlineMs = 800
      window.__ssMediaReplayMs = 1500
      if (window.__ssForgetStalledHosts) window.__ssForgetStalledHosts()
    })
    const before = await imgCount()
    const mediaStart = mediaSaves.length
    delay.stallMedia = 2   // the main-host copy and the side-door copy both hang
    await page.locator('button[title="Remove this image"]').last().click()
    await waitForImages(before - 1)
    await page.waitForTimeout(6000)
    const landed = mediaSaves.slice(mediaStart)
    const lastLanded = landed[landed.length - 1] || {}
    ok('A MEDIA SAVE LOST TO A STALL IS REPLAYED WITH THE LATEST LIST',
      delay.stallMedia === 0 && landed.length >= 1 && (lastLanded.d3Photos || []).length === before - 1,
      `${landed.length} landed; last has ${(lastLanded.d3Photos || []).length} photos, ${before - 1} on screen`)
    await page.evaluate(() => { window.__ssSaveDeadlineMs = undefined; window.__ssMediaReplayMs = undefined })
    // Put the image back so everything below still describes what it says.
    await page.locator('input[type=file][accept="image/*"]').setInputFiles([{ name: 'replay-restore.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('replay-restore') }])
    await waitForImages(before)
    await page.waitForTimeout(800)
  }

  // ── REGRESSION: a save before the refetch lands must not claim the frames are gone ──────
  // `adminCalVideo.urls === null` means "we have not looked yet". Sending [] for that wrote an
  // empty array over a walk-around already on file, and there is no UI anywhere that accepts
  // frame URLs, so the only recovery was re-filming.
  // Forget every known version first, so this save genuinely has none when it is pressed — the
  // case re-review wf_9d79b211-18b showed going out unguarded while the style's own load was hung.
  await page.evaluate(() => { if (window.__ssForgetStyleVersions) window.__ssForgetStyleVersions() })
  delay.catalogMs = 6000
  await page.getByRole('button', { name: 'Shed', exact: true }).first().click()
  await page.waitForTimeout(400)
  saveBodies.length = 0
  await page.getByRole('button', { name: /Save 3D look/ }).first().click()
  await page.waitForTimeout(1500)
  const early = saveBodies[0] || {}
  ok('a save before the frames load OMITS the column', !('d3VideoFrames' in early), Object.keys(early).join(','))
  ok('A SAVE BEFORE ITS STYLE HAS LOADED READS THE VERSION FIRST, NEVER SENDS ONE UNGUARDED',
    typeof early.baseVersion === 'string' && early.baseVersion.length > 0, `baseVersion ${JSON.stringify(early.baseVersion)}`)

  // ── REGRESSION: a slow answer for one style must not land on another ────────────────────
  await page.waitForTimeout(6000)
  let t2 = await text()
  ok('the slow answer eventually lands on its own style', /5 views ready/.test(t2), (t2.match(/\d+ views ready/) || ['none'])[0])

  delay.catalogMs = 5000
  await page.getByRole('button', { name: 'Shed', exact: true }).first().click()
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: 'Barn', exact: true }).first().click()   // Barn's own read is immediate
  await page.waitForTimeout(1500)
  const barnFrames = () => page.evaluate(() => (document.body.innerText.match(/(\d+) views ready/) || [])[1] || '0')
  const before = await barnFrames()
  await page.waitForTimeout(6000)   // Shed's delayed answer lands here
  const after = await barnFrames()
  ok("A SLOW STYLE'S FRAMES DO NOT LAND ON THE OPEN ONE", before === after, `barn showed ${before} then ${after}; shed has 5`)

  // ── PHONE WIDTH: the two steps and the Generate line still fit (2026-09-16) ───────────────
  // The badges and hint lines changed wording, and a builder films the lap on the phone they
  // would open this on. MEASURED, not eyeballed: a screenshot cannot show a clipped right edge.
  // Scoped to this panel's own controls, so an unrelated overflow elsewhere in the portal does
  // not read as this panel breaking.
  {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.waitForTimeout(1200)
    const m = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth
      const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right) } }
      const btn = Array.from(document.querySelectorAll('button')).find((b) => /Generate the 3D model/.test(b.textContent || ''))
      const hint = btn && btn.nextElementSibling
      const byText = (re) => Array.from(document.querySelectorAll('span')).find((s) => re.test((s.textContent || '').trim()))
      const cards = Array.from(document.querySelectorAll('div')).filter((d) => /^(🎥 Step 1|📸 Step 2)/.test((d.textContent || '').trim()) && d.style.borderRadius === '8px')
      return {
        vw,
        btn: rect(btn), hint: rect(hint),
        step1: rect(byText(/^🎥 Step 1/)), step2: rect(byText(/^📸 Step 2/)),
        cards: cards.map((c) => ({ ...rect(c), over: c.scrollWidth - c.clientWidth })),
      }
    })
    const inside = (r) => r && r.l >= 0 && r.r <= m.vw
    ok('AT 375PX THE GENERATE BUTTON AND ITS LINE FIT ON SCREEN', inside(m.btn) && inside(m.hint), JSON.stringify({ vw: m.vw, btn: m.btn, hint: m.hint }))
    ok('at 375px both step headings fit', inside(m.step1) && inside(m.step2), JSON.stringify({ step1: m.step1, step2: m.step2 }))
    ok('at 375px neither step card scrolls sideways', m.cards.length === 2 && m.cards.every((c) => c.over <= 1 && inside(c)), JSON.stringify(m.cards))
    if (process.env.SS_SHOT_DIR) {
      await page.getByRole('button', { name: /Generate the 3D model/ }).first().scrollIntoViewIfNeeded()
      await page.screenshot({ path: `${process.env.SS_SHOT_DIR}/cal3d-375.png` })
    }
    await page.setViewportSize({ width: 1500, height: 1100 })
  }

  // ── A SAVED WALK-AROUND AND NO PHOTOS: Generate is unlocked on reopen (review, 2026-09-16) ──
  // The builder who filmed a lap last week, never added a photo, and comes back to generate. The
  // gate counts frames RESTORED from d3_video_frames exactly as it counts a fresh upload, and
  // until this block nothing proved it: every reopen above had four photos staged beside the walk.
  // Last in the run, because it presses Generate and nothing after it should read that result.
  {
    await page.getByRole('button', { name: 'Cabin', exact: true }).first().click()
    await page.waitForTimeout(1200)
    // By the frames' OWN URLs, not the count: Barn's lap is also eight views.
    const restored = await page.waitForFunction((want) => {
      const got = Array.from(document.querySelectorAll('img[alt^="View "]')).map((i) => i.getAttribute('src'))
      return got.length === want.length && got.every((u, i) => u === want[i])
    }, STYLE_ROW3.d3_video_frames, { timeout: 20000 }).then(() => true, () => false)
    const unlocked = await genUnlocks()
    const photosShown = await page.locator('img[alt^="Image "]').count()
    ok('A STYLE REOPENED WITH A SAVED WALK-AROUND AND NO PHOTOS: GENERATE IS UNLOCKED',
      restored && unlocked && photosShown === 0 && /8 views ready/.test(await text()),
      `frames restored ${restored}, unlocked ${unlocked}, ${photosShown} photos`)
    ok('its ready line reads the restored walk-around alone',
      (await line('Ready —')).trim() === 'Ready — one generation, reading the 8 walk-around views. Photos in step 2 are optional.',
      (await line('Ready —')).trim())
    if (unlocked) {
      const g = generateCalls.length
      await gen.first().click()
      for (let i = 0; i < 80 && generateCalls.length === g; i++) await page.waitForTimeout(250)
      await page.waitForTimeout(500)
      const c = generateCalls[g] || {}
      ok('ONE PRESS SENDS THE RESTORED FRAMES ALONE, AS source "video"',
        generateCalls.length === g + 1 && c.source === 'video' && c.videoCount === 8
          && JSON.stringify(c.photoUrls) === JSON.stringify(STYLE_ROW3.d3_video_frames),
        `${generateCalls.length - g} calls, source ${c.source}, videoCount ${c.videoCount}, ${(c.photoUrls || []).length} urls`)
    }
  }

  await browser.close()

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} assertions passed`)
  if (pageErrors.length) {
    console.log('\nUNCAUGHT PAGE ERRORS:')
    pageErrors.slice(0, 8).forEach((e) => console.log('  ' + e))
  }
  process.exit(failed.length || pageErrors.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
