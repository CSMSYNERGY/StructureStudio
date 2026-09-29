// The shared edge-function modules call Deno.env.get; src/env.ts installs a shim over the
// Worker's env. This is the one member of the Deno namespace they use.
declare const Deno: { env: { get(key: string): string | undefined } };
