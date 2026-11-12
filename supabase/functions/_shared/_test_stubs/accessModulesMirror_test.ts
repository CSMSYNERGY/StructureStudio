// The tab catalogue's two copies must agree (migration 386, "plans as data").
//
// _shared/accessModules.ts ACCESS_MODULES is the list code validates a tab key against; the rows
// migration 386 inserts into public.access_modules are the list the database validates against (a
// foreign key on every plan's tab and every company exception). If one gains a key the other lacks,
// either an operator can pick a tab the database refuses, or a plan can hold a tab no code knows.
// Nothing throws when that happens, so this test makes it a failed push.
//
// It also pins the two things the resolver names by value: the phone-only plan's key, and that
// every starting plan's tabs are catalogue keys.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { ACCESS_KEY_RE, ACCESS_MODULE_KEYS, ACCESS_MODULES, isAccessModule, PHONE_ONLY_PLAN } from "../accessModules.ts";

const MIG_DIR = new URL("../../../migrations/", import.meta.url);

/** Every `insert into public.access_modules (key, label, grp, shed, sort) values ...;` row, across
 *  every migration, so a later migration that adds a tab is read too. */
async function sqlModules(): Promise<{ key: string; label: string; grp: string; shed: boolean; sort: number }[]> {
  const out: { key: string; label: string; grp: string; shed: boolean; sort: number }[] = [];
  const names: string[] = [];
  for await (const e of Deno.readDir(MIG_DIR)) if (e.isFile && e.name.endsWith(".sql")) names.push(e.name);
  for (const name of names.sort()) {
    const sql = (await Deno.readTextFile(new URL(name, MIG_DIR))).replace(/\r/g, "");
    const re = /insert into public\.access_modules \(key, label, grp, shed, sort\) values([\s\S]*?);/g;
    for (let m = re.exec(sql); m; m = re.exec(sql)) {
      const row = /\(\s*'([a-z0-9_]+)'\s*,\s*'((?:[^']|'')*)'\s*,\s*'([a-z]+)'\s*,\s*(true|false)\s*,\s*(\d+)\s*\)/g;
      for (let r = row.exec(m[1]); r; r = row.exec(m[1])) {
        out.push({ key: r[1], label: r[2].replace(/''/g, "'"), grp: r[3], shed: r[4] === "true", sort: Number(r[5]) });
      }
    }
  }
  return out;
}

Deno.test("the code catalogue and the database catalogue hold the same tabs", async () => {
  const sql = await sqlModules();
  assert(sql.length >= 33, `read only ${sql.length} catalogue rows out of the migrations: the insert block moved, re-anchor this test`);
  const code = ACCESS_MODULES.map((m) => ({ key: m.key, label: m.label, grp: m.group, shed: m.shed, sort: m.sort }));
  const byKey = (a: { key: string }, b: { key: string }) => a.key.localeCompare(b.key);
  assertEquals([...sql].sort(byKey), [...code].sort(byKey));
});

Deno.test("catalogue keys are unique, well formed, and isAccessModule knows exactly them", () => {
  assertEquals(new Set(ACCESS_MODULE_KEYS).size, ACCESS_MODULE_KEYS.length);
  for (const k of ACCESS_MODULE_KEYS) {
    assert(ACCESS_KEY_RE.test(k), `"${k}" is not a valid key`);
    assert(isAccessModule(k));
  }
  for (const bad of ["", "contcats", "Contacts", "customer-login", null, undefined, 7, "__proto__", "constructor"]) {
    assert(!isAccessModule(bad), `isAccessModule accepted ${String(bad)}`);
  }
});

Deno.test("every tab a starting plan names is in the catalogue, and the phone-only plan exists", async () => {
  const sql = (await Deno.readTextFile(new URL("386_access_plans.sql", MIG_DIR))).replace(/\r/g, "");
  // The explicit rows: ('plan', 'tab', 'included').
  const row = /\(\s*'([a-z0-9_]+)'\s*,\s*'([a-z0-9_]+)'\s*,\s*'(included|teaser)'\s*\)/g;
  let n = 0;
  for (let r = row.exec(sql); r; r = row.exec(sql)) {
    assert(isAccessModule(r[2]), `starting plan "${r[1]}" names "${r[2]}", which is not in the catalogue`);
    n++;
  }
  assert(n >= 30, `read only ${n} starting plan rows: the block moved, re-anchor this test`);
  // The base and teaser tabs come from two VALUES lists crossed with the plans.
  for (const list of [/b\(module\)/, /t\(module\)/]) {
    const end = sql.search(list);
    assert(end > 0, "a starting-rows VALUES list moved: re-anchor this test");
    const start = sql.lastIndexOf("cross join (values", end);
    const keys = [...sql.slice(start, end).matchAll(/\('([a-z0-9_]+)'\)/g)].map((m) => m[1]);
    assert(keys.length >= 6);
    for (const k of keys) assert(isAccessModule(k), `a starting list names "${k}", which is not in the catalogue`);
  }
  assert(new RegExp(`\\('${PHONE_ONLY_PLAN}',\\s+'Phone \\+ Contacts'`).test(sql), "the phone-only plan's row is gone from 386");
  assert(sql.includes(`pm.plan_key = '${PHONE_ONLY_PLAN}'`), "the resolver no longer names the phone-only plan by this key");
});
