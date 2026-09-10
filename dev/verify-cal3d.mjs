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
const delay = { catalogMs: 0 }
const saveBodies = []
const saved = {}
const generateCalls = []
const uploads = []

async function main() {
  const hasClip = ensureClip()
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
      if (a === 'upload_style_photo') {
        uploads.push(body)
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

  // A real 1x1 PNG for every uploaded image, so nothing 404s in the thumbnail strips and the
  // <img> elements the assertions count are genuinely rendering something.
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
  await page.waitForFunction(() => /4 images added/.test(document.body.innerText), { timeout: 30000 })
  await page.waitForTimeout(400)
  t = await text()
  ok('FOUR IMAGES UPLOADED IN ONE GO', t.includes('4 images added'), (await line('4 images')).trim())
  ok('four thumbnails render', (await page.locator('img[alt^="Image "]').count()) === 4, `${await page.locator('img[alt^="Image "]').count()} thumbs`)
  ok('thumbnails are numbered, not side-named', (await page.locator('img[alt="Image 2 of 4"]').count()) === 1)
  ok('PHOTOS ALONE DO NOT UNLOCK GENERATE', await gen.first().isDisabled())
  ok('gate now asks only for the video', (await line('Add a walk-around video in step 1 —')).length > 0, (await line('Add a walk-around')).trim())
  ok('adding photos charged no generation', generateCalls.length === 0, `${generateCalls.length} calls`)
  ok('four photo uploads went through the host', uploads.length === 4, `${uploads.length} uploads`)

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
  await page.locator('label', { hasText: /Choose a walk-around video/ })
    .locator('input[type=file]')
    .setInputFiles('dev/scan-fixtures/walk-around-stub.mp4')
  await page.waitForFunction(() => /\d+ views ready/.test(document.body.innerText), { timeout: 60000 })
  await page.waitForTimeout(600)

  t = await text()
  const framesRead = Number((t.match(/(\d+) views ready/) || [])[1] || 0)
  ok('video frames were cut and staged', framesRead >= 4, `${framesRead} frames`)
  ok('frames were uploaded, photos were not re-uploaded', uploads.length === 4 + framesRead, `${uploads.length} uploads total`)
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
