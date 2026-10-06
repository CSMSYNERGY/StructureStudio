// src/logPrivacy.ts (what a Chrome extension error report keeps) and scripts/log-ref.mjs (the
// help lookup), which must compute the same refs. Every id, number and SID here is made up.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXTENSION_LOG_SOURCES, REDACTED, extensionContext, logRef, pseudonymKey, reportRefs, scrubText } from "../src/logPrivacy";
import { CLIENT, USER_A, USER_B } from "./helpers";

const KEY = "test-log-pseudonym-key-0123456789abcdef";
const OTHER_KEY = "another-test-pseudonym-key-0123456789";
const SCRIPT = fileURLToPath(new URL("../scripts/log-ref.mjs", import.meta.url).href);
const hex32 = (seed: string) => seed.repeat(32 / seed.length);

function runScript(args: string[], key: string | null = KEY): { code: number; out: string } {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  delete env.LOG_PSEUDONYM_KEY;
  if (key !== null) env.LOG_PSEUDONYM_KEY = key;
  try {
    return { code: 0, out: execFileSync(process.execPath, [SCRIPT, ...args], { env, encoding: "utf8", stdio: "pipe" }) };
  } catch (e) {
    const err = e as { status: number; stderr: string; stdout: string };
    return { code: err.status, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

describe("logRef", () => {
  it("is 24 hex characters, the same every time for the same id", async () => {
    const a = await logRef(KEY, "user", USER_A);
    expect(a).toMatch(/^[0-9a-f]{24}$/);
    expect(await logRef(KEY, "user", USER_A)).toBe(a);
    expect(await logRef(KEY, "user", ` ${USER_A.toUpperCase()} `)).toBe(a);
  });

  it("differs across ids, across kinds and across keys", async () => {
    const a = await logRef(KEY, "user", USER_A);
    expect(await logRef(KEY, "user", USER_B)).not.toBe(a);
    // "user:" and "client:" prefixes: the same string as a user and as a client never collide.
    expect(await logRef(KEY, "client", USER_A)).not.toBe(a);
    expect(await logRef(OTHER_KEY, "user", USER_A)).not.toBe(a);
  });

  it("is never the id itself or an unkeyed hash of it", async () => {
    const a = await logRef(KEY, "user", USER_A);
    const plain = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`user:${USER_A}`));
    const plainHex = [...new Uint8Array(plain)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(plainHex.startsWith(a)).toBe(false);
    expect(USER_A.replace(/-/g, "").includes(a)).toBe(false);
  });
});

describe("reportRefs and the key", () => {
  it("gives user_ref and client_ref", async () => {
    expect(await reportRefs(KEY, USER_A, CLIENT)).toEqual({
      user_ref: await logRef(KEY, "user", USER_A),
      client_ref: await logRef(KEY, "client", CLIENT),
    });
  });

  it("leaves client_ref out when the person has no business", async () => {
    expect(Object.keys(await reportRefs(KEY, USER_A, null))).toEqual(["user_ref"]);
  });

  it("gives nothing at all without a usable key (unset, blank, or under 32 characters)", async () => {
    for (const k of [undefined, "", "   ", "short-key"]) {
      expect(pseudonymKey(k)).toBeNull();
      expect(await reportRefs(k, USER_A, CLIENT)).toEqual({});
    }
  });

  it("trims the key, so a secret saved with a trailing newline still matches the script", async () => {
    expect(await reportRefs(`${KEY}\n`, USER_A, CLIENT)).toEqual(await reportRefs(KEY, USER_A, CLIENT));
  });
});

describe("scrubText", () => {
  const SID = "CA" + hex32("ab12");
  const IDENTITY = `u_${USER_A.replace(/-/g, "")}_g3`;

  it.each([
    ["an E.164 number", "Call to +15555550142 failed"],
    ["a formatted number", "Call to +1 (555) 555-0142 failed"],
    ["a ten-digit number", "thread n:5555550142 not found"],
    ["an eleven-digit number", "dialed 15555550142"],
    ["a URL-encoded number", "GET /search?q=%2B15555550142 failed"],
    ["another country's number", "Call to +442071838750 failed"],
    ["an email", "No account for someone.else@example.test"],
    ["a URL-encoded email", "GET /x?email=someone%40example.test"],
    ["a user uuid", `No settings for ${USER_A}`],
    ["a contact thread key", `GET /threads/c:${USER_B} 404`],
    ["a uuid without hyphens", `id ${USER_A.replace(/-/g, "")}`],
    ["a Twilio identity", `client:${IDENTITY} is busy`],
    ["a dev identity", `client:${IDENTITY}_dev is busy`],
    ["a call SID", `Call ${SID} ended`],
    ["a text SID", `Message SM${hex32("cd34")} failed`],
    ["a login token", "Bearer eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln"],
    ["a login token cut short", "token=eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0"],
  ])("redacts %s", (_what, text) => {
    const out = scrubText(text);
    expect(out).toContain(REDACTED);
    expect(out).not.toMatch(/\d{7,}|@|%40|[0-9a-f]{16,}|eyJ/i);
  });

  it("keeps the words, Twilio error codes, versions and millisecond timestamps", () => {
    const text = "ConnectionError (31005): Error sent from gateway in HANGUP after 1759500000123 ms, app 0.3.1";
    expect(scrubText(text, 4000)).toBe(text);
  });

  it("redacts before cutting, so a number across the cut never leaves half of itself behind", () => {
    const text = `${"x".repeat(290)} +15555550142 and more`;
    const out = scrubText(text);
    expect(out).toHaveLength(300);
    expect(out).not.toMatch(/\d{3}/);
  });

  it("stays fast on a long run of address characters with no @ in it", () => {
    const t0 = Date.now();
    scrubText("a.".repeat(3000), 4000);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe("extensionContext", () => {
  it("keeps the keys the extension sends, scrubbed", () => {
    expect(extensionContext({
      where: "offscreen", repeats: 2, code: "twilio_error", twilio_code: 31005, reason: "mic", type: "call.start", surface: "popup",
    })).toEqual({ where: "offscreen", repeats: 2, code: "twilio_error", twilio_code: 31005, reason: "mic", type: "call.start", surface: "popup" });
    expect(extensionContext({ reason: "dialing +15555550142" })).toEqual({ reason: `dialing ${REDACTED}` });
  });

  it("drops identity, ids, numbers, call SIDs and anything else it doesn't know, naming only the key", () => {
    const out = extensionContext({
      where: "call",
      identity: `u_${USER_A.replace(/-/g, "")}_g1`,
      user_id: USER_A,
      client_id: CLIENT,
      contact_id: USER_B,
      call_sid: "CA" + hex32("ab12"),
      to: "+15555550142",
      email: "someone@example.test",
      user_ref: "spoofed",
      nested: { where: "x" },
    });
    expect(out).toEqual({
      where: "call",
      dropped: ["identity", "user_id", "client_id", "contact_id", "call_sid", "to", "email", "user_ref", "nested"],
    });
  });

  it("drops a known key whose value is not a plain value", () => {
    expect(extensionContext({ code: { id: USER_A }, repeats: Number.NaN })).toEqual({ dropped: ["code", "repeats"] });
  });
});

describe("EXTENSION_LOG_SOURCES", () => {
  it("is the extension's two codes and not the mobile app's", () => {
    expect([...EXTENSION_LOG_SOURCES].sort()).toEqual(["my-synergy-phone-extension", "sss-phone-extension"]);
  });
});

describe("scripts/log-ref.mjs", () => {
  it("prints the same refs the Worker stores, and the query that finds them", async () => {
    const { code, out } = runScript(["--user", USER_A, "--client", CLIENT]);
    expect(code).toBe(0);
    const userRef = await logRef(KEY, "user", USER_A);
    const clientRef = await logRef(KEY, "client", CLIENT);
    expect(out).toContain(`user_ref   ${userRef}`);
    expect(out).toContain(`client_ref ${clientRef}`);
    expect(out).toContain(`context->>'user_ref' = '${userRef}' and context->>'client_ref' = '${clientRef}'`);
  });

  it("refuses without the key, and never prints a ref", () => {
    const { code, out } = runScript(["--user", USER_A], null);
    expect(code).toBe(2);
    expect(out).toContain("LOG_PSEUDONYM_KEY is not set");
    expect(out).not.toMatch(/user_ref/);
  });

  it("refuses a user id that isn't a uuid", () => {
    const { code, out } = runScript(["--user", "someone@example.test"]);
    expect(code).toBe(2);
    expect(out).toContain("--user must be a user id");
  });
});
