// The identity and number rules, and (when the phone repo is at hand) parity with @sss/phone-core.
//
// This repo is public and cannot depend on the private phone repo, so src/identity.ts is a twin.
// Run with PHONE_CORE_DIR=<phone repo>/packages/phone-core to compare the two on every case.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import * as mine from "../src/identity";

const USER = "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0";
const IDENTITIES = [`u_${USER.replace(/-/g, "")}_g1`, `u_${USER.replace(/-/g, "")}_g12_dev`, "u_nothex_g1", `u_${USER.replace(/-/g, "")}_g`, "client:u_x", ""];
const NUMBERS = ["(555) 555-0142", "+1 555 555 0142", "15555550142", "5555550142", "555-0142", "1555555014", "0555550142", "911", "9-1-1", "112", "933", "+44 20 7946 0000", null, ""];

describe("identity", () => {
  it("round-trips a user id and generation, _dev only when asked", () => {
    expect(mine.toIdentity(USER, 3)).toBe("u_0f1e2d3c4b5a49688776a5b4c3d2e1f0_g3");
    expect(mine.toIdentity(USER, 3, true)).toBe("u_0f1e2d3c4b5a49688776a5b4c3d2e1f0_g3_dev");
    expect(mine.parseIdentity("u_0f1e2d3c4b5a49688776a5b4c3d2e1f0_g3_dev")).toEqual({ userId: USER, generation: 3, dev: true });
    expect(mine.parseIdentity("client:u_0f1e2d3c4b5a49688776a5b4c3d2e1f0_g3")).toBeNull();
    expect(mine.stripClientPrefix("client:abc")).toBe("abc");
    expect(() => mine.toIdentity(USER, 0)).toThrow();
  });

  it("numbers: +1 NANP only, emergency digits never normalized, premium refused", () => {
    expect(mine.toE164("(555) 555-0142")).toBe("+15555550142");
    expect(mine.toE164("1555555014")).toBeNull(); // the truncated +1 shape
    expect(mine.toE164("911")).toBeNull();
    expect(mine.emergencyDigits("9-1-1")).toBe("911");
    expect(mine.isPremiumRate("+19005550100")).toBe(true);
    expect(mine.isPremiumRate("+15559760100")).toBe(true);
    expect(mine.isPremiumRate("+15555550142")).toBe(false);
  });
});

const coreDir = process.env.PHONE_CORE_DIR;
describe.skipIf(!coreDir || !existsSync(join(coreDir, "src", "index.ts")))("parity with @sss/phone-core", () => {
  it("agrees on every identity and number case", async () => {
    const core = await import(/* @vite-ignore */ pathToFileURL(join(coreDir!, "src", "index.ts")).href);
    for (const id of IDENTITIES) expect(mine.parseIdentity(id)).toEqual(core.parseIdentity(id));
    for (const g of [1, 2, 99]) {
      expect(mine.toIdentity(USER, g)).toBe(core.toIdentity(USER, g));
      expect(mine.toIdentity(USER, g, true)).toBe(core.toIdentity(USER, g, true));
    }
    for (const n of NUMBERS) {
      expect(mine.toE164(n)).toBe(core.toE164(n));
      expect(mine.phoneDigits(n)).toBe(core.phoneDigits(n));
      expect(mine.emergencyDigits(n) !== null).toBe(core.isEmergencyNumber(n ?? ""));
    }
  });
});
