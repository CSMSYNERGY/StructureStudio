// The few assertions jack-agent's tests use. The gate runs a function's tests with no registry access, so
// they stay self-contained (no jsr: or npm: imports), like support-agent's.

const sorted = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(sorted);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])]));
  return v;
};
const text = (v: unknown) => JSON.stringify(sorted(v));

export function assert(ok: unknown, message = "expected a true value"): asserts ok {
  if (!ok) throw new Error(message);
}

export function assertEquals(actual: unknown, expected: unknown, message = ""): void {
  if (text(actual) !== text(expected)) throw new Error(`${message ? message + ": " : ""}expected ${text(expected)}, got ${text(actual)}`);
}

export function assertThrows(fn: () => unknown): void {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error("expected it to throw");
}
