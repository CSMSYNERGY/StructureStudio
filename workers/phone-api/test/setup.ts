import { afterEach, beforeEach, vi } from "vitest";
import { resetJwksCache } from "../src/jwt";
import { resetLogThrottle } from "../src/log";

beforeEach(() => {
  resetJwksCache();
  resetLogThrottle();
  // The Worker logs refusals and faults with console.warn; keep test output readable.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});
