// Migration 368: which "Getting set up" steps each account shape sees (_shared/setupShape.ts), and
// that portal-setup actually asks — in both the list and the tick, like the 185 gates.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { setupStepFits, shedsOnOrOpen } from "../setupShape.ts";

Deno.test("a shed builder sees 'all' and 'sheds'; a SmartBuild builder sees 'all' and 'smartbuild'", () => {
  assertEquals([setupStepFits("all", true), setupStepFits("sheds", true), setupStepFits("smartbuild", true)], [true, true, false]);
  assertEquals([setupStepFits("all", false), setupStepFits("sheds", false), setupStepFits("smartbuild", false)], [true, false, true]);
  // A missing tag is every account's, as every step was before 368.
  assert(setupStepFits(null, false) && setupStepFits(undefined, true));
});

// deno-lint-ignore no-explicit-any
const fakeAdmin = (answer: { data?: any; error?: any } | "throw") => ({
  from: () => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => {
          if (answer === "throw") throw new Error("network");
          return answer;
        },
      }),
    }),
  }),
});

Deno.test("the shape reads only an explicit false as no sheds, and fails OPEN", async () => {
  assertEquals(await shedsOnOrOpen(fakeAdmin({ data: { sheds_enabled: false } }), "x"), false);
  assertEquals(await shedsOnOrOpen(fakeAdmin({ data: { sheds_enabled: true } }), "x"), true);
  assertEquals(await shedsOnOrOpen(fakeAdmin({ data: null }), "x"), true, "no settings row = a shed builder");
  assertEquals(await shedsOnOrOpen(fakeAdmin({ error: { message: "boom" } }), "x"), true);
  assertEquals(await shedsOnOrOpen(fakeAdmin("throw"), "x"), true);
});

Deno.test("portal-setup asks the shape in the list AND before a tick", async () => {
  const src = await Deno.readTextFile(new URL("../../portal-setup/index.ts", import.meta.url));
  assert(src.includes('.select("id, requires_feature, builder_visible, account_type")'), "the template read carries account_type");
  assert(src.includes("if (g && !setupStepFits(g.audience, shedsOn)) continue;"), "the list skips the other shape's steps");
  assert(/tGate\.audience !== "all" && !setupStepFits\(tGate\.audience, await shedsOnOrOpen\(admin, clientId\)\)/.test(src),
    "the tick refuses a step the list hides");
});
