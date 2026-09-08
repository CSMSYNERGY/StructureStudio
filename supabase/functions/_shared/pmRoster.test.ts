// The Settings → Team ⇄ Projects roster mirror.
//
// WHY THESE EXIST. The failure modes here are all quiet ones: a duplicate roster row, a
// departed person still in every assignee picker, or — the expensive one — a DELETED row that
// turns every card they were ever assigned into a raw uuid, because assignments live in
// pm_items.values as a bare array of pm_people.id with no foreign key. Migration 148 already
// had to rewrite those blobs once. None of that throws, and none of it is visible until
// somebody opens the board weeks later.
//
// Dependency-free (no jsr:/npm: imports), the house rule for _shared tests.

import { deactivateRosterMember, syncRosterMember, wantsRoster } from "./pmRoster.ts";

function check(name: string, cond: boolean, detail?: string) {
  if (!cond) throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
}

type Row = Record<string, unknown>;

// A PostgREST-shaped fake over one mutable table, enough for the four call shapes this module
// uses: eq / is / order+limit+maybeSingle / insert-select-single / update-eq.
function makeAdmin(people: Row[], opts: { insertFails?: boolean; updateSteals?: boolean } = {}) {
  const state = { rows: people.map((r) => ({ ...r })) };
  const api = {
    from(_t: string) {
      const eqs: Array<[string, unknown]> = [];
      const isNulls: string[] = [];
      let desc = false;
      const q = {
        select(_c: string) { return q; },
        eq(c: string, v: unknown) { eqs.push([c, v]); return q; },
        is(c: string, _v: null) { isNulls.push(c); return q; },
        order(_c: string, o: { ascending: boolean }) { desc = !o.ascending; return q; },
        _match() {
          let out = state.rows.filter((r) =>
            eqs.every(([c, v]) => r[c] === v) && isNulls.every((c) => r[c] == null)
          );
          if (desc) out = [...out].sort((a, b) => Number(b.position) - Number(a.position));
          return out;
        },
        limit(n: number) {
          const hit = q._match().slice(0, n);
          return { data: hit, error: null, maybeSingle: () => ({ data: hit[0] ?? null, error: null }) };
        },
        maybeSingle() { const h = q._match(); return { data: h[0] ?? null, error: null }; },
        // ⚠️ .update(patch) comes BEFORE the filters in PostgREST — `update({}).eq("id", x)`,
        // not `eq(...).update({})`. Modelled faithfully, because a fake with the chain the
        // wrong way round tests a client that does not exist. Returns a thenable so the
        // `await` in pmRoster.ts resolves it after the filters have been collected.
        update(patch: Row) {
          const u = {
            eq(c: string, v: unknown) { eqs.push([c, v]); return u; },
            is(c: string, _v: null) { isNulls.push(c); return u; },
            // deno-lint-ignore no-explicit-any
            then(res: (v: any) => void) {
              // updateSteals models the race the re-check exists for: another writer claimed
              // the row between our read and our write, so the `.is("user_id", null)` filter
              // matches nothing and the update touches no rows.
              if (opts.updateSteals && isNulls.includes("user_id")) {
                return res({ data: null, error: { message: "no rows" } });
              }
              for (const r of q._match()) Object.assign(r, patch);
              return res({ data: null, error: null });
            },
          };
          return u;
        },
        insert(row: Row) {
          return {
            select: () => ({
              single: () => {
                if (opts.insertFails) return { data: null, error: { message: "duplicate key" } };
                const id = `p${state.rows.length + 1}`;
                state.rows.push({ id, active: true, ...row });
                return { data: { id }, error: null };
              },
            }),
          };
        },
      };
      return q;
    },
  };
  // deno-lint-ignore no-explicit-any
  return { admin: api as any, state };
}

Deno.test("an existing linked row is refreshed, never duplicated", async () => {
  const { admin, state } = makeAdmin([
    { id: "p1", name: "Old Name", email: "jane@csmsynergy.com", user_id: "u-jane", active: false, position: 1024 },
  ]);
  const out = await syncRosterMember(admin, { userId: "u-jane", email: "jane@csmsynergy.com", fullName: "Jane Morton" });
  check("refreshed", out.kind === "refreshed", out.kind);
  check("one row still", state.rows.length === 1);
  check("name updated", state.rows[0].name === "Jane Morton");
  // Reactivating matters: remove_user archives rather than deletes, so re-adding somebody has
  // to bring their ORIGINAL row back rather than leave them invisible with a new one beside it.
  check("reactivated", state.rows[0].active === true);
});

Deno.test("a login-less row with the same address is ADOPTED, not duplicated", async () => {
  // The person somebody typed into Projects → People by hand before they had a login. Their
  // pm_people.id is already on cards; creating a second row would strand every one of them.
  const { admin, state } = makeAdmin([
    { id: "p1", name: "Jordan", email: "jordan@csmsynergy.com", user_id: null, active: true, position: 1024 },
  ]);
  const out = await syncRosterMember(admin, { userId: "u-jordan", email: "JORDAN@csmsynergy.com", fullName: "Jordan Reid" });
  check("linked", out.kind === "linked", out.kind);
  check("same row", out.personId === "p1");
  check("no duplicate", state.rows.length === 1);
  check("now linked", state.rows[0].user_id === "u-jordan");
});

Deno.test("a brand-new person lands at the END of the list", async () => {
  const { admin, state } = makeAdmin([
    { id: "p1", name: "A", email: "a@x.com", user_id: "u-a", active: true, position: 1024 },
    { id: "p2", name: "B", email: "b@x.com", user_id: "u-b", active: true, position: 3072 },
  ]);
  const out = await syncRosterMember(admin, { userId: "u-joe", email: "joe@csmsynergy.com", fullName: "Joe Black" });
  check("created", out.kind === "created", out.kind);
  const joe = state.rows.find((r) => r.user_id === "u-joe")!;
  // max + 1024, add_person's own convention — and the column is a float precisely so a later
  // drag can insert BETWEEN two neighbours without renumbering the whole list.
  check("position", joe.position === 4096, String(joe.position));
});

Deno.test("no name and no full name still yields something readable", async () => {
  const { admin, state } = makeAdmin([]);
  await syncRosterMember(admin, { userId: "u-x", email: "carolyn@csmsynergy.com", fullName: null });
  check("local part", state.rows[0].name === "carolyn", String(state.rows[0].name));

  const bare = makeAdmin([]);
  await syncRosterMember(bare.admin, { userId: "u-y", email: null, fullName: null });
  // pm_people.name is NOT NULL, so an empty string would be an insert failure at the door.
  check("never empty", bare.state.rows[0].name === "Team member", String(bare.state.rows[0].name));
});

Deno.test("a login already claimed by ANOTHER row is a conflict, not a throw", async () => {
  // pm_people.user_id is UNIQUE with no foreign key, and add_person has always answered this
  // with a 409. A team add must not fail wholesale over it: the person really was added to
  // the tenant, and reporting failure sends an admin hunting for something that did not break.
  const { admin } = makeAdmin([], { insertFails: true });
  // The post-failure re-read finds the row that beat us.
  const raced = makeAdmin([{ id: "p9", name: "Someone", email: null, user_id: "u-new", active: true, position: 1024 }], { insertFails: true });
  const out = await syncRosterMember(raced.admin, { userId: "u-new", email: "new@csmsynergy.com", fullName: "New Person" });
  check("conflict", out.kind === "refreshed" || out.kind === "conflict", out.kind);

  // And a genuine insert failure with nothing to find DOES throw — a silent swallow here
  // would report a roster add that never happened.
  let threw = false;
  try { await syncRosterMember(admin, { userId: "u-ghost", email: "g@x.com", fullName: "G" }); } catch { threw = true; }
  check("real failure throws", threw);
});

Deno.test("losing the adoption race is a conflict, not a silent overwrite", async () => {
  const { admin } = makeAdmin(
    [{ id: "p1", name: "Jordan", email: "jordan@csmsynergy.com", user_id: null, active: true, position: 1024 }],
    { updateSteals: true },
  );
  const out = await syncRosterMember(admin, { userId: "u-jordan", email: "jordan@csmsynergy.com", fullName: "Jordan" });
  check("conflict", out.kind === "conflict", out.kind);
});

Deno.test("removal DEACTIVATES and never deletes", async () => {
  // ⚠️ The expensive one. Assignments live in pm_items.values as a bare array of
  // pm_people.id with no foreign key, so a delete turns every card they were ever assigned
  // into a raw uuid — and migration 148 already had to rewrite those blobs once.
  const { admin, state } = makeAdmin([
    { id: "p1", name: "Jane", email: "jane@x.com", user_id: "u-jane", active: true, position: 1024 },
  ]);
  const hit = await deactivateRosterMember(admin, "u-jane");
  check("found", hit === true);
  check("row survives", state.rows.length === 1);
  check("archived", state.rows[0].active === false);
  check("still resolvable", state.rows[0].name === "Jane", "the name must survive for old cards");

  // A no-op for somebody who was never on the roster, so callers need not check first.
  check("no-op", (await deactivateRosterMember(admin, "u-nobody")) === false);
});

Deno.test("wantsRoster follows the AREA, at either level", () => {
  check("view counts", wantsRoster({ projects: "view" }) === true);
  check("edit counts", wantsRoster({ projects: "edit" }) === true);
  check("none does not", wantsRoster({ projects: "none" }) === false);
  check("absent does not", wantsRoster({ designs: "edit" }) === false);
  check("null map", wantsRoster(null) === false);
});
