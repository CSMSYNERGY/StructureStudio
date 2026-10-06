#!/usr/bin/env node
// Finds one person's Chrome extension error reports, for when THEY ask for help (DEVIATIONS 64).
//
// Those reports store no user id and no business id (src/logPrivacy.ts), only `user_ref` and
// `client_ref` inside `context`: an HMAC-SHA-256 of the id under the Worker secret
// LOG_PSEUDONYM_KEY. Given the person's user id (and, if you want, their business's client id)
// and the key, this prints the refs and the query that finds their rows. It reads nothing and
// writes nothing; the key never goes on the command line, so it stays out of shell history.
//
// Usage (PowerShell; the key is the value set with `npx wrangler secret put LOG_PSEUDONYM_KEY`,
// kept in the password manager because Cloudflare never shows a secret again):
//   $env:LOG_PSEUDONYM_KEY = "<the key>"
//   node scripts/log-ref.mjs --user <user id>
//   node scripts/log-ref.mjs --user <user id> --client <client id>
//   node scripts/log-ref.mjs --client <client id>
//   Remove-Item Env:LOG_PSEUDONYM_KEY
//
// Only for the person who asked (consent), security, or the law: the refs exist so that nobody
// reads a person's reports by name otherwise.

import { createHmac } from "node:crypto";
import { pathToFileURL } from "node:url";

/** Same as src/logPrivacy.ts: 32 characters or more, trimmed. */
export const MIN_KEY_LENGTH = 32;

/** Same as src/logPrivacy.ts logRef; test/logPrivacy.test.ts checks the two agree. */
export function logRef(key, kind, id) {
  const norm = kind === "user" ? String(id).trim().toLowerCase() : String(id).trim();
  return createHmac("sha256", key).update(`${kind}:${norm}`, "utf8").digest("hex").slice(0, 24);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--user" || a === "--client") out[a.slice(2)] = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

const USAGE = "Usage: node scripts/log-ref.mjs --user <user id> [--client <client id>], with the key in $env:LOG_PSEUDONYM_KEY";

export function main(argv, env) {
  const a = args(argv);
  if (a.help || (!a.user && !a.client)) return { code: a.help ? 0 : 2, out: USAGE };
  const key = String(env.LOG_PSEUDONYM_KEY ?? "").trim();
  if (key.length < MIN_KEY_LENGTH) {
    return { code: 2, out: "LOG_PSEUDONYM_KEY is not set (or shorter than 32 characters). Set it to the Worker's key first." };
  }
  if (a.user !== undefined && !UUID.test(String(a.user).trim())) return { code: 2, out: "--user must be a user id (a uuid)." };
  if (a.client !== undefined && !String(a.client).trim()) return { code: 2, out: "--client is empty." };

  const lines = [];
  const where = [];
  if (a.user) {
    const ref = logRef(key, "user", a.user);
    lines.push(`user_ref   ${ref}`);
    where.push(`context->>'user_ref' = '${ref}'`);
  }
  if (a.client) {
    const ref = logRef(key, "client", a.client);
    lines.push(`client_ref ${ref}`);
    where.push(`context->>'client_ref' = '${ref}'`);
  }
  lines.push(
    "",
    "select created_at, source, severity, code, message, context from public.app_errors",
    ` where ${where.join(" and ")}`,
    "   and source in ('my-synergy-phone-extension', 'sss-phone-extension')",
    " order by created_at desc limit 100;",
  );
  return { code: 0, out: lines.join("\n") };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { code, out } = main(process.argv.slice(2), process.env);
    (code === 0 ? console.log : console.error)(out);
    process.exitCode = code;
  } catch (e) {
    console.error(`${e.message}\n${USAGE}`);
    process.exitCode = 2;
  }
}
