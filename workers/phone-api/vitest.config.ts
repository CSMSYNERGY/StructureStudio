import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Node environment with fetch stubbed per test (test/helpers.ts). The same alias wrangler uses
// maps the shared Deno modules' jsr: import onto the npm package installed here; it is an
// absolute path because the importing files live outside this directory.
const supabaseJs = fileURLToPath(new URL("./node_modules/@supabase/supabase-js", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [{ find: /^jsr:@supabase\/supabase-js@2$/, replacement: supabaseJs }],
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    restoreMocks: true,
  },
});
