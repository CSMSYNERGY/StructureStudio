// Which texts may skip quiet hours, pinned against the SHIPPED handlers (2026-09-29).
//
// Quiet hours are for automation. A person pressing a button that sends ONE text to ONE customer
// goes now (Ahsan: "if i am sending manual messages it should go right away"). The record page's
// Send had been left out, so a builder answering a customer at 10pm was told to wait until
// morning. Nothing failed: the flag was simply absent, and absent means "gated".
//
// THE RULES PINNED:
//   1. Every sendTenantSms call in every function says bypassQuietHours explicitly, true or false,
//      so a new caller has to decide rather than inherit a default.
//   2. `true` only in portal-settings' crm_send_sms and text_sign_link, the two buttons a person
//      presses. Automation (submit-estimate's quote text) is `false`.
//   3. In smsSend, the flag guards the clock check and nothing else: consent and STOP still refuse.
// Same technique as documentUploadWiring_test: read the source, so a drift fails the push. If an
// anchor moves, re-point it; do not delete the test.

import { assert, assertEquals } from "jsr:@std/assert@1";

const FUNCTIONS = new URL("../../", import.meta.url);

/** Source with whole-line comments removed, so a comment that NAMES the flag cannot trip it.
 *  Line endings are normalised first: a Windows checkout (core.autocrlf) reads CRLF. */
const code = (src: string) => src.replace(/\r\n/g, "\n").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join("\n");

const entrypoints: { name: string; src: string }[] = [];
for await (const e of Deno.readDir(FUNCTIONS)) {
  if (!e.isDirectory || e.name.startsWith("_")) continue;
  try {
    entrypoints.push({ name: e.name, src: code(await Deno.readTextFile(new URL(`${e.name}/index.ts`, FUNCTIONS))) });
  } catch (_) { /* a directory with no index.ts is not a function */ }
}
entrypoints.sort((a, b) => a.name.localeCompare(b.name));

type Send = { fn: string; action: string | null; bypass: string | null };

/** Every `sendTenantSms(` call: the portal action it sits under, and its bypassQuietHours value. */
function sends(): Send[] {
  const out: Send[] = [];
  for (const { name, src } of entrypoints) {
    const re = /sendTenantSms\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      if (/import\s*\{[^}]*$/.test(src.slice(Math.max(0, m.index - 80), m.index))) continue;
      // The call's argument list, up to its closing parenthesis.
      let depth = 1, i = m.index + m[0].length;
      for (; i < src.length && depth > 0; i++) {
        if (src[i] === "(") depth++;
        else if (src[i] === ")") depth--;
      }
      const argList = src.slice(m.index + m[0].length, i - 1);
      const flag = /bypassQuietHours:\s*([^,\n}]+)/.exec(argList);
      const actions = [...src.slice(0, m.index).matchAll(/action === "([a-z_]+)"/g)];
      out.push({
        fn: name,
        action: actions.length ? actions[actions.length - 1][1] : null,
        bypass: flag ? flag[1].trim() : null,
      });
    }
  }
  return out;
}

const ALL = sends();
const where = (s: Send) => `${s.fn}${s.action ? ` (${s.action})` : ""}`;

Deno.test("the scan found the text senders it is meant to police", () => {
  // A scan that matched nothing would pass every test below. These are the callers as of the fix.
  assertEquals(ALL.map(where).sort(), [
    "portal-settings (crm_send_sms)",
    "portal-settings (text_sign_link)",
    "submit-estimate",
  ]);
});

Deno.test("every text sender says bypassQuietHours explicitly", () => {
  const missing = ALL.filter((s) => s.bypass !== "true" && s.bypass !== "false");
  assert(missing.length === 0, `sendTenantSms without an explicit bypassQuietHours true/false:\n  ${missing.map(where).join("\n  ")}`);
});

Deno.test("only the two buttons a person presses skip quiet hours", () => {
  const MANUAL = new Set(["portal-settings (crm_send_sms)", "portal-settings (text_sign_link)"]);
  for (const s of ALL) {
    const expected = MANUAL.has(where(s)) ? "true" : "false";
    assertEquals(s.bypass, expected, `${where(s)}: bypassQuietHours should be ${expected}`);
  }
});

Deno.test("in smsSend the flag guards the clock check and nothing else", async () => {
  const src = code(await Deno.readTextFile(new URL("_shared/smsSend.ts", FUNCTIONS)));
  const uses = src.match(/msg\.bypassQuietHours/g) ?? [];
  assertEquals(uses.length, 1, "smsSend reads bypassQuietHours in more than one place");
  const open = src.indexOf("if (!msg.bypassQuietHours) {");
  assert(open >= 0, "the quiet-hours guard `if (!msg.bypassQuietHours) {` moved; re-point this test");
  const close = src.indexOf("\n    }", open);
  const block = src.slice(open, close);
  assert(/quietHoursVerdict\(/.test(block), "the guarded block no longer holds the quiet-hours verdict");
  for (const refusal of ["no_consent", "opted_out", "not_active", "bad_number", "damaged_number"]) {
    assert(!block.includes(refusal), `the "${refusal}" refusal is inside the quiet-hours guard, so the bypass would skip it`);
  }
});
