// A SUPPORT operator gets no Admin or Projects console on ANY portal, pinned against the
// SHIPPED sources.
//
// Found 2026-09-23 in app_errors: three pairs of admin-catalog get_master + list_clients 403s
// ("Operator access required.") and two portal-projects list_boards 403s ("Support accounts
// can't open Projects"), at a bare /portal/admin and /portal/projects with no ?view=, on
// 2026-09-16 (beta and production) and 09-18. The server refusals were right. The shell was
// wrong: every console gate read `!supportView`, and supportView is `!!viewing && isSupportOp`,
// false on the support account's OWN portal by design (it must not narrow their own tenant). So
// the consoles were drawn, routable and mounted there, and every call they made was refused.
// Nothing threw. The console just sat there being refused.
//
// Two halves, both pinned here:
//   * ADMIN — the shell. The nav item and the AdminShell mount wait for isSupportOp === false,
//     and the two route clamps pass `consolesBarred` (supportView OR a real true), not
//     supportView. isSupportOp starts null, so a reload on /portal/admin cannot mount the
//     console in the gap between is_operator answering and is_support_operator answering.
//   * PROJECTS — migration 250. canProjects comes only from can_open_projects(), whose door 1
//     now answers false for a support_only row, as portal-projects does.
//
// Lifted from the source rather than copied, so a drift fails the push. Same technique as
// tabClamp_test / operatorMirror_test.

import { assert, assertEquals } from "jsr:@std/assert";

// LF-normalised: a Windows checkout with core.autocrlf hands these over as CRLF, and the
// anchors below span line ends.
const read = async (rel: string) => (await Deno.readTextFile(new URL(rel, import.meta.url))).replace(/\r\n/g, "\n");
const CORE = await read("../../../../portal/01-core.jsx");
const SHELL = await read("../../../../portal/12-shell.jsx");

function between(src: string, start: string, end: string, label: string, keepEnd = false): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i + start.length);
  if (i < 0 || j < 0) {
    throw new Error(
      `supportConsoles_test: could not find ${label} (start=${i}, end=${j}). ` +
        "The anchors moved — re-point them rather than deleting this test.",
    );
  }
  return src.slice(i, keepEnd ? j + end.length : j);
}

// ── ssClampTab, exactly as tabClamp_test lifts it (production host, so no beta-only tabs) ──
const CLAMP_BLOCK = between(CORE, "function ssIsBetaHost()", "const ACCENT =", "the clamp block in 01-core.jsx");
type Access = Record<string, string>;
type Clamp = (tab: string, isOperator: boolean, canAdmin: boolean, access: Access | null, supportView?: unknown, canProjects?: unknown) => string;
const { ssClampTab, ssFallbackTab } = new Function("window", `${CLAMP_BLOCK}; return { ssClampTab, ssFallbackTab };`)(
  { location: { hostname: "app.structurestudiosuite.com" } },
) as { ssClampTab: Clamp; ssFallbackTab: (a: Access | null) => string };

// ── The shell's own statements, each lifted whole ──
const SUPPORT_VIEW = between(SHELL, "const supportView =", ";", "supportView", true);
const CONSOLES_BARRED = between(SHELL, "const consolesBarred =", ";", "consolesBarred", true);
const CAN_ADMIN_FOR_URL = between(SHELL, "const canAdminForUrl =", ";\n", "canAdminForUrl", true);
const RESOLVED_TAB = between(SHELL, "const resolvedTab = ssClampTab(", ");", "the URL clamp", true);
const GATES_RESOLVED = between(SHELL, "const gatesResolved =", ";", "gatesResolved", true);
const CAN_ADMIN = between(SHELL, "const canAdmin = viewing ?", ";", "canAdmin", true);
const ACTIVE_TAB = between(SHELL, "const activeTab = ssClampTab(", ");", "the render clamp", true);
const NAV = /\{(isOperator[^{}\n]*?) && navItem\("admin", "Admin"\)\}/.exec(SHELL);
const MOUNT = /\{(adminOpened && [^{}\n]*?) && \(\s*\n\s*<div style=\{\{ display: activeTab === "admin"/.exec(SHELL);
if (!NAV || !MOUNT) {
  throw new Error(`supportConsoles_test: could not find the Admin ${!NAV ? "nav item" : "AdminShell mount"} gate in 12-shell.jsx.`);
}

interface World {
  isOperator: boolean;
  isSupportOp: boolean | null;
  viewing: { clientId: string } | null;
  role: "owner" | "admin" | "user";
  canProjects: boolean | null;
  tab: string;
  entitlement?: unknown;
}
// An owner-ish map for the support account's own row on the internal tenant. Deliberately wide:
// "and yet Admin/Projects are refused" must not be an accident of a narrow map.
const OWN_MAP: Access = { designs: "edit", contacts: "edit", orders: "edit", settings_structures: "edit" };

function shell(w: World) {
  const tenant = { role: w.role, access: OWN_MAP };
  const isAdmin = w.role === "owner" || w.role === "admin";
  const f = new Function(
    "ssClampTab", "isOperator", "isSupportOp", "viewing", "tenant", "canProjects", "tab", "isAdmin", "myAccess", "entitlement", "adminOpened",
    [SUPPORT_VIEW, CONSOLES_BARRED, CAN_ADMIN_FOR_URL, RESOLVED_TAB, GATES_RESOLVED, CAN_ADMIN, ACTIVE_TAB].join("\n") +
      `\nreturn { supportView, consolesBarred, resolvedTab, gatesResolved, canAdmin, activeTab, adminNav: !!(${NAV![1]}), adminMount: !!(${MOUNT![1]}) };`,
  );
  return f(ssClampTab, w.isOperator, w.isSupportOp, w.viewing, tenant, w.canProjects, w.tab, isAdmin, OWN_MAP,
    w.entitlement === undefined ? { status: "active" } : w.entitlement, true) as {
      supportView: unknown; consolesBarred: unknown; resolvedTab: string; gatesResolved: boolean; canAdmin: boolean;
      activeTab: string; adminNav: boolean; adminMount: boolean;
    };
}

const VIEWING = { clientId: "junior-barns" };

Deno.test("a support account on its OWN portal: no Admin nav, no AdminShell, neither console route", () => {
  for (const role of ["user", "owner"] as const) {         // owner: canAdmin true must not reopen them
    for (const canProjects of [false, true]) {             // true = the rpc before migration 250
      const admin = shell({ isOperator: true, isSupportOp: true, viewing: null, role, canProjects, tab: "admin" });
      assert(!admin.adminNav, `Admin nav drawn for a support account (role ${role})`);
      assert(!admin.adminMount, `AdminShell mounted for a support account (role ${role}) — it would fire get_master + list_clients`);
      assertEquals(admin.resolvedTab, ssFallbackTab(OWN_MAP), "the URL clamp let /portal/admin through");
      assertEquals(admin.activeTab, ssFallbackTab(OWN_MAP), "the render clamp let /portal/admin through");
      const projects = shell({ isOperator: true, isSupportOp: true, viewing: null, role, canProjects, tab: "projects" });
      assert(projects.resolvedTab !== "projects" && projects.activeTab !== "projects",
        `/portal/projects resolved for a support account (role ${role}, canProjects ${canProjects})`);
    }
  }
});

Deno.test("a support account keeps the Accounts switcher and its own tenant's tabs", () => {
  // Accounts is how support reaches the next builder, and on its own portal the account is an
  // ordinary member of the internal tenant: the narrowing must not touch that.
  const w = { isOperator: true, isSupportOp: true, viewing: null, role: "owner" as const, canProjects: false };
  assertEquals(shell({ ...w, tab: "accounts" }).activeTab, "accounts");
  for (const tab of ["designs", "orders", "settings"]) assertEquals(shell({ ...w, tab }).activeTab, tab);
  assertEquals(shell({ ...w, tab: "designs" }).canAdmin, true, "canAdmin on the own portal must stay the tenant role");
});

Deno.test("supportView itself is unchanged — still false on the support account's own portal", () => {
  // Widening it would narrow myAccess / mirrorAdmin on their own tenant (12-shell's note on it).
  assertEquals(SUPPORT_VIEW, "const supportView = !!viewing && isSupportOp;");
  assert(!shell({ isOperator: true, isSupportOp: true, viewing: null, role: "user", canProjects: false, tab: "designs" }).supportView);
  assert(shell({ isOperator: true, isSupportOp: true, viewing: VIEWING, role: "user", canProjects: false, tab: "designs" }).supportView);
});

Deno.test("a support account in view-as is still barred from both consoles", () => {
  for (const tab of ["admin", "projects"]) {
    const r = shell({ isOperator: true, isSupportOp: true, viewing: VIEWING, role: "user", canProjects: true, tab });
    assert(r.activeTab !== tab && r.resolvedTab !== tab, `${tab} resolved for support in view-as`);
    assert(!r.adminNav && !r.adminMount);
  }
});

Deno.test("while is_support_operator is still out: Admin is neither drawn nor mounted, and not refused", () => {
  assert(SHELL.includes("const [isSupportOp, setIsSupportOp] = useState(null);"),
    "isSupportOp must start null — a false start mounts AdminShell before the answer on a reload");
  const r = shell({ isOperator: true, isSupportOp: null, viewing: null, role: "user", canProjects: true, tab: "admin" });
  assert(!r.adminNav, "Admin nav drawn before is_support_operator answered");
  assert(!r.adminMount, "AdminShell mounted before is_support_operator answered — its first calls would 403 for support");
  // Not refused, so a platform operator's /portal/admin deep link survives the wait.
  assertEquals(r.resolvedTab, "admin");
  assertEquals(r.activeTab, "admin");
  assert(!r.consolesBarred, "null must not bar the route");
  assertEquals(r.gatesResolved, false, "the URL effect must wait for is_support_operator like it waits for canProjects");
  assertEquals(shell({ isOperator: true, isSupportOp: false, viewing: null, role: "user", canProjects: true, tab: "admin" }).gatesResolved, true);
});

Deno.test("a platform operator keeps Admin and Projects, on their own portal and in view-as", () => {
  for (const viewing of [null, VIEWING]) {
    const a = shell({ isOperator: true, isSupportOp: false, viewing, role: "user", canProjects: true, tab: "admin" });
    assert(a.adminNav && a.adminMount, `platform operator lost Admin (viewing ${!!viewing})`);
    assertEquals(a.resolvedTab, "admin");
    assertEquals(a.activeTab, "admin");
    const p = shell({ isOperator: true, isSupportOp: false, viewing, role: "user", canProjects: true, tab: "projects" });
    assertEquals(p.activeTab, "projects");
  }
});

Deno.test("a non-operator never gets the Admin console, whatever the support flag says", () => {
  for (const isSupportOp of [null, false, true]) {
    const r = shell({ isOperator: false, isSupportOp, viewing: null, role: "owner", canProjects: false, tab: "admin" });
    assert(!r.adminNav && !r.adminMount && r.activeTab !== "admin");
  }
});

Deno.test("PROJECTS: the newest can_open_projects() answers a support_only row at door 1, with no fall-through", async () => {
  // canProjects comes from this rpc and from nothing else, so it is the Projects fix. It must
  // agree with portal-projects, which refuses any support_only operator whatever Team access the
  // same login holds (resolveProjectsAccess returns door 1 whenever an operator row exists).
  const dir = new URL("../../../migrations/", import.meta.url);
  const defs: { name: string; sql: string }[] = [];
  for await (const e of Deno.readDir(dir)) {
    if (!e.isFile || !e.name.endsWith(".sql")) continue;
    const sql = (await Deno.readTextFile(new URL(e.name, dir))).replace(/\r\n/g, "\n");
    if (/create or replace function public\.can_open_projects\(\)/i.test(sql)) defs.push({ name: e.name, sql });
  }
  defs.sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
  assert(defs.length > 0, "no migration defines can_open_projects()");
  const latest = defs[defs.length - 1];
  // Anchored on a line start: 250's own header names this statement in its rollback note.
  const body = between(latest.sql, "\ncreate or replace function public.can_open_projects()", "$fn$;", `can_open_projects in ${latest.name}`)
    .split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
  const door1 = body.indexOf("from public.app_operators");
  const door2 = body.indexOf("from public.client_users");
  assert(door1 >= 0 && door2 > door1, `${latest.name}: door 1 must read app_operators before door 2 reads client_users`);
  const d1 = body.slice(door1, door2);
  assert(/support_only/.test(d1), `${latest.name}: door 1 no longer reads support_only — a support account would be offered Projects`);
  assert(/if found then\s*return v_support_only is not true;\s*end if;/.test(d1),
    `${latest.name}: door 1 must return (not fall through) for any operator row, false for support_only`);
});
