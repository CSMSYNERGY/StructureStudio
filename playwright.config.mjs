// Playwright smoke suite for StructureStudio (added by the 2026-09 audit).
//
// This is NOT part of the pre-push gate: it drives the LIVE beta site over the network and
// needs a login token, so it runs on demand only:
//
//   PW_MAGIC_TOKEN=<hashed_token> npm run test:e2e
//
// PW_MAGIC_TOKEN is a one-time Supabase magic-link `hashed_token` for a TEST tenant's owner
// (minted outside the suite with the service-role key: POST /auth/v1/admin/generate_link
// {type:"magiclink", email:...}). No password and no service key ever lives in this repo.
// PW_BASE_URL defaults to beta; PW_CLIENT is the public designer tenant (a test tenant).
//
// Everything under tests/, this file, test-results/ and playwright-report/ is excluded from
// the Workers assets upload by .assetsignore - the host serves the repo root.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: 0,
  workers: 1,               // one logged-in session; the routes share it
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.PW_BASE_URL || "https://beta.structurestudiosuite.com",
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  // `channel: "chrome"` uses the Chrome already installed on the machine instead of
  // Playwright's pinned download. That is not a preference, it is the only thing that works
  // here: `npx playwright install chromium` has failed repeatedly on this machine, stalling
  // at ~247 MB mid-extract and leaving a stale `__dirlock` that makes every LATER install
  // refuse to start. The suite then "fails" 5 tests with
  // `Executable doesn't exist at …chromium-1194\chrome-win\chrome.exe` — which looks
  // exactly like product breakage in the report and is nothing of the kind.
  //
  // The trade is real and accepted: Chrome's version floats with the machine rather than
  // being pinned. These tests assert on routes rendering and on refusals being refusals, not
  // on rendering minutiae, so a Chrome bump is not expected to move them. If it ever does,
  // fix the install and pin again rather than loosening an assertion.
  projects: [{ name: "chromium", use: { browserName: "chromium", channel: "chrome" } }],
});
