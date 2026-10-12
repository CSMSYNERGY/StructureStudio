// My Synergy Phone 0.1.4: "Open in Structure Studio" shows the page in the Structure Studio tab
// already open (Carolyn 2026-10-12: "I'm already here? Why would I the first time want to go to a
// new tab?"). This is the portal's half: each tab keeps one port open to the extension and routes
// in place when asked. Tested against the SHIPPED source (portal/01-core.jsx), sliced between the
// same stable anchors portalPhone_test.ts uses, with a fake extension, document and timers.
//
// Run: deno test --node-modules-dir=none --allow-read tests/phone/

import { assert, assertEquals } from "jsr:@std/assert@1";

const CORE = (await Deno.readTextFile(new URL("../../portal/01-core.jsx", import.meta.url))).replace(/\r\n/g, "\n");
const slice = (src: string, a: string, b: string, what: string) => {
  const i = src.indexOf(a), j = src.indexOf(b, i);
  if (i < 0 || j < 0) throw new Error(`portalPhonePort_test: ${what} anchors moved (start=${i}, end=${j}) — re-point them.`);
  return src.slice(i, j);
};
const PHONE_BLOCK = slice(CORE, "function ssOwnPhoneOnly(", "// ── The Settings sub-pages", "MY SYNERGY PHONE helpers");

const EXT = "abcdefghijklmnopabcdefghijklmnop";
const CONTACT = "11111111-2222-4333-8444-555555555555";

type Msg = Record<string, unknown>;
type Fn = (...a: unknown[]) => void;

/** A fake extension port: what the page posts, and the extension's side of the two events. */
function fakePort() {
  const onMessage: Fn[] = [];
  const onDisconnect: Fn[] = [];
  const posted: Msg[] = [];
  return {
    posted,
    port: {
      postMessage: (m: Msg) => posted.push(m),
      onMessage: { addListener: (f: Fn) => onMessage.push(f) },
      onDisconnect: { addListener: (f: Fn) => onDisconnect.push(f) },
    },
    send: (m: Msg) => onMessage.forEach((f) => f(m)),
    close: () => onDisconnect.forEach((f) => f()),
  };
}

/**
 * The phone block running in a fake tab at `href`. `connect` is the extension's chrome.runtime
 * .connect (absent: a browser or extension without it). Timers are held, not run, until `tick`.
 */
function tab(opts: { search?: string; pathname?: string; pinged?: boolean; connect?: boolean; visible?: boolean } = {}) {
  const sent: Msg[] = [];
  const ports: ReturnType<typeof fakePort>[] = [];
  // Held timers, with their delay: the ping's own 800 ms timeout goes through here too.
  const timers: { f: Fn; ms: number }[] = [];
  const pushed: string[] = [];
  const popped: unknown[] = [];
  const listeners: Record<string, Fn[]> = {};
  const location = { href: "", pathname: opts.pathname ?? "/portal/designs", search: opts.search ?? "" };
  const runtime: Record<string, unknown> = { lastError: undefined };
  runtime.sendMessage = (_id: string, m: Msg, cb: (r: unknown) => void) => {
    sent.push(m);
    queueMicrotask(() => cb(opts.pinged === false ? undefined : { ok: true, version: "0.1.4" }));
  };
  if (opts.connect !== false) {
    runtime.connect = (id: string, info: { name: string }) => {
      sent.push({ connect: id, name: info.name });
      const p = fakePort();
      ports.push(p);
      return p.port;
    };
  }
  const win = {
    location,
    SS_PHONE_EXTENSION_IDS: [EXT],
    chrome: { runtime },
    history: {
      state: null as unknown,
      pushState(state: unknown, _t: string, url: string) {
        this.state = state;
        pushed.push(url);
        const [path, q] = url.split("?");
        location.pathname = path;
        location.search = q ? `?${q}` : "";
      },
    },
    // As the browser does: every popstate listener hears it (the shell's router, and the port's).
    dispatchEvent: (e: { type: string; state: unknown }) => {
      popped.push(e);
      for (const f of listeners[`window:${e.type}`] ?? []) f(e);
    },
    addEventListener: (type: string, f: Fn) => (listeners[`window:${type}`] ??= []).push(f),
  };
  const doc = {
    visibilityState: opts.visible === false ? "hidden" : "visible",
    addEventListener: (type: string, f: Fn) => (listeners[`document:${type}`] ??= []).push(f),
  };
  class PopStateEvent {
    type: string;
    state: unknown;
    constructor(type: string, init: { state: unknown }) {
      this.type = type;
      this.state = init.state;
    }
  }
  const ssPagePath = (page: string, sub: string | null) => "/portal" + (page ? "/" + page : "") + (page && sub ? "/" + sub : "") + (location.search || "");
  // The router's reading of the address (01-core ssParsePath, without its old-name aliases).
  const ssParsePath = () => {
    const parts = location.pathname.split("/").filter(Boolean);
    return parts[0] === "portal" ? { page: parts[1] || null, sub: parts[2] || null } : { page: null, sub: null };
  };
  const h = new Function(
    "window", "navigator", "ssIsBetaHost", "ssPagePath", "ssParsePath", "document", "PopStateEvent", "setTimeout", "clearTimeout",
    `${PHONE_BLOCK}; return { ssPhoneNavTarget, ssPhoneRoutable, ssPhonePortOpen, ssPhonePortVisit };`,
  )(
    win, { userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/140" }, () => false, ssPagePath, ssParsePath, doc, PopStateEvent,
    (f: Fn, ms: number) => { timers.push({ f, ms }); return timers.length; }, () => {},
  ) as { ssPhoneNavTarget: (m: unknown) => unknown; ssPhoneRoutable: (s?: string) => boolean; ssPhonePortOpen: () => Promise<void>; ssPhonePortVisit: () => void };
  const settle = () => new Promise((r) => setTimeout(r, 0));
  /** Run the held timers except the ping timeouts (the fake extension always answers in time). */
  const tick = async () => {
    const due = timers.splice(0).filter((t) => t.ms !== 800);
    for (const t of due) t.f();
    await settle();
    await settle();
  };
  /** The port (re)connects held: the load's 0 ms one and a reconnect's 1 s one. */
  const opens = () => timers.filter((t) => t.ms !== 800);
  return { h, win, doc, sent, ports, opens, pushed, popped, listeners, location, tick };
}

Deno.test("the page asked for is a router slug and sub-slug, never a URL", () => {
  const { h } = tab();
  assertEquals(h.ssPhoneNavTarget({ page: "contacts", sub: `c-${CONTACT}` }), { page: "contacts", sub: `c-${CONTACT}` });
  assertEquals(h.ssPhoneNavTarget({ page: "settings", sub: "phone" }), { page: "settings", sub: "phone" });
  assertEquals(h.ssPhoneNavTarget({ page: "contacts" }), { page: "contacts", sub: null });
  for (const bad of [null, "contacts", { page: "Contacts" }, { page: "//evil.test" }, { page: "contacts", sub: "c-1/../admin" }, { page: "contacts", sub: "x?view=y" }, { page: "contacts", sub: "" }, { page: 7 }]) {
    assertEquals(h.ssPhoneNavTarget(bad), null, JSON.stringify(bad));
  }
});

Deno.test("view-as and the Projects pop-out are never routed for the extension", () => {
  const { h } = tab();
  assert(h.ssPhoneRoutable(""));
  assert(h.ssPhoneRoutable("?tab=x"));
  assert(!h.ssPhoneRoutable("?view=some-builder"));
  assert(!h.ssPhoneRoutable("?popout=1"));
});

Deno.test("on load the tab pings, opens ONE port named sss.portal, and says it is on screen and routable", async () => {
  const t = tab();
  assertEquals(t.opens().length, 1, "the port opens once the app has loaded, not during the script's first run");
  assert(t.listeners["document:visibilitychange"] && t.listeners["window:focus"] && t.listeners["window:pageshow"]);
  await t.tick();
  assertEquals(t.sent.map((m) => m.type ?? m.name), ["sss.ping", "sss.portal"]);
  assertEquals(t.sent[1], { connect: EXT, name: "sss.portal" });
  assertEquals(t.ports.length, 1);
  const hello = t.ports[0].posted[0];
  assertEquals(hello.type, "sss.hello");
  assertEquals(hello.visible, true);
  assertEquals(hello.routable, true);
  assert(typeof hello.seen_at === "number" && (hello.seen_at as number) > 0);
  assertEquals([hello.page, hello.sub], ["designs", null], "the page it shows, as the router names it");
  // A visit while the port is open says so, and opens nothing more.
  t.h.ssPhonePortVisit();
  assertEquals(t.ports[0].posted.at(-1)?.type, "sss.seen");
  assertEquals(t.ports.length, 1);
});

Deno.test("sss.navigate routes this tab in place, the way Back does, and answers ok", async () => {
  const t = tab();
  await t.tick();
  const p = t.ports[0];
  p.send({ type: "sss.welcome", version: "0.1.4" });
  p.send({ type: "sss.navigate", id: 3, page: "contacts", sub: `c-${CONTACT}` });
  assertEquals(t.pushed, [`/portal/contacts/c-${CONTACT}`]);
  assertEquals(t.popped.length, 1);
  assertEquals((t.popped[0] as { type: string }).type, "popstate");
  assertEquals(p.posted.at(-1), { type: "sss.navigated", id: 3, ok: true });
  // Asked again for the page it is already on: no second history entry, still ok.
  p.send({ type: "sss.navigate", id: 4, page: "contacts", sub: `c-${CONTACT}` });
  assertEquals(t.pushed.length, 1);
  assertEquals(p.posted.at(-1), { type: "sss.navigated", id: 4, ok: true });
  // Junk is refused, and nothing moves.
  p.send({ type: "sss.navigate", id: 5, page: "https://evil.test", sub: null });
  assertEquals(p.posted.at(-1), { type: "sss.navigated", id: 5, ok: false, error: "bad_request" });
  assertEquals(t.pushed.length, 1);
});

Deno.test("the tab says which page it shows (so one already on the contact is picked first), and says it again after a navigate or Back", async () => {
  const t = tab({ pathname: `/portal/contacts/c-${CONTACT}` });
  await t.tick();
  const p = t.ports[0];
  assertEquals([p.posted[0].page, p.posted[0].sub], ["contacts", `c-${CONTACT}`]);
  p.send({ type: "sss.welcome" });
  p.send({ type: "sss.navigate", id: 1, page: "settings", sub: "phone" });
  const seen = p.posted.filter((m) => m.type === "sss.seen").at(-1);
  assertEquals([seen?.page, seen?.sub], ["settings", "phone"]);
  assertEquals(p.posted.at(-1), { type: "sss.navigated", id: 1, ok: true });
  // Back (the browser's own popstate) says so too.
  t.location.pathname = "/portal/orders";
  for (const f of t.listeners["window:popstate"] ?? []) f({ type: "popstate", state: null });
  assertEquals([p.posted.at(-1)?.type, p.posted.at(-1)?.page, p.posted.at(-1)?.sub], ["sss.seen", "orders", null]);
  // Anything that isn't a router slug is never said: the page is then unknown, not the address.
  t.location.pathname = "/portal/contacts/c-1..%2Fadmin";
  t.h.ssPhonePortVisit();
  assertEquals([p.posted.at(-1)?.page, p.posted.at(-1)?.sub], [null, null]);
});

// ── 02-sales: the SMS tab's hand-off carries the contact's name ────────────────────────────
Deno.test("the SMS tab's Text carries the contact's name, so the extension's Quick sends fill {first_name} (C51)", async () => {
  const SALES = (await Deno.readTextFile(new URL("../../portal/02-sales.jsx", import.meta.url))).replace(/\r\n/g, "\n");
  const routeText = slice(SALES, "const routeText = async () => {", "\n  };\n", "CrmRecord.routeText") + "\n  };";
  const run = async (contact: Record<string, unknown>) => {
    const sent: Msg[] = [];
    const ui: unknown[] = [];
    const f = new Function(
      "setSmsHere", "phoneOn", "canCall", "ssIsPhoneBrowser", "setPhoneUi", "phoneMsg", "ssPhonePing", "ssPhoneSend", "ssPhoneRefusal", "userId", "clientId", "data",
      `${routeText}; return routeText;`,
    )(
      () => {}, true, true, () => false, (u: unknown) => ui.push(u),
      () => ({ to_e164: "+15555550142", contact_id: CONTACT, user_id: "u1", client_id: "demo-tenant" }),
      async () => ({ id: EXT, reply: { ok: true, user_id: "u1", client_id: "demo-tenant" } }),
      async (type: string, m: Msg) => { sent.push({ type, ...m }); return { installed: true, reply: { ok: true } }; },
      () => "", "u1", "demo-tenant", { contact },
    ) as () => Promise<void>;
    await f();
    return { sent, ui };
  };
  const named = await run({ id: CONTACT, name: "Test Customer", phone: "(555) 555-0142" });
  assertEquals(named.sent, [{ type: "sss.text", to_e164: "+15555550142", contact_id: CONTACT, user_id: "u1", client_id: "demo-tenant", name: "Test Customer" }]);
  assertEquals((named.ui.at(-1) as Msg).kind, "texting");
  const unnamed = await run({ id: CONTACT, name: "", phone: "(555) 555-0142" });
  assertEquals(unnamed.sent[0].name, null);
});

Deno.test("a tab in view-as refuses, and says routable:false up front", async () => {
  const t = tab({ search: "?view=some-builder" });
  await t.tick();
  const p = t.ports[0];
  assertEquals(p.posted[0].routable, false);
  p.send({ type: "sss.navigate", id: 1, page: "contacts", sub: `c-${CONTACT}` });
  assertEquals(p.posted.at(-1), { type: "sss.navigated", id: 1, ok: false, error: "not_here" });
  assertEquals(t.pushed, []);
});

Deno.test("a welcomed port that Chrome closes (the extension's worker stopped) reconnects a second later", async () => {
  const t = tab();
  await t.tick();
  t.ports[0].send({ type: "sss.welcome" });
  t.ports[0].close();
  assertEquals(t.opens().map((x) => x.ms), [1000], "one reconnect, a second later");
  await t.tick();
  assertEquals(t.ports.length, 2);
  assertEquals(t.ports[1].posted[0].type, "sss.hello");
});

Deno.test("an extension older than 0.1.4 (no welcome, the port closes at once) isn't asked again within a minute", async () => {
  const t = tab();
  await t.tick();
  t.ports[0].close();
  assertEquals(t.opens().length, 0, "no reconnect for a port that was never welcomed");
  t.h.ssPhonePortVisit();
  await t.tick();
  assertEquals(t.ports.length, 1);
  assertEquals(t.sent.filter((m) => m.type === "sss.ping").length, 1);
});

Deno.test("no connect (another browser, the test harness's stub) and no extension: nothing is opened, and only a ping is tried", async () => {
  const none = tab({ connect: false });
  await none.tick();
  assertEquals(none.sent, [], "without chrome.runtime.connect the page doesn't even ping");
  const absent = tab({ pinged: false });
  await absent.tick();
  assertEquals(absent.sent.map((m) => m.type), ["sss.ping"]);
  assertEquals(absent.ports.length, 0);
});
