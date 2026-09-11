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
  id: 's1', key: 'barn', label: 'Barn', code: 'BRN', image_url: null, active: true,
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
  id: 's2', key: 'shed', label: 'Shed', code: 'SHD', image_url: null, active: true,
  show_image_on_estimate: true, d3: null,
  d3_photos: ['http://127.0.0.1:8123/__stub/img-90.png', 'http://127.0.0.1:8123/__stub/img-91.png', 'http://127.0.0.1:8123/__stub/img-92.png', 'http://127.0.0.1:8123/__stub/img-93.png'],
  d3_video_frames: ['http://127.0.0.1:8123/__stub/img-94.png', 'http://127.0.0.1:8123/__stub/img-95.png', 'http://127.0.0.1:8123/__stub/img-96.png', 'http://127.0.0.1:8123/__stub/img-97.png', 'http://127.0.0.1:8123/__stub/img-98.png'],
  model_url: null, model_status: 'none', model_uploaded_at: null, model_locked_at: null,
  model_meta: null, taxable: true,
}

// Set to a millisecond count to hold the NEXT catalog answer back, which is what turns the
// refetch race from a timing accident into a test.
// `failNext` makes the NEXT n upload attempts reject at the transport layer (a dropped
// connection, not a status), which is what FunctionsFetchError means and what a bad uplink
// actually does. `attempts` counts every attempt including retries.
const delay = { catalogMs: 0, uploadMs: 0, failNext: 0, noSignedUrl: false }
// Counted separately so a test can prove WHICH route an upload took. The signed route is the
// fast one (raw bytes straight to storage); base64 through the edge function is the fallback.
const attempts = { upload: 0, signedMint: 0, signedPut: 0 }
// Raw bytes of each signed PUT. With the base64 route gone this is the wire measurement.
const putBytes = []
// MONOTONIC, never reset. attempts.signedMint is zeroed by individual tests to count one block's
// calls, and reusing it for the URL handed back the same path twice — which calTrimPhotos then
// correctly DE-DUPLICATED, so the image silently never appeared and the test looked like an
// upload failure. The stub must mint a genuinely new URL every time, like the real server does.
let signedSeq = 0
// Uploads by EITHER route. The pre-existing assertions count "did an image get stored", which
// is route-agnostic; counting only base64 silently turned them into no-ops the day the signed
// path landed, and two of them did exactly that before this line existed.
const uploadCount = () => attempts.upload + attempts.signedMint
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

  await page.route(`**/${REF}.supabase.co/**`, async (route) => {
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
        return json(route, { ok: true, aiReady: true, styles: [STYLE_ROW, STYLE_ROW2], sizes: [], layoutItems: [], fixtures: [], colors: [] })
      }
      if (a === 'style_photo_upload_url') {
        attempts.signedMint++
        if (delay.noSignedUrl) return json(route, { ok: false, error: 'signed urls off for this test' })
        const n = ++signedSeq
        return json(route, { ok: true, path: `${CLIENT}/style-photo-${n}.jpg`, token: `tok-${n}`, url: `${BASE}/__stub/img-s${n}.png` })
      }
      if (a === 'upload_style_photo') {
        attempts.upload++
        if (delay.failNext > 0) {
          delay.failNext--
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
        return json(route, {
          ok: true,
          d3: { roof: { type: 'gambrel', pitch: 0.5, overhang: 0.8 }, wallHeightFt: 7.5, siding: null, colors: { body: '#ff0000' } },
          frames: n, dropped: 0,
          observed: { roofNote: 'Gambrel, read from the ground.', eave: 'open rafter tails', doors: 'one double, gable end', windows: 'two', vents: 'gable vents', confidence: 'medium' },
          balanceCents: 18000,
        })
      }
      if (a === 'save_style_media') {
        // Mirrors the real action: writes ONLY the media columns, leaves d3 alone, and treats an
        // ABSENT key as "leave that column" rather than as an empty array.
        mediaSaves.push(body)
        const row = body.styleValue === 'shed' ? STYLE_ROW2 : STYLE_ROW
        if (Array.isArray(body.d3Photos)) row.d3_photos = body.d3Photos
        if (Array.isArray(body.d3VideoFrames)) row.d3_video_frames = body.d3VideoFrames
        return json(route, { ok: true })
      }
      if (a === 'save_style_d3') {
        saveBodies.push(body)
        saved.d3Photos = body.d3Photos || null
        saved.d3VideoFrames = body.d3VideoFrames || null
        STYLE_ROW.d3_photos = saved.d3Photos || []
        STYLE_ROW.d3_video_frames = saved.d3VideoFrames || []
        return json(route, { ok: true, d3: body.d3, d3Photos: saved.d3Photos, d3VideoFrames: saved.d3VideoFrames })
      }
      return json(route, { ok: true })
    }
    return json(route, { ok: true })
  })

  // The signed-URL PUT. supabase-js posts the raw file to /storage/v1/object/upload/sign/...
  await page.route(`**/${REF}.supabase.co/storage/v1/object/upload/sign/**`, (route) => {
    attempts.signedPut++
    try { putBytes.push((route.request().postDataBuffer() || Buffer.alloc(0)).length) } catch (_e) { putBytes.push(0) }
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ Key: 'branding/x' }) })
  })

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
  ok('video reads as not yet supplied', t.includes('needed'))
  ok('photo counter starts empty', t.includes('0 of 4 added'), (await line('0 of 4')).trim())
  ok('the four named slots are GONE', !t.includes('Left side') && !t.includes('Right side'), 'no Front/Left side/Right side/Back labels')

  const gen = page.getByRole('button', { name: /Generate the 3D model/ })
  ok('generate button is RENDERED, never hidden', (await gen.count()) === 1)
  ok('generate disabled with nothing supplied', await gen.first().isDisabled())
  ok('gate names BOTH missing inputs', (await line('Add a walk-around video in step 1, and at least')).length > 0, (await line('Add a walk-around')).trim())

  // ── four photos, still no video ───────────────────────────────────────────────────────
  // ONE picker interaction, FOUR files -- the whole point of the 2026-09-10 change. Setting
  // four files on one input is exactly what a builder shift-selecting four photos produces.
  const picker = page.locator('label', { hasText: /Choose images/ }).locator('input[type=file]')
  ok('the image input accepts multiple', await picker.evaluate((el) => el.multiple))
  await picker.setInputFiles([0, 1, 2, 3].map((i) => ({ name: `p${i}.jpg`, mimeType: 'image/jpeg', buffer: Buffer.from(`stub-photo-${i}`) })))
  // The counter is the readout now — the per-batch "N images added" message went when step 2
  // stopped sharing adminCalMsg with the video path and the generation.
  await page.waitForFunction(() => /4 of 12 used/.test(document.body.innerText), { timeout: 30000 })
  await page.waitForTimeout(400)
  t = await text()
  ok('FOUR IMAGES UPLOADED IN ONE GO', t.includes('4 of 12 used'), (await line('4 of 12')).trim())
  ok('four thumbnails render', (await page.locator('img[alt^="Image "]').count()) === 4, `${await page.locator('img[alt^="Image "]').count()} thumbs`)
  ok('thumbnails are numbered, not side-named', (await page.locator('img[alt="Image 2 of 4"]').count()) === 1)
  ok('PHOTOS ALONE DO NOT UNLOCK GENERATE', await gen.first().isDisabled())
  ok('gate now asks only for the video', (await line('Add a walk-around video in step 1 —')).length > 0, (await line('Add a walk-around')).trim())
  ok('adding photos charged no generation', generateCalls.length === 0, `${generateCalls.length} calls`)
  ok('four photo uploads went through the host', uploadCount() === 4, `${uploadCount()} uploads`)

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
  ok('STAGING THE VIDEO CHARGED NOTHING', generateCalls.length === 0, `${generateCalls.length} generations`)

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

  ok('EXACTLY ONE generation was requested', generateCalls.length === 1, `${generateCalls.length}`)
  const call = generateCalls[0] || {}
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
  ok('and the message says colours came from the photos', t.includes('Colours are set from the photos'), (await line('Read ')).slice(0, 120))
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

  // ── REGRESSION: a save before the refetch lands must not claim the frames are gone ──────
  // `adminCalVideo.urls === null` means "we have not looked yet". Sending [] for that wrote an
  // empty array over a walk-around already on file, and there is no UI anywhere that accepts
  // frame URLs, so the only recovery was re-filming.
  delay.catalogMs = 6000
  await page.getByRole('button', { name: 'Shed', exact: true }).first().click()
  await page.waitForTimeout(400)
  saveBodies.length = 0
  await page.getByRole('button', { name: /Save 3D look/ }).first().click()
  await page.waitForTimeout(1500)
  const early = saveBodies[0] || {}
  ok('a save before the frames load OMITS the column', !('d3VideoFrames' in early), Object.keys(early).join(','))

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
