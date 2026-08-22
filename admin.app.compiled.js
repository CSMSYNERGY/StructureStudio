// GENERATED FILE — do not edit. Compiled from admin.app.jsx (sha256 f723f8e309b2)
// by scripts/compile.mjs using vendored babel-standalone 7.23.9. Rebuild: npm run compile
;(function () {
if (window.__ssBootBlocked) return; // the boot guard neutralises compiled scripts via this flag
"use strict";

function _typeof(o) { "@babel/helpers - typeof"; return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function (o) { return typeof o; } : function (o) { return o && "function" == typeof Symbol && o.constructor === Symbol && o !== Symbol.prototype ? "symbol" : typeof o; }, _typeof(o); }
var _excluded = ["style", "wrapStyle"];
function _createForOfIteratorHelper(o, allowArrayLike) { var it = typeof Symbol !== "undefined" && o[Symbol.iterator] || o["@@iterator"]; if (!it) { if (Array.isArray(o) || (it = _unsupportedIterableToArray(o)) || allowArrayLike && o && typeof o.length === "number") { if (it) o = it; var i = 0; var F = function F() {}; return { s: F, n: function n() { if (i >= o.length) return { done: true }; return { done: false, value: o[i++] }; }, e: function e(_e) { throw _e; }, f: F }; } throw new TypeError("Invalid attempt to iterate non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method."); } var normalCompletion = true, didErr = false, err; return { s: function s() { it = it.call(o); }, n: function n() { var step = it.next(); normalCompletion = step.done; return step; }, e: function e(_e2) { didErr = true; err = _e2; }, f: function f() { try { if (!normalCompletion && it["return"] != null) it["return"](); } finally { if (didErr) throw err; } } }; }
function _regeneratorRuntime() { "use strict"; /*! regenerator-runtime -- Copyright (c) 2014-present, Facebook, Inc. -- license (MIT): https://github.com/facebook/regenerator/blob/main/LICENSE */ _regeneratorRuntime = function _regeneratorRuntime() { return e; }; var t, e = {}, r = Object.prototype, n = r.hasOwnProperty, o = Object.defineProperty || function (t, e, r) { t[e] = r.value; }, i = "function" == typeof Symbol ? Symbol : {}, a = i.iterator || "@@iterator", c = i.asyncIterator || "@@asyncIterator", u = i.toStringTag || "@@toStringTag"; function define(t, e, r) { return Object.defineProperty(t, e, { value: r, enumerable: !0, configurable: !0, writable: !0 }), t[e]; } try { define({}, ""); } catch (t) { define = function define(t, e, r) { return t[e] = r; }; } function wrap(t, e, r, n) { var i = e && e.prototype instanceof Generator ? e : Generator, a = Object.create(i.prototype), c = new Context(n || []); return o(a, "_invoke", { value: makeInvokeMethod(t, r, c) }), a; } function tryCatch(t, e, r) { try { return { type: "normal", arg: t.call(e, r) }; } catch (t) { return { type: "throw", arg: t }; } } e.wrap = wrap; var h = "suspendedStart", l = "suspendedYield", f = "executing", s = "completed", y = {}; function Generator() {} function GeneratorFunction() {} function GeneratorFunctionPrototype() {} var p = {}; define(p, a, function () { return this; }); var d = Object.getPrototypeOf, v = d && d(d(values([]))); v && v !== r && n.call(v, a) && (p = v); var g = GeneratorFunctionPrototype.prototype = Generator.prototype = Object.create(p); function defineIteratorMethods(t) { ["next", "throw", "return"].forEach(function (e) { define(t, e, function (t) { return this._invoke(e, t); }); }); } function AsyncIterator(t, e) { function invoke(r, o, i, a) { var c = tryCatch(t[r], t, o); if ("throw" !== c.type) { var u = c.arg, h = u.value; return h && "object" == _typeof(h) && n.call(h, "__await") ? e.resolve(h.__await).then(function (t) { invoke("next", t, i, a); }, function (t) { invoke("throw", t, i, a); }) : e.resolve(h).then(function (t) { u.value = t, i(u); }, function (t) { return invoke("throw", t, i, a); }); } a(c.arg); } var r; o(this, "_invoke", { value: function value(t, n) { function callInvokeWithMethodAndArg() { return new e(function (e, r) { invoke(t, n, e, r); }); } return r = r ? r.then(callInvokeWithMethodAndArg, callInvokeWithMethodAndArg) : callInvokeWithMethodAndArg(); } }); } function makeInvokeMethod(e, r, n) { var o = h; return function (i, a) { if (o === f) throw new Error("Generator is already running"); if (o === s) { if ("throw" === i) throw a; return { value: t, done: !0 }; } for (n.method = i, n.arg = a;;) { var c = n.delegate; if (c) { var u = maybeInvokeDelegate(c, n); if (u) { if (u === y) continue; return u; } } if ("next" === n.method) n.sent = n._sent = n.arg;else if ("throw" === n.method) { if (o === h) throw o = s, n.arg; n.dispatchException(n.arg); } else "return" === n.method && n.abrupt("return", n.arg); o = f; var p = tryCatch(e, r, n); if ("normal" === p.type) { if (o = n.done ? s : l, p.arg === y) continue; return { value: p.arg, done: n.done }; } "throw" === p.type && (o = s, n.method = "throw", n.arg = p.arg); } }; } function maybeInvokeDelegate(e, r) { var n = r.method, o = e.iterator[n]; if (o === t) return r.delegate = null, "throw" === n && e.iterator["return"] && (r.method = "return", r.arg = t, maybeInvokeDelegate(e, r), "throw" === r.method) || "return" !== n && (r.method = "throw", r.arg = new TypeError("The iterator does not provide a '" + n + "' method")), y; var i = tryCatch(o, e.iterator, r.arg); if ("throw" === i.type) return r.method = "throw", r.arg = i.arg, r.delegate = null, y; var a = i.arg; return a ? a.done ? (r[e.resultName] = a.value, r.next = e.nextLoc, "return" !== r.method && (r.method = "next", r.arg = t), r.delegate = null, y) : a : (r.method = "throw", r.arg = new TypeError("iterator result is not an object"), r.delegate = null, y); } function pushTryEntry(t) { var e = { tryLoc: t[0] }; 1 in t && (e.catchLoc = t[1]), 2 in t && (e.finallyLoc = t[2], e.afterLoc = t[3]), this.tryEntries.push(e); } function resetTryEntry(t) { var e = t.completion || {}; e.type = "normal", delete e.arg, t.completion = e; } function Context(t) { this.tryEntries = [{ tryLoc: "root" }], t.forEach(pushTryEntry, this), this.reset(!0); } function values(e) { if (e || "" === e) { var r = e[a]; if (r) return r.call(e); if ("function" == typeof e.next) return e; if (!isNaN(e.length)) { var o = -1, i = function next() { for (; ++o < e.length;) if (n.call(e, o)) return next.value = e[o], next.done = !1, next; return next.value = t, next.done = !0, next; }; return i.next = i; } } throw new TypeError(_typeof(e) + " is not iterable"); } return GeneratorFunction.prototype = GeneratorFunctionPrototype, o(g, "constructor", { value: GeneratorFunctionPrototype, configurable: !0 }), o(GeneratorFunctionPrototype, "constructor", { value: GeneratorFunction, configurable: !0 }), GeneratorFunction.displayName = define(GeneratorFunctionPrototype, u, "GeneratorFunction"), e.isGeneratorFunction = function (t) { var e = "function" == typeof t && t.constructor; return !!e && (e === GeneratorFunction || "GeneratorFunction" === (e.displayName || e.name)); }, e.mark = function (t) { return Object.setPrototypeOf ? Object.setPrototypeOf(t, GeneratorFunctionPrototype) : (t.__proto__ = GeneratorFunctionPrototype, define(t, u, "GeneratorFunction")), t.prototype = Object.create(g), t; }, e.awrap = function (t) { return { __await: t }; }, defineIteratorMethods(AsyncIterator.prototype), define(AsyncIterator.prototype, c, function () { return this; }), e.AsyncIterator = AsyncIterator, e.async = function (t, r, n, o, i) { void 0 === i && (i = Promise); var a = new AsyncIterator(wrap(t, r, n, o), i); return e.isGeneratorFunction(r) ? a : a.next().then(function (t) { return t.done ? t.value : a.next(); }); }, defineIteratorMethods(g), define(g, u, "Generator"), define(g, a, function () { return this; }), define(g, "toString", function () { return "[object Generator]"; }), e.keys = function (t) { var e = Object(t), r = []; for (var n in e) r.push(n); return r.reverse(), function next() { for (; r.length;) { var t = r.pop(); if (t in e) return next.value = t, next.done = !1, next; } return next.done = !0, next; }; }, e.values = values, Context.prototype = { constructor: Context, reset: function reset(e) { if (this.prev = 0, this.next = 0, this.sent = this._sent = t, this.done = !1, this.delegate = null, this.method = "next", this.arg = t, this.tryEntries.forEach(resetTryEntry), !e) for (var r in this) "t" === r.charAt(0) && n.call(this, r) && !isNaN(+r.slice(1)) && (this[r] = t); }, stop: function stop() { this.done = !0; var t = this.tryEntries[0].completion; if ("throw" === t.type) throw t.arg; return this.rval; }, dispatchException: function dispatchException(e) { if (this.done) throw e; var r = this; function handle(n, o) { return a.type = "throw", a.arg = e, r.next = n, o && (r.method = "next", r.arg = t), !!o; } for (var o = this.tryEntries.length - 1; o >= 0; --o) { var i = this.tryEntries[o], a = i.completion; if ("root" === i.tryLoc) return handle("end"); if (i.tryLoc <= this.prev) { var c = n.call(i, "catchLoc"), u = n.call(i, "finallyLoc"); if (c && u) { if (this.prev < i.catchLoc) return handle(i.catchLoc, !0); if (this.prev < i.finallyLoc) return handle(i.finallyLoc); } else if (c) { if (this.prev < i.catchLoc) return handle(i.catchLoc, !0); } else { if (!u) throw new Error("try statement without catch or finally"); if (this.prev < i.finallyLoc) return handle(i.finallyLoc); } } } }, abrupt: function abrupt(t, e) { for (var r = this.tryEntries.length - 1; r >= 0; --r) { var o = this.tryEntries[r]; if (o.tryLoc <= this.prev && n.call(o, "finallyLoc") && this.prev < o.finallyLoc) { var i = o; break; } } i && ("break" === t || "continue" === t) && i.tryLoc <= e && e <= i.finallyLoc && (i = null); var a = i ? i.completion : {}; return a.type = t, a.arg = e, i ? (this.method = "next", this.next = i.finallyLoc, y) : this.complete(a); }, complete: function complete(t, e) { if ("throw" === t.type) throw t.arg; return "break" === t.type || "continue" === t.type ? this.next = t.arg : "return" === t.type ? (this.rval = this.arg = t.arg, this.method = "return", this.next = "end") : "normal" === t.type && e && (this.next = e), y; }, finish: function finish(t) { for (var e = this.tryEntries.length - 1; e >= 0; --e) { var r = this.tryEntries[e]; if (r.finallyLoc === t) return this.complete(r.completion, r.afterLoc), resetTryEntry(r), y; } }, "catch": function _catch(t) { for (var e = this.tryEntries.length - 1; e >= 0; --e) { var r = this.tryEntries[e]; if (r.tryLoc === t) { var n = r.completion; if ("throw" === n.type) { var o = n.arg; resetTryEntry(r); } return o; } } throw new Error("illegal catch attempt"); }, delegateYield: function delegateYield(e, r, n) { return this.delegate = { iterator: values(e), resultName: r, nextLoc: n }, "next" === this.method && (this.arg = t), y; } }, e; }
function _toConsumableArray(arr) { return _arrayWithoutHoles(arr) || _iterableToArray(arr) || _unsupportedIterableToArray(arr) || _nonIterableSpread(); }
function _nonIterableSpread() { throw new TypeError("Invalid attempt to spread non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method."); }
function _iterableToArray(iter) { if (typeof Symbol !== "undefined" && iter[Symbol.iterator] != null || iter["@@iterator"] != null) return Array.from(iter); }
function _arrayWithoutHoles(arr) { if (Array.isArray(arr)) return _arrayLikeToArray(arr); }
function asyncGeneratorStep(gen, resolve, reject, _next, _throw, key, arg) { try { var info = gen[key](arg); var value = info.value; } catch (error) { reject(error); return; } if (info.done) { resolve(value); } else { Promise.resolve(value).then(_next, _throw); } }
function _asyncToGenerator(fn) { return function () { var self = this, args = arguments; return new Promise(function (resolve, reject) { var gen = fn.apply(self, args); function _next(value) { asyncGeneratorStep(gen, resolve, reject, _next, _throw, "next", value); } function _throw(err) { asyncGeneratorStep(gen, resolve, reject, _next, _throw, "throw", err); } _next(undefined); }); }; }
function _extends() { _extends = Object.assign ? Object.assign.bind() : function (target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i]; for (var key in source) { if (Object.prototype.hasOwnProperty.call(source, key)) { target[key] = source[key]; } } } return target; }; return _extends.apply(this, arguments); }
function ownKeys(e, r) { var t = Object.keys(e); if (Object.getOwnPropertySymbols) { var o = Object.getOwnPropertySymbols(e); r && (o = o.filter(function (r) { return Object.getOwnPropertyDescriptor(e, r).enumerable; })), t.push.apply(t, o); } return t; }
function _objectSpread(e) { for (var r = 1; r < arguments.length; r++) { var t = null != arguments[r] ? arguments[r] : {}; r % 2 ? ownKeys(Object(t), !0).forEach(function (r) { _defineProperty(e, r, t[r]); }) : Object.getOwnPropertyDescriptors ? Object.defineProperties(e, Object.getOwnPropertyDescriptors(t)) : ownKeys(Object(t)).forEach(function (r) { Object.defineProperty(e, r, Object.getOwnPropertyDescriptor(t, r)); }); } return e; }
function _defineProperty(obj, key, value) { key = _toPropertyKey(key); if (key in obj) { Object.defineProperty(obj, key, { value: value, enumerable: true, configurable: true, writable: true }); } else { obj[key] = value; } return obj; }
function _toPropertyKey(t) { var i = _toPrimitive(t, "string"); return "symbol" == _typeof(i) ? i : String(i); }
function _toPrimitive(t, r) { if ("object" != _typeof(t) || !t) return t; var e = t[Symbol.toPrimitive]; if (void 0 !== e) { var i = e.call(t, r || "default"); if ("object" != _typeof(i)) return i; throw new TypeError("@@toPrimitive must return a primitive value."); } return ("string" === r ? String : Number)(t); }
function _slicedToArray(arr, i) { return _arrayWithHoles(arr) || _iterableToArrayLimit(arr, i) || _unsupportedIterableToArray(arr, i) || _nonIterableRest(); }
function _nonIterableRest() { throw new TypeError("Invalid attempt to destructure non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method."); }
function _unsupportedIterableToArray(o, minLen) { if (!o) return; if (typeof o === "string") return _arrayLikeToArray(o, minLen); var n = Object.prototype.toString.call(o).slice(8, -1); if (n === "Object" && o.constructor) n = o.constructor.name; if (n === "Map" || n === "Set") return Array.from(o); if (n === "Arguments" || /^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(n)) return _arrayLikeToArray(o, minLen); }
function _arrayLikeToArray(arr, len) { if (len == null || len > arr.length) len = arr.length; for (var i = 0, arr2 = new Array(len); i < len; i++) arr2[i] = arr[i]; return arr2; }
function _iterableToArrayLimit(r, l) { var t = null == r ? null : "undefined" != typeof Symbol && r[Symbol.iterator] || r["@@iterator"]; if (null != t) { var e, n, i, u, a = [], f = !0, o = !1; try { if (i = (t = t.call(r)).next, 0 === l) { if (Object(t) !== t) return; f = !1; } else for (; !(f = (e = i.call(t)).done) && (a.push(e.value), a.length !== l); f = !0); } catch (r) { o = !0, n = r; } finally { try { if (!f && null != t["return"] && (u = t["return"](), Object(u) !== u)) return; } finally { if (o) throw n; } } return a; } }
function _arrayWithHoles(arr) { if (Array.isArray(arr)) return arr; }
function _objectWithoutProperties(source, excluded) { if (source == null) return {}; var target = _objectWithoutPropertiesLoose(source, excluded); var key, i; if (Object.getOwnPropertySymbols) { var sourceSymbolKeys = Object.getOwnPropertySymbols(source); for (i = 0; i < sourceSymbolKeys.length; i++) { key = sourceSymbolKeys[i]; if (excluded.indexOf(key) >= 0) continue; if (!Object.prototype.propertyIsEnumerable.call(source, key)) continue; target[key] = source[key]; } } return target; }
function _objectWithoutPropertiesLoose(source, excluded) { if (source == null) return {}; var target = {}; var sourceKeys = Object.keys(source); var key, i; for (i = 0; i < sourceKeys.length; i++) { key = sourceKeys[i]; if (excluded.indexOf(key) >= 0) continue; target[key] = source[key]; } return target; }
var _React = React,
  useState = _React.useState,
  useEffect = _React.useEffect,
  useCallback = _React.useCallback;
var createClient = window.supabase.createClient;

// ─── StructureStudio Operator Admin ───
// Standalone app-creator page (no .jsx twin, like portal.html). Assigns master
// building styles + layout items to each client, and manages the global master
// catalog. Gated by the shared ADMIN_PASSWORD edge-function secret — entered
// here, held only in memory, sent with every admin-catalog call. The anon key
// is used solely to invoke the edge function; ALL data work happens server-side
// (service role) in the admin-catalog function.

var SUPABASE_URL = "https://jzeamjbhdrsbygdnphbm.supabase.co";
var SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp6ZWFtamJoZHJzYnlnZG5waGJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczNDIwNDMsImV4cCI6MjA5MjkxODA0M30.YawJS7aiyTbQdwVnzndyKwD2ejNGYhdBSiectURvxwY";
// SESSION-ISOLATED on purpose. With supabase-js defaults this page shares localStorage with
// portal.html on the same origin, so it silently adopted (and auto-refreshed) whatever portal
// session was signed in and sent THAT user's JWT instead of the anon key. admin-catalog's gate
// is dual-credential, so a signed-in NON-operator then hit the hard 403 that
// `checkAdminAuth` returns for a real-but-unauthorized user and could never reach the password
// path at all — i.e. break-glass was broken in exactly the situation you'd reach for it.
// Also stops `detectSessionInUrl` from consuming an auth fragment that lands on /admin.
// The page's stated model is password-only, no session (see the header above); this makes the
// code match it.
var sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false
  }
});

// Hide the operator "Email Sender" card for now. Flip to true to restore it — all
// the wiring (connect/disconnect/test + the admin-catalog actions) stays in place.
var SHOW_EMAIL_SENDER = false;

// ── Central error logging → Supabase app_errors (via the log_error RPC). Best-effort:
// never throws, never blocks the UI. Auto-captures uncaught errors + unhandled promise
// rejections, and anything reported explicitly via window.ssLogError(source,msg,code,ctx). ──
var SS_ERR_SOURCE = "admin";
function ssLogError(source, message, code, context) {
  try {
    var params = new URLSearchParams(location.search);
    fetch(SUPABASE_URL + "/rest/v1/rpc/log_error", {
      method: "POST",
      keepalive: true,
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": "Bearer " + SUPABASE_ANON_KEY
      },
      body: JSON.stringify({
        p_source: String(source || SS_ERR_SOURCE).slice(0, 100),
        p_message: String(message == null ? "" : message.message || message).slice(0, 4000),
        p_code: code == null ? null : String(code).slice(0, 100),
        p_client_id: window.__SS_CLIENT_ID__ || params.get("client") || null,
        p_url: location.href.slice(0, 600),
        p_context: context || null
      })
    })["catch"](function () {});
  } catch (_) {/* logging must never break the app */}
}
window.ssLogError = ssLogError;
window.addEventListener("error", function (e) {
  return ssLogError(SS_ERR_SOURCE, e && e.message || "window.onerror", e && e.error && e.error.name, {
    stack: e && e.error && e.error.stack ? String(e.error.stack).slice(0, 2000) : null,
    file: e && e.filename,
    line: e && e.lineno
  });
});
window.addEventListener("unhandledrejection", function (e) {
  var r = e && e.reason;
  ssLogError(SS_ERR_SOURCE, r && r.message || String(r), r && r.name, {
    stack: r && r.stack ? String(r.stack).slice(0, 2000) : null
  });
});
var ACCENT = "#3D3672"; // brand purple
var S = {
  header: {
    background: "linear-gradient(135deg, #3D3672 0%, #1B7895 100%)",
    color: "#FFF",
    padding: "16px 24px",
    display: "flex",
    alignItems: "center",
    gap: 12
  },
  badge: {
    background: ACCENT,
    borderRadius: 8,
    width: 38,
    height: 38,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: 800,
    fontSize: 15
  },
  wrap: {
    padding: 20
  },
  card: {
    background: "#FFF",
    border: "1px solid #E2E8F0",
    borderRadius: 12,
    padding: 18,
    marginBottom: 14
  },
  h2: {
    fontSize: 14,
    fontWeight: 800,
    letterSpacing: 0.3,
    marginBottom: 10
  },
  lbl: {
    fontSize: 11,
    fontWeight: 700,
    color: "#64748B",
    textTransform: "uppercase",
    letterSpacing: 0.5
  },
  input: {
    border: "1px solid #CBD5E1",
    borderRadius: 6,
    padding: "7px 9px",
    fontSize: 13,
    fontWeight: 600,
    background: "#FFF",
    boxSizing: "border-box"
  },
  btn: function btn(bg, fg) {
    return {
      background: bg,
      color: fg,
      border: "none",
      borderRadius: 8,
      padding: "8px 14px",
      fontSize: 13,
      fontWeight: 700,
      cursor: "pointer"
    };
  },
  tab: function tab(on) {
    return {
      padding: "8px 14px",
      borderRadius: 8,
      fontSize: 13,
      fontWeight: 700,
      cursor: "pointer",
      border: "2px solid ".concat(on ? ACCENT : "#E2E8F0"),
      background: on ? ACCENT : "#FFF",
      color: on ? "#FFF" : "#334155"
    };
  },
  pill: function pill(on) {
    return {
      padding: "6px 10px",
      borderRadius: 7,
      fontSize: 12,
      fontWeight: 700,
      cursor: "pointer",
      border: "2px solid ".concat(on ? ACCENT : "#E2E8F0"),
      background: on ? "#DBEAFF" : "#FFF",
      color: on ? ACCENT : "#64748B"
    };
  },
  err: {
    background: "#FEF2F2",
    border: "1px solid #FECACA",
    borderRadius: 8,
    padding: "9px 13px",
    color: "#DC2626",
    fontSize: 13,
    fontWeight: 600,
    marginBottom: 12
  },
  ok: {
    background: "#F0FDF4",
    border: "1px solid #BBF7D0",
    borderRadius: 8,
    padding: "9px 13px",
    color: "#15803D",
    fontSize: 13,
    fontWeight: 600,
    marginBottom: 12
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "8px 0",
    borderBottom: "1px solid #F1F5F9"
  }
};

// Board-and-batten door glyph — mirrors the designer's palette icon so the door items
// look the same here as in the layout. Rendered for the singleDoor/doubleDoor item keys
// (via layoutItemGlyph) instead of the generic door emoji.
function DoorIcon(_ref) {
  var _ref$double = _ref["double"],
    _double = _ref$double === void 0 ? false : _ref$double;
  var FRAME = "#ECE4D3",
    PANEL = "#B99A82",
    PLANK = "#8B7058",
    IRON = "#2C2A28";
  var leaf = function leaf(x, w, hingeLeft) {
    var planks = [];
    for (var i = 1; i <= 3; i++) {
      var px = x + w * i / 4;
      planks.push( /*#__PURE__*/React.createElement("line", {
        key: i,
        x1: px,
        y1: 2.6,
        x2: px,
        y2: 15.4,
        stroke: PLANK,
        strokeWidth: 0.4
      }));
    }
    var hx = hingeLeft ? x + 0.5 : x + w - 1.8;
    return /*#__PURE__*/React.createElement("g", {
      key: x
    }, /*#__PURE__*/React.createElement("rect", {
      x: x,
      y: 1,
      width: w,
      height: 16,
      rx: 0.5,
      fill: FRAME,
      stroke: "#B5A98E",
      strokeWidth: 0.7
    }), /*#__PURE__*/React.createElement("rect", {
      x: x + 1.1,
      y: 2.2,
      width: w - 2.2,
      height: 13.6,
      fill: PANEL
    }), planks, /*#__PURE__*/React.createElement("rect", {
      x: x + 1.1,
      y: 8.1,
      width: w - 2.2,
      height: 1.2,
      fill: FRAME
    }), /*#__PURE__*/React.createElement("rect", {
      x: hx,
      y: 3.4,
      width: 1.3,
      height: 0.9,
      fill: IRON
    }), /*#__PURE__*/React.createElement("rect", {
      x: hx,
      y: 12.8,
      width: 1.3,
      height: 0.9,
      fill: IRON
    }));
  };
  if (_double) {
    return /*#__PURE__*/React.createElement("svg", {
      width: 18,
      height: 16,
      viewBox: "0 0 20 18",
      style: {
        display: "block"
      },
      "aria-hidden": "true"
    }, leaf(0.5, 9, true), leaf(10.5, 9, false), /*#__PURE__*/React.createElement("rect", {
      x: 9.2,
      y: 8.3,
      width: 1.6,
      height: 0.9,
      fill: IRON
    }));
  }
  return /*#__PURE__*/React.createElement("svg", {
    width: 11,
    height: 16,
    viewBox: "0 0 12 18",
    style: {
      display: "block"
    },
    "aria-hidden": "true"
  }, leaf(0.5, 11, true), /*#__PURE__*/React.createElement("rect", {
    x: 9.4,
    y: 8.2,
    width: 1.4,
    height: 0.9,
    fill: IRON
  }));
}
// Icon for a layout-item row: the board-and-batten DoorIcon for the door items, the
// item's emoji otherwise.
function layoutItemGlyph(it) {
  if (it.item_key === "singleDoor") return /*#__PURE__*/React.createElement(DoorIcon, null);
  if (it.item_key === "doubleDoor") return /*#__PURE__*/React.createElement(DoorIcon, {
    "double": true
  });
  return it.icon;
}

// Password input with a show/hide (eye) toggle. Forwards all input props; `wrapStyle`
// carries any flex/grid sizing onto the positioned wrapper so layouts are preserved.
function PasswordInput(_ref2) {
  var style = _ref2.style,
    wrapStyle = _ref2.wrapStyle,
    rest = _objectWithoutProperties(_ref2, _excluded);
  var _useState = useState(false),
    _useState2 = _slicedToArray(_useState, 2),
    show = _useState2[0],
    setShow = _useState2[1];
  return /*#__PURE__*/React.createElement("div", {
    style: _objectSpread({
      position: "relative",
      width: "100%",
      boxSizing: "border-box"
    }, wrapStyle)
  }, /*#__PURE__*/React.createElement("input", _extends({}, rest, {
    type: show ? "text" : "password",
    style: _objectSpread(_objectSpread({}, style), {}, {
      width: "100%",
      boxSizing: "border-box",
      paddingRight: 38
    })
  })), /*#__PURE__*/React.createElement("button", {
    type: "button",
    tabIndex: -1,
    "aria-label": show ? "Hide password" : "Show password",
    title: show ? "Hide password" : "Show password",
    onMouseDown: function onMouseDown(e) {
      return e.preventDefault();
    },
    onClick: function onClick() {
      return setShow(function (v) {
        return !v;
      });
    },
    style: {
      position: "absolute",
      top: 0,
      right: 0,
      height: "100%",
      width: 34,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "transparent",
      border: "none",
      padding: 0,
      margin: 0,
      cursor: "pointer",
      color: "#64748B"
    }
  }, show ? /*#__PURE__*/React.createElement("svg", {
    width: "18",
    height: "18",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": "true"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M9.88 9.88a3 3 0 1 0 4.24 4.24"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"
  }), /*#__PURE__*/React.createElement("line", {
    x1: "2",
    x2: "22",
    y1: "2",
    y2: "22"
  })) : /*#__PURE__*/React.createElement("svg", {
    width: "18",
    height: "18",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": "true"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "12",
    cy: "12",
    r: "3"
  }))));
}
function api(_x, _x2, _x3) {
  return _api.apply(this, arguments);
} // ── CSV helpers (RFC-4180-ish) ──────────────────────────────────────────────
function _api() {
  _api = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee15(action, password, body) {
    var _yield$sb$functions$i, data, error, msg, ctx, b;
    return _regeneratorRuntime().wrap(function _callee15$(_context15) {
      while (1) switch (_context15.prev = _context15.next) {
        case 0:
          _context15.next = 2;
          return sb.functions.invoke("admin-catalog", {
            body: _objectSpread({
              action: action,
              adminPassword: password
            }, body || {})
          });
        case 2:
          _yield$sb$functions$i = _context15.sent;
          data = _yield$sb$functions$i.data;
          error = _yield$sb$functions$i.error;
          if (!error) {
            _context15.next = 19;
            break;
          }
          // supabase-js wraps any non-2xx response in a FunctionsHttpError whose .message is the
          // opaque "Edge Function returned a non-2xx status code". The real { error } body the
          // function sent is on error.context (the raw Response) — read it so the operator sees
          // the actual reason (e.g. "No Supabase user with email …. Create the login first").
          msg = error.message || "request failed";
          _context15.prev = 7;
          ctx = error.context;
          if (!(ctx && typeof ctx.json === "function")) {
            _context15.next = 14;
            break;
          }
          _context15.next = 12;
          return (typeof ctx.clone === "function" ? ctx.clone() : ctx).json();
        case 12:
          b = _context15.sent;
          if (b && b.error) msg = b.error;
        case 14:
          _context15.next = 18;
          break;
        case 16:
          _context15.prev = 16;
          _context15.t0 = _context15["catch"](7);
        case 18:
          throw new Error(msg);
        case 19:
          if (!(data && data.error)) {
            _context15.next = 21;
            break;
          }
          throw new Error(data.error);
        case 21:
          return _context15.abrupt("return", data);
        case 22:
        case "end":
          return _context15.stop();
      }
    }, _callee15, null, [[7, 16]]);
  }));
  return _api.apply(this, arguments);
}
function csvEscape(v) {
  var s = String(v == null ? "" : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCSV(headers, rows) {
  return [headers].concat(_toConsumableArray(rows)).map(function (r) {
    return r.map(csvEscape).join(",");
  }).join("\r\n");
}
function parseCSV(text) {
  var rows = [];
  var row = [],
    field = "",
    inQ = false;
  text = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (var i = 0; i < text.length; i++) {
    var c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter(function (r) {
    return r.some(function (c) {
      return String(c).trim() !== "";
    });
  });
}
function downloadFile(name, text) {
  var b = new Blob([text], {
    type: "text/csv;charset=utf-8"
  });
  var u = URL.createObjectURL(b);
  var a = document.createElement("a");
  a.href = u;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(u);
}
function slugify(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

// ─── Read-only impersonation view (operator "view portal as <client>") ───
// Renders the SAME Designs & Leads table the owner portal shows, from the
function AdminApp() {
  var _clients$find;
  var _useState3 = useState(""),
    _useState4 = _slicedToArray(_useState3, 2),
    pwd = _useState4[0],
    setPwd = _useState4[1];
  var _useState5 = useState(false),
    _useState6 = _slicedToArray(_useState5, 2),
    authed = _useState6[0],
    setAuthed = _useState6[1];
  var _useState7 = useState([]),
    _useState8 = _slicedToArray(_useState7, 2),
    clients = _useState8[0],
    setClients = _useState8[1];
  var _useState9 = useState(null),
    _useState10 = _slicedToArray(_useState9, 2),
    master = _useState10[0],
    setMaster = _useState10[1];
  var _useState11 = useState(""),
    _useState12 = _slicedToArray(_useState11, 2),
    sel = _useState12[0],
    setSel = _useState12[1];
  var _useState13 = useState(null),
    _useState14 = _slicedToArray(_useState13, 2),
    cat = _useState14[0],
    setCat = _useState14[1];
  var _useState15 = useState("items"),
    _useState16 = _slicedToArray(_useState15, 2),
    tab = _useState16[0],
    setTab = _useState16[1];
  var _useState17 = useState(false),
    _useState18 = _slicedToArray(_useState17, 2),
    busy = _useState18[0],
    setBusy = _useState18[1];
  var _useState19 = useState(null),
    _useState20 = _slicedToArray(_useState19, 2),
    msg = _useState20[0],
    setMsg = _useState20[1];
  var _useState21 = useState(""),
    _useState22 = _slicedToArray(_useState21, 2),
    newStyleName = _useState22[0],
    setNewStyleName = _useState22[1];
  var _useState23 = useState(null),
    _useState24 = _slicedToArray(_useState23, 2),
    newStyleImg = _useState24[0],
    setNewStyleImg = _useState24[1]; // { base64, contentType }
  var _useState25 = useState(false),
    _useState26 = _slicedToArray(_useState25, 2),
    csvBusy = _useState26[0],
    setCsvBusy = _useState26[1];
  var _useState27 = useState(null),
    _useState28 = _slicedToArray(_useState27, 2),
    csvResult = _useState28[0],
    setCsvResult = _useState28[1]; // { imported, skipped[] }
  var _useState29 = useState(0),
    _useState30 = _slicedToArray(_useState29, 2),
    fileKey = _useState30[0],
    setFileKey = _useState30[1]; // bump to remount the (uncontrolled) file input
  var _useState31 = useState(false),
    _useState32 = _slicedToArray(_useState31, 2),
    newOpen = _useState32[0],
    setNewOpen = _useState32[1];
  var _useState33 = useState(""),
    _useState34 = _slicedToArray(_useState33, 2),
    ncId = _useState34[0],
    setNcId = _useState34[1];
  var _useState35 = useState(""),
    _useState36 = _slicedToArray(_useState35, 2),
    ncCompany = _useState36[0],
    setNcCompany = _useState36[1];
  var _useState37 = useState("__none__"),
    _useState38 = _slicedToArray(_useState37, 2),
    ncTemplate = _useState38[0],
    setNcTemplate = _useState38[1];
  var _useState39 = useState(false),
    _useState40 = _slicedToArray(_useState39, 2),
    ncIdTouched = _useState40[0],
    setNcIdTouched = _useState40[1];
  // Non-billable = CSM Synergy's own / demo / testing accounts: they skip the billing
  // gate. A normal new client is billable, so this defaults OFF.
  var _useState41 = useState(false),
    _useState42 = _slicedToArray(_useState41, 2),
    ncExempt = _useState42[0],
    setNcExempt = _useState42[1];
  // Account-level discount (migration 058) — an attribute of the customer, not of a
  // purchase, so it follows them onto every feature they add later.
  var _useState43 = useState("0"),
    _useState44 = _slicedToArray(_useState43, 2),
    ncDiscount = _useState44[0],
    setNcDiscount = _useState44[1];
  // Scope: all features, or only the ones ticked. Empty list on the wire = everything.
  var _useState45 = useState(true),
    _useState46 = _slicedToArray(_useState45, 2),
    ncAllFeat = _useState46[0],
    setNcAllFeat = _useState46[1];
  var _useState47 = useState([]),
    _useState48 = _slicedToArray(_useState47, 2),
    ncFeat = _useState48[0],
    setNcFeat = _useState48[1];
  // Per-client billing editor: the customers who need a discount usually already exist.
  var _useState49 = useState(false),
    _useState50 = _slicedToArray(_useState49, 2),
    billOpen = _useState50[0],
    setBillOpen = _useState50[1];
  var _useState51 = useState("0"),
    _useState52 = _slicedToArray(_useState51, 2),
    billPct = _useState52[0],
    setBillPct = _useState52[1];
  var _useState53 = useState(false),
    _useState54 = _slicedToArray(_useState53, 2),
    billExempt = _useState54[0],
    setBillExempt = _useState54[1];
  var _useState55 = useState(true),
    _useState56 = _slicedToArray(_useState55, 2),
    billAllFeat = _useState56[0],
    setBillAllFeat = _useState56[1];
  var _useState57 = useState([]),
    _useState58 = _slicedToArray(_useState57, 2),
    billFeat = _useState58[0],
    setBillFeat = _useState58[1];
  // Dated free period (059) — yyyy-mm-dd, blank = none.
  var _useState59 = useState(""),
    _useState60 = _slicedToArray(_useState59, 2),
    billUntil = _useState60[0],
    setBillUntil = _useState60[1];
  // Billable features, from billing_plans via list_clients — never hardcoded here.
  var _useState61 = useState([]),
    _useState62 = _slicedToArray(_useState61, 2),
    features = _useState62[0],
    setFeatures = _useState62[1];
  var _useState63 = useState(false),
    _useState64 = _slicedToArray(_useState63, 2),
    linkOpen = _useState64[0],
    setLinkOpen = _useState64[1];
  var _useState65 = useState(""),
    _useState66 = _slicedToArray(_useState65, 2),
    ownerEmail = _useState66[0],
    setOwnerEmail = _useState66[1];
  var _useState67 = useState("owner"),
    _useState68 = _slicedToArray(_useState67, 2),
    linkRole = _useState68[0],
    setLinkRole = _useState68[1];
  var _useState69 = useState(null),
    _useState70 = _slicedToArray(_useState69, 2),
    linkResult = _useState70[0],
    setLinkResult = _useState70[1]; // { email, client, roleLabel, created, emailSent, setupLink, movedFrom }
  var _useState71 = useState(null),
    _useState72 = _slicedToArray(_useState71, 2),
    reassignFrom = _useState72[0],
    setReassignFrom = _useState72[1]; // email already linked elsewhere: { email, role, fromClient } — drives the one-click Reassign prompt
  var _useState73 = useState(function () {
      return new Set();
    }),
    _useState74 = _slicedToArray(_useState73, 2),
    itemSel = _useState74[0],
    setItemSel = _useState74[1]; // staged layout-item picks (applied together on Save)
  var _useState75 = useState(false),
    _useState76 = _slicedToArray(_useState75, 2),
    delOpen = _useState76[0],
    setDelOpen = _useState76[1];
  var _useState77 = useState(""),
    _useState78 = _slicedToArray(_useState77, 2),
    delConfirm = _useState78[0],
    setDelConfirm = _useState78[1];
  // Operator-global email sender (Supabase Auth custom SMTP → a Google account).
  var _useState79 = useState(null),
    _useState80 = _slicedToArray(_useState79, 2),
    emailSender = _useState80[0],
    setEmailSender = _useState80[1]; // null=unloaded · {connected,senderEmail} · {error}
  var _useState81 = useState(false),
    _useState82 = _slicedToArray(_useState81, 2),
    emailOpen = _useState82[0],
    setEmailOpen = _useState82[1];
  var _useState83 = useState("carolyn@csmsynergy.com"),
    _useState84 = _slicedToArray(_useState83, 2),
    emailAddr = _useState84[0],
    setEmailAddr = _useState84[1];
  var _useState85 = useState(""),
    _useState86 = _slicedToArray(_useState85, 2),
    emailPwd = _useState86[0],
    setEmailPwd = _useState86[1];
  var _useState87 = useState(false),
    _useState88 = _slicedToArray(_useState87, 2),
    emailBusy = _useState88[0],
    setEmailBusy = _useState88[1];
  var _useState89 = useState(""),
    _useState90 = _slicedToArray(_useState89, 2),
    emailTestTo = _useState90[0],
    setEmailTestTo = _useState90[1]; // recipient for the "Send test email" button (must be an existing login)
  var _useState91 = useState(false),
    _useState92 = _slicedToArray(_useState91, 2),
    emailTestBusy = _useState92[0],
    setEmailTestBusy = _useState92[1];
  var flash = function flash(m) {
    setMsg(m);
    if (m && m.ok) setTimeout(function () {
      return setMsg(null);
    }, 2500);else if (m && m.err) ssLogError(SS_ERR_SOURCE, m.err, null, {
      ui: "flash"
    });
  };
  var login = /*#__PURE__*/function () {
    var _ref3 = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee() {
      var c, m;
      return _regeneratorRuntime().wrap(function _callee$(_context) {
        while (1) switch (_context.prev = _context.next) {
          case 0:
            setBusy(true);
            setMsg(null);
            _context.prev = 2;
            _context.next = 5;
            return api("list_clients", pwd);
          case 5:
            c = _context.sent;
            _context.next = 8;
            return api("get_master", pwd);
          case 8:
            m = _context.sent;
            setClients(c.clients || []);
            setFeatures(c.features || []);
            setMaster(m);
            setAuthed(true);
            loadEmailSender(); // best-effort; never blocks login
            _context.next = 19;
            break;
          case 16:
            _context.prev = 16;
            _context.t0 = _context["catch"](2);
            flash({
              err: _context.t0.message
            });
          case 19:
            setBusy(false);
          case 20:
          case "end":
            return _context.stop();
        }
      }, _callee, null, [[2, 16]]);
    }));
    return function login() {
      return _ref3.apply(this, arguments);
    };
  }();
  // Read the current Auth email-sender status (best-effort: a missing
  // MGMT_TOKEN or API hiccup must never break the admin page).
  var loadEmailSender = /*#__PURE__*/function () {
    var _ref4 = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee2() {
      return _regeneratorRuntime().wrap(function _callee2$(_context2) {
        while (1) switch (_context2.prev = _context2.next) {
          case 0:
            _context2.prev = 0;
            _context2.t0 = setEmailSender;
            _context2.next = 4;
            return api("get_email_sender", pwd);
          case 4:
            _context2.t1 = _context2.sent;
            (0, _context2.t0)(_context2.t1);
            _context2.next = 11;
            break;
          case 8:
            _context2.prev = 8;
            _context2.t2 = _context2["catch"](0);
            setEmailSender({
              error: _context2.t2.message
            });
          case 11:
          case "end":
            return _context2.stop();
        }
      }, _callee2, null, [[0, 8]]);
    }));
    return function loadEmailSender() {
      return _ref4.apply(this, arguments);
    };
  }();
  var connectEmail = /*#__PURE__*/function () {
    var _ref5 = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee3() {
      var addr, pass, r;
      return _regeneratorRuntime().wrap(function _callee3$(_context3) {
        while (1) switch (_context3.prev = _context3.next) {
          case 0:
            addr = emailAddr.trim();
            pass = emailPwd.replace(/\s+/g, ""); // Google shows it as 4 spaced groups
            if (!(!addr || !pass)) {
              _context3.next = 4;
              break;
            }
            return _context3.abrupt("return");
          case 4:
            setEmailBusy(true);
            setMsg(null);
            _context3.prev = 6;
            _context3.next = 9;
            return api("connect_email", pwd, {
              email: addr,
              appPassword: pass
            });
          case 9:
            r = _context3.sent;
            setEmailSender({
              connected: true,
              senderEmail: r.senderEmail || addr
            });
            setEmailPwd("");
            setEmailOpen(false);
            flash({
              ok: "Connected \u2014 login & invite emails now send from ".concat(r.senderEmail || addr, ".")
            });
            _context3.next = 19;
            break;
          case 16:
            _context3.prev = 16;
            _context3.t0 = _context3["catch"](6);
            flash({
              err: _context3.t0.message
            });
          case 19:
            setEmailBusy(false);
          case 20:
          case "end":
            return _context3.stop();
        }
      }, _callee3, null, [[6, 16]]);
    }));
    return function connectEmail() {
      return _ref5.apply(this, arguments);
    };
  }();
  var disconnectEmail = /*#__PURE__*/function () {
    var _ref6 = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee4() {
      return _regeneratorRuntime().wrap(function _callee4$(_context4) {
        while (1) switch (_context4.prev = _context4.next) {
          case 0:
            setEmailBusy(true);
            setMsg(null);
            _context4.prev = 2;
            _context4.next = 5;
            return api("disconnect_email", pwd);
          case 5:
            setEmailSender({
              connected: false,
              senderEmail: null
            });
            flash({
              ok: "Disconnected — emails will use the Supabase default sender."
            });
            _context4.next = 12;
            break;
          case 9:
            _context4.prev = 9;
            _context4.t0 = _context4["catch"](2);
            flash({
              err: _context4.t0.message
            });
          case 12:
            setEmailBusy(false);
          case 13:
          case "end":
            return _context4.stop();
        }
      }, _callee4, null, [[2, 9]]);
    }));
    return function disconnectEmail() {
      return _ref6.apply(this, arguments);
    };
  }();
  // Send a real auth email (a password reset) through the connected sender to
  // confirm delivery + the From address. Recipient must be an existing login.
  var sendTestEmail = /*#__PURE__*/function () {
    var _ref7 = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee5() {
      var to, r;
      return _regeneratorRuntime().wrap(function _callee5$(_context5) {
        while (1) switch (_context5.prev = _context5.next) {
          case 0:
            to = emailTestTo.trim();
            if (to) {
              _context5.next = 3;
              break;
            }
            return _context5.abrupt("return");
          case 3:
            setEmailTestBusy(true);
            setMsg(null);
            _context5.prev = 5;
            _context5.next = 8;
            return api("test_email", pwd, {
              email: to,
              portalUrl: location.origin + "/portal"
            });
          case 8:
            r = _context5.sent;
            flash({
              ok: "Test sent to ".concat(r.sentTo).concat(r.senderEmail ? " from ".concat(r.senderEmail) : "", " \u2014 check the inbox. It's a password-reset email; nothing changes unless you click the link.")
            });
            _context5.next = 15;
            break;
          case 12:
            _context5.prev = 12;
            _context5.t0 = _context5["catch"](5);
            flash({
              err: _context5.t0.message
            });
          case 15:
            setEmailTestBusy(false);
          case 16:
          case "end":
            return _context5.stop();
        }
      }, _callee5, null, [[5, 12]]);
    }));
    return function sendTestEmail() {
      return _ref7.apply(this, arguments);
    };
  }();
  // `freshClients` lets a caller that JUST refetched the list pass it in: this closure's
  // `clients` is the array from the render it was created in, so right after create_client
  // the new id isn't in it, the billing seed below would read exempt=false / 0%, and one
  // Save would silently wipe the exemption/discount the create form persisted seconds ago.
  var loadClient = /*#__PURE__*/function () {
    var _ref8 = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee6(cid, freshClients) {
      var _row$discountPercent;
      var row, scoped;
      return _regeneratorRuntime().wrap(function _callee6$(_context6) {
        while (1) switch (_context6.prev = _context6.next) {
          case 0:
            setSel(cid);
            setCat(null);
            setMsg(null);
            setCsvResult(null);
            setReassignFrom(null);
            setNewStyleName("");
            setNewStyleImg(null);
            setFileKey(function (k) {
              return k + 1;
            }); // don't carry a half-filled create-style form to another client
            setDelOpen(false);
            setDelConfirm(""); // close any open delete confirmation when switching clients
            setBillOpen(false);
            // Seed the billing editor from the list row so it opens showing what is actually set.
            row = (freshClients || clients).find(function (c) {
              return c.client_id === cid;
            });
            setBillPct(String((_row$discountPercent = row === null || row === void 0 ? void 0 : row.discountPercent) !== null && _row$discountPercent !== void 0 ? _row$discountPercent : 0));
            setBillExempt(Boolean(row === null || row === void 0 ? void 0 : row.billingExempt));
            // NULL / empty in the database means "every feature", which is the radio default.
            scoped = Array.isArray(row === null || row === void 0 ? void 0 : row.discountFeatures) ? row.discountFeatures : [];
            setBillAllFeat(scoped.length === 0);
            setBillFeat(scoped);
            setBillUntil(row !== null && row !== void 0 && row.exemptUntil ? String(row.exemptUntil).slice(0, 10) : "");
            if (cid) {
              _context6.next = 20;
              break;
            }
            return _context6.abrupt("return");
          case 20:
            setBusy(true);
            _context6.prev = 21;
            _context6.t0 = setCat;
            _context6.next = 25;
            return api("get_client_catalog", pwd, {
              clientId: cid
            });
          case 25:
            _context6.t1 = _context6.sent;
            (0, _context6.t0)(_context6.t1);
            _context6.next = 32;
            break;
          case 29:
            _context6.prev = 29;
            _context6.t2 = _context6["catch"](21);
            flash({
              err: _context6.t2.message
            });
          case 32:
            setBusy(false);
          case 33:
          case "end":
            return _context6.stop();
        }
      }, _callee6, null, [[21, 29]]);
    }));
    return function loadClient(_x4, _x5) {
      return _ref8.apply(this, arguments);
    };
  }();
  var createNewClient = /*#__PURE__*/function () {
    var _ref9 = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee7() {
      var id, c;
      return _regeneratorRuntime().wrap(function _callee7$(_context7) {
        while (1) switch (_context7.prev = _context7.next) {
          case 0:
            id = ncId.trim().toLowerCase();
            if (!(!id || !ncCompany.trim())) {
              _context7.next = 3;
              break;
            }
            return _context7.abrupt("return");
          case 3:
            setBusy(true);
            setMsg(null);
            _context7.prev = 5;
            _context7.next = 8;
            return api("create_client", pwd, {
              clientId: id,
              companyName: ncCompany.trim(),
              templateClientId: ncTemplate,
              billingExempt: ncExempt,
              discountPercent: ncExempt ? 0 : Number(ncDiscount) || 0,
              discountFeatures: ncAllFeat ? [] : ncFeat
            });
          case 8:
            _context7.next = 10;
            return api("list_clients", pwd);
          case 10:
            c = _context7.sent;
            setClients(c.clients || []);
            setFeatures(c.features || []);
            setNewOpen(false);
            setNcId("");
            setNcCompany("");
            setNcTemplate("__none__");
            setNcIdTouched(false);
            setNcExempt(false);
            setNcDiscount("0");
            setNcAllFeat(true);
            setNcFeat([]);
            _context7.next = 24;
            return loadClient(id, c.clients || []);
          case 24:
            // the refetched list, NOT this closure's stale `clients` — see loadClient
            flash({
              ok: "Builder \"".concat(id, "\" created. Next: add styles/items/pricing in the tabs, then create the owner login in Supabase Auth + map client_users.")
            });
            _context7.next = 30;
            break;
          case 27:
            _context7.prev = 27;
            _context7.t0 = _context7["catch"](5);
            flash({
              err: _context7.t0.message
            });
          case 30:
            setBusy(false);
          case 31:
          case "end":
            return _context7.stop();
        }
      }, _callee7, null, [[5, 27]]);
    }));
    return function createNewClient() {
      return _ref9.apply(this, arguments);
    };
  }();
  // Which features a discount covers. All (empty list on the wire) or a chosen few.
  // Rendered in both the New client form and the per-client Billing panel.
  var FeatureScope = function FeatureScope(_ref10) {
    var all = _ref10.all,
      setAll = _ref10.setAll,
      picked = _ref10.picked,
      setPicked = _ref10.setPicked,
      disabled = _ref10.disabled;
    return /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 8,
        opacity: disabled ? 0.5 : 1,
        pointerEvents: disabled ? "none" : "auto"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: 16,
        flexWrap: "wrap",
        fontSize: 13,
        color: "#1E293B"
      }
    }, /*#__PURE__*/React.createElement("label", {
      style: {
        display: "flex",
        alignItems: "center",
        gap: 6,
        cursor: "pointer"
      }
    }, /*#__PURE__*/React.createElement("input", {
      type: "radio",
      checked: all,
      onChange: function onChange() {
        return setAll(true);
      }
    }), /*#__PURE__*/React.createElement("span", null, "Every feature")), /*#__PURE__*/React.createElement("label", {
      style: {
        display: "flex",
        alignItems: "center",
        gap: 6,
        cursor: "pointer"
      }
    }, /*#__PURE__*/React.createElement("input", {
      type: "radio",
      checked: !all,
      onChange: function onChange() {
        return setAll(false);
      }
    }), /*#__PURE__*/React.createElement("span", null, "Only the ones I pick"))), !all && /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        flexWrap: "wrap",
        gap: "6px 16px",
        marginTop: 8,
        paddingLeft: 2
      }
    }, features.length === 0 && /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 12,
        color: "#B91C1C"
      }
    }, "No billable features found."), features.map(function (f) {
      return /*#__PURE__*/React.createElement("label", {
        key: f.feature,
        style: {
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 12.5,
          color: "#334155",
          cursor: "pointer"
        }
      }, /*#__PURE__*/React.createElement("input", {
        type: "checkbox",
        checked: picked.indexOf(f.feature) !== -1,
        onChange: function onChange(e) {
          return setPicked(e.target.checked ? picked.concat([f.feature]) : picked.filter(function (x) {
            return x !== f.feature;
          }));
        }
      }), /*#__PURE__*/React.createElement("span", null, f.name, f.required ? " (required)" : "", f.availability === "coming_soon" ? " — soon" : ""));
    })), !all && picked.length === 0 && /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11.5,
        color: "#B91C1C",
        marginTop: 6
      }
    }, "Pick at least one feature, or choose \"Every feature\" \u2014 an empty list means no discount applies anywhere."));
  };
  var saveBilling = /*#__PURE__*/function () {
    var _ref11 = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee8() {
      var pct, r, c;
      return _regeneratorRuntime().wrap(function _callee8$(_context8) {
        while (1) switch (_context8.prev = _context8.next) {
          case 0:
            if (sel) {
              _context8.next = 2;
              break;
            }
            return _context8.abrupt("return");
          case 2:
            pct = Math.round(Number(billPct));
            if (!(!Number.isFinite(pct) || pct < 0 || pct > 100)) {
              _context8.next = 6;
              break;
            }
            flash({
              err: "Discount must be a whole number from 0 to 100."
            });
            return _context8.abrupt("return");
          case 6:
            if (!(pct > 0 && !billExempt && !billAllFeat && billFeat.length === 0)) {
              _context8.next = 9;
              break;
            }
            flash({
              err: "Choose which features the discount applies to, or select \"Every feature\"."
            });
            return _context8.abrupt("return");
          case 9:
            setBusy(true);
            setMsg(null);
            _context8.prev = 11;
            _context8.next = 14;
            return api("set_billing", pwd, {
              clientId: sel,
              billingExempt: billExempt,
              discountPercent: pct,
              discountFeatures: billAllFeat ? [] : billFeat,
              exemptUntil: billUntil
            });
          case 14:
            r = _context8.sent;
            _context8.next = 17;
            return api("list_clients", pwd);
          case 17:
            c = _context8.sent;
            setClients(c.clients || []);
            setFeatures(c.features || []);
            setBillOpen(false);
            flash({
              ok: "Billing saved for ".concat(sel, ". ").concat(r.note || "").trim()
            });
            _context8.next = 27;
            break;
          case 24:
            _context8.prev = 24;
            _context8.t0 = _context8["catch"](11);
            flash({
              err: _context8.t0.message
            });
          case 27:
            setBusy(false);
          case 28:
          case "end":
            return _context8.stop();
        }
      }, _callee8, null, [[11, 24]]);
    }));
    return function saveBilling() {
      return _ref11.apply(this, arguments);
    };
  }();
  // reassign=false → normal link; reassign=true → move a login already mapped to another
  // client (the backend refuses to silently re-home one without this explicit flag).
  var linkOwner = /*#__PURE__*/function () {
    var _ref12 = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee9() {
      var reassign,
        email,
        r,
        roleLabel,
        movedFrom,
        errMsg,
        m,
        _args9 = arguments;
      return _regeneratorRuntime().wrap(function _callee9$(_context9) {
        while (1) switch (_context9.prev = _context9.next) {
          case 0:
            reassign = _args9.length > 0 && _args9[0] !== undefined ? _args9[0] : false;
            if (!(!sel || !ownerEmail.trim())) {
              _context9.next = 3;
              break;
            }
            return _context9.abrupt("return");
          case 3:
            setBusy(true);
            setMsg(null);
            setLinkResult(null);
            _context9.prev = 6;
            email = ownerEmail.trim();
            _context9.next = 10;
            return api("link_owner", pwd, _objectSpread({
              clientId: sel,
              email: email,
              role: linkRole,
              portalUrl: location.origin + "/portal"
            }, reassign ? {
              reassign: true
            } : {}));
          case 10:
            r = _context9.sent;
            roleLabel = r && r.role === "user" ? "team member (Designs & Leads only)" : "admin";
            movedFrom = reassign && reassignFrom ? reassignFrom.fromClient : null; // keep the panel open so the operator can copy the setup link
            setLinkResult({
              email: email,
              client: sel,
              roleLabel: roleLabel,
              created: !!(r && r.created),
              emailSent: !!(r && r.emailSent),
              setupLink: r && r.setupLink || null,
              movedFrom: movedFrom
            });
            setOwnerEmail("");
            setReassignFrom(null);
            flash({
              ok: "\"".concat(email, "\" ").concat(movedFrom ? "reassigned from \"".concat(movedFrom, "\" to") : "linked to", " \"").concat(sel, "\" as ").concat(roleLabel, ".")
            });
            _context9.next = 24;
            break;
          case 19:
            _context9.prev = 19;
            _context9.t0 = _context9["catch"](6);
            // Email already belongs to another tenant: rather than dead-end on the error, offer a
            // one-click Reassign. We key off the backend's stable "reassign:true" instruction and
            // pull the current client out of its message so the prompt can name it.
            errMsg = _context9.t0 && _context9.t0.message || String(_context9.t0);
            if (/reassign\s*:\s*true/i.test(errMsg)) {
              // Tolerates BOTH wordings: the server said "client" before the 2026-08-02
              // builder rename, and an operator's browser can be running a cached page
              // against a newer function (or vice versa) — a strict match would silently
              // stop naming the tenant in the reassign prompt.
              m = /already linked to (?:client|builder) "([^"]+)"/.exec(errMsg);
              setReassignFrom({
                email: ownerEmail.trim(),
                role: linkRole,
                fromClient: m ? m[1] : null
              });
            } else {
              setReassignFrom(null);
            }
            flash({
              err: errMsg
            });
          case 24:
            setBusy(false);
          case 25:
          case "end":
            return _context9.stop();
        }
      }, _callee9, null, [[6, 19]]);
    }));
    return function linkOwner() {
      return _ref12.apply(this, arguments);
    };
  }();
  // Operator hard-delete: server wipes the tenant + all its data (catalog,
  // designs, settings, logins, storage). Guarded by typing the builder id.
  var deleteClient = /*#__PURE__*/function () {
    var _ref13 = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee10() {
      var id, r, c, parts;
      return _regeneratorRuntime().wrap(function _callee10$(_context10) {
        while (1) switch (_context10.prev = _context10.next) {
          case 0:
            id = sel;
            if (!(!id || delConfirm.trim() !== id)) {
              _context10.next = 3;
              break;
            }
            return _context10.abrupt("return");
          case 3:
            setBusy(true);
            setMsg(null);
            _context10.prev = 5;
            _context10.next = 8;
            return api("delete_client", pwd, {
              clientId: id,
              confirmClientId: delConfirm.trim()
            });
          case 8:
            r = _context10.sent;
            _context10.next = 11;
            return api("list_clients", pwd);
          case 11:
            c = _context10.sent;
            setClients(c.clients || []);
            setFeatures(c.features || []);
            setDelOpen(false);
            setDelConfirm("");
            setSel("");
            setCat(null);
            parts = r && r.deleted ? Object.entries(r.deleted).filter(function (_ref14) {
              var _ref15 = _slicedToArray(_ref14, 2),
                v = _ref15[1];
              return v;
            }).map(function (_ref16) {
              var _ref17 = _slicedToArray(_ref16, 2),
                k = _ref17[0],
                v = _ref17[1];
              return "".concat(v, " ").concat(k);
            }).join(", ") : "";
            flash({
              ok: "Builder \"".concat(id, "\" deleted").concat(parts ? " (".concat(parts, ")") : "", ".")
            });
            _context10.next = 25;
            break;
          case 22:
            _context10.prev = 22;
            _context10.t0 = _context10["catch"](5);
            flash({
              err: _context10.t0.message
            });
          case 25:
            setBusy(false);
          case 26:
          case "end":
            return _context10.stop();
        }
      }, _callee10, null, [[5, 22]]);
    }));
    return function deleteClient() {
      return _ref13.apply(this, arguments);
    };
  }();
  var act = /*#__PURE__*/function () {
    var _ref18 = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee11(action, body, ok) {
      var m;
      return _regeneratorRuntime().wrap(function _callee11$(_context11) {
        while (1) switch (_context11.prev = _context11.next) {
          case 0:
            setBusy(true);
            setMsg(null);
            _context11.prev = 2;
            _context11.next = 5;
            return api(action, pwd, body);
          case 5:
            _context11.next = 12;
            break;
          case 7:
            _context11.prev = 7;
            _context11.t0 = _context11["catch"](2);
            flash({
              err: _context11.t0.message
            });
            setBusy(false);
            return _context11.abrupt("return");
          case 12:
            flash({
              ok: ok || "Saved"
            }); // write succeeded — report it BEFORE refreshing
            _context11.prev = 13;
            if (!sel) {
              _context11.next = 20;
              break;
            }
            _context11.t1 = setCat;
            _context11.next = 18;
            return api("get_client_catalog", pwd, {
              clientId: sel
            });
          case 18:
            _context11.t2 = _context11.sent;
            (0, _context11.t1)(_context11.t2);
          case 20:
            _context11.next = 22;
            return api("get_master", pwd);
          case 22:
            m = _context11.sent;
            setMaster(m); // corrupt the on-screen pill state
            _context11.next = 28;
            break;
          case 26:
            _context11.prev = 26;
            _context11.t3 = _context11["catch"](13);
          case 28:
            setBusy(false);
          case 29:
          case "end":
            return _context11.stop();
        }
      }, _callee11, null, [[2, 7], [13, 26]]);
    }));
    return function act(_x6, _x7, _x8) {
      return _ref18.apply(this, arguments);
    };
  }();

  // Layout-item editing is staged: the pills toggle a local selection and nothing is
  // written until "Save". Re-sync the staged set whenever the loaded client/catalog
  // changes (client switch or a post-save refresh). cat only changes on an explicit
  // load/refresh, so an operator's in-progress ticks are never clobbered mid-edit.
  useEffect(function () {
    setItemSel(new Set((cat && cat.clientLayoutItems || []).filter(function (i) {
      return i.active;
    }).map(function (i) {
      return i.item_key;
    })));
  }, [sel, cat]);
  var toggleItemSel = function toggleItemSel(key) {
    return setItemSel(function (prev) {
      var n = new Set(prev);
      n.has(key) ? n["delete"](key) : n.add(key);
      return n;
    });
  };
  var selectAllItems = function selectAllItems() {
    return setItemSel(new Set((master && master.layoutItemTypes || []).map(function (i) {
      return i.item_key;
    })));
  };
  var clearAllItems = function clearAllItems() {
    return setItemSel(new Set());
  };
  // Diff the staged set against what's actually assigned, then apply only the changes
  // (enable newly-ticked, disable newly-unticked) and refresh once at the end — so the
  // operator ticks everything and clicks Save once instead of one request per pill.
  var saveItems = /*#__PURE__*/function () {
    var _ref19 = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee12() {
      var saved, keys, toEnable, toDisable, total, _iterator, _step, k, _iterator2, _step2, _k;
      return _regeneratorRuntime().wrap(function _callee12$(_context12) {
        while (1) switch (_context12.prev = _context12.next) {
          case 0:
            if (!(!sel || !cat || !master)) {
              _context12.next = 2;
              break;
            }
            return _context12.abrupt("return");
          case 2:
            saved = new Set((cat.clientLayoutItems || []).filter(function (i) {
              return i.active;
            }).map(function (i) {
              return i.item_key;
            }));
            keys = (master.layoutItemTypes || []).map(function (i) {
              return i.item_key;
            });
            toEnable = keys.filter(function (k) {
              return itemSel.has(k) && !saved.has(k);
            });
            toDisable = keys.filter(function (k) {
              return !itemSel.has(k) && saved.has(k);
            });
            total = toEnable.length + toDisable.length;
            if (!(total === 0)) {
              _context12.next = 10;
              break;
            }
            flash({
              ok: "No changes to save."
            });
            return _context12.abrupt("return");
          case 10:
            setBusy(true);
            setMsg(null);
            _context12.prev = 12;
            _iterator = _createForOfIteratorHelper(toEnable);
            _context12.prev = 14;
            _iterator.s();
          case 16:
            if ((_step = _iterator.n()).done) {
              _context12.next = 22;
              break;
            }
            k = _step.value;
            _context12.next = 20;
            return api("toggle_item", pwd, {
              clientId: sel,
              itemKey: k,
              active: true
            });
          case 20:
            _context12.next = 16;
            break;
          case 22:
            _context12.next = 27;
            break;
          case 24:
            _context12.prev = 24;
            _context12.t0 = _context12["catch"](14);
            _iterator.e(_context12.t0);
          case 27:
            _context12.prev = 27;
            _iterator.f();
            return _context12.finish(27);
          case 30:
            _iterator2 = _createForOfIteratorHelper(toDisable);
            _context12.prev = 31;
            _iterator2.s();
          case 33:
            if ((_step2 = _iterator2.n()).done) {
              _context12.next = 39;
              break;
            }
            _k = _step2.value;
            _context12.next = 37;
            return api("toggle_item", pwd, {
              clientId: sel,
              itemKey: _k,
              active: false
            });
          case 37:
            _context12.next = 33;
            break;
          case 39:
            _context12.next = 44;
            break;
          case 41:
            _context12.prev = 41;
            _context12.t1 = _context12["catch"](31);
            _iterator2.e(_context12.t1);
          case 44:
            _context12.prev = 44;
            _iterator2.f();
            return _context12.finish(44);
          case 47:
            _context12.next = 54;
            break;
          case 49:
            _context12.prev = 49;
            _context12.t2 = _context12["catch"](12);
            flash({
              err: _context12.t2.message
            });
            setBusy(false);
            return _context12.abrupt("return");
          case 54:
            flash({
              ok: "Saved ".concat(total, " change").concat(total === 1 ? "" : "s", ".")
            });
            _context12.prev = 55;
            _context12.t3 = setCat;
            _context12.next = 59;
            return api("get_client_catalog", pwd, {
              clientId: sel
            });
          case 59:
            _context12.t4 = _context12.sent;
            (0, _context12.t3)(_context12.t4);
            _context12.t5 = setMaster;
            _context12.next = 64;
            return api("get_master", pwd);
          case 64:
            _context12.t6 = _context12.sent;
            (0, _context12.t5)(_context12.t6);
            _context12.next = 70;
            break;
          case 68:
            _context12.prev = 68;
            _context12.t7 = _context12["catch"](55);
          case 70:
            setBusy(false);
          case 71:
          case "end":
            return _context12.stop();
        }
      }, _callee12, null, [[12, 49], [14, 24, 27, 30], [31, 41, 44, 47], [55, 68]]);
    }));
    return function saveItems() {
      return _ref19.apply(this, arguments);
    };
  }();
  var ALLOWED_IMG = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  var onPickStyleImg = function onPickStyleImg(file) {
    if (!file) {
      setNewStyleImg(null);
      return;
    }
    if (!ALLOWED_IMG.includes(file.type)) {
      flash({
        err: "Use a JPG, PNG, WEBP or GIF image."
      });
      setFileKey(function (k) {
        return k + 1;
      });
      return;
    }
    if (file.size > 3000000) {
      flash({
        err: "Image too large (max 3MB)."
      });
      setFileKey(function (k) {
        return k + 1;
      });
      return;
    }
    var r = new FileReader();
    r.onerror = function () {
      return flash({
        err: "Could not read that image."
      });
    };
    r.onload = function () {
      return setNewStyleImg({
        base64: r.result,
        contentType: file.type || "image/jpeg"
      });
    };
    r.readAsDataURL(file);
  };
  var createStyle = /*#__PURE__*/function () {
    var _ref20 = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee13() {
      var imageUrl, up;
      return _regeneratorRuntime().wrap(function _callee13$(_context13) {
        while (1) switch (_context13.prev = _context13.next) {
          case 0:
            if (!(!sel || !newStyleName.trim())) {
              _context13.next = 2;
              break;
            }
            return _context13.abrupt("return");
          case 2:
            setBusy(true);
            setMsg(null);
            _context13.prev = 4;
            imageUrl = null;
            if (!newStyleImg) {
              _context13.next = 11;
              break;
            }
            _context13.next = 9;
            return api("upload_image", pwd, {
              clientId: sel,
              imageBase64: newStyleImg.base64,
              contentType: newStyleImg.contentType
            });
          case 9:
            up = _context13.sent;
            imageUrl = up.url;
          case 11:
            _context13.next = 13;
            return api("create_style", pwd, {
              clientId: sel,
              label: newStyleName.trim(),
              imageUrl: imageUrl
            });
          case 13:
            setNewStyleName("");
            setNewStyleImg(null);
            setFileKey(function (k) {
              return k + 1;
            });
            _context13.t0 = setCat;
            _context13.next = 19;
            return api("get_client_catalog", pwd, {
              clientId: sel
            });
          case 19:
            _context13.t1 = _context13.sent;
            (0, _context13.t0)(_context13.t1);
            flash({
              ok: "Style created"
            });
            _context13.next = 27;
            break;
          case 24:
            _context13.prev = 24;
            _context13.t2 = _context13["catch"](4);
            flash({
              err: _context13.t2.message
            });
          case 27:
            setBusy(false);
          case 28:
          case "end":
            return _context13.stop();
        }
      }, _callee13, null, [[4, 24]]);
    }));
    return function createStyle() {
      return _ref20.apply(this, arguments);
    };
  }();

  // CSV pricing/inclusion: active items for this client with display labels.
  var csvItems = function csvItems() {
    var labelByKey = {};
    (master && master.layoutItemTypes || []).forEach(function (it) {
      labelByKey[it.item_key] = it.label;
    });
    return (cat && cat.clientLayoutItems || []).filter(function (i) {
      return i.active;
    }).map(function (i) {
      return {
        key: i.item_key,
        label: i.label_override || labelByKey[i.item_key] || i.item_key
      };
    });
  };
  var downloadTemplate = function downloadTemplate() {
    var items = csvItems();
    var headers = ["style", "width", "length", "price"].concat(_toConsumableArray(items.map(function (it) {
      return it.label;
    })), ["active"]);
    // Item cells carry the included QUANTITY (loft = sq ft, doors = count); 0 = not included.
    // Legacy "yes"/"no" sheets still upload fine (yes imports as quantity 1).
    var incBySize = {};
    (cat && cat.inclusions || []).forEach(function (x) {
      if (x.included) (incBySize[x.size_id] = incBySize[x.size_id] || {})[x.item_key] = Number(x.qty) || 1;
    });
    var rows = [];
    (cat && cat.buildingStyles || []).filter(function (s) {
      return s.active;
    }).forEach(function (s) {
      var sizes = (cat && cat.buildingSizes || []).filter(function (z) {
        return z.style_id === s.id;
      });
      if (sizes.length === 0) {
        rows.push([s.label, "", "", ""].concat(_toConsumableArray(items.map(function () {
          return "0";
        })), ["yes"]));
      } else {
        sizes.forEach(function (z) {
          var inc = incBySize[z.id] || {};
          rows.push([s.label, z.width_ft, z.length_ft, z.base_price == null ? "" : z.base_price].concat(_toConsumableArray(items.map(function (it) {
            return String(inc[it.key] || 0);
          })), [z.active ? "yes" : "no"]));
        });
      }
    });
    downloadFile("".concat(sel, "-pricing.csv"), toCSV(headers, rows));
  };
  var onUploadCsv = /*#__PURE__*/function () {
    var _ref21 = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee14(file) {
      var matrix, header, lc, iStyle, iWidth, iLength, iPrice, iActive, reserved, labelToKey, colKey, rows, res, parts;
      return _regeneratorRuntime().wrap(function _callee14$(_context14) {
        while (1) switch (_context14.prev = _context14.next) {
          case 0:
            if (!(!file || !sel)) {
              _context14.next = 2;
              break;
            }
            return _context14.abrupt("return");
          case 2:
            setCsvBusy(true);
            setMsg(null);
            setCsvResult(null);
            _context14.prev = 5;
            if (!(file.size > 5000000)) {
              _context14.next = 8;
              break;
            }
            throw new Error("CSV too large (max 5MB).");
          case 8:
            _context14.t0 = parseCSV;
            _context14.next = 11;
            return file.text();
          case 11:
            _context14.t1 = _context14.sent;
            matrix = (0, _context14.t0)(_context14.t1);
            if (!(matrix.length < 2)) {
              _context14.next = 15;
              break;
            }
            throw new Error("CSV has no data rows.");
          case 15:
            header = matrix[0].map(function (h) {
              return String(h).trim();
            });
            lc = header.map(function (h) {
              return h.toLowerCase();
            });
            iStyle = lc.indexOf("style"), iWidth = lc.indexOf("width"), iLength = lc.indexOf("length"), iPrice = lc.indexOf("price"), iActive = lc.indexOf("active");
            if (!(iStyle < 0 || iWidth < 0 || iLength < 0 || iPrice < 0)) {
              _context14.next = 20;
              break;
            }
            throw new Error('CSV needs "style", "width", "length" and "price" columns.');
          case 20:
            reserved = new Set([iStyle, iWidth, iLength, iPrice, iActive]);
            labelToKey = {};
            csvItems().forEach(function (it) {
              labelToKey[it.label.toLowerCase()] = it.key;
              labelToKey[it.key.toLowerCase()] = it.key;
            });
            colKey = header.map(function (h, idx) {
              return reserved.has(idx) ? null : labelToKey[h.toLowerCase()] || null;
            });
            rows = matrix.slice(1).map(function (cols) {
              var inclusions = {};
              colKey.forEach(function (k, idx) {
                if (k) inclusions[k] = cols[idx];
              });
              return {
                style: cols[iStyle],
                width: cols[iWidth],
                length: cols[iLength],
                price: cols[iPrice],
                active: iActive >= 0 ? cols[iActive] : "",
                inclusions: inclusions
              };
            });
            _context14.next = 27;
            return api("import_pricing_csv", pwd, {
              clientId: sel,
              rows: rows
            });
          case 27:
            res = _context14.sent;
            setCsvResult(res);
            _context14.t2 = setCat;
            _context14.next = 32;
            return api("get_client_catalog", pwd, {
              clientId: sel
            });
          case 32:
            _context14.t3 = _context14.sent;
            (0, _context14.t2)(_context14.t3);
            parts = [];
            if (res.created) parts.push("".concat(res.created, " added"));
            if (res.updated) parts.push("".concat(res.updated, " updated"));
            flash({
              ok: "Imported ".concat(res.imported || 0, " size(s)") + (parts.length ? " (".concat(parts.join(", "), ")") : "") + (res.skipped && res.skipped.length ? ", ".concat(res.skipped.length, " skipped") : "")
            });
            _context14.next = 43;
            break;
          case 40:
            _context14.prev = 40;
            _context14.t4 = _context14["catch"](5);
            flash({
              err: _context14.t4.message
            });
          case 43:
            setCsvBusy(false);
          case 44:
          case "end":
            return _context14.stop();
        }
      }, _callee14, null, [[5, 40]]);
    }));
    return function onUploadCsv(_x9) {
      return _ref21.apply(this, arguments);
    };
  }();
  if (!authed) {
    return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      style: S.header
    }, /*#__PURE__*/React.createElement("div", {
      style: S.badge
    }, "SS"), /*#__PURE__*/React.createElement("div", {
      style: {
        fontWeight: 800
      }
    }, "Operator Admin")), /*#__PURE__*/React.createElement("div", {
      style: _objectSpread(_objectSpread({}, S.wrap), {}, {
        maxWidth: 420
      })
    }, /*#__PURE__*/React.createElement("div", {
      style: S.card
    }, /*#__PURE__*/React.createElement("div", {
      style: S.h2
    }, "\uD83D\uDD12 Enter operator password"), msg && msg.err && /*#__PURE__*/React.createElement("div", {
      style: S.err
    }, msg.err), /*#__PURE__*/React.createElement(PasswordInput, {
      value: pwd,
      onChange: function onChange(e) {
        return setPwd(e.target.value);
      },
      placeholder: "ADMIN_PASSWORD",
      onKeyDown: function onKeyDown(e) {
        return e.key === "Enter" && pwd && login();
      },
      style: _objectSpread(_objectSpread({}, S.input), {}, {
        width: "100%"
      }),
      wrapStyle: {
        marginBottom: 10
      }
    }), /*#__PURE__*/React.createElement("button", {
      onClick: login,
      disabled: busy || !pwd,
      style: S.btn(busy ? "#9CA3AF" : ACCENT, "#FFF")
    }, busy ? "…" : "Unlock"))));
  }
  var styleAssigned = function styleAssigned(key) {
    return ((cat === null || cat === void 0 ? void 0 : cat.buildingStyles) || []).some(function (s) {
      return s.key === key && s.active;
    });
  };
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: S.header
  }, /*#__PURE__*/React.createElement("div", {
    style: S.badge
  }, "SS"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 800
    }
  }, "Operator Admin"), /*#__PURE__*/React.createElement("div", {
    style: {
      marginLeft: "auto",
      fontSize: 12,
      opacity: 0.8
    }
  }, clients.length, " builders")), /*#__PURE__*/React.createElement("div", {
    style: S.wrap
  }, msg && msg.err && /*#__PURE__*/React.createElement("div", {
    style: S.err
  }, msg.err), msg && msg.ok && /*#__PURE__*/React.createElement("div", {
    style: S.ok
  }, msg.ok), /*#__PURE__*/React.createElement("div", {
    style: _objectSpread(_objectSpread({}, S.card), {}, {
      display: "flex",
      alignItems: "center",
      gap: 12
    })
  }, /*#__PURE__*/React.createElement("span", {
    style: S.lbl
  }, "Builder"), /*#__PURE__*/React.createElement("select", {
    value: sel,
    onChange: function onChange(e) {
      return loadClient(e.target.value);
    },
    style: _objectSpread(_objectSpread({}, S.input), {}, {
      minWidth: 240
    })
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "\u2014 select a builder \u2014"), clients.map(function (c) {
    return /*#__PURE__*/React.createElement("option", {
      key: c.client_id,
      value: c.client_id
    }, c.company_name || c.client_id, " (", c.client_id, ")");
  })), /*#__PURE__*/React.createElement("button", {
    onClick: function onClick() {
      return setNewOpen(function (o) {
        return !o;
      });
    },
    style: S.btn("#F1F5F9", "#334155")
  }, newOpen ? "Cancel" : "+ New builder"), /*#__PURE__*/React.createElement("button", {
    onClick: function onClick() {
      return setLinkOpen(function (o) {
        return !o;
      });
    },
    style: S.btn("#F1F5F9", "#334155")
  }, linkOpen ? "Cancel" : "Link owner"), /*#__PURE__*/React.createElement("button", {
    onClick: function onClick() {
      return setBillOpen(function (o) {
        return !o;
      });
    },
    disabled: !sel,
    style: S.btn(sel ? "#F1F5F9" : "#F1F5F9", sel ? "#334155" : "#94A3B8"),
    title: sel ? "Billing posture for ".concat(sel) : "Select a builder first"
  }, billOpen ? "Cancel" : "Billing"), /*#__PURE__*/React.createElement("button", {
    onClick: function onClick() {
      return setDelOpen(function (o) {
        return !o;
      });
    },
    disabled: !sel,
    style: S.btn(sel ? "#FEE2E2" : "#F1F5F9", sel ? "#B91C1C" : "#94A3B8"),
    title: sel ? "Delete ".concat(sel, " and all its data") : "Select a builder first"
  }, delOpen ? "Cancel" : "Delete builder"), sel && /*#__PURE__*/React.createElement("a", {
    href: "/portal?view=".concat(encodeURIComponent(sel)),
    target: "_blank",
    rel: "noopener",
    style: _objectSpread(_objectSpread({}, S.btn("#3D3672", "#FFF")), {}, {
      textDecoration: "none",
      display: "inline-flex",
      alignItems: "center"
    })
  }, "Open portal \u2197"), /*#__PURE__*/React.createElement("div", {
    style: {
      marginLeft: "auto",
      display: "flex",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: S.tab(tab === "items"),
    onClick: function onClick() {
      return setTab("items");
    }
  }, "Layout Items"), /*#__PURE__*/React.createElement("div", {
    style: S.tab(tab === "styles"),
    onClick: function onClick() {
      return setTab("styles");
    }
  }, "Building Styles"), /*#__PURE__*/React.createElement("div", {
    style: S.tab(tab === "csv"),
    onClick: function onClick() {
      return setTab("csv");
    }
  }, "CSV / Pricing"), /*#__PURE__*/React.createElement("div", {
    style: S.tab(tab === "master"),
    onClick: function onClick() {
      return setTab("master");
    }
  }, "Master Items"))), newOpen && /*#__PURE__*/React.createElement("div", {
    style: _objectSpread(_objectSpread({}, S.card), {}, {
      background: "#DBEAFF",
      border: "1px solid #75E6DA"
    })
  }, /*#__PURE__*/React.createElement("div", {
    style: S.h2
  }, "Create a new builder"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: "#475569",
      marginBottom: 10,
      lineHeight: 1.5
    }
  }, "Creates the tenant config. ", /*#__PURE__*/React.createElement("b", null, "No template"), " starts blank (standard contact form, no sizes/options \u2014 you add everything in the tabs). Or clone a template to copy its contact fields, default sizes & options. After this: add building styles, layout items & pricing in the tabs, then create the owner login in Supabase Auth and map ", /*#__PURE__*/React.createElement("code", null, "client_users"), "."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 10,
      flexWrap: "wrap",
      alignItems: "center"
    }
  }, /*#__PURE__*/React.createElement("input", {
    value: ncCompany,
    onChange: function onChange(e) {
      var v = e.target.value;
      setNcCompany(v);
      if (!ncIdTouched) setNcId(slugify(v));
    },
    placeholder: "Company name (e.g. Acme Barns)",
    style: _objectSpread(_objectSpread({}, S.input), {}, {
      minWidth: 220
    })
  }), /*#__PURE__*/React.createElement("input", {
    value: ncId,
    onChange: function onChange(e) {
      setNcId(e.target.value.toLowerCase());
      setNcIdTouched(true);
    },
    placeholder: "builder-id (auto from name)",
    title: "Auto-generated from the company name; edit to override",
    style: _objectSpread(_objectSpread({}, S.input), {}, {
      minWidth: 200
    })
  }), /*#__PURE__*/React.createElement("select", {
    value: ncTemplate,
    onChange: function onChange(e) {
      return setNcTemplate(e.target.value);
    },
    style: _objectSpread({}, S.input)
  }, /*#__PURE__*/React.createElement("option", {
    value: "__none__"
  }, "No template \u2014 blank (recommended)"), /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "Clone template: junior-barns"), clients.map(function (c) {
    return /*#__PURE__*/React.createElement("option", {
      key: c.client_id,
      value: c.client_id
    }, "Clone: ", c.client_id);
  })), /*#__PURE__*/React.createElement("button", {
    onClick: createNewClient,
    disabled: busy || !ncId.trim() || !ncCompany.trim(),
    style: S.btn(busy || !ncId.trim() || !ncCompany.trim() ? "#9CA3AF" : ACCENT, "#FFF")
  }, "Create builder")), /*#__PURE__*/React.createElement("label", {
    style: {
      display: "flex",
      alignItems: "flex-start",
      gap: 8,
      marginTop: 12,
      fontSize: 13,
      color: "#1E293B",
      cursor: "pointer"
    }
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: ncExempt,
    onChange: function onChange(e) {
      return setNcExempt(e.target.checked);
    },
    style: {
      marginTop: 2
    }
  }), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("b", null, "Non-billable"), " \u2014 CSM Synergy internal / demo / testing account", /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11.5,
      color: "#475569",
      marginTop: 2,
      lineHeight: 1.45
    }
  }, "Skips the billing gate: the portal opens normally with no subscription and is never charged. Leave this OFF for a real customer \u2014 they'll land on Billing and activate before anything unlocks."))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "flex-start",
      gap: 8,
      marginTop: 10,
      fontSize: 13,
      color: "#1E293B"
    }
  }, /*#__PURE__*/React.createElement("input", {
    type: "number",
    min: "0",
    max: "100",
    step: "1",
    value: ncDiscount,
    onChange: function onChange(e) {
      return setNcDiscount(e.target.value);
    },
    disabled: ncExempt,
    style: _objectSpread(_objectSpread({}, S.input), {}, {
      width: 74,
      marginTop: -2,
      opacity: ncExempt ? 0.5 : 1
    })
  }), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("b", null, "% off"), " \u2014 ongoing discount on recurring price", /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11.5,
      color: "#475569",
      marginTop: 2,
      lineHeight: 1.45
    }
  }, "Leave 0 for full price. Applies for as long as each subscription runs \u2014 no coupon code to re-enter. Setup fees are never discounted.", ncExempt && /*#__PURE__*/React.createElement("b", null, " Not applicable to a non-billable account.")))), !ncExempt && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 4,
      paddingLeft: 2
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      fontWeight: 700,
      color: Number(ncDiscount) > 0 ? "#334155" : "#94A3B8"
    }
  }, "Discount applies to", !(Number(ncDiscount) > 0) && /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 600
    }
  }, " \u2014 enter a % above to choose")), /*#__PURE__*/React.createElement(FeatureScope, {
    all: ncAllFeat,
    setAll: setNcAllFeat,
    picked: ncFeat,
    setPicked: setNcFeat,
    disabled: !(Number(ncDiscount) > 0)
  }))), billOpen && /*#__PURE__*/React.createElement("div", {
    style: _objectSpread(_objectSpread({}, S.card), {}, {
      background: "#F0FDF4",
      border: "1px solid #86EFAC"
    })
  }, /*#__PURE__*/React.createElement("div", {
    style: S.h2
  }, "Billing \u2014 ", sel), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: "#475569",
      marginBottom: 12,
      lineHeight: 1.5
    }
  }, "The discount belongs to the ", /*#__PURE__*/React.createElement("b", null, "account"), ", so it applies to every feature this tenant ever subscribes to, for as long as each subscription runs. Recurring price only \u2014 setup fees are never discounted."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 14,
      flexWrap: "wrap",
      alignItems: "center"
    }
  }, /*#__PURE__*/React.createElement("label", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      fontSize: 13,
      color: "#1E293B"
    }
  }, /*#__PURE__*/React.createElement("input", {
    type: "number",
    min: "0",
    max: "100",
    step: "1",
    value: billPct,
    onChange: function onChange(e) {
      return setBillPct(e.target.value);
    },
    disabled: billExempt,
    style: _objectSpread(_objectSpread({}, S.input), {}, {
      width: 74,
      opacity: billExempt ? 0.5 : 1
    })
  }), /*#__PURE__*/React.createElement("b", null, "% off recurring")), /*#__PURE__*/React.createElement("label", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      fontSize: 13,
      color: "#1E293B",
      cursor: "pointer"
    }
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: billExempt,
    onChange: function onChange(e) {
      return setBillExempt(e.target.checked);
    }
  }), /*#__PURE__*/React.createElement("b", null, "Non-billable"), " (never charged, skips the gate)"), /*#__PURE__*/React.createElement("label", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      fontSize: 13,
      color: "#1E293B"
    }
  }, /*#__PURE__*/React.createElement("b", null, "Free until"), /*#__PURE__*/React.createElement("input", {
    type: "date",
    value: billUntil,
    onChange: function onChange(e) {
      return setBillUntil(e.target.value);
    },
    style: _objectSpread(_objectSpread({}, S.input), {}, {
      width: 160
    })
  }), billUntil && /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: function onClick() {
      return setBillUntil("");
    },
    style: _objectSpread(_objectSpread({}, S.btn("#F1F5F9", "#64748B")), {}, {
      padding: "5px 9px",
      fontSize: 11
    })
  }, "clear")), /*#__PURE__*/React.createElement("button", {
    onClick: saveBilling,
    disabled: busy,
    style: S.btn(busy ? "#9CA3AF" : ACCENT, "#FFF")
  }, "Save billing")), !billExempt && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      fontWeight: 700,
      color: Number(billPct) > 0 ? "#334155" : "#94A3B8"
    }
  }, "Discount applies to", !(Number(billPct) > 0) && /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 600
    }
  }, " \u2014 enter a % above to choose")), /*#__PURE__*/React.createElement(FeatureScope, {
    all: billAllFeat,
    setAll: setBillAllFeat,
    picked: billFeat,
    setPicked: setBillFeat,
    disabled: !(Number(billPct) > 0)
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: "#166534",
      marginTop: 12,
      lineHeight: 1.55,
      background: "#DCFCE7",
      borderRadius: 8,
      padding: "9px 12px"
    }
  }, /*#__PURE__*/React.createElement("b", null, "Applies to future subscriptions only."), " The gateway stores the amount on each subscription, so changing the discount does not re-price anything already running \u2014 it affects what they subscribe to next.", /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 6
    }
  }, /*#__PURE__*/React.createElement("b", null, "Non-billable vs Free until."), " Non-billable is permanent and silent \u2014 a failed payment on such an account produces no warning and no lock, because it bypasses the gate entirely. \"Free until\" is a dated window: they keep working and see a countdown with their rate, then the normal gate takes over. Subscribing ends the countdown early. Use the date for a customer you intend to convert; use Non-billable for our own accounts."), billExempt === false && ((_clients$find = clients.find(function (c) {
    return c.client_id === sel;
  })) === null || _clients$find === void 0 ? void 0 : _clients$find.billingExempt) && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 6,
      color: "#991B1B"
    }
  }, /*#__PURE__*/React.createElement("b", null, "Careful:"), " you are removing Non-billable. If ", sel, " has no active subscription they will be locked out of their portal the moment this saves. Set the discount first, have them subscribe, then remove the exemption."))), linkOpen && /*#__PURE__*/React.createElement("div", {
    style: _objectSpread(_objectSpread({}, S.card), {}, {
      background: "#EFF6FF",
      border: "1px solid #BFDBFE"
    })
  }, /*#__PURE__*/React.createElement("div", {
    style: S.h2
  }, "Link an owner login"), !sel ? /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: "#B91C1C"
    }
  }, "Select a builder above first.") : /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: "#475569",
      marginBottom: 10,
      lineHeight: 1.5
    }
  }, "Enter the owner's email \u2014 we'll create their portal login automatically (no manual Supabase step), map it to ", /*#__PURE__*/React.createElement("b", null, sel), ", and give you a one-time set-password link to send them (also emailed automatically if SMTP is configured)."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 10,
      flexWrap: "wrap",
      alignItems: "center"
    }
  }, /*#__PURE__*/React.createElement("input", {
    value: ownerEmail,
    onChange: function onChange(e) {
      setOwnerEmail(e.target.value);
      setReassignFrom(null);
    },
    placeholder: "owner@theirbusiness.com",
    style: _objectSpread(_objectSpread({}, S.input), {}, {
      minWidth: 240
    })
  }), /*#__PURE__*/React.createElement("select", {
    value: linkRole,
    onChange: function onChange(e) {
      return setLinkRole(e.target.value);
    },
    style: _objectSpread(_objectSpread({}, S.input), {}, {
      width: 230
    })
  }, /*#__PURE__*/React.createElement("option", {
    value: "owner"
  }, "Admin (full access)"), /*#__PURE__*/React.createElement("option", {
    value: "user"
  }, "Team member (Designs & Leads only)")), /*#__PURE__*/React.createElement("button", {
    onClick: function onClick() {
      return linkOwner(false);
    },
    disabled: busy || !ownerEmail.trim(),
    style: S.btn(busy || !ownerEmail.trim() ? "#9CA3AF" : ACCENT, "#FFF")
  }, "Link to ", sel)), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: "#94A3B8",
      marginTop: 6
    }
  }, "Admins see Pricing & Settings; team members only see Designs & Leads."), reassignFrom && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 12,
      padding: 12,
      background: "#DBEAFF",
      border: "1px solid #75E6DA",
      borderRadius: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: "#1B7895",
      marginBottom: 8,
      lineHeight: 1.5
    }
  }, /*#__PURE__*/React.createElement("b", null, reassignFrom.email), " already has a login linked to ", reassignFrom.fromClient ? /*#__PURE__*/React.createElement("b", null, reassignFrom.fromClient) : "another builder", ". Reassigning ", /*#__PURE__*/React.createElement("b", null, "moves"), " that same login to ", /*#__PURE__*/React.createElement("b", null, sel), " \u2014 they'll no longer see ", reassignFrom.fromClient || "the other builder", "'s designs & leads."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      alignItems: "center",
      flexWrap: "wrap"
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: function onClick() {
      return linkOwner(true);
    },
    disabled: busy,
    style: S.btn(busy ? "#9CA3AF" : "#B45309", "#FFF")
  }, busy ? "Reassigning…" : "Reassign to ".concat(sel)), /*#__PURE__*/React.createElement("button", {
    onClick: function onClick() {
      return setReassignFrom(null);
    },
    disabled: busy,
    style: S.btn("#E2E8F0", "#0F172A")
  }, "Cancel"))), linkResult && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 12,
      padding: 12,
      background: "#FFF",
      border: "1px solid #BFDBFE",
      borderRadius: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: "#15803D",
      fontWeight: 600,
      marginBottom: 6
    }
  }, "\u2713 ", linkResult.email, " ", linkResult.movedFrom ? "reassigned from ".concat(linkResult.movedFrom, " to") : "linked to", " ", linkResult.client, " as ", linkResult.roleLabel, ".", linkResult.movedFrom ? "" : linkResult.created ? linkResult.emailSent ? " Login created and invite email sent." : " Login created." : " (login already existed)"), linkResult.setupLink ? /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: "#475569",
      marginBottom: 6
    }
  }, "Send them this one-time set-password link", linkResult.emailSent ? " (in case the email doesn't arrive)" : "", ":"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      alignItems: "center",
      flexWrap: "wrap"
    }
  }, /*#__PURE__*/React.createElement("input", {
    readOnly: true,
    value: linkResult.setupLink,
    onFocus: function onFocus(e) {
      return e.target.select();
    },
    style: _objectSpread(_objectSpread({}, S.input), {}, {
      flex: 1,
      minWidth: 260,
      fontSize: 12
    })
  }), /*#__PURE__*/React.createElement("button", {
    onClick: function onClick() {
      navigator.clipboard && navigator.clipboard.writeText(linkResult.setupLink);
      flash({
        ok: "Setup link copied."
      });
    },
    style: S.btn(ACCENT, "#FFF")
  }, "Copy link"))) : /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: "#B45309"
    }
  }, "Couldn't generate a setup link \u2014 have them use the portal's \u201CForgot password\u201D to set one.")))), delOpen && /*#__PURE__*/React.createElement("div", {
    style: _objectSpread(_objectSpread({}, S.card), {}, {
      background: "#FEF2F2",
      border: "1px solid #FECACA"
    })
  }, /*#__PURE__*/React.createElement("div", {
    style: S.h2
  }, "\u26A0\uFE0F Delete builder"), !sel ? /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: "#B91C1C"
    }
  }, "Select a builder above first.") : /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: "#7F1D1D",
      marginBottom: 10,
      lineHeight: 1.5
    }
  }, "This permanently deletes ", /*#__PURE__*/React.createElement("b", null, sel), " and ", /*#__PURE__*/React.createElement("b", null, "all of its data"), " \u2014 designs/leads, building styles & sizes, pricing & inclusions, layout items, settings (incl. GHL credentials), error logs, owner/team logins, and uploaded floor-plan & branding files. ", /*#__PURE__*/React.createElement("b", null, "This cannot be undone."), " (GoHighLevel contacts/estimates live in GHL and are not affected.)"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 10,
      flexWrap: "wrap",
      alignItems: "center"
    }
  }, /*#__PURE__*/React.createElement("input", {
    value: delConfirm,
    onChange: function onChange(e) {
      return setDelConfirm(e.target.value);
    },
    placeholder: "Type \"".concat(sel, "\" to confirm"),
    onKeyDown: function onKeyDown(e) {
      return e.key === "Enter" && delConfirm.trim() === sel && deleteClient();
    },
    style: _objectSpread(_objectSpread({}, S.input), {}, {
      minWidth: 260
    })
  }), /*#__PURE__*/React.createElement("button", {
    onClick: deleteClient,
    disabled: busy || delConfirm.trim() !== sel,
    style: S.btn(busy || delConfirm.trim() !== sel ? "#9CA3AF" : "#DC2626", "#FFF")
  }, busy ? "Deleting…" : "Delete permanently")))), tab === "master" && master && /*#__PURE__*/React.createElement("div", {
    style: S.card
  }, /*#__PURE__*/React.createElement("div", {
    style: S.h2
  }, "\uD83E\uDDF1 Master layout items"), master.layoutItemTypes.map(function (it) {
    return /*#__PURE__*/React.createElement("div", {
      key: it.item_key,
      style: S.row
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 16,
        display: "inline-flex",
        alignItems: "center"
      }
    }, layoutItemGlyph(it)), /*#__PURE__*/React.createElement("b", {
      style: {
        minWidth: 120
      }
    }, it.item_key), /*#__PURE__*/React.createElement("span", {
      style: {
        color: "#64748B"
      }
    }, it.label), /*#__PURE__*/React.createElement("span", {
      style: {
        marginLeft: "auto",
        fontSize: 11,
        color: "#94A3B8"
      }
    }, it.default_width, "\xD7", it.default_height, "ft ", it.wall_only ? "· wallOnly" : "", it.wall_snap ? "· wallSnap" : "", it.door_snap ? "· doorSnap" : "", it.active ? "" : " · INACTIVE"));
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: "#64748B",
      marginTop: 12
    }
  }, "Global layout-item defaults. Per-builder building styles & sizes live under the ", /*#__PURE__*/React.createElement("b", null, "Building Styles"), " and ", /*#__PURE__*/React.createElement("b", null, "CSV / Pricing"), " tabs; new builders are seeded with the ", /*#__PURE__*/React.createElement("b", null, "Clone"), " feature.")), tab !== "master" && !sel && /*#__PURE__*/React.createElement("div", {
    style: S.card
  }, "Select a builder above to manage their styles and items."), tab === "items" && sel && cat && master && function () {
    var saved = new Set((cat.clientLayoutItems || []).filter(function (i) {
      return i.active;
    }).map(function (i) {
      return i.item_key;
    }));
    var pending = (master.layoutItemTypes || []).reduce(function (acc, it) {
      return acc + (itemSel.has(it.item_key) !== saved.has(it.item_key) ? 1 : 0);
    }, 0);
    return /*#__PURE__*/React.createElement("div", {
      style: S.card
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        alignItems: "center",
        gap: 10,
        flexWrap: "wrap"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: _objectSpread(_objectSpread({}, S.h2), {}, {
        marginBottom: 0
      })
    }, "Layout items for ", /*#__PURE__*/React.createElement("span", {
      style: {
        color: ACCENT
      }
    }, sel)), /*#__PURE__*/React.createElement("div", {
      style: {
        marginLeft: "auto",
        display: "flex",
        gap: 8,
        alignItems: "center"
      }
    }, /*#__PURE__*/React.createElement("button", {
      onClick: selectAllItems,
      disabled: busy,
      style: S.btn("#F1F5F9", "#334155")
    }, "Select all"), /*#__PURE__*/React.createElement("button", {
      onClick: clearAllItems,
      disabled: busy,
      style: S.btn("#F1F5F9", "#334155")
    }, "Clear"), /*#__PURE__*/React.createElement("button", {
      onClick: saveItems,
      disabled: busy || pending === 0,
      style: S.btn(busy || pending === 0 ? "#9CA3AF" : ACCENT, "#FFF")
    }, busy ? "Saving…" : pending > 0 ? "Save (".concat(pending, ")") : "Saved"))), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 12,
        color: "#64748B",
        margin: "8px 0 10px"
      }
    }, "Tick the placeable items this builder gets, then click ", /*#__PURE__*/React.createElement("b", null, "Save"), " to apply them all at once."), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        flexWrap: "wrap",
        gap: 8
      }
    }, master.layoutItemTypes.map(function (it) {
      var on = itemSel.has(it.item_key);
      return /*#__PURE__*/React.createElement("div", {
        key: it.item_key,
        style: S.pill(on),
        onClick: function onClick() {
          return !busy && toggleItemSel(it.item_key);
        }
      }, /*#__PURE__*/React.createElement("span", {
        style: {
          marginRight: 6,
          display: "inline-flex",
          alignItems: "center",
          verticalAlign: "middle"
        }
      }, layoutItemGlyph(it)), it.label, " ", on ? "✓" : "");
    })), pending > 0 && /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 12,
        color: ACCENT,
        fontWeight: 700,
        marginTop: 10
      }
    }, pending, " unsaved change", pending === 1 ? "" : "s", " \u2014 click Save to apply."));
  }(), tab === "styles" && sel && cat && master && /*#__PURE__*/React.createElement("div", {
    style: S.card
  }, /*#__PURE__*/React.createElement("div", {
    style: S.h2
  }, "Building styles for ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: ACCENT
    }
  }, sel)), /*#__PURE__*/React.createElement("span", {
    style: S.lbl
  }, "This builder's styles"), (cat.buildingStyles || []).length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      color: "#94A3B8",
      fontSize: 13,
      padding: "6px 0"
    }
  }, "None yet \u2014 create one below."), (cat.buildingStyles || []).map(function (row) {
    var sizes = (cat.buildingSizes || []).filter(function (z) {
      return z.style_id === row.id;
    });
    return /*#__PURE__*/React.createElement("div", {
      key: row.id,
      style: {
        borderBottom: "1px solid #F1F5F9",
        padding: "10px 0"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        alignItems: "center",
        gap: 10
      }
    }, row.image_url ? /*#__PURE__*/React.createElement("img", {
      src: row.image_url,
      alt: row.label,
      style: {
        width: 40,
        height: 40,
        borderRadius: 6,
        objectFit: "cover",
        flexShrink: 0
      }
    }) : /*#__PURE__*/React.createElement("div", {
      style: {
        width: 40,
        height: 40,
        borderRadius: 6,
        background: "#F1F5F9",
        flexShrink: 0
      }
    }), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        flexDirection: "column"
      }
    }, /*#__PURE__*/React.createElement("b", null, row.label), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 11,
        color: "#94A3B8"
      }
    }, row.key, " \xB7 ", row.client_id)), /*#__PURE__*/React.createElement("div", {
      style: {
        marginLeft: "auto"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: S.pill(row.active),
      onClick: function onClick() {
        return !busy && act("save_style", {
          clientId: sel,
          styleKey: row.key,
          active: !row.active
        }, row.active ? "Hidden" : "Shown");
      }
    }, row.active ? "✓ Active" : "Hidden"))), sizes.length > 0 && /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 8,
        paddingLeft: 50
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: S.lbl
    }, "Sizes & base prices"), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        flexWrap: "wrap",
        gap: 6,
        marginTop: 4
      }
    }, sizes.map(function (z) {
      return /*#__PURE__*/React.createElement("span", {
        key: z.id,
        style: {
          fontSize: 12,
          padding: "3px 8px",
          borderRadius: 6,
          background: z.active ? "#F1F5F9" : "#FEF2F2",
          color: z.active ? "#334155" : "#B91C1C"
        }
      }, z.label, ": ", z.base_price == null ? "—" : "$" + z.base_price);
    }))));
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 16,
      padding: 12,
      background: "#DBEAFF",
      border: "1px solid #75E6DA",
      borderRadius: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: S.lbl
  }, "Create a new style for this builder"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10,
      marginTop: 6,
      flexWrap: "wrap"
    }
  }, /*#__PURE__*/React.createElement("input", {
    value: newStyleName,
    onChange: function onChange(e) {
      return setNewStyleName(e.target.value);
    },
    placeholder: "Style name (e.g. Garage)",
    style: _objectSpread(_objectSpread({}, S.input), {}, {
      minWidth: 200
    })
  }), /*#__PURE__*/React.createElement("input", {
    key: fileKey,
    type: "file",
    accept: "image/*",
    onChange: function onChange(e) {
      return onPickStyleImg(e.target.files && e.target.files[0]);
    },
    style: {
      fontSize: 12
    }
  }), newStyleImg && /*#__PURE__*/React.createElement("img", {
    src: newStyleImg.base64,
    alt: "",
    style: {
      width: 36,
      height: 36,
      borderRadius: 6,
      objectFit: "cover"
    }
  }), /*#__PURE__*/React.createElement("button", {
    onClick: createStyle,
    disabled: busy || !newStyleName.trim(),
    style: S.btn(busy || !newStyleName.trim() ? "#9CA3AF" : ACCENT, "#FFF")
  }, "Create style")), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: "#1B7895",
      marginTop: 6
    }
  }, "Add sizes & prices afterward via CSV import. Styles are private to this builder."))), tab === "csv" && sel && cat && /*#__PURE__*/React.createElement("div", {
    style: S.card
  }, /*#__PURE__*/React.createElement("div", {
    style: S.h2
  }, "CSV pricing & inclusions for ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: ACCENT
    }
  }, sel)), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: "#475569",
      marginBottom: 12,
      lineHeight: 1.5
    }
  }, "Download the template (one row per style, pre-filled with any existing sizes), then add a row for every size: type ", /*#__PURE__*/React.createElement("b", null, "width"), " and ", /*#__PURE__*/React.createElement("b", null, "length"), " (feet) and the ", /*#__PURE__*/React.createElement("b", null, "price"), ". The option columns hold the", /*#__PURE__*/React.createElement("b", null, " quantity included in the price"), " \u2014 loft = included ", /*#__PURE__*/React.createElement("b", null, "sq ft"), " (e.g. 50), doors/windows = ", /*#__PURE__*/React.createElement("b", null, "count"), "(e.g. 1); ", /*#__PURE__*/React.createElement("b", null, "0"), " = not included (charged). Declined included items credit quantity \xD7 rate on the estimate. Sizes are created/updated on upload, matched by style + width + length (no duplicates).", /*#__PURE__*/React.createElement("b", null, " Styles must exist first"), " (Building Styles tab). A blank price \u2014 or ", /*#__PURE__*/React.createElement("b", null, "active = no"), " \u2014 hides that size."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 10,
      alignItems: "center",
      flexWrap: "wrap"
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: downloadTemplate,
    style: S.btn("#F1F5F9", "#334155")
  }, "\u2B07 Download template"), /*#__PURE__*/React.createElement("label", {
    style: _objectSpread(_objectSpread({}, S.btn(csvBusy ? "#9CA3AF" : ACCENT, "#FFF")), {}, {
      cursor: csvBusy ? "default" : "pointer",
      display: "inline-block"
    })
  }, csvBusy ? "Importing…" : "⬆ Upload filled CSV", /*#__PURE__*/React.createElement("input", {
    type: "file",
    accept: ".csv,text/csv",
    disabled: csvBusy,
    style: {
      display: "none"
    },
    onChange: function onChange(e) {
      var f = e.target.files && e.target.files[0];
      e.target.value = "";
      onUploadCsv(f);
    }
  }))), csvResult && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 14,
      fontSize: 13
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      color: "#15803D",
      fontWeight: 700
    }
  }, "\u2713 Imported ", csvResult.imported, " row(s)."), csvResult.skipped && csvResult.skipped.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 6
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      color: "#B91C1C",
      fontWeight: 700
    }
  }, csvResult.skipped.length, " row(s) skipped:"), /*#__PURE__*/React.createElement("ul", {
    style: {
      margin: "4px 0 0 18px",
      color: "#B91C1C",
      maxHeight: 160,
      overflow: "auto"
    }
  }, csvResult.skipped.slice(0, 30).map(function (s, i) {
    return /*#__PURE__*/React.createElement("li", {
      key: i
    }, s);
  }))))), SHOW_EMAIL_SENDER && /*#__PURE__*/React.createElement("div", {
    style: _objectSpread(_objectSpread({}, S.card), {}, {
      marginTop: 14
    })
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10,
      flexWrap: "wrap"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: _objectSpread(_objectSpread({}, S.h2), {}, {
      marginBottom: 0
    })
  }, "\uD83D\uDCE7 Email Sender"), /*#__PURE__*/React.createElement("div", {
    style: {
      marginLeft: "auto",
      display: "flex",
      gap: 8,
      alignItems: "center"
    }
  }, emailSender && emailSender.connected && /*#__PURE__*/React.createElement("button", {
    onClick: disconnectEmail,
    disabled: emailBusy,
    style: S.btn("#FEE2E2", "#B91C1C")
  }, emailBusy ? "…" : "Disconnect"), /*#__PURE__*/React.createElement("button", {
    onClick: function onClick() {
      return setEmailOpen(function (o) {
        return !o;
      });
    },
    style: S.btn(emailOpen ? "#F1F5F9" : ACCENT, emailOpen ? "#334155" : "#FFF")
  }, emailOpen ? "Cancel" : emailSender && emailSender.connected ? "Reconnect Google account" : "Connect Google account"))), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: "#475569",
      marginTop: 8,
      lineHeight: 1.5
    }
  }, emailSender && emailSender.error ? /*#__PURE__*/React.createElement("span", {
    style: {
      color: "#B45309"
    }
  }, "\u26A0 Couldn't read email status: ", emailSender.error) : emailSender && emailSender.connected ? /*#__PURE__*/React.createElement("span", null, "Portal login & invite emails send from ", /*#__PURE__*/React.createElement("b", {
    style: {
      color: ACCENT
    }
  }, emailSender.senderEmail), ".") : /*#__PURE__*/React.createElement("span", null, "Not connected \u2014 login & invite emails use the ", /*#__PURE__*/React.createElement("b", null, "Supabase default sender"), ". Connect a Google account to send them from your own address.")), emailSender && emailSender.connected && !emailOpen && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 12,
      display: "flex",
      gap: 10,
      flexWrap: "wrap",
      alignItems: "center"
    }
  }, /*#__PURE__*/React.createElement("input", {
    value: emailTestTo,
    onChange: function onChange(e) {
      return setEmailTestTo(e.target.value);
    },
    placeholder: "send a test to an owner/operator login email",
    autoComplete: "off",
    onKeyDown: function onKeyDown(e) {
      return e.key === "Enter" && emailTestTo.trim() && sendTestEmail();
    },
    style: _objectSpread(_objectSpread({}, S.input), {}, {
      minWidth: 300
    })
  }), /*#__PURE__*/React.createElement("button", {
    onClick: sendTestEmail,
    disabled: emailTestBusy || !emailTestTo.trim(),
    style: S.btn(emailTestBusy || !emailTestTo.trim() ? "#9CA3AF" : "#F1F5F9", emailTestBusy || !emailTestTo.trim() ? "#FFF" : "#334155")
  }, emailTestBusy ? "Sending…" : "Send test email")), emailOpen && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 12,
      padding: 12,
      background: "#DBEAFF",
      border: "1px solid #75E6DA",
      borderRadius: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: "#475569",
      marginBottom: 8,
      lineHeight: 1.5
    }
  }, "Enter the Google account and its ", /*#__PURE__*/React.createElement("b", null, "app password"), " (Google Account \u2192 Security \u2192 2-Step Verification \u2192 App passwords). 2-step verification must be on. The password is stored securely server-side and never shown again."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 10,
      flexWrap: "wrap",
      alignItems: "center"
    }
  }, /*#__PURE__*/React.createElement("input", {
    value: emailAddr,
    onChange: function onChange(e) {
      return setEmailAddr(e.target.value);
    },
    placeholder: "name@yourdomain.com",
    autoComplete: "off",
    style: _objectSpread(_objectSpread({}, S.input), {}, {
      minWidth: 240
    })
  }), /*#__PURE__*/React.createElement(PasswordInput, {
    value: emailPwd,
    onChange: function onChange(e) {
      return setEmailPwd(e.target.value);
    },
    placeholder: "paste the 16-char app password",
    autoComplete: "new-password",
    onKeyDown: function onKeyDown(e) {
      return e.key === "Enter" && emailAddr.trim() && emailPwd.trim() && connectEmail();
    },
    style: S.input,
    wrapStyle: {
      minWidth: 240
    }
  }), /*#__PURE__*/React.createElement("button", {
    onClick: connectEmail,
    disabled: emailBusy || !emailAddr.trim() || !emailPwd.trim(),
    style: S.btn(emailBusy || !emailAddr.trim() || !emailPwd.trim() ? "#9CA3AF" : ACCENT, "#FFF")
  }, emailBusy ? "Connecting…" : "Connect & save"))))));
}
ReactDOM.createRoot(document.getElementById("root")).render( /*#__PURE__*/React.createElement(AdminApp, null));

// The boot guard's DOMContentLoaded check reads this sentinel: a compiled app
// script that ran to completion is the definition of "the app booted". Without
// it, a 404'd or syntax-broken app artifact was a silent blank page - the one
// failure class the old inline-babel world could not even see.
window.__ssAppBooted = true;
}).call(window);
