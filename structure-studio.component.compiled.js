// GENERATED FILE — do not edit. Compiled from structure-studio.component.js (sha256 83aa1a5aa51e)
// by scripts/compile.mjs using vendored babel-standalone 7.23.9. Rebuild: npm run compile
;(function () {
if (window.__ssBootBlocked) return; // the boot guard neutralises compiled scripts via this flag
"use strict";

var _excluded = ["style", "wrapStyle"];
function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }
function _defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, _toPropertyKey(descriptor.key), descriptor); } }
function _createClass(Constructor, protoProps, staticProps) { if (protoProps) _defineProperties(Constructor.prototype, protoProps); if (staticProps) _defineProperties(Constructor, staticProps); Object.defineProperty(Constructor, "prototype", { writable: false }); return Constructor; }
function _callSuper(t, o, e) { return o = _getPrototypeOf(o), _possibleConstructorReturn(t, _isNativeReflectConstruct() ? Reflect.construct(o, e || [], _getPrototypeOf(t).constructor) : o.apply(t, e)); }
function _possibleConstructorReturn(self, call) { if (call && (_typeof(call) === "object" || typeof call === "function")) { return call; } else if (call !== void 0) { throw new TypeError("Derived constructors may only return object or undefined"); } return _assertThisInitialized(self); }
function _assertThisInitialized(self) { if (self === void 0) { throw new ReferenceError("this hasn't been initialised - super() hasn't been called"); } return self; }
function _isNativeReflectConstruct() { try { var t = !Boolean.prototype.valueOf.call(Reflect.construct(Boolean, [], function () {})); } catch (t) {} return (_isNativeReflectConstruct = function _isNativeReflectConstruct() { return !!t; })(); }
function _getPrototypeOf(o) { _getPrototypeOf = Object.setPrototypeOf ? Object.getPrototypeOf.bind() : function _getPrototypeOf(o) { return o.__proto__ || Object.getPrototypeOf(o); }; return _getPrototypeOf(o); }
function _inherits(subClass, superClass) { if (typeof superClass !== "function" && superClass !== null) { throw new TypeError("Super expression must either be null or a function"); } subClass.prototype = Object.create(superClass && superClass.prototype, { constructor: { value: subClass, writable: true, configurable: true } }); Object.defineProperty(subClass, "prototype", { writable: false }); if (superClass) _setPrototypeOf(subClass, superClass); }
function _setPrototypeOf(o, p) { _setPrototypeOf = Object.setPrototypeOf ? Object.setPrototypeOf.bind() : function _setPrototypeOf(o, p) { o.__proto__ = p; return o; }; return _setPrototypeOf(o, p); }
function _regeneratorRuntime() { "use strict"; /*! regenerator-runtime -- Copyright (c) 2014-present, Facebook, Inc. -- license (MIT): https://github.com/facebook/regenerator/blob/main/LICENSE */ _regeneratorRuntime = function _regeneratorRuntime() { return e; }; var t, e = {}, r = Object.prototype, n = r.hasOwnProperty, o = Object.defineProperty || function (t, e, r) { t[e] = r.value; }, i = "function" == typeof Symbol ? Symbol : {}, a = i.iterator || "@@iterator", c = i.asyncIterator || "@@asyncIterator", u = i.toStringTag || "@@toStringTag"; function define(t, e, r) { return Object.defineProperty(t, e, { value: r, enumerable: !0, configurable: !0, writable: !0 }), t[e]; } try { define({}, ""); } catch (t) { define = function define(t, e, r) { return t[e] = r; }; } function wrap(t, e, r, n) { var i = e && e.prototype instanceof Generator ? e : Generator, a = Object.create(i.prototype), c = new Context(n || []); return o(a, "_invoke", { value: makeInvokeMethod(t, r, c) }), a; } function tryCatch(t, e, r) { try { return { type: "normal", arg: t.call(e, r) }; } catch (t) { return { type: "throw", arg: t }; } } e.wrap = wrap; var h = "suspendedStart", l = "suspendedYield", f = "executing", s = "completed", y = {}; function Generator() {} function GeneratorFunction() {} function GeneratorFunctionPrototype() {} var p = {}; define(p, a, function () { return this; }); var d = Object.getPrototypeOf, v = d && d(d(values([]))); v && v !== r && n.call(v, a) && (p = v); var g = GeneratorFunctionPrototype.prototype = Generator.prototype = Object.create(p); function defineIteratorMethods(t) { ["next", "throw", "return"].forEach(function (e) { define(t, e, function (t) { return this._invoke(e, t); }); }); } function AsyncIterator(t, e) { function invoke(r, o, i, a) { var c = tryCatch(t[r], t, o); if ("throw" !== c.type) { var u = c.arg, h = u.value; return h && "object" == _typeof(h) && n.call(h, "__await") ? e.resolve(h.__await).then(function (t) { invoke("next", t, i, a); }, function (t) { invoke("throw", t, i, a); }) : e.resolve(h).then(function (t) { u.value = t, i(u); }, function (t) { return invoke("throw", t, i, a); }); } a(c.arg); } var r; o(this, "_invoke", { value: function value(t, n) { function callInvokeWithMethodAndArg() { return new e(function (e, r) { invoke(t, n, e, r); }); } return r = r ? r.then(callInvokeWithMethodAndArg, callInvokeWithMethodAndArg) : callInvokeWithMethodAndArg(); } }); } function makeInvokeMethod(e, r, n) { var o = h; return function (i, a) { if (o === f) throw new Error("Generator is already running"); if (o === s) { if ("throw" === i) throw a; return { value: t, done: !0 }; } for (n.method = i, n.arg = a;;) { var c = n.delegate; if (c) { var u = maybeInvokeDelegate(c, n); if (u) { if (u === y) continue; return u; } } if ("next" === n.method) n.sent = n._sent = n.arg;else if ("throw" === n.method) { if (o === h) throw o = s, n.arg; n.dispatchException(n.arg); } else "return" === n.method && n.abrupt("return", n.arg); o = f; var p = tryCatch(e, r, n); if ("normal" === p.type) { if (o = n.done ? s : l, p.arg === y) continue; return { value: p.arg, done: n.done }; } "throw" === p.type && (o = s, n.method = "throw", n.arg = p.arg); } }; } function maybeInvokeDelegate(e, r) { var n = r.method, o = e.iterator[n]; if (o === t) return r.delegate = null, "throw" === n && e.iterator["return"] && (r.method = "return", r.arg = t, maybeInvokeDelegate(e, r), "throw" === r.method) || "return" !== n && (r.method = "throw", r.arg = new TypeError("The iterator does not provide a '" + n + "' method")), y; var i = tryCatch(o, e.iterator, r.arg); if ("throw" === i.type) return r.method = "throw", r.arg = i.arg, r.delegate = null, y; var a = i.arg; return a ? a.done ? (r[e.resultName] = a.value, r.next = e.nextLoc, "return" !== r.method && (r.method = "next", r.arg = t), r.delegate = null, y) : a : (r.method = "throw", r.arg = new TypeError("iterator result is not an object"), r.delegate = null, y); } function pushTryEntry(t) { var e = { tryLoc: t[0] }; 1 in t && (e.catchLoc = t[1]), 2 in t && (e.finallyLoc = t[2], e.afterLoc = t[3]), this.tryEntries.push(e); } function resetTryEntry(t) { var e = t.completion || {}; e.type = "normal", delete e.arg, t.completion = e; } function Context(t) { this.tryEntries = [{ tryLoc: "root" }], t.forEach(pushTryEntry, this), this.reset(!0); } function values(e) { if (e || "" === e) { var r = e[a]; if (r) return r.call(e); if ("function" == typeof e.next) return e; if (!isNaN(e.length)) { var o = -1, i = function next() { for (; ++o < e.length;) if (n.call(e, o)) return next.value = e[o], next.done = !1, next; return next.value = t, next.done = !0, next; }; return i.next = i; } } throw new TypeError(_typeof(e) + " is not iterable"); } return GeneratorFunction.prototype = GeneratorFunctionPrototype, o(g, "constructor", { value: GeneratorFunctionPrototype, configurable: !0 }), o(GeneratorFunctionPrototype, "constructor", { value: GeneratorFunction, configurable: !0 }), GeneratorFunction.displayName = define(GeneratorFunctionPrototype, u, "GeneratorFunction"), e.isGeneratorFunction = function (t) { var e = "function" == typeof t && t.constructor; return !!e && (e === GeneratorFunction || "GeneratorFunction" === (e.displayName || e.name)); }, e.mark = function (t) { return Object.setPrototypeOf ? Object.setPrototypeOf(t, GeneratorFunctionPrototype) : (t.__proto__ = GeneratorFunctionPrototype, define(t, u, "GeneratorFunction")), t.prototype = Object.create(g), t; }, e.awrap = function (t) { return { __await: t }; }, defineIteratorMethods(AsyncIterator.prototype), define(AsyncIterator.prototype, c, function () { return this; }), e.AsyncIterator = AsyncIterator, e.async = function (t, r, n, o, i) { void 0 === i && (i = Promise); var a = new AsyncIterator(wrap(t, r, n, o), i); return e.isGeneratorFunction(r) ? a : a.next().then(function (t) { return t.done ? t.value : a.next(); }); }, defineIteratorMethods(g), define(g, u, "Generator"), define(g, a, function () { return this; }), define(g, "toString", function () { return "[object Generator]"; }), e.keys = function (t) { var e = Object(t), r = []; for (var n in e) r.push(n); return r.reverse(), function next() { for (; r.length;) { var t = r.pop(); if (t in e) return next.value = t, next.done = !1, next; } return next.done = !0, next; }; }, e.values = values, Context.prototype = { constructor: Context, reset: function reset(e) { if (this.prev = 0, this.next = 0, this.sent = this._sent = t, this.done = !1, this.delegate = null, this.method = "next", this.arg = t, this.tryEntries.forEach(resetTryEntry), !e) for (var r in this) "t" === r.charAt(0) && n.call(this, r) && !isNaN(+r.slice(1)) && (this[r] = t); }, stop: function stop() { this.done = !0; var t = this.tryEntries[0].completion; if ("throw" === t.type) throw t.arg; return this.rval; }, dispatchException: function dispatchException(e) { if (this.done) throw e; var r = this; function handle(n, o) { return a.type = "throw", a.arg = e, r.next = n, o && (r.method = "next", r.arg = t), !!o; } for (var o = this.tryEntries.length - 1; o >= 0; --o) { var i = this.tryEntries[o], a = i.completion; if ("root" === i.tryLoc) return handle("end"); if (i.tryLoc <= this.prev) { var c = n.call(i, "catchLoc"), u = n.call(i, "finallyLoc"); if (c && u) { if (this.prev < i.catchLoc) return handle(i.catchLoc, !0); if (this.prev < i.finallyLoc) return handle(i.finallyLoc); } else if (c) { if (this.prev < i.catchLoc) return handle(i.catchLoc, !0); } else { if (!u) throw new Error("try statement without catch or finally"); if (this.prev < i.finallyLoc) return handle(i.finallyLoc); } } } }, abrupt: function abrupt(t, e) { for (var r = this.tryEntries.length - 1; r >= 0; --r) { var o = this.tryEntries[r]; if (o.tryLoc <= this.prev && n.call(o, "finallyLoc") && this.prev < o.finallyLoc) { var i = o; break; } } i && ("break" === t || "continue" === t) && i.tryLoc <= e && e <= i.finallyLoc && (i = null); var a = i ? i.completion : {}; return a.type = t, a.arg = e, i ? (this.method = "next", this.next = i.finallyLoc, y) : this.complete(a); }, complete: function complete(t, e) { if ("throw" === t.type) throw t.arg; return "break" === t.type || "continue" === t.type ? this.next = t.arg : "return" === t.type ? (this.rval = this.arg = t.arg, this.method = "return", this.next = "end") : "normal" === t.type && e && (this.next = e), y; }, finish: function finish(t) { for (var e = this.tryEntries.length - 1; e >= 0; --e) { var r = this.tryEntries[e]; if (r.finallyLoc === t) return this.complete(r.completion, r.afterLoc), resetTryEntry(r), y; } }, "catch": function _catch(t) { for (var e = this.tryEntries.length - 1; e >= 0; --e) { var r = this.tryEntries[e]; if (r.tryLoc === t) { var n = r.completion; if ("throw" === n.type) { var o = n.arg; resetTryEntry(r); } return o; } } throw new Error("illegal catch attempt"); }, delegateYield: function delegateYield(e, r, n) { return this.delegate = { iterator: values(e), resultName: r, nextLoc: n }, "next" === this.method && (this.arg = t), y; } }, e; }
function asyncGeneratorStep(gen, resolve, reject, _next, _throw, key, arg) { try { var info = gen[key](arg); var value = info.value; } catch (error) { reject(error); return; } if (info.done) { resolve(value); } else { Promise.resolve(value).then(_next, _throw); } }
function _asyncToGenerator(fn) { return function () { var self = this, args = arguments; return new Promise(function (resolve, reject) { var gen = fn.apply(self, args); function _next(value) { asyncGeneratorStep(gen, resolve, reject, _next, _throw, "next", value); } function _throw(err) { asyncGeneratorStep(gen, resolve, reject, _next, _throw, "throw", err); } _next(undefined); }); }; }
function _typeof(o) { "@babel/helpers - typeof"; return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function (o) { return typeof o; } : function (o) { return o && "function" == typeof Symbol && o.constructor === Symbol && o !== Symbol.prototype ? "symbol" : typeof o; }, _typeof(o); }
function _toConsumableArray(arr) { return _arrayWithoutHoles(arr) || _iterableToArray(arr) || _unsupportedIterableToArray(arr) || _nonIterableSpread(); }
function _nonIterableSpread() { throw new TypeError("Invalid attempt to spread non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method."); }
function _iterableToArray(iter) { if (typeof Symbol !== "undefined" && iter[Symbol.iterator] != null || iter["@@iterator"] != null) return Array.from(iter); }
function _arrayWithoutHoles(arr) { if (Array.isArray(arr)) return _arrayLikeToArray(arr); }
function _createForOfIteratorHelper(o, allowArrayLike) { var it = typeof Symbol !== "undefined" && o[Symbol.iterator] || o["@@iterator"]; if (!it) { if (Array.isArray(o) || (it = _unsupportedIterableToArray(o)) || allowArrayLike && o && typeof o.length === "number") { if (it) o = it; var i = 0; var F = function F() {}; return { s: F, n: function n() { if (i >= o.length) return { done: true }; return { done: false, value: o[i++] }; }, e: function e(_e2) { throw _e2; }, f: F }; } throw new TypeError("Invalid attempt to iterate non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method."); } var normalCompletion = true, didErr = false, err; return { s: function s() { it = it.call(o); }, n: function n() { var step = it.next(); normalCompletion = step.done; return step; }, e: function e(_e3) { didErr = true; err = _e3; }, f: function f() { try { if (!normalCompletion && it["return"] != null) it["return"](); } finally { if (didErr) throw err; } } }; }
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
// structure-studio.component.js — the ONE shared designer module, loaded by BOTH
// index.html and portal.html via <script src=... type="text/babel">. Hand-mirrored
// twin of StructureStudio.jsx (the ES-module canon) in the babel/global-destructure
// dialect — every body/wrapper edit lands in BOTH files (see CLAUDE.md).
// Self-contained on purpose: Babel compiles each text/babel block independently, so
// nothing here leans on the host page's consts; the page mounts alias the globals
// published at the bottom. No createRoot here — mounting is the host page's job.
var _React = React,
  useState = _React.useState,
  useRef = _React.useRef,
  useCallback = _React.useCallback,
  useEffect = _React.useEffect,
  useMemo = _React.useMemo,
  Component = _React.Component;
var _ReactDOM = ReactDOM,
  createPortal = _ReactDOM.createPortal;

// Password input with a show/hide (eye) toggle. Forwards all input props; `wrapStyle`
// carries any flex/grid sizing onto the positioned wrapper so layouts are preserved.
function PasswordInput(_ref) {
  var style = _ref.style,
    wrapStyle = _ref.wrapStyle,
    rest = _objectWithoutProperties(_ref, _excluded);
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
var createClient = window.supabase.createClient;

// ─── Supabase project ───
// Single shared project across all white-label tenants. The anon key is browser-safe
// (RLS + capability RPCs); the service-role key never leaves the Edge Functions.
var SUPABASE_URL = "https://jzeamjbhdrsbygdnphbm.supabase.co";
var SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp6ZWFtamJoZHJzYnlnZG5waGJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczNDIwNDMsImV4cCI6MjA5MjkxODA0M30.YawJS7aiyTbQdwVnzndyKwD2ejNGYhdBSiectURvxwY";

// Address-autocomplete key used when a tenant's config row doesn't carry its own
// googleMapsApiKey.
var DEFAULT_GOOGLE_MAPS_API_KEY = "AIzaSyDEKe7mODI2xKnUQ5-z7L0ZZnUfBgE6dok";

// ─── Default tenant ───
// When neither ?client= nor a tenant subdomain nor a design owner resolves a
// client, the loader fetches this client's config from public.client_configs.
// There is no in-source config copy — the table row is the source of truth.
// To change Junior Barns, edit the row, not this file.
var DEFAULT_CLIENT_ID = "junior-barns";

// ─── STRUCTURE STUDIO ENGINE ───
var WALL_THICKNESS = 6;

// Built-in annotation tools that are merged into ITEMS for every client.
// Distinct from `layoutItems` in config (which the client controls): these
// are universal drawing aids — a free-text note and a freeform line.
var BUILT_IN_TOOLS = {
  textNote: {
    label: "Note",
    color: "#0F172A",
    icon: "📝",
    shortLabel: "Note",
    noteType: true,
    width: 4,
    height: 1
  },
  line: {
    label: "Line",
    color: "#475569",
    icon: "📏",
    shortLabel: "Line",
    lineType: true,
    width: 4,
    height: 0
  }
};

// Legacy render safety-net. When a tenant HIDES a built-in option (deactivates it in
// client_layout_items so it drops out of get_config's layoutItems), its already-placed items on
// SAVED designs would otherwise lose their render config and vanish. This provides the standard
// built-in door/window/ramp definitions for RENDERING ONLY (noPalette → never a placeable tool),
// so old quotes keep drawing correctly forever. Spread FIRST in ITEMS so a tenant that still has
// the item ACTIVE overrides it with their own config (and it shows in the palette as normal); it
// only fills the gap for a HIDDEN item. Dimensions/colors mirror the layout_item_types master.
var LEGACY_LAYOUT_FALLBACK = {
  singleDoor: {
    label: "Single Door (36\")",
    icon: "🚪",
    color: "#D97706",
    width: 3,
    height: 0.5,
    shortLabel: "SD",
    wallOnly: true,
    noPalette: true
  },
  doubleDoor: {
    label: "Double Door (60\")",
    icon: "🚪🚪",
    color: "#B45309",
    width: 5,
    height: 0.5,
    shortLabel: "DD",
    wallOnly: true,
    noPalette: true
  },
  window: {
    label: "Window (24\")",
    icon: "🪟",
    color: "#0EA5E9",
    width: 2,
    height: 0.5,
    shortLabel: "W",
    wallOnly: true,
    noPalette: true
  }
  // NOTE: ramp is NOT here — it's fully self-contained now (SIMPLE_RAMP_CFG below), decoupled from
  // the built-in `ramp` layout item, so a tenant's ramp works whether or not that legacy row exists.
};

// Title-case a building-style name for display (designs store either the label
// "Farmland" or the lowercase key "cabin").
function capWords(s) {
  return String(s || "").replace(/\b\w/g, function (c) {
    return c.toUpperCase();
  });
}

// Board-and-batten door glyph for the palette buttons (single + double), modeled on the
// real shed doors: cream frame, vertical planks, a mid cross-rail, black T-hinges, and a
// latch. Replaces the generic door emoji so the button reads as the actual product.
function DoorIcon(_ref2) {
  var _ref2$double = _ref2["double"],
    _double = _ref2$double === void 0 ? false : _ref2$double;
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

// Closest point distance from (px,py) to the segment (x1,y1)-(x2,y2)
function _distToSeg(px, py, x1, y1, x2, y2) {
  var dx = x2 - x1,
    dy = y2 - y1;
  var lenSq = dx * dx + dy * dy;
  var t = lenSq ? ((px - x1) * dx + (py - y1) * dy) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  var cx = x1 + t * dx,
    cy = y1 + t * dy;
  return Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy));
}

// Treat each wall as a line segment; pick the wall closest to the click.
// Returns null only when the click is too far from any wall to be reasonable.
function getWallFromClick(x, y, pW, pH, mgX, mgY) {
  var ix = x - mgX,
    iy = y - mgY,
    T = 80;
  var walls = [{
    wall: "north",
    d: _distToSeg(ix, iy, 0, 0, pW, 0)
  }, {
    wall: "south",
    d: _distToSeg(ix, iy, 0, pH, pW, pH)
  }, {
    wall: "west",
    d: _distToSeg(ix, iy, 0, 0, 0, pH)
  }, {
    wall: "east",
    d: _distToSeg(ix, iy, pW, 0, pW, pH)
  }];
  walls.sort(function (a, b) {
    return a.d - b.d;
  });
  return walls[0].d <= T ? walls[0].wall : null;
}
function snapToWall(wall, cx, cy, iW, iH, pW, pH, mgX, mgY) {
  var hw = iW / 2;
  switch (wall) {
    case "north":
      return {
        x: Math.max(mgX + hw, Math.min(cx, mgX + pW - hw)),
        y: mgY,
        rotation: 0,
        wall: wall
      };
    case "south":
      return {
        x: Math.max(mgX + hw, Math.min(cx, mgX + pW - hw)),
        y: mgY + pH,
        rotation: 0,
        wall: wall
      };
    case "west":
      return {
        x: mgX,
        y: Math.max(mgY + hw, Math.min(cy, mgY + pH - hw)),
        rotation: 90,
        wall: wall
      };
    case "east":
      return {
        x: mgX + pW,
        y: Math.max(mgY + hw, Math.min(cy, mgY + pH - hw)),
        rotation: 90,
        wall: wall
      };
    default:
      return {
        x: cx,
        y: cy,
        rotation: 0,
        wall: null
      };
  }
}
function snapToWallInterior(wall, cx, cy, iW, iH, pW, pH, mgX, mgY) {
  switch (wall) {
    case "north":
      return {
        x: Math.max(mgX + iW / 2, Math.min(cx, mgX + pW - iW / 2)),
        y: mgY + iH / 2,
        rotation: 0,
        wall: wall
      };
    case "south":
      return {
        x: Math.max(mgX + iW / 2, Math.min(cx, mgX + pW - iW / 2)),
        y: mgY + pH - iH / 2,
        rotation: 0,
        wall: wall
      };
    case "west":
      return {
        x: mgX + iH / 2,
        y: Math.max(mgY + iW / 2, Math.min(cy, mgY + pH - iW / 2)),
        rotation: 90,
        wall: wall
      };
    case "east":
      return {
        x: mgX + pW - iH / 2,
        y: Math.max(mgY + iW / 2, Math.min(cy, mgY + pH - iW / 2)),
        rotation: 90,
        wall: wall
      };
    default:
      return {
        x: cx,
        y: cy,
        rotation: 0,
        wall: null
      };
  }
}

// Always returns a wall — used as a fallback when the click is ambiguous or far
// from the plan. Uses segment distance so corner clicks resolve to the closer side.
function getNearestWall(x, y, pW, pH, mgX, mgY) {
  var ix = x - mgX,
    iy = y - mgY;
  var walls = [{
    wall: "north",
    d: _distToSeg(ix, iy, 0, 0, pW, 0)
  }, {
    wall: "south",
    d: _distToSeg(ix, iy, 0, pH, pW, pH)
  }, {
    wall: "west",
    d: _distToSeg(ix, iy, 0, 0, 0, pH)
  }, {
    wall: "east",
    d: _distToSeg(ix, iy, pW, 0, pW, pH)
  }];
  walls.sort(function (a, b) {
    return a.d - b.d;
  });
  return walls[0].wall;
}
function checkDoorCollision(ni, nc, existing, itemTypes, sc) {
  if (!ni.wall) return false;
  var niw = (ni.widthFt || nc.width) * sc;
  var _iterator = _createForOfIteratorHelper(existing),
    _step;
  try {
    for (_iterator.s(); !(_step = _iterator.n()).done;) {
      var it = _step.value;
      var c = itemTypes[it.type];
      if (!c || !c.wallOnly || it.type === "window") continue;
      // Only check doors on the same wall
      if (it.wall !== ni.wall) continue;
      var iw = (it.widthFt || c.width) * sc;
      // Check overlap along the wall axis
      if (ni.wall === "north" || ni.wall === "south") {
        if (Math.abs(ni.x - it.x) < niw / 2 + iw / 2 + 4) return true;
      } else {
        if (Math.abs(ni.y - it.y) < niw / 2 + iw / 2 + 4) return true;
      }
    }
  } catch (err) {
    _iterator.e(err);
  } finally {
    _iterator.f();
  }
  return false;
}

// Does a wall-mounted item (door / window / rough opening) at `sn` overlap a WORKBENCH on the
// same wall? checkDoorCollision above deliberately only compares wallOnly items to each other, and
// a workbench is wallSnap, so it is skipped there — which meant the invariant was enforced in one
// direction only: dragging a workbench into a door showed "A door is blocking this wall!", while
// dragging the DOOR onto the workbench silently succeeded and produced exactly the layout that
// toast exists to prevent, rasterized into the PDF and sent to the shop. Same math as the
// workbench-side check, read from the other side.
function checkWorkbenchOverlap(sn, widthFtPx, existing, itemTypes, sc) {
  if (!sn.wall) return false;
  var isH = sn.wall === "north" || sn.wall === "south";
  var candPos = isH ? sn.x : sn.y;
  var candHalf = widthFtPx / 2;
  var _iterator2 = _createForOfIteratorHelper(existing),
    _step2;
  try {
    for (_iterator2.s(); !(_step2 = _iterator2.n()).done;) {
      var ob = _step2.value;
      if (ob.type !== "workbench" || ob.wall !== sn.wall) continue;
      var obHalf = (ob.widthFt || itemTypes[ob.type] && itemTypes[ob.type].width) * sc / 2;
      var obPos = isH ? ob.x : ob.y;
      if (Math.abs(candPos - obPos) < candHalf + obHalf - 2) return true;
    }
  } catch (err) {
    _iterator2.e(err);
  } finally {
    _iterator2.f();
  }
  return false;
}
function parseSize(s) {
  if (!s) return null;
  var m = s.match(/(\d+)\s*[x×✕]\s*(\d+)/i); // accept Unicode ×/✕ size labels too, not just ASCII x — else the building silently stays at the default size (audit #F2)
  return m ? {
    w: parseInt(m[1]),
    h: parseInt(m[2])
  } : null;
}

// Check if a loft (edges in ft) has both ends of at least one axis attached to walls or other lofts
function checkLoftAttached(l, r, t, b, bldgW, bldgH, otherLoftEdges) {
  var tol = 0.3;
  var atWall = function atWall(val, wallVal) {
    return Math.abs(val - wallVal) < tol;
  };
  var touchesLoft = function touchesLoft(edge, oKey, pMin, pMax, opMin, opMax) {
    return otherLoftEdges.some(function (o) {
      return Math.abs(edge - o[oKey]) < tol && pMin < o[opMax] - tol && pMax > o[opMin] + tol;
    });
  };
  var leftOk = atWall(l, 0) || touchesLoft(l, "r", t, b, "t", "b");
  var rightOk = atWall(r, bldgW) || touchesLoft(r, "l", t, b, "t", "b");
  if (leftOk && rightOk) return true;
  var topOk = atWall(t, 0) || touchesLoft(t, "b", l, r, "l", "r");
  var bottomOk = atWall(b, bldgH) || touchesLoft(b, "t", l, r, "l", "r");
  if (topOk && bottomOk) return true;
  return false;
}

// ─── Page geometry, as a pure function of the building size ───────────────────
// The component derives scale/mgX/mgY from bldgW/bldgH on every render. Reflowing
// a layout after a size change needs the SAME derivation for the OLD size, to turn
// stored page-pixels back into feet — so the formula lives here, called twice
// (old, new), instead of being inlined once in the render body.
var SS_PAGE = {
  W: 850,
  H: 1100,
  TEXT_AREA_H: 340,
  TOP_LABEL_PAD: 30,
  BOT_LABEL_PAD: 30,
  RAMP_SPACE_FT: 2
};
function pageGeom(bldgW, bldgH) {
  var visibleH = SS_PAGE.H - SS_PAGE.TEXT_AREA_H;
  var scale = Math.min(SS_PAGE.W * 0.70 / bldgW, visibleH * 0.70 / bldgH, (visibleH - SS_PAGE.TOP_LABEL_PAD - SS_PAGE.BOT_LABEL_PAD) / (bldgH + 2 * SS_PAGE.RAMP_SPACE_FT));
  var pW = bldgW * scale,
    pH = bldgH * scale;
  return {
    scale: scale,
    pW: pW,
    pH: pH,
    mgX: (SS_PAGE.W - pW) / 2,
    mgY: SS_PAGE.RAMP_SPACE_FT * scale + SS_PAGE.TOP_LABEL_PAD
  };
}

// Where a ramp sits for a given door position — the ramp is derived, never placed.
// Uses the ramp's OWN depth (heightFt) rather than the 2 ft default, so a catalog
// ramp with a longer run stays where it was drawn.
function rampPosFor(rmp, sn, g) {
  var depthPx = (rmp && rmp.heightFt || SS_PAGE.RAMP_SPACE_FT) * g.scale;
  if (sn.wall === "north") return {
    x: sn.x,
    y: g.mgY - depthPx / 2,
    rotation: 0,
    wall: "north"
  };
  if (sn.wall === "south") return {
    x: sn.x,
    y: g.mgY + g.pH + depthPx / 2,
    rotation: 0,
    wall: "south"
  };
  if (sn.wall === "west") return {
    x: g.mgX - depthPx / 2,
    y: sn.y,
    rotation: 90,
    wall: "west"
  };
  if (sn.wall === "east") return {
    x: g.mgX + g.pW + depthPx / 2,
    y: sn.y,
    rotation: 90,
    wall: "east"
  };
  return null;
}

// Items the customer sizes themselves, so shrinking one to fit a smaller building
// preserves their intent. A DOOR is not in this list on purpose: a 6 ft double door
// quietly becoming 4 ft would change what they are buying.
var SS_SHRINKABLE = {
  workbench: true,
  roughOpening: true,
  loft: true
};
var SS_WALL_ORDER = {
  north: ["south", "east", "west"],
  south: ["north", "east", "west"],
  east: ["west", "north", "south"],
  west: ["east", "north", "south"]
};

/**
 * Move every placed item into the equivalent legal position for a new building size.
 *
 * PURE — returns { items, events } and mutates nothing, so the caller can inspect the
 * events and decide whether to commit. That is what makes "revert the size change when
 * something cannot be placed" possible without ever leaving a half-reflowed layout.
 *
 * events: { id, type, label, kind } where kind is "movedWall" | "resized" | "blocked".
 * Sliding along the SAME wall is deliberately not an event — it is what the customer
 * expects when a building grows or shrinks, and reporting it would bury the two things
 * they do need to know.
 */
function reflowItems(items, prev, next, ITEMS) {
  var A = pageGeom(prev.w, prev.h),
    B = pageGeom(next.w, next.h);
  var events = [];
  var byId = new Map();
  var placed = []; // already-reflowed items, for collision tests
  var labelOf = function labelOf(it) {
    return ITEMS[it.type] && ITEMS[it.type].label || it.type;
  };

  // Try to seat a wall item at `wantFt` along `wall`, sliding to the nearest clear spot.
  // Returns the snap result, or null when the wall has no room.
  var seat = function seat(it, cfg, wall, wantFt, wFt, hFt) {
    var isH = wall === "north" || wall === "south";
    var wallLen = isH ? next.w : next.h;
    var half = wFt / 2;
    if (wFt > wallLen) return null;
    var lo = half,
      hi = wallLen - half;
    var start = Math.max(lo, Math.min(wantFt, hi));
    // Search outward from the wanted spot in 0.25 ft steps, nearest first.
    for (var d = 0; d <= hi - lo + 0.25; d += 0.25) {
      for (var _i = 0, _arr = d === 0 ? [start] : [start - d, start + d]; _i < _arr.length; _i++) {
        var c = _arr[_i];
        if (c < lo - 0.001 || c > hi + 0.001) continue;
        var px = (isH ? B.mgX : B.mgY) + c * B.scale;
        var sn = cfg.wallSnap ? snapToWallInterior(wall, isH ? px : B.mgX, isH ? B.mgY : px, wFt * B.scale, hFt * B.scale, B.pW, B.pH, B.mgX, B.mgY) : snapToWall(wall, isH ? px : B.mgX, isH ? B.mgY : px, wFt * B.scale, hFt * B.scale, B.pW, B.pH, B.mgX, B.mgY);
        var cand = _objectSpread(_objectSpread(_objectSpread({}, it), sn), {}, {
          widthFt: wFt,
          heightFt: hFt
        });
        if (checkDoorCollision(cand, _objectSpread(_objectSpread({}, cfg), {}, {
          width: wFt
        }), placed, ITEMS, B.scale)) continue;
        if (checkWorkbenchOverlap(sn, wFt * B.scale, placed, ITEMS, B.scale)) continue;
        return sn;
      }
    }
    return null;
  };

  // ── Pass 1: everything except ramps (which are derived from their door) ──
  var _iterator3 = _createForOfIteratorHelper(items),
    _step3;
  try {
    for (_iterator3.s(); !(_step3 = _iterator3.n()).done;) {
      var it = _step3.value;
      var cfg = ITEMS[it.type];
      // Annotations live in PAGE space, deliberately independent of the building —
      // moving them with the plan would be a regression, not a completion.
      if (!cfg || cfg.lineType || it.type === "textNote" || it.type === "line") {
        byId.set(it.id, it);
        continue;
      }
      if (cfg.doorSnap) continue; // pass 2

      var isWall = (cfg.wallOnly || cfg.wallSnap) && it.wall;
      if (isWall) {
        var isH = it.wall === "north" || it.wall === "south";
        var wantFt = isH ? (it.x - A.mgX) / A.scale : (it.y - A.mgY) / A.scale;
        var _hFt = it.heightFt || cfg.height;
        var _wFt = it.widthFt || cfg.width;
        var wallLen = isH ? next.w : next.h;
        if (_wFt > wallLen && SS_SHRINKABLE[it.type]) {
          var shrunk = Math.max(it.type === "roughOpening" ? 0.5 : 2, wallLen);
          if (shrunk !== _wFt) {
            _wFt = shrunk;
            events.push({
              id: it.id,
              type: it.type,
              label: labelOf(it),
              kind: "resized",
              to: _wFt
            });
          }
        }
        var sn = seat(it, cfg, it.wall, wantFt, _wFt, _hFt);
        var movedWall = false;
        if (!sn) {
          var _iterator5 = _createForOfIteratorHelper(SS_WALL_ORDER[it.wall] || []),
            _step5;
          try {
            for (_iterator5.s(); !(_step5 = _iterator5.n()).done;) {
              var w2 = _step5.value;
              var isH2 = w2 === "north" || w2 === "south";
              sn = seat(it, cfg, w2, (isH2 ? next.w : next.h) / 2, _wFt, _hFt);
              if (sn) {
                movedWall = true;
                break;
              }
            }
          } catch (err) {
            _iterator5.e(err);
          } finally {
            _iterator5.f();
          }
        }
        if (!sn) {
          events.push({
            id: it.id,
            type: it.type,
            label: labelOf(it),
            kind: "blocked"
          });
          byId.set(it.id, it);
          continue;
        }
        if (movedWall) events.push({
          id: it.id,
          type: it.type,
          label: labelOf(it),
          kind: "movedWall",
          to: sn.wall
        });
        var _nit = _objectSpread(_objectSpread(_objectSpread({}, it), sn), {}, {
          widthFt: _wFt
        });
        byId.set(it.id, _nit);
        placed.push(_nit);
        continue;
      }
      if (it.type === "loft") {
        var _wFt2 = it.widthFt || cfg.width,
          _hFt2 = it.heightFt || cfg.height;
        var _cxFt = (it.x - A.mgX) / A.scale,
          _cyFt = (it.y - A.mgY) / A.scale;
        // A loft placed by clicking is seeded widthFt = bldgW (a snapshot of the building
        // width). If it spanned wall to wall, it should still span wall to wall.
        if (Math.abs(_wFt2 - prev.w) < 0.35) {
          _wFt2 = next.w;
          _cxFt = next.w / 2;
        } else _cxFt = _cxFt * (next.w / prev.w);
        _cyFt = _cyFt * (next.h / prev.h);
        var wasW = _wFt2,
          wasH = _hFt2;
        _wFt2 = Math.max(2, Math.min(_wFt2, next.w));
        _hFt2 = Math.max(2, Math.min(_hFt2, next.h));
        if (_wFt2 > next.w || _hFt2 > next.h) {
          events.push({
            id: it.id,
            type: it.type,
            label: labelOf(it),
            kind: "blocked"
          });
          byId.set(it.id, it);
          continue;
        }
        if (_wFt2 !== wasW || _hFt2 !== wasH) events.push({
          id: it.id,
          type: it.type,
          label: labelOf(it),
          kind: "resized",
          to: _wFt2
        });
        _cxFt = Math.max(_wFt2 / 2, Math.min(_cxFt, next.w - _wFt2 / 2));
        _cyFt = Math.max(_hFt2 / 2, Math.min(_cyFt, next.h - _hFt2 / 2));
        var _nit2 = _objectSpread(_objectSpread({}, it), {}, {
          x: B.mgX + _cxFt * B.scale,
          y: B.mgY + _cyFt * B.scale,
          widthFt: _wFt2,
          heightFt: _hFt2
        });
        byId.set(it.id, _nit2);
        placed.push(_nit2);
        continue;
      }

      // Free-floating: keep it inside the new box.
      var wFt = it.widthFt || cfg.width,
        hFt = it.heightFt || cfg.height;
      var cxFt = (it.x - A.mgX) / A.scale * (next.w / prev.w);
      var cyFt = (it.y - A.mgY) / A.scale * (next.h / prev.h);
      cxFt = Math.max(wFt / 2, Math.min(cxFt, next.w - wFt / 2));
      cyFt = Math.max(hFt / 2, Math.min(cyFt, next.h - hFt / 2));
      var nit = _objectSpread(_objectSpread({}, it), {}, {
        x: B.mgX + cxFt * B.scale,
        y: B.mgY + cyFt * B.scale
      });
      byId.set(it.id, nit);
      placed.push(nit);
    }

    // ── Pass 2: ramps follow their door, or go with it ──
  } catch (err) {
    _iterator3.e(err);
  } finally {
    _iterator3.f();
  }
  var _iterator4 = _createForOfIteratorHelper(items),
    _step4;
  try {
    for (_iterator4.s(); !(_step4 = _iterator4.n()).done;) {
      var _it = _step4.value;
      var _cfg = ITEMS[_it.type];
      if (!_cfg || !_cfg.doorSnap) continue;
      var door = byId.get(_it.snapDoorId);
      var pos = door && door.wall ? rampPosFor(_it, door, B) : null;
      if (!pos) continue; // orphaned ramp is dropped, as when its door is deleted
      byId.set(_it.id, _objectSpread(_objectSpread({}, _it), pos));
    }
  } catch (err) {
    _iterator4.e(err);
  } finally {
    _iterator4.f();
  }
  return {
    items: items.map(function (it) {
      return byId.get(it.id);
    }).filter(Boolean),
    events: events
  };
}

// Point on a note box's border in the direction of a target — where the note's
// leader (pointer) line starts, so the dashed line begins at the pill's edge
// instead of its center. If the target is inside the box, returns the target
// itself (degenerate line; callers skip drawing when start ≈ end).
function noteEdgePoint(cx, cy, w, h, tx, ty) {
  var dx = tx - cx,
    dy = ty - cy;
  if (!dx && !dy) return {
    x: cx,
    y: cy
  };
  var t = Math.min(dx ? w / 2 / Math.abs(dx) : Infinity, dy ? h / 2 / Math.abs(dy) : Infinity, 1);
  return {
    x: cx + dx * t,
    y: cy + dy * t
  };
}

// Determine which positional wall (north/south/east/west) is the FRONT
// based on door placement. Double door wins over single door.
function getFrontWall(items) {
  // Catalog fixture doors count as doors too; a double-leaf (built-in doubleDoor, or a
  // fixture whose operation is "double") wins over a single, same as before.
  var doubles = items.filter(function (i) {
    return i.wall && (i.type === "doubleDoor" || i.type === "fixtureDoor" && i.operation === "double");
  });
  if (doubles.length > 0) return doubles[0].wall;
  var singles = items.filter(function (i) {
    return i.wall && (i.type === "singleDoor" || i.type === "fixtureDoor");
  });
  if (singles.length > 0) return singles[0].wall;
  return null;
}

// ── Fixtures catalog (Options → Doors) → placeable designer tools + rendering ──────
// Each active catalog door (from get_fixtures) becomes a palette tool keyed `fx:<id>`
// (wallOnly, carrying its own width in feet). Placing one creates a stable `fixtureDoor`
// item that SNAPSHOTS the door's spec (name/width/price/swing/operation) so a later catalog
// edit never changes a saved design. FIXTURE_DOOR_CFG is the render cfg for those placed
// items; `noPalette` keeps it out of the tool row (only the fx: tools are shown).
var FIXTURE_DOOR_COLOR = "#D97706"; // matches the built-in Single Door glyph
var FIXTURE_DOOR_COLOR_DOUBLE = "#B45309"; // matches the built-in Double Door glyph
// Amber like the built-in doors, darker for a double so it reads the same as doubleDoor.
function fixtureDoorColor(item) {
  return item && item.operation === "double" ? FIXTURE_DOOR_COLOR_DOUBLE : FIXTURE_DOOR_COLOR;
}
var FIXTURE_DOOR_CFG = {
  label: "Door",
  color: FIXTURE_DOOR_COLOR,
  wallOnly: true,
  width: 3,
  height: 0.5,
  shortLabel: "DOOR",
  noPalette: true,
  isFixtureDoor: true
};
// The single "Door" palette tool. Arming it and clicking a wall opens the door picker
// (below) instead of placing immediately — the shopper chooses WHICH door (and its swing/
// operation where more than one is offered) in the popup.
var DOOR_PICKER_CFG = {
  label: "Door",
  color: FIXTURE_DOOR_COLOR,
  wallOnly: true,
  width: 3,
  height: 0.5,
  shortLabel: "DOOR",
  isDoorPicker: true
};
// Custom ramps (custom mode). The "Ramp" tool attaches to a door (doorSnap) and opens the ramp
// picker. A placed custom ramp is a normal type:"ramp" item — so it reuses ALL the existing ramp
// machinery (render, door-snap follow, delete-cascade, z-order) — but carries the chosen style's
// own width/length + a priced snapshot (vs the simple built-in ramp which takes the door's width).
var FIXTURE_RAMP_COLOR = "#0284C7";
var RAMP_PICKER_CFG = {
  label: "Ramp",
  color: FIXTURE_RAMP_COLOR,
  icon: "⬛",
  doorSnap: true,
  width: 3,
  height: 2,
  shortLabel: "RAMP",
  isRampPicker: true
};
// Simple ramp — a fully self-contained option (render + placement), NO longer the built-in `ramp`
// layout item. Auto-widths to the door it attaches to (handled in handleClick's doorSnap branch,
// same as before). Stone color matches the old built-in so already-placed ramps look identical.
// ITEMS.ramp is ALWAYS this cfg (so every placed type:"ramp" renders), placeable only when the
// tenant offers a simple ramp (rampSettings.enabled + simple mode).
var SIMPLE_RAMP_CFG = {
  label: "Ramp",
  color: "#78716C",
  icon: "⬛",
  doorSnap: true,
  width: 3,
  height: 3,
  shortLabel: "RAMP",
  isSimpleRamp: true
};
// Catalog windows. The "Window" tool is wall-placed (like the door picker). A placed catalog
// window is a normal type:"window" item — so it reuses the built-in window's render (mullions,
// wall bar), collision, and payload — but carries the chosen style's width + a priced snapshot
// (built-in windows have no fixtureItemId; that's how the two are told apart in pricing).
var FIXTURE_WINDOW_COLOR = "#0EA5E9";
var WINDOW_PICKER_CFG = {
  label: "Window",
  color: FIXTURE_WINDOW_COLOR,
  icon: "🪟",
  wallOnly: true,
  width: 2,
  height: 0.5,
  shortLabel: "WIN",
  isWindowPicker: true
};
function fixtureInitialSwing(fx) {
  if (fx.swingIn && fx.swingOut) return fx.swingDefault || "in";
  if (fx.swingIn) return "in";
  if (fx.swingOut) return "out";
  return null;
}
function fixtureInitialOperation(fx) {
  if (fx.opSlideUp) return "slideup";
  if (fx.opDouble) return "double";
  if (fx.opRight && fx.opLeft) return fx.opDefault || "right";
  if (fx.opRight) return "right";
  if (fx.opLeft) return "left";
  return null;
}
function buildFixtureTools(fixtures) {
  var out = {};
  (Array.isArray(fixtures) ? fixtures : []).forEach(function (fx) {
    if (!fx || fx.category && fx.category !== "door") return;
    var wIn = Number(fx.widthIn) || 36;
    out["fx:".concat(fx.id)] = {
      label: fx.name || "Door",
      color: FIXTURE_DOOR_COLOR,
      icon: "🚪",
      wallOnly: true,
      width: wIn / 12,
      height: 0.5,
      shortLabel: (fx.name || "DOOR").toUpperCase().slice(0, 10),
      fixture: fx
    };
  });
  return out;
}
// Swing/operation-aware door glyph. `out` combines the wall side (like the built-in
// singleDoor/doubleDoor) with the door's in/out swing (in = mirror of out). Hinge side
// comes from operation (right/left); "double" = two leaves; "slideup" = a segmented
// garage/roll-up panel with no arc.
function fixtureDoorOut(item) {
  var outBase = item.wall === "north" || item.wall === "east";
  return item.swing === "in" ? !outBase : outBase;
}
function fixtureDoorSVG(item, iw, color) {
  var stroke = color + "60",
    op = item.operation,
    out = fixtureDoorOut(item);
  if (op === "slideup") {
    return /*#__PURE__*/React.createElement("g", null, [-iw / 4, 0, iw / 4].map(function (lx, k) {
      return /*#__PURE__*/React.createElement("line", {
        key: k,
        x1: lx,
        y1: -5,
        x2: lx,
        y2: 5,
        stroke: "#FFF",
        strokeWidth: 1.5
      });
    }));
  }
  if (op === "double") {
    var _r = iw * 0.4,
      s = out ? -1 : 1;
    return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
      d: "M ".concat(-iw / 2 + _r, " 0 A ").concat(_r, " ").concat(_r, " 0 0 ").concat(out ? 0 : 1, " ").concat(-iw / 2, " ").concat(s * _r),
      fill: "none",
      stroke: stroke,
      strokeWidth: 1.5,
      strokeDasharray: "4 3"
    }), /*#__PURE__*/React.createElement("path", {
      d: "M ".concat(iw / 2 - _r, " 0 A ").concat(_r, " ").concat(_r, " 0 0 ").concat(out ? 1 : 0, " ").concat(iw / 2, " ").concat(s * _r),
      fill: "none",
      stroke: stroke,
      strokeWidth: 1.5,
      strokeDasharray: "4 3"
    }), /*#__PURE__*/React.createElement("line", {
      x1: 0,
      y1: -5,
      x2: 0,
      y2: 5,
      stroke: "#FFF",
      strokeWidth: 1.5
    }));
  }
  var r = iw * 0.8,
    rightHinge = op === "right",
    ey = out ? -r : r;
  var sx = rightHinge ? iw / 2 - r : -iw / 2 + r,
    ex = rightHinge ? iw / 2 : -iw / 2;
  var sweep = rightHinge ? out ? 1 : 0 : out ? 0 : 1;
  return /*#__PURE__*/React.createElement("path", {
    d: "M ".concat(sx, " 0 A ").concat(r, " ").concat(r, " 0 0 ").concat(sweep, " ").concat(ex, " ").concat(ey),
    fill: "none",
    stroke: stroke,
    strokeWidth: 1.5,
    strokeDasharray: "4 3"
  });
}
function fixtureDoorCanvas(ctx, item, iw, color) {
  var op = item.operation,
    out = fixtureDoorOut(item);
  if (op === "slideup") {
    ctx.strokeStyle = "#FFF";
    ctx.lineWidth = 1.5;
    [-iw / 4, 0, iw / 4].forEach(function (lx) {
      ctx.beginPath();
      ctx.moveTo(lx, -5);
      ctx.lineTo(lx, 5);
      ctx.stroke();
    });
    return;
  }
  ctx.strokeStyle = color + "60";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  if (op === "double") {
    var _r2 = iw * 0.4;
    ctx.beginPath();
    ctx.arc(-iw / 2, 0, _r2, 0, out ? -Math.PI / 2 : Math.PI / 2, out);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(iw / 2, 0, _r2, Math.PI, out ? 3 * Math.PI / 2 : Math.PI / 2, !out);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = "#FFF";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, -5);
    ctx.lineTo(0, 5);
    ctx.stroke();
    return;
  }
  var r = iw * 0.8,
    rightHinge = op === "right";
  if (rightHinge) {
    ctx.beginPath();
    ctx.arc(iw / 2, 0, r, Math.PI, out ? 3 * Math.PI / 2 : Math.PI / 2, !out);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.arc(-iw / 2, 0, r, 0, out ? -Math.PI / 2 : Math.PI / 2, out);
    ctx.stroke();
  }
  ctx.setLineDash([]);
}
// Door sizes are stored in inches; show them as feet/inches on the plan + in the picker.
function fmtFtIn(inches) {
  var n = Number(inches);
  if (!isFinite(n) || n <= 0) return "";
  var ft = Math.floor(n / 12),
    inch = Math.round((n - ft * 12) * 100) / 100;
  if (ft === 0) return inch + '"';
  if (inch === 0) return ft + "'";
  return ft + "'" + inch + '"';
}
// Door placement picker. Doors are grouped by STYLE (exact name): one card per style; picking a
// style with more than one size reveals a size chooser, then swing/operation where more than one
// is offered, then place.
function DoorPicker(_ref3) {
  var doors = _ref3.doors,
    showPricing = _ref3.showPricing,
    onCancel = _ref3.onCancel,
    onPlace = _ref3.onPlace;
  var styles = useMemo(function () {
    var m = new Map();
    doors.forEach(function (d) {
      var k = d.name || "Door";
      if (!m.has(k)) m.set(k, {
        name: k,
        imageUrl: d.imageUrl || null,
        sizes: []
      });
      var g = m.get(k);
      g.sizes.push(d);
      if (!g.imageUrl && d.imageUrl) g.imageUrl = d.imageUrl;
    });
    return _toConsumableArray(m.values());
  }, [doors]);
  var _useState3 = useState(styles.length === 1 ? styles[0] : null),
    _useState4 = _slicedToArray(_useState3, 2),
    style = _useState4[0],
    setStyle = _useState4[1];
  var _useState5 = useState(styles.length === 1 && styles[0].sizes.length === 1 ? styles[0].sizes[0] : null),
    _useState6 = _slicedToArray(_useState5, 2),
    sel = _useState6[0],
    setSel = _useState6[1];
  var _useState7 = useState(null),
    _useState8 = _slicedToArray(_useState7, 2),
    swing = _useState8[0],
    setSwing = _useState8[1];
  var _useState9 = useState(null),
    _useState10 = _slicedToArray(_useState9, 2),
    operation = _useState10[0],
    setOperation = _useState10[1];
  useEffect(function () {
    if (!sel) {
      setSwing(null);
      setOperation(null);
      return;
    }
    setSwing(fixtureInitialSwing(sel));
    setOperation(fixtureInitialOperation(sel));
  }, [sel]);
  var pickStyle = function pickStyle(st) {
    setStyle(st);
    setSel(st.sizes.length === 1 ? st.sizes[0] : null);
  };
  var swingOpts = sel ? [sel.swingIn && "in", sel.swingOut && "out"].filter(Boolean) : [];
  var opOpts = sel ? [sel.opRight && "right", sel.opLeft && "left", sel.opDouble && "double", sel.opSlideUp && "slideup"].filter(Boolean) : [];
  var OP_LABEL = {
    right: "Right",
    left: "Left",
    "double": "Double",
    slideup: "Slide up"
  };
  var money = function money(n) {
    return "$" + Number(n).toLocaleString();
  };
  var chip = function chip(key, on, label, onClick) {
    return /*#__PURE__*/React.createElement("div", {
      key: key,
      onClick: onClick,
      style: {
        padding: "6px 14px",
        borderRadius: 20,
        fontSize: 13,
        fontWeight: 600,
        cursor: "pointer",
        border: "2px solid ".concat(on ? FIXTURE_DOOR_COLOR : "#E2E8F0"),
        background: on ? "#FEF3C7" : "#FFF",
        color: on ? "#92400E" : "#334155"
      }
    }, label);
  };
  return /*#__PURE__*/React.createElement("div", {
    onClick: onCancel,
    style: {
      position: "fixed",
      inset: 0,
      background: "rgba(15,23,42,0.45)",
      zIndex: 9000,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: function onClick(e) {
      return e.stopPropagation();
    },
    style: {
      background: "#FFF",
      borderRadius: 14,
      width: "min(560px, 96vw)",
      maxHeight: "88vh",
      overflow: "auto",
      padding: 20,
      boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
      fontFamily: "system-ui, -apple-system, sans-serif"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 17,
      fontWeight: 800,
      color: "#1E293B",
      marginBottom: 4
    }
  }, "Choose a door"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: "#64748B",
      marginBottom: 14
    }
  }, style && style.sizes.length > 1 ? "Pick a size." : "Pick a door to place on this wall."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
      gap: 10,
      marginBottom: 16
    }
  }, styles.map(function (st) {
    var on = style && style.name === st.name;
    var one = st.sizes.length === 1 ? st.sizes[0] : null;
    var sub = one ? "".concat(fmtFtIn(one.widthIn), " \xD7 ").concat(fmtFtIn(one.heightIn)).concat(showPricing && one.price != null ? " \xB7 ".concat(money(one.price)) : "") : "".concat(st.sizes.length, " sizes");
    return /*#__PURE__*/React.createElement("div", {
      key: st.name,
      onClick: function onClick() {
        return pickStyle(st);
      },
      style: {
        border: "2px solid ".concat(on ? FIXTURE_DOOR_COLOR : "#E2E8F0"),
        borderRadius: 10,
        overflow: "hidden",
        cursor: "pointer",
        background: "#FFF"
      }
    }, st.imageUrl ? /*#__PURE__*/React.createElement("img", {
      src: st.imageUrl,
      alt: "",
      style: {
        width: "100%",
        height: 90,
        objectFit: "cover",
        display: "block"
      }
    }) : /*#__PURE__*/React.createElement("div", {
      style: {
        height: 90,
        background: "#F1F5F9",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 26
      }
    }, "\uD83D\uDEAA"), /*#__PURE__*/React.createElement("div", {
      style: {
        padding: "8px 10px"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 13,
        fontWeight: 700,
        color: "#1E293B"
      }
    }, st.name), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11.5,
        color: "#64748B"
      }
    }, sub)));
  })), style && style.sizes.length > 1 && /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      fontWeight: 700,
      color: "#334155",
      marginBottom: 6
    }
  }, "Size"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      flexWrap: "wrap"
    }
  }, style.sizes.map(function (d) {
    return chip(d.id, sel && sel.id === d.id, "".concat(fmtFtIn(d.widthIn), " \xD7 ").concat(fmtFtIn(d.heightIn)).concat(showPricing && d.price != null ? " \xB7 ".concat(money(d.price)) : ""), function () {
      return setSel(d);
    });
  }))), sel && swingOpts.length > 1 && /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      fontWeight: 700,
      color: "#334155",
      marginBottom: 6
    }
  }, "Swing"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8
    }
  }, swingOpts.map(function (o) {
    return chip(o, swing === o, o === "in" ? "In-swing" : "Out-swing", function () {
      return setSwing(o);
    });
  }))), sel && opOpts.length > 1 && /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      fontWeight: 700,
      color: "#334155",
      marginBottom: 6
    }
  }, "Operation"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      flexWrap: "wrap"
    }
  }, opOpts.map(function (o) {
    return chip(o, operation === o, OP_LABEL[o], function () {
      return setOperation(o);
    });
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      justifyContent: "flex-end",
      marginTop: 4
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: onCancel,
    style: {
      padding: "9px 16px",
      borderRadius: 8,
      border: "1px solid #CBD5E1",
      background: "#FFF",
      color: "#334155",
      fontWeight: 600,
      cursor: "pointer"
    }
  }, "Cancel"), /*#__PURE__*/React.createElement("button", {
    onClick: function onClick() {
      return sel && onPlace(sel, swing, operation);
    },
    disabled: !sel,
    style: {
      padding: "9px 18px",
      borderRadius: 8,
      border: "none",
      background: sel ? FIXTURE_DOOR_COLOR : "#CBD5E1",
      color: "#FFF",
      fontWeight: 700,
      cursor: sel ? "pointer" : "default"
    }
  }, "Place door"))));
}

// Map a positional wall to a display label (FRONT/BACK/LEFT/RIGHT)
// based on which wall is currently FRONT. Returns null if no front set.
//
// VIEWPOINT: a customer standing OUTSIDE the building, in front of the doors, looking
// at them. LEFT/RIGHT are that person's left and right — what they'd say pointing at
// the real building — NOT what a plan reader sees on screen. For a north- or
// south-facing front those two are mirror images of each other, which is exactly what
// makes this easy to get wrong.
//
// Facing the front wall, the customer's left is the direction they face rotated 90°
// counter-clockwise on the compass:
//
//   front   customer faces   LEFT    RIGHT
//   north   south            east    west
//   south   north            west    east
//   east    west             south   north
//   west    east             north   south
//
// (Plan orientation, per getWallFromClick: north = top of the canvas, south = bottom,
// west = left, east = right.)
//
// FIXED 2026-07-26 (reported by Junior Barns): the north and south rows were inverted.
// They described an INSIDE-looking-out viewpoint while east/west already used
// outside-looking-in, so a door on the north or south wall reported its sides
// backwards while an end-wall door read correctly — an inconsistency, not a uniform
// flip. This function is the single source of truth for the on-screen labels, the
// exported PNG/PDF, and the `wall` field in the submit payload, so it drives the
// emailed estimate too. Check any edit against the table above, not against a
// screenshot of the plan.
function getDisplayLabel(positionalWall, frontWall) {
  if (!frontWall || !positionalWall) return null;
  var map = {
    north: {
      north: "FRONT",
      south: "BACK",
      east: "LEFT",
      west: "RIGHT"
    },
    south: {
      south: "FRONT",
      north: "BACK",
      west: "LEFT",
      east: "RIGHT"
    },
    east: {
      east: "FRONT",
      west: "BACK",
      south: "LEFT",
      north: "RIGHT"
    },
    west: {
      west: "FRONT",
      east: "BACK",
      north: "LEFT",
      south: "RIGHT"
    }
  };
  return map[frontWall][positionalWall];
}

// How to name a wall in a sentence to the customer. getDisplayLabel is relative to the
// FRONT, and there is no front until a door is placed — it returns null, which rendered as
// "moved to the null wall". Naming a direction we cannot actually derive would be worse
// than not naming one, so say "another wall" until a door defines the front.
function wallPhrase(positionalWall, frontWall) {
  var d = getDisplayLabel(positionalWall, frontWall);
  return d ? "the " + d.toLowerCase() + " wall" : "another wall";
}
// ─── Layout add-on pricing (browser mirror of submit-estimate's pushItem) ─────────
// Compute one display row per priceable placed item type, applying the SAME 7
// pricing_method formulas the edge function uses so the prices shown on the plan match
// the emailed estimate to the penny. Needs C.layoutPricing ({key:{rate,method,byStyle}})
// and C.sizePricing ({styleKey:{sizeLabel:{basePrice,widthFt,lengthFt}}}) — both are
// present only when the tenant's show_pricing is on (else {} → returns no rows).
var LAYOUT_PRICE_ORDER = ["singleDoor", "doubleDoor", "window", "workbench", "loft", "ramp"];
function normSizeLabel(s) {
  return String(s || "").toLowerCase().replace(/[×✕]/g, "x").replace(/\s+/g, "");
}
function fmtMoney2(n) {
  var v = Number(n) || 0;
  var s = "$" + Math.abs(v).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  return v < 0 ? "−" + s : s;
}
// Building / Paint Colors / Roof summary for the "Details" section, in the SAME order they appear
// on the GHL estimate (Building, Paint, Roof). Prices use the same sizePricing + color rate/method
// the estimate uses (total is null when show_pricing is off). The Roof row shows only when the
// tenant offers roof colors (some color flagged shingle/metal).
// Origin allowlist for the postMessage prefill/config listeners — same-origin,
// the structurestudio.app family, and localhost (dev). Without it, a malicious
// page that frames or window.opens the designer can inject selections/contact or
// remount the app with an attacker-controlled config. If a tenant ever embeds the
// designer from its own domain via postMessage, add that origin here.
function ssAllowedOrigin(origin) {
  try {
    if (!origin || origin === "null") return false;
    if (origin === window.location.origin) return true;
    var h = new URL(origin).hostname;
    return h === "structurestudiosuite.com" || h.endsWith(".structurestudiosuite.com") || h === "structurestudio.app" || h.endsWith(".structurestudio.app") || h === "localhost" || h === "127.0.0.1";
  } catch (_unused) {
    return false;
  }
}
function computeSelectionRows(sel, paintColors, C, items) {
  var styleKey = sel && sel.style;
  var showP = !!(C && C.showPricing);
  var colors = Array.isArray(C && C.colors) ? C.colors : [];
  var szMap = C && C.sizePricing && styleKey ? C.sizePricing[styleKey] : null;
  var szRow = null;
  if (szMap && sel && sel.size) {
    szRow = szMap[sel.size];
    if (!szRow) {
      var want = normSizeLabel(sel.size);
      for (var k in szMap) {
        if (normSizeLabel(k) === want) {
          szRow = szMap[k];
          break;
        }
      }
    }
  }
  var bW = szRow && szRow.widthFt != null ? Number(szRow.widthFt) : 0;
  var bL = szRow && szRow.lengthFt != null ? Number(szRow.lengthFt) : 0;
  var buildingArea = bW * bL,
    buildingPerimeter = 2 * (bW + bL);
  var buildingPrice = szRow && szRow.basePrice != null ? Number(szRow.basePrice) : 0;
  var charge = function charge(c) {
    if (!c) return 0;
    var rate = Number(c.rate) || 0;
    if (rate <= 0) return 0;
    switch (c.pricingMethod || "each") {
      case "sqft_building":
        return rate * buildingArea;
      case "perimeter_building":
        return rate * buildingPerimeter;
      case "pct_building_price":
        return rate / 100 * buildingPrice;
      case "pct_estimate_total":
        return 0;
      default:
        return rate;
    }
  };
  var pick = function pick(label, pred) {
    var v = String(label || "").trim();
    if (!v) return null;
    var list = colors.filter(pred);
    return list.find(function (c) {
      return c.label === v;
    }) || list.find(function (c) {
      return c.allowCustom;
    }) || null;
  };
  var styleLabel = ((C && C.buildingStyles || []).find(function (s) {
    return s.value === styleKey;
  }) || {}).label || styleKey || "";
  var rows = [];
  // Declined included items are itemized UNDER the building line (one per line), same as the GHL
  // estimate — the building line's bold label is just the style + size, and the gray detail lists
  // the original price + each declined item; the credits reduce the building total.
  var layoutPricing = C && C.layoutPricing || {};
  var resolveLp = function resolveLp(key) {
    var lp = layoutPricing[key];
    if (!lp) return null;
    var ov = lp.byStyle && styleKey ? lp.byStyle[styleKey] : null;
    return {
      rate: Number(ov && ov.rate != null ? ov.rate : lp.rate) || 0,
      method: ov && ov.method || lp.method || "each"
    };
  };
  var stEntry = (C && C.buildingStyles || []).find(function (s) {
    return s.value === styleKey;
  });
  var pickSize = function pickSize(map) {
    if (!map || _typeof(map) !== "object" || !(sel && sel.size)) return null;
    if (map[sel.size] != null) return map[sel.size];
    var want = normSizeLabel(sel.size);
    for (var _k in map) {
      if (normSizeLabel(_k) === want) return map[_k];
    }
    return null;
  };
  var rawQ = stEntry ? pickSize(stEntry.sizeInclusionQty) : null;
  var qmap = rawQ && _typeof(rawQ) === "object" && !Array.isArray(rawQ) ? rawQ : null;
  var legacyArr = !qmap && stEntry ? pickSize(stEntry.sizeInclusions) : null;
  var includedNow = {};
  if (qmap) includedNow = qmap;else if (Array.isArray(legacyArr)) {
    var _iterator6 = _createForOfIteratorHelper(legacyArr),
      _step6;
    try {
      for (_iterator6.s(); !(_step6 = _iterator6.n()).done;) {
        var _k2 = _step6.value;
        includedNow[_k2] = 1;
      }
    } catch (err) {
      _iterator6.e(err);
    } finally {
      _iterator6.f();
    }
  }
  var declinedKeys = sel && Array.isArray(sel.declinedItems) ? sel.declinedItems : [];
  var declinedLines = [];
  var declinedTotal = 0;
  if (sel && sel.size) {
    var _iterator7 = _createForOfIteratorHelper(declinedKeys),
      _step7;
    try {
      var _loop = function _loop() {
          var k = _step7.value;
          if (includedNow[k] == null) return 0; // continue
          // Catalog fixture inclusion (key = fixture id): credit its snapshot price × the included qty.
          var fxDecl = (Array.isArray(C.fixtures) ? C.fixtures : []).find(function (f) {
            return String(f.id) === k;
          });
          if (fxDecl) {
            var q0 = Math.max(1, Number(includedNow[k]) || 1);
            var credit0 = Math.round((fxDecl.price != null ? Number(fxDecl.price) : 0) * q0 * 100) / 100;
            if (credit0 <= 0) return 0; // continue
            declinedLines.push("".concat(fxDecl.name || "Item", " declined (\u2212").concat(fmtMoney2(credit0), ")"));
            declinedTotal += credit0;
            return 0; // continue
          }
          var rp = resolveLp(k);
          if (!rp || !(rp.rate > 0)) return 0; // continue
          var q = rp.method === "pct_estimate_total" ? 1 : Math.max(1, Number(includedNow[k]) || 1);
          var unitValue = rp.rate;
          switch (rp.method) {
            case "sqft_building":
              unitValue = rp.rate * buildingArea;
              break;
            case "perimeter_building":
              unitValue = rp.rate * buildingPerimeter;
              break;
            case "pct_building_price":
              unitValue = rp.rate / 100 * buildingPrice;
              break;
            default:
              break;
          }
          unitValue = Math.round(unitValue * 100) / 100;
          var credit = Math.round(unitValue * q * 100) / 100;
          if (credit <= 0) return 0; // continue
          var label = C.layoutItems && C.layoutItems[k] && C.layoutItems[k].label || LEGACY_LAYOUT_FALLBACK[k] && LEGACY_LAYOUT_FALLBACK[k].label || k;
          declinedLines.push("".concat(label, " declined (\u2212").concat(fmtMoney2(credit), ")"));
          declinedTotal += credit;
        },
        _ret;
      for (_iterator7.s(); !(_step7 = _iterator7.n()).done;) {
        _ret = _loop();
        if (_ret === 0) continue;
      }
    } catch (err) {
      _iterator7.e(err);
    } finally {
      _iterator7.f();
    }
  }
  // Under-placed included area items (loft, and any sqft_option inclusion): a smaller placed
  // area than the included amount credits the shortfall (mirrors submit-estimate's pushItem,
  // which credits sqft_option under-placement). Only when actually placed and not declined — a
  // fully-absent include is handled by the decline flow, not auto-credited. Kept method-scoped
  // to sqft_option so it stays in lock-step with the edge (lineal_ft is NOT under-credited).
  if (sel && sel.size && Array.isArray(items)) {
    var _loop2 = function _loop2(_k3) {
        if (declinedKeys.includes(_k3)) return 0; // continue
        var rpk = resolveLp(_k3);
        if (!rpk || rpk.method !== "sqft_option" || !(rpk.rate > 0)) return 0; // continue
        var incQ = Number(includedNow[_k3]) || 0;
        if (incQ <= 0) return 0; // continue
        var placedSqft = Math.round(items.filter(function (i) {
          return i.type === _k3;
        }).reduce(function (s, i) {
          return s + (Number(i.widthFt) || 0) * (Number(i.heightFt) || 0);
        }, 0));
        if (placedSqft > 0 && placedSqft < incQ) {
          var credit = Math.round(rpk.rate * (incQ - placedSqft) * 100) / 100;
          if (credit > 0) {
            var lbl = C.layoutItems && C.layoutItems[_k3] && C.layoutItems[_k3].label || LEGACY_LAYOUT_FALLBACK[_k3] && LEGACY_LAYOUT_FALLBACK[_k3].label || _k3;
            declinedLines.push("".concat(lbl, " smaller than included: ").concat(incQ - placedSqft, " sq ft credited (\u2212").concat(fmtMoney2(credit), ")"));
            declinedTotal += credit;
          }
        }
      },
      _ret2;
    for (var _k3 in includedNow) {
      _ret2 = _loop2(_k3);
      if (_ret2 === 0) continue;
    }
  }
  declinedTotal = Math.round(declinedTotal * 100) / 100;
  var styleSize = [styleLabel, sel && sel.size].filter(Boolean).join(" ") || "—";
  var buildingDetail = declinedLines.length ? ["Original building price: ".concat(fmtMoney2(buildingPrice))].concat(declinedLines).join("\n") : "";
  rows.push({
    key: "building",
    label: styleSize,
    detail: buildingDetail,
    total: showP ? Math.max(0, buildingPrice - declinedTotal) : null
  });
  var painted = sel && sel.paint === "Painted";
  var pDetail = "Unpainted",
    pTotal = 0;
  if (painted) {
    var body = pick(paintColors && paintColors.body, function (c) {
      return c.siding;
    });
    var trim = pick(paintColors && paintColors.trim, function (c) {
      return c.trim;
    });
    var seen = {};
    [body, trim].forEach(function (c) {
      if (c && c.id && !seen[c.id]) {
        seen[c.id] = 1;
        pTotal += charge(c);
      }
    });
    pDetail = "Body: ".concat(paintColors && paintColors.body || "TBD", ", Trim: ").concat(paintColors && paintColors.trim || "TBD");
  }
  rows.push({
    key: "paint",
    label: "Paint Colors",
    detail: pDetail,
    total: showP ? pTotal : null
  });
  var offersRoof = colors.some(function (c) {
    return c.shingle || c.metal;
  });
  if (offersRoof) {
    var rt = sel && sel.roofType || "";
    var rDetail = "No roof selected",
      rTotal = 0;
    if (rt) {
      var rc = pick(sel && sel.roofColor, function (c) {
        return rt === "Metal" ? c.metal : c.shingle;
      });
      rTotal = charge(rc);
      rDetail = sel && sel.roofColor ? "".concat(rt, " \u2014 ").concat(sel.roofColor) : "".concat(rt, " \u2014 (color TBD)");
    }
    rows.push({
      key: "roof",
      label: "Roof",
      detail: rDetail,
      total: showP ? rTotal : null
    });
  }
  return rows;
}
// Only allow a design's image_url to be used as a clickable href when it is an
// https Supabase-storage (or same-origin) URL. image_url is stored verbatim by the
// anon-granted save_design RPC, so a hostile caller could stash a javascript: or
// off-site phishing URL; gate it before it reaches an <a href>. Returns null if unsafe. (audit #F8)
function ssSafeUrl(u) {
  try {
    var url = new URL(u, window.location.origin);
    if (url.protocol !== "https:") return null;
    var h = url.hostname;
    return h === window.location.hostname || h.endsWith(".supabase.co") ? u : null;
  } catch (_unused2) {
    return null;
  }
}
function computeLayoutPricingRows(items, sel, customOptions, C, paintColors) {
  if (!C || !C.showPricing || !C.layoutPricing) return {
    rows: []
  };
  var pricing = C.layoutPricing;
  var styleKey = sel && sel.style;
  // Resolve rate + method for an item_key: a per-style override wins over the default,
  // matching submit-estimate's layoutRates precedence.
  var resolve = function resolve(key) {
    var lp = pricing[key];
    if (!lp) return null;
    var ov = lp.byStyle && styleKey ? lp.byStyle[styleKey] : null;
    return {
      rate: Number(ov && ov.rate != null ? ov.rate : lp.rate) || 0,
      method: ov && ov.method || lp.method || "each"
    };
  };
  // Building geometry + base price for the building-dependent methods, from the selected
  // size (0 when the size isn't priced/matched — same $0 the estimate would show).
  var szMap = C.sizePricing && styleKey ? C.sizePricing[styleKey] : null;
  var szRow = null;
  if (szMap && sel && sel.size) {
    szRow = szMap[sel.size];
    if (!szRow) {
      var want = normSizeLabel(sel.size);
      for (var k in szMap) {
        if (normSizeLabel(k) === want) {
          szRow = szMap[k];
          break;
        }
      }
    }
  }
  var bW = szRow && szRow.widthFt != null ? Number(szRow.widthFt) : 0;
  var bL = szRow && szRow.lengthFt != null ? Number(szRow.lengthFt) : 0;
  var buildingArea = bW * bL;
  var buildingPerimeter = 2 * (bW + bL);
  var buildingPrice = szRow && szRow.basePrice != null ? Number(szRow.basePrice) : 0;

  // Roll placed items into counts + per-measure quantities. Ramps split two ways: CUSTOM ramps
  // (a catalog style with a snapshot price) price like fixture doors; SIMPLE ramps (the built-in
  // ramp) price from the tenant's single ramp price when set, else the legacy layout "ramp" rate.
  var rampSettings = C.rampSettings || null;
  var rampSimplePriced = !!(rampSettings && rampSettings.price != null);
  var singleDoors = 0,
    doubleDoors = 0,
    builtinWindows = 0,
    lofts = 0,
    loftSqft = 0;
  var workbenchFt = [];
  var customRamps = [],
    simpleRamps = [];
  var customWindows = [];
  var _iterator8 = _createForOfIteratorHelper(items),
    _step8;
  try {
    for (_iterator8.s(); !(_step8 = _iterator8.n()).done;) {
      var _it3 = _step8.value;
      if (_it3.type === "singleDoor") singleDoors++;else if (_it3.type === "doubleDoor") doubleDoors++;
      // Catalog windows (own snapshot price) price below like fixture doors; built-in windows
      // (no fixtureItemId) keep pricing via the layout "window" rate.
      else if (_it3.type === "window") {
        if (_it3.fixtureItemId && _it3.price != null) customWindows.push(_it3);else builtinWindows++;
      } else if (_it3.type === "workbench") workbenchFt.push(Number(_it3.widthFt) || 0);else if (_it3.type === "loft") {
        lofts++;
        loftSqft += (Number(_it3.widthFt) || 0) * (Number(_it3.heightFt) || 0);
      } else if (_it3.type === "ramp") {
        if (_it3.fixtureItemId && _it3.price != null) customRamps.push(_it3);else simpleRamps.push(_it3);
      }
    }
  } catch (err) {
    _iterator8.e(err);
  } finally {
    _iterator8.f();
  }
  loftSqft = Math.round(loftSqft);
  var totalWorkbenchFt = workbenchFt.reduce(function (s, f) {
    return s + f;
  }, 0);
  var measures = {
    singleDoor: {
      count: singleDoors
    },
    doubleDoor: {
      count: doubleDoors
    },
    window: {
      count: builtinWindows
    },
    workbench: {
      count: workbenchFt.length,
      lengthFt: totalWorkbenchFt
    },
    loft: {
      count: lofts,
      optionSqft: loftSqft
    },
    // Legacy layout "ramp" row applies only to simple ramps that AREN'T priced by the new ramp
    // settings — otherwise ramps price below (custom by snapshot, simple by ramp settings).
    ramp: {
      count: rampSimplePriced ? 0 : simpleRamps.length
    }
  };
  var lineFor = function lineFor(rate, method, m) {
    var count = m.count || 0;
    switch (method) {
      case "lineal_ft":
        return {
          qty: m.lengthFt != null ? m.lengthFt : count,
          total: rate * (m.lengthFt != null ? m.lengthFt : count),
          unit: fmtMoney2(rate) + " / ft"
        };
      case "sqft_option":
        return {
          qty: m.optionSqft != null ? m.optionSqft : count,
          total: rate * (m.optionSqft != null ? m.optionSqft : count),
          unit: fmtMoney2(rate) + " / sq ft"
        };
      case "sqft_building":
        return {
          qty: count,
          total: rate * buildingArea * count,
          unit: fmtMoney2(rate) + " / sq ft of building"
        };
      case "perimeter_building":
        return {
          qty: count,
          total: rate * buildingPerimeter * count,
          unit: fmtMoney2(rate) + " / ft of perimeter"
        };
      case "pct_building_price":
        return {
          qty: count,
          total: rate / 100 * buildingPrice * count,
          unit: rate + "% of building price"
        };
      case "pct_estimate_total":
        return {
          qty: count,
          total: null,
          pct: rate,
          unit: rate + "% of subtotal"
        };
      case "each":
      default:
        return {
          qty: count,
          total: rate * count,
          unit: fmtMoney2(rate) + " each"
        };
    }
  };

  // Included quantities for this style+size (part of the base price → not re-charged; only the
  // amount placed BEYOND the inclusion is charged, matching submit-estimate's pushItem).
  var incForRows = function () {
    var st = (C.buildingStyles || []).find(function (s) {
      return s.value === styleKey;
    });
    if (!st || !sel || !sel.size) return {};
    var pick = function pick(map) {
      if (!map || _typeof(map) !== "object") return null;
      if (map[sel.size] != null) return map[sel.size];
      var want = normSizeLabel(sel.size);
      for (var _k4 in map) {
        if (normSizeLabel(_k4) === want) return map[_k4];
      }
      return null;
    };
    var q = pick(st.sizeInclusionQty);
    if (q && _typeof(q) === "object" && !Array.isArray(q)) {
      var _o = {};
      for (var _k5 in q) _o[_k5] = Math.max(1, Number(q[_k5]) || 1);
      return _o;
    }
    var arr = pick(st.sizeInclusions);
    var o = {};
    if (Array.isArray(arr)) {
      var _iterator9 = _createForOfIteratorHelper(arr),
        _step9;
      try {
        for (_iterator9.s(); !(_step9 = _iterator9.n()).done;) {
          var _k6 = _step9.value;
          o[_k6] = 1;
        }
      } catch (err) {
        _iterator9.e(err);
      } finally {
        _iterator9.f();
      }
    }
    return o;
  }();
  var rows = [];
  var deferred = [];
  var nonPctSubtotal = 0;
  var _iterator10 = _createForOfIteratorHelper(LAYOUT_PRICE_ORDER),
    _step10;
  try {
    for (_iterator10.s(); !(_step10 = _iterator10.n()).done;) {
      var key = _step10.value;
      var m = measures[key];
      if (!m || !m.count) continue;
      var rp = resolve(key);
      if (!rp) continue;
      var label = C.layoutItems && C.layoutItems[key] && C.layoutItems[key].label || LEGACY_LAYOUT_FALLBACK[key] && LEGACY_LAYOUT_FALLBACK[key].label || key;
      // Net out the included quantity for this item (loft = sq ft, others = count).
      var _inc3 = incForRows[key] || 0;
      var placedMeasure = rp.method === "lineal_ft" ? m.lengthFt || 0 : rp.method === "sqft_option" ? m.optionSqft || 0 : m.count || 0;
      var _chargeable3 = Math.max(0, placedMeasure - _inc3);
      if (_inc3 > 0 && _chargeable3 <= 0) {
        rows.push({
          key: key,
          label: label + " (included)",
          qty: placedMeasure,
          unit: "included",
          total: 0,
          method: rp.method
        });
        continue;
      }
      var mNet = m;
      if (_inc3 > 0) mNet = rp.method === "lineal_ft" ? _objectSpread(_objectSpread({}, m), {}, {
        lengthFt: _chargeable3
      }) : rp.method === "sqft_option" ? _objectSpread(_objectSpread({}, m), {}, {
        optionSqft: _chargeable3
      }) : _objectSpread(_objectSpread({}, m), {}, {
        count: _chargeable3
      });
      var ln = lineFor(rp.rate, rp.method, mNet);
      // Measured inclusions (loft = sq ft, workbench = ft): show the TOTAL placed measure as the
      // row quantity so it reads accurately, but keep charging only the excess beyond the included
      // amount. "each" items (doors/windows) keep the netted count.
      var measured = rp.method === "lineal_ft" || rp.method === "sqft_option";
      var dispQty = measured && _inc3 > 0 ? placedMeasure : ln.qty;
      // Measured item with an inclusion (loft/workbench): spell out the full calc — placed, included,
      // billable — WORD-FOR-WORD the same as the estimate's loft line, so the two match.
      var unit = void 0;
      if (measured && _inc3 > 0) {
        var u2 = rp.method === "sqft_option" ? "sq ft" : "ft";
        unit = ["".concat(placedMeasure, " ").concat(u2, " placed"), "".concat(_inc3, " ").concat(u2, " included in base price"), "".concat(_chargeable3, " ").concat(u2, " billable @ ").concat(fmtMoney2(rp.rate), "/").concat(u2)].join(" · ");
      } else {
        unit = ln.unit;
      }
      var row = {
        key: key,
        label: label,
        qty: dispQty,
        unit: unit,
        total: ln.total,
        method: rp.method
      };
      rows.push(row);
      if (ln.total == null) deferred.push({
        row: row,
        pct: ln.pct
      });else nonPctSubtotal += ln.total;
    }

    // Catalog fixture doors (Options → Doors): each carries its OWN snapshotted price, not a
    // per-key rate — so they price separately from the layout items above. Identical doors
    // (same name + price) collapse into one line with a qty. Feeds the % base like any add-on.
    // Grouped by fixture id so a size-inclusion nets the first N free (incForRows[fixtureId] = the
    // qty the base price covers). Fully-included shows "(included)"; extras beyond it are charged.
  } catch (err) {
    _iterator10.e(err);
  } finally {
    _iterator10.f();
  }
  var fxGroups = {};
  var _iterator11 = _createForOfIteratorHelper(items),
    _step11;
  try {
    for (_iterator11.s(); !(_step11 = _iterator11.n()).done;) {
      var _it4 = _step11.value;
      if (_it4.type !== "fixtureDoor") continue;
      var _price2 = _it4.price != null ? Number(_it4.price) : 0;
      var _fid5 = _it4.fixtureItemId || "".concat(_it4.doorName || "Door", "|").concat(_price2);
      if (!fxGroups[_fid5]) fxGroups[_fid5] = {
        label: _it4.doorName || "Door",
        price: _price2,
        qty: 0,
        fid: _it4.fixtureItemId || null
      };
      fxGroups[_fid5].qty++;
    }
  } catch (err) {
    _iterator11.e(err);
  } finally {
    _iterator11.f();
  }
  for (var fid in fxGroups) {
    var g = fxGroups[fid];
    var inc = g.fid && incForRows[g.fid] ? Number(incForRows[g.fid]) : 0;
    var chargeable = Math.max(0, g.qty - inc);
    if (g.price > 0 && inc > 0 && chargeable <= 0) {
      rows.push({
        key: "fx:".concat(fid),
        label: g.label + " (included)",
        qty: g.qty,
        unit: "included",
        total: 0,
        method: "each"
      });
      continue;
    }
    if (!(g.price > 0)) continue; // $0 / unpriced = free, no line
    var total = Math.round(g.price * chargeable * 100) / 100;
    rows.push({
      key: "fx:".concat(fid),
      label: g.label,
      qty: chargeable,
      unit: fmtMoney2(g.price) + " each" + (inc > 0 ? " \xB7 ".concat(inc, " included") : ""),
      total: total,
      method: "each"
    });
    nonPctSubtotal += total;
  }

  // Catalog windows (Options → Windows): each carries its OWN snapshot price, grouped by style
  // like doors. Built-in windows already priced above via the layout "window" rate.
  var winGroups = {};
  for (var _i2 = 0, _customWindows = customWindows; _i2 < _customWindows.length; _i2++) {
    var it = _customWindows[_i2];
    var price = it.price != null ? Number(it.price) : 0;
    var _fid = it.fixtureItemId || "".concat(it.windowName || "Window", "|").concat(price);
    if (!winGroups[_fid]) winGroups[_fid] = {
      label: it.windowName || "Window",
      price: price,
      qty: 0,
      fid: it.fixtureItemId || null
    };
    winGroups[_fid].qty++;
  }
  for (var _fid2 in winGroups) {
    var _g = winGroups[_fid2];
    var _inc = _g.fid && incForRows[_g.fid] ? Number(incForRows[_g.fid]) : 0;
    var _chargeable = Math.max(0, _g.qty - _inc);
    if (_g.price > 0 && _inc > 0 && _chargeable <= 0) {
      rows.push({
        key: "win:".concat(_fid2),
        label: _g.label + " (included)",
        qty: _g.qty,
        unit: "included",
        total: 0,
        method: "each"
      });
      continue;
    }
    if (!(_g.price > 0)) continue; // $0 / unpriced = free, no line
    var _total = Math.round(_g.price * _chargeable * 100) / 100;
    rows.push({
      key: "win:".concat(_fid2),
      label: _g.label,
      qty: _chargeable,
      unit: fmtMoney2(_g.price) + " each" + (_inc > 0 ? " \xB7 ".concat(_inc, " included") : ""),
      total: _total,
      method: "each"
    });
    nonPctSubtotal += _total;
  }

  // Catalog ramps (Options → Ramps). Custom ramps carry their own snapshot price (grouped by
  // style like doors); simple ramps price from the tenant's single ramp price — "each" per ramp,
  // or "per_ft" × the attached door's width. Both feed the % base like any add-on.
  var rampGroups = {};
  for (var _i3 = 0, _customRamps = customRamps; _i3 < _customRamps.length; _i3++) {
    var _it2 = _customRamps[_i3];
    var _price = _it2.price != null ? Number(_it2.price) : 0;
    var _fid3 = _it2.fixtureItemId || "".concat(_it2.rampName || "Ramp", "|").concat(_price);
    if (!rampGroups[_fid3]) rampGroups[_fid3] = {
      label: _it2.rampName || "Ramp",
      price: _price,
      qty: 0,
      fid: _it2.fixtureItemId || null
    };
    rampGroups[_fid3].qty++;
  }
  for (var _fid4 in rampGroups) {
    var _g2 = rampGroups[_fid4];
    var _inc2 = _g2.fid && incForRows[_g2.fid] ? Number(incForRows[_g2.fid]) : 0;
    var _chargeable2 = Math.max(0, _g2.qty - _inc2);
    if (_g2.price > 0 && _inc2 > 0 && _chargeable2 <= 0) {
      rows.push({
        key: "ramp:".concat(_fid4),
        label: _g2.label + " (included)",
        qty: _g2.qty,
        unit: "included",
        total: 0,
        method: "each"
      });
      continue;
    }
    if (!(_g2.price > 0)) continue; // $0 / unpriced = free, no line
    var _total2 = Math.round(_g2.price * _chargeable2 * 100) / 100;
    rows.push({
      key: "ramp:".concat(_fid4),
      label: _g2.label,
      qty: _chargeable2,
      unit: fmtMoney2(_g2.price) + " each" + (_inc2 > 0 ? " \xB7 ".concat(_inc2, " included") : ""),
      total: _total2,
      method: "each"
    });
    nonPctSubtotal += _total2;
  }
  if (rampSimplePriced && simpleRamps.length) {
    var rampPrice = Number(rampSettings.price) || 0;
    var perFt = rampSettings.method === "per_ft";
    if (rampPrice > 0) {
      if (perFt) {
        // Price per foot of the attached door's width. fixture doors carry their real width
        // (widthIn); built-in doors fall back to the ramp's stored widthFt.
        var totalFt = 0;
        var _iterator12 = _createForOfIteratorHelper(simpleRamps),
          _step12;
        try {
          var _loop3 = function _loop3() {
            var r = _step12.value;
            var door = items.find(function (d) {
              return d.id === r.snapDoorId;
            });
            var dw = Number(r.widthFt) || 0;
            if (door && door.type === "fixtureDoor" && door.widthIn) dw = Number(door.widthIn) / 12;
            totalFt += dw;
          };
          for (_iterator12.s(); !(_step12 = _iterator12.n()).done;) {
            _loop3();
          }
        } catch (err) {
          _iterator12.e(err);
        } finally {
          _iterator12.f();
        }
        totalFt = Math.round(totalFt * 100) / 100;
        if (totalFt > 0) {
          var _total3 = Math.round(rampPrice * totalFt * 100) / 100;
          rows.push({
            key: "ramp:simple",
            label: "Ramp",
            qty: totalFt,
            unit: fmtMoney2(rampPrice) + " / ft",
            total: _total3,
            method: "lineal_ft"
          });
          nonPctSubtotal += _total3;
        }
      } else {
        var _total4 = Math.round(rampPrice * simpleRamps.length * 100) / 100;
        rows.push({
          key: "ramp:simple",
          label: "Ramp",
          qty: simpleRamps.length,
          unit: fmtMoney2(rampPrice) + " each",
          total: _total4,
          method: "each"
        });
        nonPctSubtotal += _total4;
      }
    }
  }

  // Resolve pct_estimate_total rows LAST against the same base the edge function uses:
  // building (NET of declined-item credits — submit-estimate bakes them into the
  // building line BEFORE the % pass) + paint/roof + all non-% add-ons + rough
  // openings + custom options (delivery excluded, matching submit-estimate).
  if (deferred.length) {
    var roRate = (resolve("roughOpening") || {
      rate: 0
    }).rate;
    var roCount = items.filter(function (i) {
      return i.type === "roughOpening";
    }).length;
    var customTotal = (customOptions || []).reduce(function (s, co) {
      if (!co || !co.name || !String(co.name).trim()) return s;
      var amt = parseFloat(co.amount) || 0;
      var q = co.qty ? Math.abs(parseInt(co.qty, 10)) || 1 : 1; // abs: the edge bills |qty|
      // Only POSITIVE custom options are line items in the % base; negatives are
      // credits applied outside it, matching submit-estimate.
      return s + Math.max(0, amt) * q;
    }, 0);
    // Paint + roof color charges are line items too, so the % base must include
    // them exactly as submit-estimate does — otherwise the previewed % line is
    // lower than the emailed estimate.
    var selRowsForBase = computeSelectionRows(sel, paintColors, C, items);
    var selectionTaxable = selRowsForBase.filter(function (r) {
      return r.key === "paint" || r.key === "roof";
    }).reduce(function (s, r) {
      return s + (Number(r.total) || 0);
    }, 0);
    var buildingRow = selRowsForBase.find(function (r) {
      return r.key === "building";
    });
    var netBuilding = buildingRow && buildingRow.total != null ? Number(buildingRow.total) : buildingPrice;
    var base = netBuilding + selectionTaxable + nonPctSubtotal + roRate * roCount + customTotal;
    var _iterator13 = _createForOfIteratorHelper(deferred),
      _step13;
    try {
      for (_iterator13.s(); !(_step13 = _iterator13.n()).done;) {
        var d = _step13.value;
        d.row.total = d.pct / 100 * base * (d.row.qty || 1);
      } // ×count: the server bills GHL line = qty×amount, so the preview must scale by count too or it under-shows (audit #F1)
    } catch (err) {
      _iterator13.e(err);
    } finally {
      _iterator13.f();
    }
  }

  // (Declined included items are no longer shown here — they're itemized under the building line
  // by computeSelectionRows, matching the GHL estimate.)
  return {
    rows: rows
  };
}
var idCounter = 1;

// 10-char short code in format SS-XXXXXXXXXX. Alphabet drops 0/O/I/1 to avoid
// look-alikes when read aloud or shared. 32^10 ≈ 2^50 combinations — the code is
// the capability for loading/saving a design via the RPCs, so it must not be
// guessable. (Legacy 6-char codes from before the RPC data path still load fine.)
var _SHORT_ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function genShortCode() {
  var s = "";
  for (var i = 0; i < 10; i++) s += _SHORT_ALPHA[Math.floor(Math.random() * _SHORT_ALPHA.length)];
  return "SS-".concat(s);
}

// Pick readable text for a tenant-accent background: dark slate on light accents
// (mint, yellow), white on dark ones (navy, barn red). WCAG relative luminance,
// hex-only — the codebase already assumes hex accents (see the `${accent}50` shadows).
function textOnAccent(hex) {
  var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return "#FFFFFF";
  var _map = [0, 2, 4].map(function (i) {
      var c = parseInt(m[1].slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }),
    _map2 = _slicedToArray(_map, 3),
    r = _map2[0],
    g = _map2[1],
    b = _map2[2];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? "#1E293B" : "#FFFFFF";
}

// Progressive US phone formatter: "8163003600" -> "(816) 300-3600".
// Caps at 10 digits; partial inputs format as "(816", "(816) 30", etc.
// Display only — strip back to digits before sending to GHL.
function formatPhoneDisplay(v) {
  var d = (v || "").replace(/\D/g, "").slice(0, 10);
  if (d.length === 0) return "";
  if (d.length <= 3) return "(".concat(d);
  if (d.length <= 6) return "(".concat(d.slice(0, 3), ") ").concat(d.slice(3));
  return "(".concat(d.slice(0, 3), ") ").concat(d.slice(3, 6), "-").concat(d.slice(6));
}

// Lazy-load Google Maps JS API via the official inline bootstrap loader. Resolves
// to window.google. Rejects if no key. Idempotent: returns the same promise on
// subsequent calls.
//
// The bootstrap snippet (from Google's docs) synchronously installs
// window.google.maps.importLibrary, then defers the actual script download until
// importLibrary is first called. This is the only supported way to reach
// PlaceAutocompleteElement and other Places API (New) entry points; passing
// loading=async or libraries=places in the URL is NOT enough to expose
// importLibrary in practice.
// See: https://developers.google.com/maps/documentation/javascript/load-maps-js-api
var _googleMapsLoadPromise = null;
function loadGoogleMapsPlaces(apiKey) {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if (!apiKey) return Promise.reject(new Error("Google Maps API key not configured"));
  if (window.google && window.google.maps && typeof window.google.maps.importLibrary === "function") {
    return Promise.resolve(window.google);
  }
  if (_googleMapsLoadPromise) return _googleMapsLoadPromise;
  _googleMapsLoadPromise = new Promise(function (resolve, reject) {
    try {
      (function (g) {
        var h,
          a,
          k,
          p = "The Google Maps JavaScript API",
          c = "google",
          l = "importLibrary",
          q = "__ib__",
          m = document,
          b = window;
        b = b[c] || (b[c] = {});
        var d = b.maps || (b.maps = {}),
          r = new Set(),
          e = new URLSearchParams(),
          u = function u() {
            return h || (h = new Promise( /*#__PURE__*/function () {
              var _ref4 = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee(f, n) {
                var _m$querySelector;
                return _regeneratorRuntime().wrap(function _callee$(_context) {
                  while (1) switch (_context.prev = _context.next) {
                    case 0:
                      _context.next = 2;
                      return a = m.createElement("script");
                    case 2:
                      e.set("libraries", _toConsumableArray(r) + "");
                      for (k in g) e.set(k.replace(/[A-Z]/g, function (t) {
                        return "_" + t[0].toLowerCase();
                      }), g[k]);
                      e.set("callback", c + ".maps." + q);
                      a.src = "https://maps.".concat(c, "apis.com/maps/api/js?") + e;
                      d[q] = f;
                      a.onerror = function () {
                        return h = n(Error(p + " could not load."));
                      };
                      a.nonce = ((_m$querySelector = m.querySelector("script[nonce]")) === null || _m$querySelector === void 0 ? void 0 : _m$querySelector.nonce) || "";
                      m.head.append(a);
                    case 10:
                    case "end":
                      return _context.stop();
                  }
                }, _callee);
              }));
              return function (_x, _x2) {
                return _ref4.apply(this, arguments);
              };
            }()));
          };
        d[l] ? console.warn(p + " only loads once. Ignoring:", g) : d[l] = function (f) {
          for (var _len = arguments.length, n = new Array(_len > 1 ? _len - 1 : 0), _key = 1; _key < _len; _key++) {
            n[_key - 1] = arguments[_key];
          }
          return r.add(f) && u().then(function () {
            return d[l].apply(d, [f].concat(n));
          });
        };
      })({
        key: apiKey,
        v: "weekly"
      });
      resolve(window.google);
    } catch (err) {
      _googleMapsLoadPromise = null;
      reject(err);
    }
  });
  return _googleMapsLoadPromise;
}

// ─── Per-option building-style scoping ───
// An option may declare `buildingStyles: ["Urban", "Northwood"]` to limit when
// it's shown. Without that field (or with an empty array) the option always
// applies. Unrestricted options also show before any style is picked; scoped
// options hide until the user picks a style they target.
function isOptionApplicable(opt, styleValue) {
  if (!opt || !Array.isArray(opt.buildingStyles) || opt.buildingStyles.length === 0) return true;
  return !!styleValue && opt.buildingStyles.includes(styleValue);
}

// ─── MAIN COMPONENT ───
// Custom color dropdown: a native <select> can't render a color swatch per option, so this
// shows a color chip + name in the closed button and in each list row (matching the palette).
function ColorSelect(_ref5) {
  var value = _ref5.value,
    colors = _ref5.colors,
    onPick = _ref5.onPick;
  var _useState11 = useState(false),
    _useState12 = _slicedToArray(_useState11, 2),
    open = _useState12[0],
    setOpen = _useState12[1];
  var ref = useRef(null);
  useEffect(function () {
    if (!open) return;
    var h = function h(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    document.addEventListener("touchstart", h);
    return function () {
      document.removeEventListener("mousedown", h);
      document.removeEventListener("touchstart", h);
    };
  }, [open]);
  var sel = colors.find(function (c) {
    return c.label === value;
  });
  var chip = function chip(hex) {
    return /*#__PURE__*/React.createElement("span", {
      style: {
        width: 14,
        height: 14,
        borderRadius: 3,
        background: hex || "transparent",
        border: "1px solid rgba(0,0,0,0.25)",
        flexShrink: 0,
        display: "inline-block"
      }
    });
  };
  return /*#__PURE__*/React.createElement("div", {
    ref: ref,
    style: {
      position: "relative",
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: function onClick() {
      return setOpen(function (o) {
        return !o;
      });
    },
    style: {
      width: "100%",
      display: "flex",
      alignItems: "center",
      gap: 6,
      border: "1px solid #CBD5E1",
      borderRadius: 6,
      padding: "5px 8px",
      fontSize: 12,
      background: "#FFF",
      cursor: "pointer",
      color: sel ? "#334155" : "#94A3B8"
    }
  }, sel && chip(sel.hex), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      textAlign: "left",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap"
    }
  }, sel ? sel.label : "Select…"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 10,
      color: "#94A3B8"
    }
  }, "\u25BE")), open && /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      top: "calc(100% + 2px)",
      left: 0,
      right: 0,
      zIndex: 30,
      background: "#FFF",
      border: "1px solid #CBD5E1",
      borderRadius: 6,
      boxShadow: "0 6px 18px rgba(0,0,0,0.15)",
      maxHeight: 220,
      overflowY: "auto"
    }
  }, colors.map(function (c) {
    return /*#__PURE__*/React.createElement("div", {
      key: c.id || c.label,
      onClick: function onClick() {
        onPick(c.label);
        setOpen(false);
      },
      style: {
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "7px 10px",
        cursor: "pointer",
        fontSize: 12,
        background: c.label === value ? "#F1F5F9" : "#FFF",
        color: "#334155"
      }
    }, chip(c.hex), /*#__PURE__*/React.createElement("span", {
      style: {
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap"
      }
    }, c.label));
  })));
}

// Lead-capture gate shown BEFORE the designer (the customer link is a lead-gen tool).
// Collects name + phone and fires a best-effort GHL lead capture (capture-lead edge fn) the
// moment they continue. Rendered by StructureStudioInner as a body-portaled overlay when
// !gatePassed && !isAdmin && !embedded — the designer renders BEHIND it, dimmed/blurred and
// marked inert (no pointer/keyboard/focus) until the gate is passed.
// NOTE: a phone-as-login "find my saved designs" flow was intentionally deferred — it needs
// SMS/OTP verification, else a low-entropy phone could expose a customer's saved address.
function LeadGate(_ref6) {
  var config = _ref6.config,
    supabase = _ref6.supabase,
    accent = _ref6.accent,
    onPass = _ref6.onPass,
    onClose = _ref6.onClose;
  var _useState13 = useState(""),
    _useState14 = _slicedToArray(_useState13, 2),
    name = _useState14[0],
    setName = _useState14[1];
  var _useState15 = useState(""),
    _useState16 = _slicedToArray(_useState15, 2),
    phone = _useState16[0],
    setPhone = _useState16[1];
  var _useState17 = useState(false),
    _useState18 = _slicedToArray(_useState17, 2),
    busy = _useState18[0],
    setBusy = _useState18[1];
  var digits = phone.replace(/\D/g, "");
  var valid = name.trim().length > 0 && digits.length === 10;
  var brand = config && config.branding || {};
  var acc = accent || "#3D3672";
  var start = function start() {
    if (!valid || busy) return;
    setBusy(true);
    // Best-effort lead capture to the tenant's GHL — never block entry on it.
    try {
      supabase.functions.invoke("capture-lead", {
        body: {
          clientId: config.clientId,
          name: name.trim(),
          phone: phone
        }
      });
    } catch (_e) {}
    onPass({
      name: name.trim(),
      phone: phone
    });
  };
  var inp = {
    width: "100%",
    boxSizing: "border-box",
    border: "1px solid #CBD5E1",
    borderRadius: 8,
    padding: "10px 12px",
    fontSize: 14,
    margin: "4px 0 12px"
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: "fixed",
      inset: 0,
      zIndex: 9999,
      background: "rgba(15,23,42,0.42)",
      backdropFilter: "blur(2.5px)",
      WebkitBackdropFilter: "blur(2.5px)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: "relative",
      background: "#FFF",
      borderRadius: 16,
      maxWidth: 420,
      width: "100%",
      padding: 24,
      boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
      fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif"
    }
  }, onClose && /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: onClose,
    "aria-label": "Close",
    title: "Close",
    style: {
      position: "absolute",
      top: 10,
      right: 12,
      background: "transparent",
      border: "none",
      fontSize: 20,
      color: "#94A3B8",
      cursor: "pointer",
      lineHeight: 1,
      padding: 4
    }
  }, "\xD7"), brand.logo ? /*#__PURE__*/React.createElement("img", {
    src: brand.logo,
    alt: brand.companyName || "logo",
    style: {
      height: 40,
      objectFit: "contain",
      marginBottom: 12
    }
  }) : /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 800,
      fontSize: 18,
      color: acc,
      marginBottom: 12
    }
  }, brand.companyName || "Design Studio"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 20,
      fontWeight: 800,
      color: "#0F172A",
      marginBottom: 4
    }
  }, "Let's design your building"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: "#64748B",
      marginBottom: 18
    }
  }, "Enter your name and phone to get started."), /*#__PURE__*/React.createElement("label", {
    style: {
      fontSize: 12,
      fontWeight: 700,
      color: "#475569"
    }
  }, "Name"), /*#__PURE__*/React.createElement("input", {
    value: name,
    onChange: function onChange(e) {
      return setName(e.target.value);
    },
    placeholder: "Your name",
    style: inp,
    autoFocus: true
  }), /*#__PURE__*/React.createElement("label", {
    style: {
      fontSize: 12,
      fontWeight: 700,
      color: "#475569"
    }
  }, "Phone"), /*#__PURE__*/React.createElement("input", {
    type: "tel",
    inputMode: "tel",
    value: formatPhoneDisplay(phone),
    onChange: function onChange(e) {
      return setPhone(formatPhoneDisplay(e.target.value));
    },
    onKeyDown: function onKeyDown(e) {
      return e.key === "Enter" && start();
    },
    placeholder: "(555) 555-5555",
    style: _objectSpread(_objectSpread({}, inp), {}, {
      margin: "4px 0 16px"
    })
  }), /*#__PURE__*/React.createElement("button", {
    onClick: start,
    disabled: !valid || busy,
    style: {
      width: "100%",
      background: valid && !busy ? acc : "#94A3B8",
      color: "#FFF",
      border: "none",
      borderRadius: 10,
      padding: "12px",
      fontSize: 15,
      fontWeight: 700,
      cursor: valid && !busy ? "pointer" : "default"
    }
  }, busy ? "Starting…" : "Start Designing →")));
}

// Ramp placement picker (custom mode). Like DoorPicker but no swing/operation: pick a ramp
// STYLE (exact name), then its size, then place it on the door the tool was dropped near.
function RampPicker(_ref7) {
  var ramps = _ref7.ramps,
    showPricing = _ref7.showPricing,
    onCancel = _ref7.onCancel,
    onPlace = _ref7.onPlace;
  var styles = useMemo(function () {
    var m = new Map();
    ramps.forEach(function (d) {
      var k = d.name || "Ramp";
      if (!m.has(k)) m.set(k, {
        name: k,
        imageUrl: d.imageUrl || null,
        sizes: []
      });
      var g = m.get(k);
      g.sizes.push(d);
      if (!g.imageUrl && d.imageUrl) g.imageUrl = d.imageUrl;
    });
    return _toConsumableArray(m.values());
  }, [ramps]);
  var _useState19 = useState(styles.length === 1 ? styles[0] : null),
    _useState20 = _slicedToArray(_useState19, 2),
    style = _useState20[0],
    setStyle = _useState20[1];
  var _useState21 = useState(styles.length === 1 && styles[0].sizes.length === 1 ? styles[0].sizes[0] : null),
    _useState22 = _slicedToArray(_useState21, 2),
    sel = _useState22[0],
    setSel = _useState22[1];
  var pickStyle = function pickStyle(st) {
    setStyle(st);
    setSel(st.sizes.length === 1 ? st.sizes[0] : null);
  };
  var money = function money(n) {
    return "$" + Number(n).toLocaleString();
  };
  var chip = function chip(key, on, label, onClick) {
    return /*#__PURE__*/React.createElement("div", {
      key: key,
      onClick: onClick,
      style: {
        padding: "6px 14px",
        borderRadius: 20,
        fontSize: 13,
        fontWeight: 600,
        cursor: "pointer",
        border: "2px solid ".concat(on ? FIXTURE_RAMP_COLOR : "#E2E8F0"),
        background: on ? "#E0F2FE" : "#FFF",
        color: on ? "#075985" : "#334155"
      }
    }, label);
  };
  return /*#__PURE__*/React.createElement("div", {
    onClick: onCancel,
    style: {
      position: "fixed",
      inset: 0,
      background: "rgba(15,23,42,0.45)",
      zIndex: 9000,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: function onClick(e) {
      return e.stopPropagation();
    },
    style: {
      background: "#FFF",
      borderRadius: 14,
      width: "min(560px, 96vw)",
      maxHeight: "88vh",
      overflow: "auto",
      padding: 20,
      boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
      fontFamily: "system-ui, -apple-system, sans-serif"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 17,
      fontWeight: 800,
      color: "#1E293B",
      marginBottom: 4
    }
  }, "Choose a ramp"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: "#64748B",
      marginBottom: 14
    }
  }, style && style.sizes.length > 1 ? "Pick a size." : "Pick a ramp for this door."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
      gap: 10,
      marginBottom: 16
    }
  }, styles.map(function (st) {
    var on = style && style.name === st.name;
    var one = st.sizes.length === 1 ? st.sizes[0] : null;
    var sub = one ? "".concat(fmtFtIn(one.widthIn), " \xD7 ").concat(fmtFtIn(one.heightIn)).concat(showPricing && one.price != null ? " \xB7 ".concat(money(one.price)) : "") : "".concat(st.sizes.length, " sizes");
    return /*#__PURE__*/React.createElement("div", {
      key: st.name,
      onClick: function onClick() {
        return pickStyle(st);
      },
      style: {
        border: "2px solid ".concat(on ? FIXTURE_RAMP_COLOR : "#E2E8F0"),
        borderRadius: 10,
        overflow: "hidden",
        cursor: "pointer",
        background: "#FFF"
      }
    }, st.imageUrl ? /*#__PURE__*/React.createElement("img", {
      src: st.imageUrl,
      alt: "",
      style: {
        width: "100%",
        height: 90,
        objectFit: "cover",
        display: "block"
      }
    }) : /*#__PURE__*/React.createElement("div", {
      style: {
        height: 90,
        background: "#F1F5F9",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 24
      }
    }, "\u2B1B"), /*#__PURE__*/React.createElement("div", {
      style: {
        padding: "8px 10px"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 13,
        fontWeight: 700,
        color: "#1E293B"
      }
    }, st.name), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11.5,
        color: "#64748B"
      }
    }, sub)));
  })), style && style.sizes.length > 1 && /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      fontWeight: 700,
      color: "#334155",
      marginBottom: 6
    }
  }, "Size"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      flexWrap: "wrap"
    }
  }, style.sizes.map(function (d) {
    return chip(d.id, sel && sel.id === d.id, "".concat(fmtFtIn(d.widthIn), " \xD7 ").concat(fmtFtIn(d.heightIn)).concat(showPricing && d.price != null ? " \xB7 ".concat(money(d.price)) : ""), function () {
      return setSel(d);
    });
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      justifyContent: "flex-end",
      marginTop: 4
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: onCancel,
    style: {
      padding: "9px 16px",
      borderRadius: 8,
      border: "1px solid #CBD5E1",
      background: "#FFF",
      color: "#334155",
      fontWeight: 600,
      cursor: "pointer"
    }
  }, "Cancel"), /*#__PURE__*/React.createElement("button", {
    onClick: function onClick() {
      return sel && onPlace(sel);
    },
    disabled: !sel,
    style: {
      padding: "9px 18px",
      borderRadius: 8,
      border: "none",
      background: sel ? FIXTURE_RAMP_COLOR : "#CBD5E1",
      color: "#FFF",
      fontWeight: 700,
      cursor: sel ? "pointer" : "default"
    }
  }, "Place ramp"))));
}

// Window placement picker. Like RampPicker (style → size, no swing/operation), but the placed
// item goes on a wall. "Choose a window" / "Place window".
function WindowPicker(_ref8) {
  var windows = _ref8.windows,
    showPricing = _ref8.showPricing,
    onCancel = _ref8.onCancel,
    onPlace = _ref8.onPlace;
  var styles = useMemo(function () {
    var m = new Map();
    windows.forEach(function (d) {
      var k = d.name || "Window";
      if (!m.has(k)) m.set(k, {
        name: k,
        imageUrl: d.imageUrl || null,
        sizes: []
      });
      var g = m.get(k);
      g.sizes.push(d);
      if (!g.imageUrl && d.imageUrl) g.imageUrl = d.imageUrl;
    });
    return _toConsumableArray(m.values());
  }, [windows]);
  var _useState23 = useState(styles.length === 1 ? styles[0] : null),
    _useState24 = _slicedToArray(_useState23, 2),
    style = _useState24[0],
    setStyle = _useState24[1];
  var _useState25 = useState(styles.length === 1 && styles[0].sizes.length === 1 ? styles[0].sizes[0] : null),
    _useState26 = _slicedToArray(_useState25, 2),
    sel = _useState26[0],
    setSel = _useState26[1];
  var pickStyle = function pickStyle(st) {
    setStyle(st);
    setSel(st.sizes.length === 1 ? st.sizes[0] : null);
  };
  var money = function money(n) {
    return "$" + Number(n).toLocaleString();
  };
  var chip = function chip(key, on, label, onClick) {
    return /*#__PURE__*/React.createElement("div", {
      key: key,
      onClick: onClick,
      style: {
        padding: "6px 14px",
        borderRadius: 20,
        fontSize: 13,
        fontWeight: 600,
        cursor: "pointer",
        border: "2px solid ".concat(on ? FIXTURE_WINDOW_COLOR : "#E2E8F0"),
        background: on ? "#E0F2FE" : "#FFF",
        color: on ? "#075985" : "#334155"
      }
    }, label);
  };
  return /*#__PURE__*/React.createElement("div", {
    onClick: onCancel,
    style: {
      position: "fixed",
      inset: 0,
      background: "rgba(15,23,42,0.45)",
      zIndex: 9000,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: function onClick(e) {
      return e.stopPropagation();
    },
    style: {
      background: "#FFF",
      borderRadius: 14,
      width: "min(560px, 96vw)",
      maxHeight: "88vh",
      overflow: "auto",
      padding: 20,
      boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
      fontFamily: "system-ui, -apple-system, sans-serif"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 17,
      fontWeight: 800,
      color: "#1E293B",
      marginBottom: 4
    }
  }, "Choose a window"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: "#64748B",
      marginBottom: 14
    }
  }, style && style.sizes.length > 1 ? "Pick a size." : "Pick a window for this wall."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
      gap: 10,
      marginBottom: 16
    }
  }, styles.map(function (st) {
    var on = style && style.name === st.name;
    var one = st.sizes.length === 1 ? st.sizes[0] : null;
    var sub = one ? "".concat(fmtFtIn(one.widthIn), " \xD7 ").concat(fmtFtIn(one.heightIn)).concat(showPricing && one.price != null ? " \xB7 ".concat(money(one.price)) : "") : "".concat(st.sizes.length, " sizes");
    return /*#__PURE__*/React.createElement("div", {
      key: st.name,
      onClick: function onClick() {
        return pickStyle(st);
      },
      style: {
        border: "2px solid ".concat(on ? FIXTURE_WINDOW_COLOR : "#E2E8F0"),
        borderRadius: 10,
        overflow: "hidden",
        cursor: "pointer",
        background: "#FFF"
      }
    }, st.imageUrl ? /*#__PURE__*/React.createElement("img", {
      src: st.imageUrl,
      alt: "",
      style: {
        width: "100%",
        height: 90,
        objectFit: "cover",
        display: "block"
      }
    }) : /*#__PURE__*/React.createElement("div", {
      style: {
        height: 90,
        background: "#F1F5F9",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 24
      }
    }, "\uD83E\uDE9F"), /*#__PURE__*/React.createElement("div", {
      style: {
        padding: "8px 10px"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 13,
        fontWeight: 700,
        color: "#1E293B"
      }
    }, st.name), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11.5,
        color: "#64748B"
      }
    }, sub)));
  })), style && style.sizes.length > 1 && /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      fontWeight: 700,
      color: "#334155",
      marginBottom: 6
    }
  }, "Size"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      flexWrap: "wrap"
    }
  }, style.sizes.map(function (d) {
    return chip(d.id, sel && sel.id === d.id, "".concat(fmtFtIn(d.widthIn), " \xD7 ").concat(fmtFtIn(d.heightIn)).concat(showPricing && d.price != null ? " \xB7 ".concat(money(d.price)) : ""), function () {
      return setSel(d);
    });
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      justifyContent: "flex-end",
      marginTop: 4
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: onCancel,
    style: {
      padding: "9px 16px",
      borderRadius: 8,
      border: "1px solid #CBD5E1",
      background: "#FFF",
      color: "#334155",
      fontWeight: 600,
      cursor: "pointer"
    }
  }, "Cancel"), /*#__PURE__*/React.createElement("button", {
    onClick: function onClick() {
      return sel && onPlace(sel);
    },
    disabled: !sel,
    style: {
      padding: "9px 18px",
      borderRadius: 8,
      border: "none",
      background: sel ? FIXTURE_WINDOW_COLOR : "#CBD5E1",
      color: "#FFF",
      fontWeight: 700,
      cursor: sel ? "pointer" : "default"
    }
  }, "Place window"))));
}
function StructureStudioInner(_ref9) {
  var _INV_RANKS$designUnit, _INV_RANKS$designUnit2;
  var config = _ref9.config,
    _ref9$embedded = _ref9.embedded,
    embedded = _ref9$embedded === void 0 ? false : _ref9$embedded,
    _ref9$onSaved = _ref9.onSaved,
    onSaved = _ref9$onSaved === void 0 ? null : _ref9$onSaved,
    _ref9$openDesign = _ref9.openDesign,
    openDesign = _ref9$openDesign === void 0 ? null : _ref9$openDesign;
  var C = config;
  // ── Which surface is this? THE discriminator between the two mounts of this module ──
  //   embedded = true  → the Designer tab inside portal.html: business users building
  //                      quotes for customers (discounts, delivery fees, full tooling).
  //   embedded = false → the PUBLIC customer-facing page (index.html / tenant subdomains /
  //                      the "try it" link on marketing sites): anonymous shed-shoppers.
  // New surface differences gate on one of these two flags — never on a new prop, never on
  // sniffing the URL. If a feature is for the business, use `embedded`; if it is lead- or
  // customer-flavoured (contact gates, silent lead capture), use `customerFacing`.
  var customerFacing = !embedded;
  var doorFixtures = useMemo(function () {
    return (Array.isArray(C.fixtures) ? C.fixtures : []).filter(function (f) {
      return f && (f.category || "door") === "door";
    });
  }, [C.fixtures]);
  var rampFixtures = useMemo(function () {
    return (Array.isArray(C.fixtures) ? C.fixtures : []).filter(function (f) {
      return f && (f.category || "") === "ramp";
    });
  }, [C.fixtures]);
  var windowFixtures = useMemo(function () {
    return (Array.isArray(C.fixtures) ? C.fixtures : []).filter(function (f) {
      return f && (f.category || "") === "window";
    });
  }, [C.fixtures]);
  // Internal-only fixtures: the rep (embedded) designer can place them, but the customer-facing page
  // must NOT offer them as placement options. These "placeable" lists drive the PICKERS + picker
  // buttons only; the full memos above still feed isArchivedItem / swap / render so an already-placed
  // internal-only fixture keeps rendering for the customer and never reads as archived.
  var placeableDoors = customerFacing ? doorFixtures.filter(function (f) {
    return !f.internalOnly;
  }) : doorFixtures;
  var placeableRamps = customerFacing ? rampFixtures.filter(function (f) {
    return !f.internalOnly;
  }) : rampFixtures;
  var placeableWindows = customerFacing ? windowFixtures.filter(function (f) {
    return !f.internalOnly;
  }) : windowFixtures;
  // Ramp is self-contained now (SIMPLE_RAMP_CFG), driven by the Ramp settings — NOT the built-in
  // `ramp` layout item. Custom mode → the ramp picker (catalog styles); simple mode + offered → the
  // simple ramp tool; otherwise render-only (old ramps still draw, but no new placement).
  var rampMode = C.rampSettings && C.rampSettings.mode || "simple";
  var rampEnabled = !!(C.rampSettings && C.rampSettings.enabled);
  var rampCustom = rampMode === "custom" && placeableRamps.length > 0;
  var _useState27 = useState(function () {
      var init = {
        style: "",
        size: "",
        roofType: "",
        roofColor: ""
      };
      C.options.forEach(function (o) {
        init[o.id] = o.type === "counter" ? o.options[0] : "";
      });
      return init;
    }),
    _useState28 = _slicedToArray(_useState27, 2),
    sel = _useState28[0],
    setSel = _useState28[1];
  // Catalog fixtures the current size INCLUDES → a placement tool keyed by the fixture id. Each
  // renders in the "included — place or decline" row and, when armed, drops that EXACT fixture on
  // the next wall click (doors/windows) or door (ramps). Empty until a style+size is chosen; the
  // built-in door/window/ramp keep their own catalog pickers.
  var includedFixtureTools = function () {
    var out = {};
    if (!sel.style || !sel.size) return out;
    var st = (C.buildingStyles || []).find(function (s) {
      return s.value === sel.style;
    });
    if (!st) return out;
    var pickInc = function pickInc(map) {
      if (!map || _typeof(map) !== "object") return null;
      if (map[sel.size] != null) return map[sel.size];
      var want = normSizeLabel(sel.size);
      for (var k in map) {
        if (normSizeLabel(k) === want) return map[k];
      }
      return null;
    };
    var qmap = pickInc(st.sizeInclusionQty);
    if (!qmap || _typeof(qmap) !== "object" || Array.isArray(qmap)) {
      var arr = pickInc(st.sizeInclusions);
      qmap = {};
      if (Array.isArray(arr)) arr.forEach(function (k) {
        qmap[k] = 1;
      });
    }
    var fixtures = Array.isArray(C.fixtures) ? C.fixtures : [];
    var _loop4 = function _loop4(k) {
        var fx = fixtures.find(function (f) {
          return String(f.id) === k;
        });
        if (!fx) return 0; // continue
        // built-in keys (loft etc.) are handled by their own ITEMS entry
        if (customerFacing && fx.internalOnly) return 0; // continue
        // internal-only: rep can place it, customer can't add/decline it
        var cat = fx.category || "door";
        out[k] = {
          label: fx.name || "Item",
          color: cat === "window" ? FIXTURE_WINDOW_COLOR : cat === "ramp" ? FIXTURE_RAMP_COLOR : FIXTURE_DOOR_COLOR,
          icon: cat === "window" ? "🪟" : cat === "ramp" ? "⬛" : "🚪",
          shortLabel: fx.planLabel && String(fx.planLabel).trim() || (fx.name || "ITEM").toUpperCase().slice(0, 4),
          wallOnly: cat !== "ramp",
          doorSnap: cat === "ramp",
          width: (Number(fx.widthIn) || 36) / 12,
          height: 0.5,
          includedFixture: _objectSpread({}, fx) // placement marker: drop THIS specific fixture
        };
      },
      _ret3;
    for (var k in qmap) {
      _ret3 = _loop4(k);
      if (_ret3 === 0) continue;
    }
    return out;
  }();
  var ITEMS = _objectSpread(_objectSpread(_objectSpread(_objectSpread(_objectSpread(_objectSpread(_objectSpread({}, LEGACY_LAYOUT_FALLBACK), C.layoutItems), BUILT_IN_TOOLS), {}, {
    fixtureDoor: FIXTURE_DOOR_CFG
  }, placeableDoors.length ? {
    doorPicker: DOOR_PICKER_CFG
  } : {}), rampCustom ? {
    rampPicker: RAMP_PICKER_CFG
  } : {}), {}, {
    // Ramp is ALWAYS the self-contained SIMPLE_RAMP_CFG (overrides any built-in `ramp` layout item),
    // so every placed ramp renders. Placeable only when the tenant offers a SIMPLE ramp; custom mode
    // and not-offered are render-only (the picker handles custom placement).
    ramp: _objectSpread(_objectSpread({}, SIMPLE_RAMP_CFG), {}, {
      noPalette: !(rampMode === "simple" && rampEnabled)
    })
  }, placeableWindows.length ? {
    windowPicker: WINDOW_PICKER_CFG
  } : {}), includedFixtureTools);
  var _useState29 = useState(null),
    _useState30 = _slicedToArray(_useState29, 2),
    swapId = _useState30[0],
    setSwapId = _useState30[1]; // id of a placed catalog fixture being SWAPPED to another
  var _useState31 = useState(null),
    _useState32 = _slicedToArray(_useState31, 2),
    doorPick = _useState32[0],
    setDoorPick = _useState32[1]; // { wall, ptx, pty } while the door picker modal is open
  var _useState33 = useState(null),
    _useState34 = _slicedToArray(_useState33, 2),
    rampPick = _useState34[0],
    setRampPick = _useState34[1]; // { door } while the ramp picker modal is open
  var _useState35 = useState(null),
    _useState36 = _slicedToArray(_useState35, 2),
    windowPick = _useState36[0],
    setWindowPick = _useState36[1]; // { wall, ptx, pty } while the window picker modal is open
  // A PLACED item is "archived" (option retired) if: a catalog fixture whose fixture is no longer
  // in the active list (get_fixtures drops archived), or a built-in whose layoutItems cfg is flagged
  // archived (get_config keeps it, noPalette+archived). Archived items still render on the design;
  // the rep is nudged to Swap them for a current option. Never blocks rendering.
  var isArchivedItem = function isArchivedItem(it) {
    if (!it) return false;
    if (it.fixtureItemId) {
      var pool = it.type === "window" ? windowFixtures : it.type === "ramp" ? rampFixtures : doorFixtures;
      return !pool.some(function (f) {
        return String(f.id) === String(it.fixtureItemId);
      });
    }
    var c = ITEMS[it.type];
    return !!(c && c.archived);
  };
  var accent = C.branding.accentColor || "#D97706";
  // White-label initials for the logo placeholder shown when no logo is set.
  var initials = (C.branding.companyName || "").split(" ").filter(Boolean).slice(0, 2).map(function (w) {
    return w[0];
  }).join("").toUpperCase() || "SS";
  // Admin gate: ?admin=1 surfaces the GHL credentials panel. The credentials never
  // round-trip through the browser — admin types them in, the Edge Function stores
  // them in Supabase, and customers' browsers never see them.
  // Never true when embedded: the URL is the HOST page's (the portal), and
  // /portal.html?admin=1 must not surface the operator panel inside a tenant portal.
  var isAdmin = useMemo(function () {
    if (embedded) return false;
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("admin") === "1";
  }, [embedded]);

  // Options the user currently sees. Options without scoping are always in the
  // list; scoped options join/leave as the user picks/changes building style.
  var visibleOptions = useMemo(function () {
    return C.options.filter(function (o) {
      return isOptionApplicable(o, sel.style);
    });
  }, [C.options, sel.style]);

  // Roof colors come from the same palette (shingle/metal flags). A roof type is only offered
  // when the tenant has >=1 active color in it; roof pricing is the chosen color's rate
  // (server-side), exactly like paint. Empty until the owner adds roof colors in the portal.
  var roofColorsFor = function roofColorsFor(type) {
    var list = Array.isArray(C.colors) ? C.colors : [];
    return type === "Shingle" ? list.filter(function (c) {
      return c.shingle;
    }) : type === "Metal" ? list.filter(function (c) {
      return c.metal;
    }) : [];
  };
  var roofTypes = ["Shingle", "Metal"].filter(function (t) {
    return roofColorsFor(t).length > 0;
  });
  // The paint option renders inline beside the Roof Options (same row), not in
  // the option list below — see the Size/Roof/Paint row and renderPaintFields.
  var paintOpt = visibleOptions.find(function (o) {
    return o.type === "counter" && o.id === "paint";
  }) || null;

  // When the building style changes, snap any now-inapplicable option back to
  // its default so a stale "Painted" (etc.) selection can't be silently sent
  // along in the submit payload.
  useEffect(function () {
    setSel(function (prev) {
      var changed = false;
      var next = _objectSpread({}, prev);
      C.options.forEach(function (opt) {
        if (isOptionApplicable(opt, prev.style)) return;
        var def = opt.type === "counter" ? opt.options[0] : "";
        if (next[opt.id] !== def) {
          next[opt.id] = def;
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [sel.style, C.options]);

  // Phase 4a: which placeable items are INCLUDED (free) with the selected
  // style+size — from get_config's per-style sizeInclusions map. Everything else
  // is an "additional" (chargeable) option. Empty until a style+size is chosen.
  // includedItemQty maps item key -> included quantity (loft = sq ft, doors = count)
  // from the parallel sizeInclusionQty map; configs predating migration 039 fall
  // back to quantity 1 per included key.
  var includedItemQty = useMemo(function () {
    if (!sel.style || !sel.size) return {};
    var st = C.buildingStyles.find(function (s) {
      return s.value === sel.style;
    });
    if (!st) return {};
    // Size labels can drift between "12x16" and "12×16" (CSV rewrite vs. saved design),
    // so fall back to a normalized-label match like the sizePricing lookup does.
    var pick = function pick(map) {
      if (!map || _typeof(map) !== "object") return null;
      if (map[sel.size] != null) return map[sel.size];
      var want = normSizeLabel(sel.size);
      for (var k in map) {
        if (normSizeLabel(k) === want) return map[k];
      }
      return null;
    };
    var qmap = pick(st.sizeInclusionQty);
    if (qmap && _typeof(qmap) === "object" && !Array.isArray(qmap)) {
      var _out = {};
      for (var k in qmap) _out[k] = Math.max(1, Number(qmap[k]) || 1);
      return _out;
    }
    var arr = pick(st.sizeInclusions);
    var out = {};
    if (Array.isArray(arr)) {
      var _iterator14 = _createForOfIteratorHelper(arr),
        _step14;
      try {
        for (_iterator14.s(); !(_step14 = _iterator14.n()).done;) {
          var _k7 = _step14.value;
          out[_k7] = 1;
        }
      } catch (err) {
        _iterator14.e(err);
      } finally {
        _iterator14.f();
      }
    }
    return out;
  }, [sel.style, sel.size, C.buildingStyles]);
  var includedItemKeys = useMemo(function () {
    return Object.keys(includedItemQty);
  }, [includedItemQty]);
  var _useState37 = useState({
      name: "",
      phone: "",
      email: "",
      street: "",
      city: "",
      state: "",
      zip: ""
    }),
    _useState38 = _slicedToArray(_useState37, 2),
    contact = _useState38[0],
    setContact = _useState38[1];
  // Lead-capture gate: shoppers give name + phone before designing (the customer link is a
  // lead-gen tool). Bypassed for a returning shopper arriving via a saved-design link (?id=,
  // which loads their contact), the operator preview (?admin=1), and once remembered in this
  // browser. See <LeadGate/> rendered at the top of the return.
  var _useState39 = useState(function () {
      try {
        var params = new URLSearchParams(location.search);
        if (params.get("id") || params.get("admin") === "1") return true;
        if (localStorage.getItem("ss_gate_" + (C.clientId || ""))) return true;
      } catch (_e) {}
      return false;
    }),
    _useState40 = _slicedToArray(_useState39, 2),
    gatePassed = _useState40[0],
    setGatePassed = _useState40[1];
  // Default each side to the tenant's default palette color (e.g. "Unpainted"); a saved
  // design overrides this from design.paint_colors on load.
  var _useState41 = useState(function () {
      var list = Array.isArray(C.colors) ? C.colors : [];
      var dflt = function dflt(k) {
        var d = list.find(function (c) {
          return (k === "body" ? c.siding : c.trim) && c.isDefault;
        });
        return d ? d.label : "";
      };
      return {
        body: dflt("body"),
        trim: dflt("trim")
      };
    }),
    _useState42 = _slicedToArray(_useState41, 2),
    paintColors = _useState42[0],
    setPaintColors = _useState42[1];
  // Tracks when the shopper picked an "allow custom" color and is typing an exact value
  // (so the custom text box stays open even while paintColors.body/trim is momentarily "").
  var _useState43 = useState({
      body: false,
      trim: false
    }),
    _useState44 = _slicedToArray(_useState43, 2),
    paintCustom = _useState44[0],
    setPaintCustom = _useState44[1];
  // Roof: type (Shingle/Metal) + color live in `sel` (saved with the design); this tracks the
  // transient "typing a custom roof color" state, same as paintCustom.
  var _useState45 = useState(false),
    _useState46 = _slicedToArray(_useState45, 2),
    roofCustom = _useState46[0],
    setRoofCustom = _useState46[1];
  var _useState47 = useState([]),
    _useState48 = _slicedToArray(_useState47, 2),
    customOptions = _useState48[0],
    setCustomOptions = _useState48[1];
  var _useState49 = useState({}),
    _useState50 = _slicedToArray(_useState49, 2),
    roDimensions = _useState50[0],
    setRoDimensions = _useState50[1];
  var _useState51 = useState(10),
    _useState52 = _slicedToArray(_useState51, 2),
    bldgW = _useState52[0],
    setShedW = _useState52[1];
  var _useState53 = useState(12),
    _useState54 = _slicedToArray(_useState53, 2),
    bldgH = _useState54[0],
    setShedH = _useState54[1];
  var _useState55 = useState(null),
    _useState56 = _slicedToArray(_useState55, 2),
    activeTool = _useState56[0],
    setActiveTool = _useState56[1];
  var _useState57 = useState([]),
    _useState58 = _slicedToArray(_useState57, 2),
    items = _useState58[0],
    setItems = _useState58[1];
  var _useState59 = useState(null),
    _useState60 = _slicedToArray(_useState59, 2),
    selectedId = _useState60[0],
    setSelectedId = _useState60[1];
  var _useState61 = useState(null),
    _useState62 = _slicedToArray(_useState61, 2),
    editingNoteId = _useState62[0],
    setEditingNoteId = _useState62[1]; // note being typed in-place on the canvas
  // Pick-one-to-remove mode ({ type }): entered from a Details row's × when several
  // "each"-priced items of that type are placed — the plan highlights them and the
  // rest of the page is blocked until the user clicks one (or cancels).
  var _useState63 = useState(null),
    _useState64 = _slicedToArray(_useState63, 2),
    pendingRemoval = _useState64[0],
    setPendingRemoval = _useState64[1];
  // "+ Add Delivery Fee" clicked — shows the delivery row before a value is typed.
  var _useState65 = useState(false),
    _useState66 = _slicedToArray(_useState65, 2),
    deliveryOpen = _useState66[0],
    setDeliveryOpen = _useState66[1];
  useEffect(function () {
    // Reopened designs restore sel.deliveryFee without deliveryOpen; latch the row
    // open so clearing the amount mid-edit doesn't unmount the input underneath the
    // user (only the row's × closes it).
    if (!deliveryOpen && String(sel.deliveryFee || "") !== "") setDeliveryOpen(true);
  }, [deliveryOpen, sel.deliveryFee]);
  useEffect(function () {
    if (!pendingRemoval) return;
    // ESC cancels. Every other key is swallowed in the capture phase: the scrim only
    // blocks POINTERS, so without this Tab+Enter could still fire buttons underneath
    // it (another row's ×, even Get Quote) while the page looks blocked.
    var onKey = function onKey(e) {
      if (e.key === "Escape") {
        setPendingRemoval(null);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return function () {
      return window.removeEventListener("keydown", onKey, true);
    };
  }, [pendingRemoval]);
  useEffect(function () {
    // Auto-exit pick mode if the last item of the target type disappears.
    if (pendingRemoval && !items.some(function (i) {
      return i.type === pendingRemoval.type;
    })) setPendingRemoval(null);
  }, [items, pendingRemoval]);
  var _useState67 = useState(null),
    _useState68 = _slicedToArray(_useState67, 2),
    dragging = _useState68[0],
    setDragging = _useState68[1];
  var _useState69 = useState(null),
    _useState70 = _slicedToArray(_useState69, 2),
    resizing = _useState70[0],
    setResizing = _useState70[1];
  var _useState71 = useState(false),
    _useState72 = _slicedToArray(_useState71, 2),
    showExport = _useState72[0],
    setShowExport = _useState72[1];
  var _useState73 = useState(null),
    _useState74 = _slicedToArray(_useState73, 2),
    exportUrl = _useState74[0],
    setExportUrl = _useState74[1];
  var _useState75 = useState(false),
    _useState76 = _slicedToArray(_useState75, 2),
    submitting = _useState76[0],
    setSubmitting = _useState76[1];
  var _useState77 = useState(false),
    _useState78 = _slicedToArray(_useState77, 2),
    submitted = _useState78[0],
    setSubmitted = _useState78[1];
  var _useState79 = useState(null),
    _useState80 = _slicedToArray(_useState79, 2),
    submitError = _useState80[0],
    setSubmitError = _useState80[1];
  // After a successful save, holds { code, viewUrl, imageUrl } for the success screen
  var _useState81 = useState(null),
    _useState82 = _slicedToArray(_useState81, 2),
    savedDesign = _useState82[0],
    setSavedDesign = _useState82[1];
  // Current design's short code (set when a design is loaded or saved). Drives the
  // "all designs on this estimate" version list shown in the editor + success screen.
  var _useState83 = useState(null),
    _useState84 = _slicedToArray(_useState83, 2),
    designCode = _useState84[0],
    setDesignCode = _useState84[1];
  // All versions of the current design (this estimate), newest first.
  var _useState85 = useState([]),
    _useState86 = _slicedToArray(_useState85, 2),
    estimateVersions = _useState86[0],
    setEstimateVersions = _useState86[1];
  // Which version is currently loaded in the editor (null = the latest). Marks "Viewing".
  var _useState87 = useState(null),
    _useState88 = _slicedToArray(_useState87, 2),
    viewingVersion = _useState88[0],
    setViewingVersion = _useState88[1];
  // Whether the "all designs on this estimate" dropdown is expanded (collapsed by default).
  var _useState89 = useState(false),
    _useState90 = _slicedToArray(_useState89, 2),
    versionsOpen = _useState90[0],
    setVersionsOpen = _useState90[1];
  // "Additional options" (custom line items) is collapsed by default behind a subtle toggle.
  var _useState91 = useState(false),
    _useState92 = _slicedToArray(_useState91, 2),
    additionalOpen = _useState92[0],
    setAdditionalOpen = _useState92[1];
  // Every enabled contact field filled, phone a real 10 digits — the same bar submitQuote
  // enforces. Drives the public Details gate: a shopper sees quote details only after
  // giving full contact info (which is what makes them a capturable lead).
  var contactComplete = useMemo(function () {
    var req = ["name", "email", "phone", "street", "city", "state", "zip"].filter(function (f) {
      return C.contactFields.includes(f);
    });
    if (req.some(function (f) {
      return !String(contact[f] || "").trim();
    })) return false;
    if (C.contactFields.includes("phone") && String(contact.phone || "").replace(/\D/g, "").length !== 10) return false;
    return true;
  }, [contact, C.contactFields]);
  // The public Details section is locked until the contact form is complete. Content is
  // ALSO gated on this (not just the click), so emptying a field after opening re-locks
  // the details instead of leaving prices on screen behind a stale open state.
  var detailsLocked = customerFacing && !contactComplete;
  // Silent lead save, once per page load, the first time a shopper opens Details: they
  // have just typed full contact info and asked to see prices — that IS a lead, even if
  // they never press submit. Best-effort fire-and-forget (capture-lead validates and
  // upserts into the tenant's GHL); it must never block or break the designer.
  var leadCapturedRef = useRef(false);
  var captureLeadSilently = function captureLeadSilently() {
    if (!customerFacing || leadCapturedRef.current || !contactComplete) return;
    leadCapturedRef.current = true;
    try {
      supabase.functions.invoke("capture-lead", {
        body: {
          clientId: C.clientId,
          source: "details",
          // vs the gate's default — "asked for prices" ranks higher
          name: String(contact.name || "").trim(),
          phone: String(contact.phone || "").trim(),
          email: String(contact.email || "").trim(),
          street: String(contact.street || "").trim(),
          city: String(contact.city || "").trim(),
          state: String(contact.state || "").trim(),
          zip: String(contact.zip || "").trim()
        }
      });
    } catch (_e) {/* lead capture must never break the designer */}
  };
  // Draft-design capture (migration 063). The same Details-open moment that captures the
  // lead also saves WHAT they designed, as a status='draft' designs row — so the portal
  // can open a browsing lead's actual floor plan even though they never pressed submit.
  // A later real submit reuses the same short_code (currentDesignIdRef) and save_design
  // promotes the row to 'sent'. Silent and best-effort like the lead capture: no PDF is
  // rendered, no URL is rewritten, nothing changes for the visitor.
  var draftStateRef = useRef(null); // JSON of the last draft-saved payload (skip no-op re-saves)
  var isDraftRef = useRef(false); // the row behind currentDesignIdRef is a draft, safe to re-save
  var saveDraftSilently = function saveDraftSilently() {
    if (!customerFacing || !supabase) return;
    // Never write over a row we didn't create as a draft: someone re-opening a SUBMITTED
    // design from a share link must not have it silently rewritten by browsing further.
    if (currentDesignIdRef.current && !isDraftRef.current) return;
    if (!sel.style && !sel.size && items.length === 0) return; // nothing designed yet
    var body = {
      p_contact: contact,
      p_selections: sel,
      p_paint_colors: paintColors,
      p_items: items,
      p_custom_options: customOptions,
      p_ro_dimensions: roDimensions,
      p_bldg_w: bldgW,
      p_bldg_h: bldgH
    };
    var snapshot = JSON.stringify(body);
    if (snapshot === draftStateRef.current) return; // unchanged since the last draft save
    var code = currentDesignIdRef.current || genShortCode();
    _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee2() {
      var _yield$supabase$rpc, error;
      return _regeneratorRuntime().wrap(function _callee2$(_context2) {
        while (1) switch (_context2.prev = _context2.next) {
          case 0:
            _context2.prev = 0;
            _context2.next = 3;
            return supabase.rpc("save_design", _objectSpread(_objectSpread({
              p_code: code,
              p_client_id: C.clientId
            }, body), {}, {
              p_image_url: null,
              // drafts carry no PDF; save_design preserves any existing one
              p_status: "draft" // the ONLY status the RPC accepts from an anon caller
            }));
          case 3:
            _yield$supabase$rpc = _context2.sent;
            error = _yield$supabase$rpc.error;
            if (!error) {
              _context2.next = 7;
              break;
            }
            return _context2.abrupt("return");
          case 7:
            // best-effort: a failed draft save is invisible by design
            currentDesignIdRef.current = code;
            isDraftRef.current = true;
            draftStateRef.current = snapshot;
            _context2.next = 14;
            break;
          case 12:
            _context2.prev = 12;
            _context2.t0 = _context2["catch"](0);
          case 14:
          case "end":
            return _context2.stop();
        }
      }, _callee2, null, [[0, 12]]);
    }))();
  };
  // ─── Inventory (migration 075) — embedded-only ───
  // inventoryUnitRef: the unit a "Send estimate" flow came from; the submit success path
  // links the new design back to it. inventoryMaster: non-null while an inventory MASTER
  // design (status='inventory') is open — submit is blocked (a master must never become a
  // customer estimate) and the save button flips to "Update Inventory Building".
  var inventoryUnitRef = useRef(null);
  // The inventory unit an ALREADY-SAVED design was quoted from (designs.inventory_unit_id,
  // read at load). Distinct from inventoryUnitRef, which arms a not-yet-submitted
  // send-estimate flow — this one survives reopening the estimate later.
  var _useState93 = useState(null),
    _useState94 = _slicedToArray(_useState93, 2),
    designUnit = _useState94[0],
    setDesignUnit = _useState94[1]; // { id, serial, lifecycle } | null
  // Staff chose "Design a new build instead" on a locked estimate: the plan unlocks and
  // the next submit saves a NEW version that is no longer tied to the unit.
  var _useState95 = useState(false),
    _useState96 = _slicedToArray(_useState95, 2),
    newBuildMode = _useState96[0],
    setNewBuildMode = _useState96[1];
  var _useState97 = useState(null),
    _useState98 = _slicedToArray(_useState97, 2),
    inventoryMaster = _useState98[0],
    setInventoryMaster = _useState98[1]; // { code, unitId, priceCents, locationId } | null
  var _useState99 = useState(null),
    _useState100 = _slicedToArray(_useState99, 2),
    invDialog = _useState100[0],
    setInvDialog = _useState100[1]; // { busy, err, price, done } | null — price/confirm only (location is inline now)
  // The inventory Save bar (inline location dropdown + button) appears ONLY for a NEW inventory
  // build ("+ New inventory building" → openDesign.blank) or an OPENED inventory master — never on
  // an ordinary customer design. Location is chosen inline, beside the Save button.
  var _useState101 = useState(false),
    _useState102 = _slicedToArray(_useState101, 2),
    inventoryNew = _useState102[0],
    setInventoryNew = _useState102[1];
  var _useState103 = useState([]),
    _useState104 = _slicedToArray(_useState103, 2),
    invLocations = _useState104[0],
    setInvLocations = _useState104[1]; // [{id, name, city}]
  var _useState105 = useState(""),
    _useState106 = _slicedToArray(_useState105, 2),
    invLocationId = _useState106[0],
    setInvLocationId = _useState106[1]; // where this building sits
  var invLocLoadedRef = useRef(false);
  // PLAN LOCK (Carolyn, 2026-08-02): "Building is BUILT". An estimate for an inventory
  // building describes a structure that already physically exists, so its floor plan,
  // size, style, roof and colours are not negotiable — only the money lines are (custom
  // options, discount, delivery). Applies to the send-estimate flow AND to reopening that
  // estimate later, on the public share link too. NEVER applies to the inventory MASTER
  // itself (that is the builder editing their own building via "Update Inventory
  // Building"), and staff can lift it deliberately with "Design a new build instead".
  //
  // …but only once the building actually EXISTS (migration 102). A unit can now be sold
  // while it is still Requested or in the build queue, and locking those would mean the buyer
  // of a building that has not been cut yet cannot change anything about it — the opposite of
  // what a pre-build sale is for. So the lock keys on the ladder, not on the mere existence
  // of a link. UNKNOWN FAILS TOWARD LOCKED: that is today's behaviour, so this can only ever
  // loosen where we are sure. (Seven rungs since migration 105 — `accepted` retired; the
  // built rank is 3 — see _shared/inventoryLifecycle.ts, which owns the ladder.)
  var INV_BUILT_RANK = 3;
  var INV_RANKS = {
    requested: 0,
    in_queue: 1,
    scheduled_build: 2,
    built: 3,
    scheduled_delivery: 4,
    at_location: 5,
    delivered: 6
  };
  var unitIsBuilt = !designUnit || !designUnit.lifecycle || ((_INV_RANKS$designUnit = INV_RANKS[designUnit.lifecycle]) !== null && _INV_RANKS$designUnit !== void 0 ? _INV_RANKS$designUnit : INV_BUILT_RANK) >= INV_BUILT_RANK;
  var planLocked = Boolean((inventoryUnitRef.current || designUnit) && !inventoryMaster && !newBuildMode && unitIsBuilt);
  // The canvas handlers are useCallbacks with their own dep arrays — reading the lock
  // through a ref keeps them from capturing a stale value (and from re-creating on every
  // lock change). Assigned during render on purpose: a useEffect sync would lag one
  // render, and one render is long enough to drag an item on a building that is built.
  var planLockedRef = useRef(false);
  planLockedRef.current = planLocked;
  // The pre-tax building total, mirroring the Details subtotal WITHOUT the customer-
  // specific lines (delivery, discounts) — an asking price describes the building alone.
  var inventoryQuotePrefill = function inventoryQuotePrefill() {
    try {
      var selRows = computeSelectionRows(sel, paintColors, C, items);
      var priceRows = C.showPricing ? computeLayoutPricingRows(items, sel, customOptions, C, paintColors).rows : [];
      var roList = items.filter(function (i) {
        return i.type === "roughOpening";
      });
      var lp = C.layoutPricing && C.layoutPricing.roughOpening;
      var ov = lp && lp.byStyle && sel.style ? lp.byStyle[sel.style] : null;
      var roRate = lp ? Number(ov && ov.rate != null ? ov.rate : lp.rate) || 0 : 0;
      var customTotal = (customOptions || []).reduce(function (s, r) {
        var amt = Math.max(0, parseFloat(r && r.amount) || 0);
        var q = r && r.qty ? Math.abs(parseInt(r.qty, 10)) || 1 : 1;
        return s + amt * q;
      }, 0);
      return Math.max(0, selRows.reduce(function (s, r) {
        return s + (Number(r.total) || 0);
      }, 0) + priceRows.reduce(function (s, r) {
        return s + (Number(r.total) || 0);
      }, 0) + (C.showPricing ? roList.length * roRate : 0) + customTotal);
    } catch (_e) {
      return 0;
    }
  };
  // Load the tenant's locations once we enter an inventory context (new build or opened master),
  // so the inline location dropdown by the Save button is ready. targetClientId names the tenant
  // explicitly — the component's supabase client lacks portal.html's operator view-as injection.
  useEffect(function () {
    if (!embedded || !supabase || invLocLoadedRef.current) return;
    if (!(inventoryNew || inventoryMaster)) return;
    invLocLoadedRef.current = true;
    _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee3() {
      var _yield$supabase$funct, data;
      return _regeneratorRuntime().wrap(function _callee3$(_context3) {
        while (1) switch (_context3.prev = _context3.next) {
          case 0:
            _context3.prev = 0;
            _context3.next = 3;
            return supabase.functions.invoke("portal-settings", {
              body: {
                action: "list_locations",
                targetClientId: C.clientId
              }
            });
          case 3:
            _yield$supabase$funct = _context3.sent;
            data = _yield$supabase$funct.data;
            if (data && Array.isArray(data.locations)) setInvLocations(data.locations);
            _context3.next = 10;
            break;
          case 8:
            _context3.prev = 8;
            _context3.t0 = _context3["catch"](0);
          case 10:
          case "end":
            return _context3.stop();
        }
      }, _callee3, null, [[0, 8]]);
    }))();
  }, [embedded, supabase, inventoryNew, inventoryMaster, C.clientId]);
  var openInventoryDialog = function openInventoryDialog() {
    if (!sel.style || !sel.size) {
      setSubmitError("Pick a Building Style and Size before saving to inventory.");
      return;
    }
    setSubmitError(null);
    var isUpdate = Boolean(inventoryMaster && inventoryMaster.unitId);
    var prefill = isUpdate && inventoryMaster.priceCents != null ? inventoryMaster.priceCents / 100 : inventoryQuotePrefill();
    // Location is chosen on the inline dropdown beside the Save button; this dialog only confirms price.
    setInvDialog({
      busy: false,
      err: null,
      price: prefill > 0 ? String(Math.round(prefill * 100) / 100) : "",
      done: null
    });
  };
  var saveInventory = /*#__PURE__*/function () {
    var _ref12 = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee4() {
      var _invDialog$price, isUpdate, code, imageUrl, canvas, jpegDataUrl, jpegBin, jpegBytes, i, blob, filePath, up, priceStr, askingPriceCents, n, _yield$supabase$funct2, data, error, m, b;
      return _regeneratorRuntime().wrap(function _callee4$(_context4) {
        while (1) switch (_context4.prev = _context4.next) {
          case 0:
            if (!(!invDialog || invDialog.busy)) {
              _context4.next = 2;
              break;
            }
            return _context4.abrupt("return");
          case 2:
            setInvDialog(function (d) {
              return _objectSpread(_objectSpread({}, d), {}, {
                busy: true,
                err: null
              });
            });
            _context4.prev = 3;
            isUpdate = Boolean(inventoryMaster && inventoryMaster.unitId);
            code = isUpdate ? inventoryMaster.code : genShortCode(); // Render + upload the plan PDF — the same steps submitQuote runs, deliberately
            // duplicated rather than extracted: refactoring the money path for a reuse win
            // is a bad trade. Best-effort: an upload failure must not lose the unit.
            imageUrl = null;
            _context4.prev = 7;
            canvas = renderExportCanvas();
            jpegDataUrl = canvas.toDataURL("image/jpeg", 0.92);
            jpegBin = atob(jpegDataUrl.split(",")[1]);
            jpegBytes = new Uint8Array(jpegBin.length);
            for (i = 0; i < jpegBin.length; i++) jpegBytes[i] = jpegBin.charCodeAt(i);
            blob = buildPdfFromJpegBytes(jpegBytes, canvas.width, canvas.height);
            filePath = "".concat(C.clientId, "/").concat(code, "-").concat(Date.now(), ".pdf");
            _context4.next = 17;
            return supabase.storage.from("floor-plans").upload(filePath, blob, {
              upsert: false,
              contentType: "application/pdf",
              cacheControl: "0"
            });
          case 17:
            up = _context4.sent;
            if (!up.error) imageUrl = supabase.storage.from("floor-plans").getPublicUrl(filePath).data.publicUrl;
            _context4.next = 23;
            break;
          case 21:
            _context4.prev = 21;
            _context4.t0 = _context4["catch"](7);
          case 23:
            // A typo must never become $0 on the lot. `Number("12,5o0")` is NaN, and the old
            // `|| 0` turned that into a building publicly listed at $0.
            priceStr = String((_invDialog$price = invDialog.price) !== null && _invDialog$price !== void 0 ? _invDialog$price : "").replace(/[$,\s]/g, "");
            askingPriceCents = null;
            if (!(priceStr !== "")) {
              _context4.next = 31;
              break;
            }
            n = Number(priceStr);
            if (!(!Number.isFinite(n) || n < 0)) {
              _context4.next = 30;
              break;
            }
            setInvDialog(function (d) {
              return d && _objectSpread(_objectSpread({}, d), {}, {
                busy: false,
                err: "Enter the asking price as a number, e.g. 8950 — or leave it blank."
              });
            });
            return _context4.abrupt("return");
          case 30:
            askingPriceCents = Math.round(n * 100);
          case 31:
            _context4.next = 33;
            return supabase.functions.invoke("portal-settings", {
              body: _objectSpread(_objectSpread({
                action: "save_inventory",
                targetClientId: C.clientId
              }, isUpdate ? {
                unitId: inventoryMaster.unitId
              } : {
                shortCode: code
              }), {}, {
                imageUrl: imageUrl,
                askingPriceCents: askingPriceCents,
                locationId: invLocationId || null,
                selections: sel,
                paintColors: paintColors,
                items: items,
                customOptions: customOptions,
                roDimensions: roDimensions,
                bldgW: bldgW,
                bldgH: bldgH
              })
            });
          case 33:
            _yield$supabase$funct2 = _context4.sent;
            data = _yield$supabase$funct2.data;
            error = _yield$supabase$funct2.error;
            if (!error) {
              _context4.next = 48;
              break;
            }
            m = "Save failed — try again.";
            _context4.prev = 38;
            _context4.next = 41;
            return error.context.clone().json();
          case 41:
            b = _context4.sent;
            if (b && b.error) m = b.error;
            _context4.next = 47;
            break;
          case 45:
            _context4.prev = 45;
            _context4.t1 = _context4["catch"](38);
          case 47:
            throw new Error(m);
          case 48:
            if (!(!data || data.error)) {
              _context4.next = 50;
              break;
            }
            throw new Error(data && data.error || "Save failed — try again.");
          case 50:
            setInvDialog(function (d) {
              var _data$serial;
              return _objectSpread(_objectSpread({}, d), {}, {
                busy: false,
                done: {
                  serial: (_data$serial = data.serial) !== null && _data$serial !== void 0 ? _data$serial : null,
                  updated: isUpdate
                }
              });
            });
            if (!isUpdate) {
              // The design on screen IS now this unit's master — further saves are updates.
              currentDesignIdRef.current = code;
              setDesignCode(code);
              setInventoryMaster({
                code: code,
                unitId: data.unitId,
                priceCents: askingPriceCents,
                locationId: invLocationId || null
              });
            } else {
              setInventoryMaster(function (m) {
                return m && _objectSpread(_objectSpread({}, m), {}, {
                  priceCents: askingPriceCents,
                  locationId: invLocationId || null
                });
              });
            }
            if (onSaved) onSaved();
            _context4.next = 58;
            break;
          case 55:
            _context4.prev = 55;
            _context4.t2 = _context4["catch"](3);
            setInvDialog(function (d) {
              return _objectSpread(_objectSpread({}, d), {}, {
                busy: false,
                err: _context4.t2.message || String(_context4.t2)
              });
            });
          case 58:
          case "end":
            return _context4.stop();
        }
      }, _callee4, null, [[3, 55], [7, 21], [38, 45]]);
    }));
    return function saveInventory() {
      return _ref12.apply(this, arguments);
    };
  }();
  // Details NEVER auto-opens. If the form drops back to incomplete (a cleared field, the
  // address search resetting values), the section CLOSES — so re-completing the form can
  // never resurface it without a fresh click. Without this, an earlier open survived the
  // re-lock and the rows reappeared "by themselves" the moment the last field was filled.
  useEffect(function () {
    if (detailsLocked && additionalOpen) setAdditionalOpen(false);
  }, [detailsLocked]);
  // The lead save keys off VISIBILITY, not the click handler: whatever path reveals the
  // details, the contact is saved. The ref in captureLeadSilently keeps it once per load,
  // and its customerFacing guard keeps the portal designer out entirely. The draft save
  // rides the same moment: who they are (lead) and what they designed (draft) together.
  useEffect(function () {
    if (additionalOpen && !detailsLocked) {
      captureLeadSilently();
      saveDraftSilently();
    }
  }, [additionalOpen, detailsLocked]);
  var _useState107 = useState(null),
    _useState108 = _slicedToArray(_useState107, 2),
    toast = _useState108[0],
    setToast = _useState108[1];
  var svgRef = useRef(null);
  // After a drag or resize gesture ends, the trailing click on the SVG
  // would otherwise re-run the hit test and deselect the item if the cursor
  // ended outside its bounds. This ref signals "ignore the click that follows".
  var justGesturedRef = useRef(false);
  // Gesture-movement tracking: a press only counts as a drag/resize (and thus
  // swallows its trailing click) if the pointer actually moved past a jitter
  // threshold. A stationary click must SURVIVE so clicking a selected note can
  // enter in-place edit — an unconditional swallow made notes uneditable.
  var movedRef = useRef(false);
  var gestureStartRef = useRef(null); // {x,y} in client px at pointer-down

  // PostMessage listener
  useEffect(function () {
    var handler = function handler(e) {
      if (!ssAllowedOrigin(e.origin)) return;
      if (e.data && e.data.type === "structureConfig") {
        var d = e.data;
        setSel(function (p) {
          var n = _objectSpread({}, p);
          Object.keys(d).forEach(function (k) {
            if (k !== "type" && k in n) n[k] = d[k];
          });
          return n;
        });
        if (d.name || d.phone || d.email) {
          setContact(function (p) {
            return _objectSpread(_objectSpread({}, p), {}, {
              name: d.name || p.name,
              phone: d.phone || p.phone,
              email: d.email || p.email,
              street: d.street || p.street,
              city: d.city || p.city,
              state: d.state || p.state,
              zip: d.zip || p.zip
            });
          });
          if (d.name && d.phone) setGatePassed(true); // host pre-satisfied the lead gate
        }
      }
    };
    window.addEventListener("message", handler);
    return function () {
      return window.removeEventListener("message", handler);
    };
  }, []);

  // ─── Supabase client (browser-safe anon key, baked-in — config rows can't
  // redirect the data connection) ───
  var supabase = useMemo(function () {
    return createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }, []);

  // Tracks the design currently being edited (set on load via ?id=, then on save)
  var currentDesignIdRef = useRef(null);
  // GHL identifiers for the design currently being edited. When set (loaded from
  // the saved row or returned by the Edge Function), the next submit becomes a
  // PUT/update of the existing GHL estimate instead of a POST/create.
  var ghlContactIdRef = useRef(null);
  var ghlEstimateIdRef = useRef(null);
  var ghlEstimateNumberRef = useRef(null);
  // Mirrors ghlEstimateIdRef in state so the submit button can re-render its label
  // ("Get Quote" vs "Resubmit for Updated Estimate") when a design loads.
  var _useState109 = useState(false),
    _useState110 = _slicedToArray(_useState109, 2),
    hasExistingEstimate = _useState110[0],
    setHasExistingEstimate = _useState110[1];

  // Admin panel state — only used when isAdmin
  var _useState111 = useState(""),
    _useState112 = _slicedToArray(_useState111, 2),
    adminPwd = _useState112[0],
    setAdminPwd = _useState112[1];
  var _useState113 = useState(""),
    _useState114 = _slicedToArray(_useState113, 2),
    adminLocId = _useState114[0],
    setAdminLocId = _useState114[1];
  var _useState115 = useState(""),
    _useState116 = _slicedToArray(_useState115, 2),
    adminApiKey = _useState116[0],
    setAdminApiKey = _useState116[1];
  var _useState117 = useState(false),
    _useState118 = _slicedToArray(_useState117, 2),
    adminBusy = _useState118[0],
    setAdminBusy = _useState118[1];
  var _useState119 = useState(null),
    _useState120 = _slicedToArray(_useState119, 2),
    adminStatus = _useState120[0],
    setAdminStatus = _useState120[1]; // {configured, ghlLocationIdMasked, updatedAt} | null
  var _useState121 = useState(null),
    _useState122 = _slicedToArray(_useState121, 2),
    adminMsg = _useState122[0],
    setAdminMsg = _useState122[1]; // {ok, msg} | null
  // Prevents the size-change effect from clearing items when we're rehydrating
  // a saved design (sel.size and items get set together).
  var prevSizeRef = useRef("");
  // Outcomes of a size-change reflow. `reflowNote` is advisory (items moved wall or were
  // shortened); `sizeBlock` is the refusal — { from, to, items } — shown when something
  // could not be placed at all, with the size already reverted.
  var _useState123 = useState(null),
    _useState124 = _slicedToArray(_useState123, 2),
    reflowNote = _useState124[0],
    setReflowNote = _useState124[1];
  var _useState125 = useState(null),
    _useState126 = _slicedToArray(_useState125, 2),
    sizeBlock = _useState126[0],
    setSizeBlock = _useState126[1];

  // Google Places "search for address" widget that auto-fills the four address
  // fields below it. Uses google.maps.places.PlaceAutocompleteElement (Places API
  // New) — the replacement for the deprecated Autocomplete class. The element
  // brings its own input + dropdown; we mount it into a container <div> and
  // listen for gmp-select. On selection we resolve the chosen place's address
  // components and populate street / city / state / zip. When the key is empty,
  // this is a no-op and the container renders empty (the row hides itself).
  var attachStreetAutocomplete = useCallback(function (container) {
    var mapsKey = C.googleMapsApiKey || DEFAULT_GOOGLE_MAPS_API_KEY;
    if (!container || !mapsKey) return;
    loadGoogleMapsPlaces(mapsKey).then( /*#__PURE__*/function () {
      var _ref13 = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee6(google) {
        var _yield$google$maps$im, PlaceAutocompleteElement, pa, sizeTries, sizeToFields;
        return _regeneratorRuntime().wrap(function _callee6$(_context6) {
          while (1) switch (_context6.prev = _context6.next) {
            case 0:
              if (container.isConnected) {
                _context6.next = 2;
                break;
              }
              return _context6.abrupt("return");
            case 2:
              _context6.next = 4;
              return google.maps.importLibrary("places");
            case 4:
              _yield$google$maps$im = _context6.sent;
              PlaceAutocompleteElement = _yield$google$maps$im.PlaceAutocompleteElement;
              pa = new PlaceAutocompleteElement({
                includedRegionCodes: ["us"]
              }); // Google's gmp-place-autocomplete now uses a CLOSED shadow root, so its
              // inner input can't be styled from here (pa.shadowRoot is null). The HOST
              // element is stylable from outside, though: give it the same light-gray
              // border/radius as S.sel and pin its height to the sibling address fields
              // so the search box lines up with them instead of Google's tall default.
              pa.style.width = "100%";
              pa.style.display = "block";
              pa.style.boxSizing = "border-box";
              pa.style.border = "1px solid #CBD5E1";
              pa.style.borderRadius = "6px";
              // Font properties inherit across the closed shadow boundary (Google's inner
              // input uses font: inherit), so set them on the host to match S.sel.
              pa.style.fontFamily = "Arial, sans-serif";
              pa.style.fontSize = "13px";
              pa.style.fontWeight = "600";
              pa.style.color = "#000";
              // Force a light theme so the search box matches the white sibling address
              // fields — the gmp element otherwise defaults to a dark background, which
              // looked like the brand color "bleeding" into the search box. color-scheme
              // crosses the closed shadow boundary; backgroundColor covers the host.
              pa.style.colorScheme = "light";
              pa.style.backgroundColor = "#FFF";
              container.replaceChildren(pa);
              sizeTries = 0;
              sizeToFields = function sizeToFields() {
                var ref = document.querySelector('input[autocomplete="street-address"], input[autocomplete="postal-code"], input[autocomplete="address-level2"]');
                var h = ref ? Math.round(ref.getBoundingClientRect().height) : 0;
                if (h) {
                  pa.style.height = h + "px";
                  return;
                }
                if (sizeTries++ < 20) requestAnimationFrame(sizeToFields);else pa.style.height = "28px";
              };
              requestAnimationFrame(sizeToFields);
              pa.addEventListener("gmp-select", /*#__PURE__*/function () {
                var _ref14 = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee5(ev) {
                  var place, comps, find, street, city, state, zip;
                  return _regeneratorRuntime().wrap(function _callee5$(_context5) {
                    while (1) switch (_context5.prev = _context5.next) {
                      case 0:
                        place = ev.placePrediction.toPlace();
                        _context5.next = 3;
                        return place.fetchFields({
                          fields: ["addressComponents"]
                        });
                      case 3:
                        comps = place.addressComponents || [];
                        find = function find(type) {
                          var c = comps.find(function (x) {
                            return (x.types || []).includes(type);
                          });
                          return c ? c.longText || c.shortText || "" : "";
                        };
                        street = [find("street_number"), find("route")].filter(Boolean).join(" ");
                        city = find("locality") || find("sublocality") || find("postal_town");
                        state = find("administrative_area_level_1"); // full state name to match <select> options
                        zip = (find("postal_code") || "").replace(/\D/g, "").slice(0, 5);
                        setContact(function (p) {
                          return _objectSpread(_objectSpread(_objectSpread(_objectSpread(_objectSpread({}, p), street ? {
                            street: street
                          } : {}), city ? {
                            city: city
                          } : {}), state ? {
                            state: state
                          } : {}), zip ? {
                            zip: zip
                          } : {});
                        });
                      case 10:
                      case "end":
                        return _context5.stop();
                    }
                  }, _callee5);
                }));
                return function (_x4) {
                  return _ref14.apply(this, arguments);
                };
              }());
            case 23:
            case "end":
              return _context6.stop();
          }
        }, _callee6);
      }));
      return function (_x3) {
        return _ref13.apply(this, arguments);
      };
    }())["catch"](function (err) {
      console.warn("[StructureStudio] Google Maps autocomplete unavailable:", err.message);
    });
  }, [C.googleMapsApiKey]);

  // Auto-update building size, REFLOWING the layout instead of destroying it.
  //
  // This used to `setItems([])` on any size change — the customer lost their whole plan
  // with no warning. Worse, it missed a case: changing the STYLE blanks the size, which
  // recorded a blank into prevSizeRef, so the next size pick saw a falsy previous value
  // and skipped the wipe. The items survived carrying page-pixels computed from the OLD
  // scale/mgX/mgY, which left doors floating off their walls — and, because they then
  // failed their own wallOnly rule, unable to be dragged back. That is the bug Carolyn
  // reported. Comparing parsed DIMENSIONS rather than label strings closes it: a blank
  // size parses to null and is skipped without poisoning the ref.
  //
  // reflowItems is pure, so the result is inspected BEFORE committing: if anything cannot
  // be placed at all, the size change is reverted and the customer is told what to remove.
  useEffect(function () {
    var p = parseSize(sel.size);
    if (!p) {
      prevSizeRef.current = sel.size;
      return;
    }
    var prev = parseSize(prevSizeRef.current);
    if (prev && (prev.w !== p.w || prev.h !== p.h) && items.length) {
      var _reflowItems = reflowItems(items, prev, p, ITEMS),
        nextItems = _reflowItems.items,
        events = _reflowItems.events;
      var blocked = events.filter(function (e) {
        return e.kind === "blocked";
      });
      if (blocked.length) {
        // Nothing has changed yet — put the size back and let them decide.
        setSizeBlock({
          from: prevSizeRef.current,
          to: sel.size,
          items: blocked
        });
        setSel(function (s) {
          return _objectSpread(_objectSpread({}, s), {}, {
            size: prevSizeRef.current
          });
        });
        return; // prevSizeRef stays put; the revert re-runs this effect
      }
      setItems(nextItems);
      setSelectedId(null);
      var notable = events.filter(function (e) {
        return e.kind === "movedWall" || e.kind === "resized";
      });
      if (notable.length) setReflowNote(notable);
    }
    setShedW(p.w);
    setShedH(p.h);
    prevSizeRef.current = sel.size;
  }, [sel.size]);

  // Snap a loaded layout back onto legal positions. Designs saved before the size-change
  // reflow existed can carry items stranded off their walls by an old style-then-size
  // change — they render floating and, failing their own placement rule, cannot be dragged
  // back. Passing the SAME dimensions in and out makes the geometry conversion an identity,
  // so nothing moves that was already legal; the clamps and collision checks do the repair.
  // Silent by design: someone opening a link did not do anything to be told about.
  var repairLoaded = function repairLoaded(loaded, sizeLabel) {
    var d = parseSize(sizeLabel);
    if (!d || !loaded.length) return loaded;
    try {
      return reflowItems(loaded, d, d, ITEMS).items;
    } catch (_e) {
      return loaded;
    }
  };

  // ─── Load a saved design by short code ───
  // Shared by the public ?id= URL path and the portal's openDesign prop below — the two
  // must hydrate identically (GHL refs, draft flag, optional version snapshot, id counter).
  var loadDesignByCode = /*#__PURE__*/function () {
    var _ref15 = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee7(id, vParam) {
      var isCancelled,
        _yield$supabase$rpc2,
        rows,
        error,
        data,
        design,
        _yield$supabase$rpc3,
        vrows,
        vrow,
        loadedItems,
        _args7 = arguments;
      return _regeneratorRuntime().wrap(function _callee7$(_context7) {
        while (1) switch (_context7.prev = _context7.next) {
          case 0:
            isCancelled = _args7.length > 2 && _args7[2] !== undefined ? _args7[2] : function () {
              return false;
            };
            _context7.next = 3;
            return supabase.rpc("load_design", {
              p_code: id
            });
          case 3:
            _yield$supabase$rpc2 = _context7.sent;
            rows = _yield$supabase$rpc2.data;
            error = _yield$supabase$rpc2.error;
            data = Array.isArray(rows) ? rows[0] : rows; // Returns TRUE only when the design actually loaded. Callers act on the result:
            // the openDesign effect must not arm inventory state (unitId / asNew reset) against
            // whatever design is still on the canvas when the RPC failed or the row is gone —
            // that grafted unit B's id onto unit A's design and let an update overwrite B.
            if (!(isCancelled() || error || !data)) {
              _context7.next = 9;
              break;
            }
            return _context7.abrupt("return", false);
          case 9:
            // The persistent portal designer can be sitting on the submit-success screen when an
            // Open request arrives — without this the OLD design's success screen would keep
            // covering the newly loaded one. No-op on the public ?id= path (fresh mount, false).
            setSubmitted(false);
            setSubmitError(null);
            currentDesignIdRef.current = data.short_code;
            setDesignCode(data.short_code);
            // A re-opened draft may keep draft-saving; any other status locks the row against
            // silent rewrites (saveDraftSilently refuses non-draft rows). Embedded mounts never
            // draft-save at all (customerFacing guard), so there this flag is inert.
            isDraftRef.current = data.status === "draft";
            // Inventory master (075)? Mark it: submit gets blocked and the inventory button
            // flips to update mode. unitId is enriched by the openDesign effect (the portal
            // sends it); a master reached any other way still blocks submit.
            setInventoryMaster(data.status === "inventory" ? {
              code: data.short_code,
              unitId: null,
              priceCents: null,
              locationId: null
            } : null);
            // Opening an existing design is never a NEW inventory build; a master's location is seeded
            // by the openDesign enrichment below.
            setInventoryNew(false);
            setInvLocationId("");
            // An estimate quoted FROM an inventory building carries the link on the row, so
            // reopening it later (portal or public share link) locks the plan again. The serial
            // is a nicety for the banner: readable to a signed-in tenant under inventory_units'
            // owner-select policy, absent for an anon visitor — never let it block the lock.
            setNewBuildMode(false);
            if (data.inventory_unit_id) {
              // lifecycle stays null here on purpose. It is DERIVED from build_jobs + delivery_stops
              // (see _shared/inventoryLifecycle.ts) — not a column this read could fetch, and
              // re-deriving it in the browser would be a third copy of a rule that must not drift.
              // Null means "unknown", which fails toward LOCKED — the behaviour this path has always
              // had, and staff still have "Design a new build instead" to lift it deliberately. The
              // Inventory tab, which does know, passes it through openDesign below.
              setDesignUnit({
                id: data.inventory_unit_id,
                serial: null,
                lifecycle: null
              });
              supabase.from("inventory_units").select("serial").eq("id", data.inventory_unit_id).maybeSingle().then(function (_ref16) {
                var u = _ref16.data;
                if (u && !isCancelled()) setDesignUnit(function (p) {
                  return _objectSpread(_objectSpread({}, p || {}), {}, {
                    id: data.inventory_unit_id,
                    serial: u.serial
                  });
                });
              }, function () {});
            } else {
              setDesignUnit(null);
            }
            // Hydrate GHL refs so a re-submit becomes an update of the same estimate.
            ghlContactIdRef.current = data.ghl_contact_id || null;
            ghlEstimateIdRef.current = data.ghl_estimate_id || null;
            ghlEstimateNumberRef.current = data.ghl_estimate_number || null;
            setHasExistingEstimate(!!data.ghl_estimate_id);

            // Optionally open a specific saved version for review/resubmit. The design DATA
            // comes from that version's snapshot; the GHL refs above stay from the current
            // row so a resubmit updates the same one estimate rather than creating a new one.
            design = data;
            if (!(Number.isFinite(vParam) && vParam > 0)) {
              _context7.next = 31;
              break;
            }
            _context7.next = 27;
            return supabase.rpc("load_design_version", {
              p_code: id,
              p_version: vParam
            });
          case 27:
            _yield$supabase$rpc3 = _context7.sent;
            vrows = _yield$supabase$rpc3.data;
            vrow = Array.isArray(vrows) ? vrows[0] : vrows;
            if (!isCancelled() && vrow) design = vrow;
          case 31:
            if (!isCancelled()) {
              _context7.next = 33;
              break;
            }
            return _context7.abrupt("return", false);
          case 33:
            setViewingVersion(Number.isFinite(vParam) && vParam > 0 ? vParam : null);
            setContact(data.contact || {
              name: "",
              email: "",
              phone: "",
              street: "",
              city: "",
              state: "",
              zip: ""
            });
            // Pre-set prevSizeRef to what sel.size is ABOUT to become, so the size effect doesn't
            // treat this load as a user size-change and wipe the items set below (same guard
            // openVersion uses). "" (not the old size) because sel is REBUILT below, not merged.
            prevSizeRef.current = (design.selections || {}).size || "";
            // Rebuild sel from pristine defaults rather than merging over the persistent portal
            // designer's current selections: a design saved before an option existed (e.g. rows
            // from before roofType/roofColor shipped) must not inherit the previously opened
            // design's values for those keys. Mirrors the sel useState initializer.
            setSel(function () {
              var base = {
                style: "",
                size: "",
                roofType: "",
                roofColor: ""
              };
              C.options.forEach(function (o) {
                base[o.id] = o.type === "counter" ? o.options[0] : "";
              });
              return _objectSpread(_objectSpread({}, base), design.selections || {});
            });
            setPaintColors(design.paint_colors || {
              body: "",
              trim: ""
            });
            setPaintCustom({
              body: false,
              trim: false
            });
            setCustomOptions(design.custom_options || []);
            setRoDimensions(design.ro_dimensions || {});
            // Items must be set after sel.size has propagated; the prevSizeRef guard
            // above keeps the size effect from wiping them.
            loadedItems = repairLoaded(Array.isArray(design.items) ? design.items : [], (design.selections || {}).size);
            setItems(loadedItems);
            // The persistent portal mount can carry a selection/note-edit from the PREVIOUS
            // design; item ids are small integers that collide across designs, so a stale
            // selectedId would put the Delete/Rotate toolbar on an arbitrary item of this one.
            setSelectedId(null);
            setEditingNoteId(null);
            // Keep the global id counter ahead of any restored ids so the next placement can't
            // reuse an existing id (which collided in select/drag/delete/resize).
            idCounter = Math.max.apply(Math, [idCounter, 0].concat(_toConsumableArray(loadedItems.map(function (i) {
              return Number(i.id) || 0;
            })))) + 1;
            return _context7.abrupt("return", true);
          case 47:
          case "end":
            return _context7.stop();
        }
      }, _callee7);
    }));
    return function loadDesignByCode(_x5, _x6) {
      return _ref15.apply(this, arguments);
    };
  }();

  // ─── Load saved design from ?id=SS-XXXXXX on the URL ───
  useEffect(function () {
    if (!supabase) return;
    // Embedded mounts never read the HOST page's URL — /portal.html?id=SS-… must not
    // hydrate the in-portal designer with an arbitrary design code.
    if (embedded) return;
    var params = new URLSearchParams(window.location.search);
    var id = params.get("id");
    if (!id) return;
    var cancelled = false;
    loadDesignByCode(id, parseInt(params.get("v") || "", 10), function () {
      return cancelled;
    });
    return function () {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, embedded]);

  // ─── Open a design on demand (portal Designer tab) ───
  // The portal's Designs/Contacts "Open" buttons hand the persistent embedded designer an
  // { code, version } request instead of linking to the public page. Business users must
  // NEVER review a customer's design on the public page: it silently captures leads and
  // saves drafts (capture-lead / saveDraftSilently), so staff browsing there would corrupt
  // the very activity Contacts reports. Embedded-only; the public page keeps its ?id= path.
  // Each click sends a fresh object (identity change re-fires this even for the same code).
  useEffect(function () {
    if (!embedded || !supabase || !openDesign) return;
    // "+ New inventory building" sends { blank: true } with no code: clear the canvas so
    // a brand-new building never starts from the design that happened to be open. Without
    // this, clicking New while another unit's MASTER was loaded left the submit bar saying
    // "Update Inventory Building" — saving would have rewritten that other unit.
    if (openDesign.blank) {
      if (items.length > 0 || sel.style || sel.size) {
        if (!window.confirm("Start a new building? This clears what's currently in the Designer tab.")) return;
      }
      setItems([]);
      setSel(function (p) {
        var n = _objectSpread({}, p);
        Object.keys(n).forEach(function (k) {
          return n[k] = "";
        });
        return n;
      });
      setContact({
        name: "",
        phone: "",
        email: "",
        street: "",
        city: "",
        state: "",
        zip: ""
      });
      setPaintColors({
        body: "",
        trim: ""
      });
      setCustomOptions([]);
      setRoDimensions({});
      setSelectedId(null);
      setEditingNoteId(null);
      currentDesignIdRef.current = null;
      isDraftRef.current = false;
      draftStateRef.current = null;
      ghlContactIdRef.current = null;
      ghlEstimateIdRef.current = null;
      ghlEstimateNumberRef.current = null;
      inventoryUnitRef.current = null;
      setInventoryMaster(null);
      setDesignUnit(null);
      setNewBuildMode(false);
      setInventoryNew(true); // "+ New inventory building" → show the inventory Save bar + location dropdown
      setInvLocationId("");
      setHasExistingEstimate(false);
      setDesignCode(null);
      setEstimateVersions([]);
      setViewingVersion(null);
      setSubmitted(false);
      setSubmitError(null);
      return;
    }
    if (!openDesign.code) return;
    // The persistent Designer tab may hold in-progress work — hand-built, or a previously
    // opened design mid-edit. The old public links opened a NEW tab and could never
    // destroy it; this in-place load can, so it asks first (the same courtesy the
    // portal's openAccount extends before its remount discards the designer).
    if (items.length > 0 || sel.style || sel.size) {
      if (!window.confirm("Opening this design will replace what's currently in the Designer tab. Continue?")) return;
    }
    var cancelled = false;
    _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee8() {
      var loaded, _openDesign$unitSeria, _openDesign$unitLifec;
      return _regeneratorRuntime().wrap(function _callee8$(_context8) {
        while (1) switch (_context8.prev = _context8.next) {
          case 0:
            _context8.next = 2;
            return loadDesignByCode(String(openDesign.code), Number(openDesign.version) || null, function () {
              return cancelled;
            });
          case 2:
            loaded = _context8.sent;
            if (!(cancelled || !loaded)) {
              _context8.next = 6;
              break;
            }
            if (!cancelled) setSubmitError("That design could not be opened — check your connection and try again.");
            return _context8.abrupt("return");
          case 6:
            if (openDesign.asNew) {
              // "Send estimate" from Inventory: the unit's design becomes a FRESH estimate for
              // a new customer — a new short_code is minted at submit, the contact starts
              // blank, no GHL identity carries over, and the master itself stays untouched.
              // Many customers can each get their own estimate on the same physical building.
              currentDesignIdRef.current = null;
              setDesignCode(null);
              isDraftRef.current = false;
              draftStateRef.current = null;
              ghlContactIdRef.current = null;
              ghlEstimateIdRef.current = null;
              ghlEstimateNumberRef.current = null;
              setHasExistingEstimate(false);
              setViewingVersion(null);
              setContact({
                name: "",
                email: "",
                phone: "",
                street: "",
                city: "",
                state: "",
                zip: ""
              });
              setInventoryMaster(null);
              // asNew is a NEW quote on that building: the lock comes from the armed ref, and
              // designUnit (which tracks a SAVED row's link) must not also be set yet.
              setDesignUnit(openDesign.inventoryUnitId ? {
                id: openDesign.inventoryUnitId,
                serial: (_openDesign$unitSeria = openDesign.unitSerial) !== null && _openDesign$unitSeria !== void 0 ? _openDesign$unitSeria : null,
                // The Inventory tab knows where the building is on the ladder, so it says so —
                // that is what lets a not-yet-built unit be quoted with an editable plan.
                lifecycle: (_openDesign$unitLifec = openDesign.unitLifecycle) !== null && _openDesign$unitLifec !== void 0 ? _openDesign$unitLifec : null
              } : null);
              setNewBuildMode(false);
              inventoryUnitRef.current = openDesign.inventoryUnitId || null;
            } else if (openDesign.newBuild) {
              // "Quote a new build for this customer" from a sold building's estimate list. Exactly
              // what the in-designer "Design a new build instead" button does — the plan unlocks and
              // unitToLink resolves to null at submit, so the new version reads New rather than
              // inheriting the sold unit. No extra confirm here: openInDesigner already asked about
              // replacing what is in the Designer tab, and the user clicked a button that says this.
              inventoryUnitRef.current = null;
              setNewBuildMode(true);
            } else {
              inventoryUnitRef.current = null;
              if (openDesign.unit) {
                // Inventory "Open": enrich the master marker so update mode knows its unit.
                setInventoryMaster(function (m) {
                  var _openDesign$unit$aski, _openDesign$unit$loca;
                  return m && _objectSpread(_objectSpread({}, m), {}, {
                    unitId: openDesign.unit.unitId,
                    priceCents: (_openDesign$unit$aski = openDesign.unit.askingPriceCents) !== null && _openDesign$unit$aski !== void 0 ? _openDesign$unit$aski : null,
                    locationId: (_openDesign$unit$loca = openDesign.unit.locationId) !== null && _openDesign$unit$loca !== void 0 ? _openDesign$unit$loca : null
                  });
                });
                setInvLocationId(openDesign.unit.locationId || ""); // seed the inline location dropdown
              }
            }
          case 7:
          case "end":
            return _context8.stop();
        }
      }, _callee8);
    }))();
    return function () {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, embedded, openDesign]);

  // On the submit-success screen, load every version of this design (this estimate) so the
  // customer/rep can see and reopen all designs on the estimate. Capability read by code.
  useEffect(function () {
    if (!supabase || !designCode) {
      setEstimateVersions([]);
      return;
    }
    var cancelled = false;
    _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee9() {
      var _yield$supabase$rpc4, data, error;
      return _regeneratorRuntime().wrap(function _callee9$(_context9) {
        while (1) switch (_context9.prev = _context9.next) {
          case 0:
            _context9.next = 2;
            return supabase.rpc("list_design_versions", {
              p_code: designCode
            });
          case 2:
            _yield$supabase$rpc4 = _context9.sent;
            data = _yield$supabase$rpc4.data;
            error = _yield$supabase$rpc4.error;
            if (!(cancelled || error)) {
              _context9.next = 7;
              break;
            }
            return _context9.abrupt("return");
          case 7:
            setEstimateVersions(Array.isArray(data) ? data : []);
          case 8:
          case "end":
            return _context9.stop();
        }
      }, _callee9);
    }))();
    return function () {
      cancelled = true;
    };
  }, [supabase, designCode, submitted]);

  // Switch to another saved version in place (no page reload). Loads that version's design
  // data and keeps the current GHL refs (same estimate), marking it as the one being viewed.
  var openVersion = useCallback( /*#__PURE__*/function () {
    var _ref19 = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee10(version) {
      var _yield$supabase$rpc5, vrows, error, vrow, vsel, loadedItems, p;
      return _regeneratorRuntime().wrap(function _callee10$(_context10) {
        while (1) switch (_context10.prev = _context10.next) {
          case 0:
            if (!(!supabase || !designCode)) {
              _context10.next = 2;
              break;
            }
            return _context10.abrupt("return");
          case 2:
            _context10.next = 4;
            return supabase.rpc("load_design_version", {
              p_code: designCode,
              p_version: version
            });
          case 4:
            _yield$supabase$rpc5 = _context10.sent;
            vrows = _yield$supabase$rpc5.data;
            error = _yield$supabase$rpc5.error;
            vrow = Array.isArray(vrows) ? vrows[0] : vrows;
            if (!(error || !vrow)) {
              _context10.next = 10;
              break;
            }
            return _context10.abrupt("return");
          case 10:
            vsel = vrow.selections || {}; // Pre-set prevSizeRef to this version's size so the size effect doesn't treat it as a
            // user size-change and wipe the items we're loading (same guard the initial load uses).
            prevSizeRef.current = vsel.size || prevSizeRef.current;
            setSel(function (prev) {
              return _objectSpread(_objectSpread({}, prev), vsel);
            });
            setPaintColors(vrow.paint_colors || {
              body: "",
              trim: ""
            });
            setPaintCustom({
              body: false,
              trim: false
            });
            setCustomOptions(vrow.custom_options || []);
            setRoDimensions(vrow.ro_dimensions || {});
            loadedItems = repairLoaded(Array.isArray(vrow.items) ? vrow.items : [], (vrow.selections || {}).size);
            setItems(loadedItems);
            setSelectedId(null);
            idCounter = Math.max.apply(Math, [idCounter, 0].concat(_toConsumableArray(loadedItems.map(function (i) {
              return Number(i.id) || 0;
            })))) + 1;
            setViewingVersion(version);
            if (!embedded) {
              p = new URLSearchParams(window.location.search);
              p.set("v", String(version));
              window.history.replaceState({}, "", "?".concat(p.toString()));
            }
          case 23:
          case "end":
            return _context10.stop();
        }
      }, _callee10);
    }));
    return function (_x7) {
      return _ref19.apply(this, arguments);
    };
  }(), [supabase, designCode, embedded]);

  // ─── Page-based geometry: on-screen mirrors the 8.5"×11" export 1:1 ───
  // The SVG viewBox IS the export page. Notes/lines live in page coordinates,
  // so wherever they sit on screen is exactly where they print.
  var PAGE_W = SS_PAGE.W,
    PAGE_H = SS_PAGE.H;
  var TEXT_AREA_H = SS_PAGE.TEXT_AREA_H; // bottom band reserved for auto customer info
  var TOP_LABEL_PAD = SS_PAGE.TOP_LABEL_PAD; // space for size + FRONT labels above plan
  var BOT_LABEL_PAD = SS_PAGE.BOT_LABEL_PAD; // space for size + BACK labels below plan
  var RAMP_SPACE_FT = SS_PAGE.RAMP_SPACE_FT; // a ramp shows 2 ft past its wall (visual)
  var visibleH = PAGE_H - TEXT_AREA_H;
  // Plan dynamically scales: caps in three directions ensure a ramp fits
  // both north and south plus 70% target sizing.
  //   1) width ≤ 70% of page (so the plan never spans the full sheet)
  //   2) height ≤ 70% of the visible top area
  //   3) plan + 2 ramps + 2 label pads ≤ visibleH (so south + north ramps fit)
  // Top-bias: the plan sits RAMP_SPACE_FT*scale + TOP_LABEL_PAD from the top so a north
  // ramp + labels fit; the third scale constraint guarantees room for a south ramp below.
  // Derived by pageGeom() so the reflow can compute the OLD page geometry the same way.
  var _pageGeom = pageGeom(bldgW, bldgH),
    scale = _pageGeom.scale,
    pW = _pageGeom.pW,
    pH = _pageGeom.pH,
    mgX = _pageGeom.mgX,
    mgY = _pageGeom.mgY;
  var cW = PAGE_W,
    cH = PAGE_H;
  var TEXT_BAND_TOP = PAGE_H - TEXT_AREA_H;

  // ─── Display frame: zoom-to-fit crop of the sheet (DISPLAY-ONLY) ───
  // Everything above (scale, mgX, mgY) is shared with the print/export path and
  // is untouched. The frame only decides which part of the sheet the on-screen
  // SVG shows (its viewBox) and how large it renders — the plan plus a wide
  // margin band for notes/lines, expanded to include any annotation already
  // placed outside it (saved designs), clamped to the sheet. Because the
  // element's aspect ratio always matches the frame's, on-screen px-per-page-px
  // stays uniform on both axes and getSvgPt's single-ratio math stays exact.
  var NOTE_MARGIN = 170; // page px kept beside the plan for notes (~20% of sheet width per side)
  var frame = function () {
    var x0 = Math.max(0, mgX - NOTE_MARGIN);
    var x1 = Math.min(PAGE_W, mgX + pW + NOTE_MARGIN);
    var y0 = 0;
    var y1 = Math.min(TEXT_BAND_TOP, mgY + pH + RAMP_SPACE_FT * scale + BOT_LABEL_PAD + 40);
    items.forEach(function (it) {
      if (it.type === "textNote") {
        var w = it.widthPx || 160,
          h = it.heightPx || 40;
        // Left pad is wider (28) so the docked leader handle (cx -w/2-18, r7)
        // is never clipped out of the frame for notes near the sheet's edge.
        x0 = Math.min(x0, it.x - w / 2 - 28);
        x1 = Math.max(x1, it.x + w / 2 + 12);
        y0 = Math.min(y0, it.y - h / 2 - 12);
        y1 = Math.max(y1, it.y + h / 2 + 12);
        if (it.leader) {
          x0 = Math.min(x0, it.leader.x - 12);
          x1 = Math.max(x1, it.leader.x + 12);
          y0 = Math.min(y0, it.leader.y - 12);
          y1 = Math.max(y1, it.leader.y + 12);
        }
      } else if (it.type === "line") {
        x0 = Math.min(x0, Math.min(it.x1, it.x2) - 12);
        x1 = Math.max(x1, Math.max(it.x1, it.x2) + 12);
        y0 = Math.min(y0, Math.min(it.y1, it.y2) - 12);
        y1 = Math.max(y1, Math.max(it.y1, it.y2) + 12);
      }
    });
    x0 = Math.max(0, x0);
    y0 = Math.max(0, y0);
    x1 = Math.min(PAGE_W, x1);
    y1 = Math.min(TEXT_BAND_TOP, y1);
    return {
      x: x0,
      y: y0,
      w: x1 - x0,
      h: y1 - y0
    };
  }();
  // On-screen size: full container width up to a height cap. maxWidth is derived
  // from the cap so the element's aspect always equals the frame's (no letterbox).
  var DISP_MAX_H = 760;
  var dispMaxW = Math.round(Math.min(1010, frame.w * DISP_MAX_H / frame.h));
  // Ref so pointer-math reads the CURRENT frame even from stale-closured handlers.
  var frameRef = useRef(frame);
  frameRef.current = frame;

  // Get sizes for selected style
  var selectedStyle = C.buildingStyles.find(function (s) {
    return s.value === sel.style;
  });
  var sizeOpts = selectedStyle && Array.isArray(selectedStyle.sizes) ? selectedStyle.sizes : C.defaultSizes || [];
  var frontWall = getFrontWall(items);
  // Detect unattached lofts for warning banner
  var lofts = items.filter(function (i) {
    return i.type === "loft";
  });
  var unattachedLofts = lofts.filter(function (lf) {
    var w = (lf.widthFt || 6) / 2,
      h = (lf.heightFt || 4) / 2;
    var cx = (lf.x - mgX) / scale,
      cy = (lf.y - mgY) / scale;
    var others = lofts.filter(function (o) {
      return o.id !== lf.id;
    }).map(function (o) {
      var ow = (o.widthFt || 6) / 2,
        oh = (o.heightFt || 4) / 2;
      var ocx = (o.x - mgX) / scale,
        ocy = (o.y - mgY) / scale;
      return {
        l: ocx - ow,
        r: ocx + ow,
        t: ocy - oh,
        b: ocy + oh
      };
    });
    return !checkLoftAttached(cx - w, cx + w, cy - h, cy + h, bldgW, bldgH, others);
  });

  // ─── INTERACTION HANDLERS ───
  var getSvgPt = useCallback(function (e) {
    var svg = svgRef.current;
    if (!svg) return {
      x: 0,
      y: 0
    };
    var r = svg.getBoundingClientRect();
    var cx = e.touches ? e.touches[0].clientX : e.clientX;
    var cy = e.touches ? e.touches[0].clientY : e.clientY;
    // The viewBox is the zoom-to-fit display frame — a crop of the sheet whose
    // aspect ratio always matches the element's, so ONE ratio maps both axes.
    // Read the frame through the ref so this stays exact even when a handler
    // closed over an older render (the frame moves as items/sizes change).
    var f = frameRef.current;
    var sx = f.w / r.width;
    return {
      x: f.x + (cx - r.left) * sx,
      y: f.y + (cy - r.top) * sx
    };
  }, []);
  var handleClick = useCallback(function (e) {
    if (dragging) return;
    if (planLockedRef.current) return; // inventory estimate: the building is already built
    // Not captured yet: any attempt to work the canvas pops the lead gate instead.
    if (gateRequired) {
      setGateOpen(true);
      return;
    }
    // Swallow the click that fires immediately after a drag/resize gesture —
    // otherwise the hit test below would deselect items the user just resized.
    if (justGesturedRef.current) {
      justGesturedRef.current = false;
      return;
    }
    // Pick-one-to-remove mode: the pulsing overlays are the only click targets
    // (they handle their own clicks); every other canvas action is disabled.
    if (pendingRemoval) return;
    var pt = getSvgPt(e);
    if (!activeTool) {
      var hit = _toConsumableArray(items).reverse().find(function (it) {
        var c = ITEMS[it.type];
        if (!c) return false;
        if (c.lineType) {
          // Distance from click to the line segment
          var A = pt.x - it.x1,
            B = pt.y - it.y1;
          var C2 = it.x2 - it.x1,
            D = it.y2 - it.y1;
          var lenSq = C2 * C2 + D * D;
          var t = lenSq ? (A * C2 + B * D) / lenSq : 0;
          t = Math.max(0, Math.min(1, t));
          var dx = pt.x - (it.x1 + t * C2),
            dy = pt.y - (it.y1 + t * D);
          return Math.sqrt(dx * dx + dy * dy) < 8;
        }
        if (c.noteType) {
          var w = it.widthPx || 160,
            h = it.heightPx || 40;
          return Math.abs(pt.x - it.x) < w / 2 + 4 && Math.abs(pt.y - it.y) < h / 2 + 4;
        }
        // Use the item's actual stored size, not the config default — the
        // workbench/loft/RO can be resized past their default and still need
        // to be selectable at their visual bounds.
        var iwFt = it.widthFt || c.width;
        var ihFt = it.heightFt || c.height;
        var iw = iwFt * scale,
          ih = ihFt * scale;
        var rot = it.rotation === 90 || it.rotation === 270;
        var hw = (rot ? ih : iw) / 2;
        var hh = (rot ? iw : ih) / 2; // 270° swaps the visual bbox just like 90° (audit #F5)
        return Math.abs(pt.x - it.x) < hw + 5 && Math.abs(pt.y - it.y) < hh + 5;
      });
      // Clicking an ALREADY-selected note starts typing in place (works for
      // double-click and tap-tap alike; the justGestured guard above keeps a
      // drag's trailing click from triggering it).
      if (hit && hit.id === selectedId && ITEMS[hit.type] && ITEMS[hit.type].noteType) {
        setEditingNoteId(hit.id);
        return;
      }
      if (!hit || hit.id !== editingNoteId) setEditingNoteId(null);
      setSelectedId(hit ? hit.id : null);
      return;
    }
    var cfg = ITEMS[activeTool];
    if (!cfg) return;
    // The single "Door" tool: don't place yet — remember the wall + click point and open the
    // door picker, which chooses the door + swing/operation and then places it (placePickedDoor).
    if (cfg.isDoorPicker) {
      var w = getWallFromClick(pt.x, pt.y, pW, pH, mgX, mgY) || getNearestWall(pt.x, pt.y, pW, pH, mgX, mgY);
      setDoorPick({
        wall: w,
        ptx: pt.x,
        pty: pt.y
      });
      setActiveTool(null);
      setToast(null);
      return;
    }
    // The "Window" tool: like the door picker but no swing/operation — remember the wall + point
    // and open the window picker, which places the chosen catalog window (placePickedWindow).
    if (cfg.isWindowPicker) {
      var _w = getWallFromClick(pt.x, pt.y, pW, pH, mgX, mgY) || getNearestWall(pt.x, pt.y, pW, pH, mgX, mgY);
      setWindowPick({
        wall: _w,
        ptx: pt.x,
        pty: pt.y
      });
      setActiveTool(null);
      setToast(null);
      return;
    }
    // An INCLUDED catalog door/window chip is armed → drop that EXACT fixture here (no picker).
    // Included ramps are doorSnap and handled in the doorSnap branch below.
    if (cfg.includedFixture && !cfg.doorSnap) {
      var fx = cfg.includedFixture;
      var _w2 = getWallFromClick(pt.x, pt.y, pW, pH, mgX, mgY) || getNearestWall(pt.x, pt.y, pW, pH, mgX, mgY);
      var widthFt = (Number(fx.widthIn) || (fx.category === "window" ? 24 : 36)) / 12;
      var iwPx2 = widthFt * scale,
        ihPx2 = 0.5 * scale;
      var sn = snapToWall(_w2, pt.x, pt.y, iwPx2, ihPx2, pW, pH, mgX, mgY);
      var _ni;
      if (fx.category === "window") {
        _ni = _objectSpread(_objectSpread({
          id: idCounter++,
          type: "window"
        }, sn), {}, {
          widthFt: widthFt,
          heightFt: 0.5,
          fixtureItemId: fx.id,
          windowName: fx.name || "Window",
          planLabel: fx.planLabel && String(fx.planLabel).trim() || (fx.name || "WIN").toUpperCase().slice(0, 6),
          price: fx.price != null ? fx.price : null,
          widthIn: Number(fx.widthIn) || null,
          heightIn: Number(fx.heightIn) || null
        });
      } else {
        var swing = fx.swingDefault || (fx.swingOut ? "out" : fx.swingIn ? "in" : null);
        var operation = fx.opDefault || (fx.opDouble ? "double" : fx.opSlideUp ? "slideup" : fx.opRight ? "right" : fx.opLeft ? "left" : null);
        _ni = _objectSpread(_objectSpread({
          id: idCounter++,
          type: "fixtureDoor"
        }, sn), {}, {
          widthFt: widthFt,
          heightFt: 0.5,
          fixtureItemId: fx.id,
          doorName: fx.name || "Door",
          planLabel: fx.planLabel && String(fx.planLabel).trim() || (fx.name || "DOOR").toUpperCase().slice(0, 6),
          price: fx.price != null ? fx.price : null,
          widthIn: Number(fx.widthIn) || null,
          heightIn: Number(fx.heightIn) || null,
          swing: swing,
          operation: operation
        });
      }
      if (checkDoorCollision(_ni, {
        width: widthFt
      }, items, ITEMS, scale)) {
        setToast("Something's already there — pick a different spot on the wall.");
        setTimeout(function () {
          return setToast(null);
        }, 4000);
        return;
      }
      setItems(function (p) {
        return [].concat(_toConsumableArray(p), [_ni]);
      });
      setSelectedId(_ni.id);
      setActiveTool(null);
      setToast(null);
      return;
    }
    var iwPx = cfg.width * scale;
    var ihPx = cfg.height * scale;
    var wall = getWallFromClick(pt.x, pt.y, pW, pH, mgX, mgY);
    // Wall-only items always go on a wall; if the click missed the threshold,
    // fall back to the nearest wall so the placement still happens.
    if (cfg.wallOnly && !wall) wall = getNearestWall(pt.x, pt.y, pW, pH, mgX, mgY);

    // Annotation tools (note + line): free placement anywhere on the visible
    // page area (above the auto info band), not just inside the plan rectangle.
    if (cfg.noteType) {
      var _ni2 = {
        id: idCounter++,
        type: activeTool,
        x: Math.max(20, Math.min(pt.x, PAGE_W - 20)),
        y: Math.max(20, Math.min(pt.y, TEXT_BAND_TOP - 20)),
        rotation: 0,
        wall: null,
        widthPx: 160,
        heightPx: 40,
        // user-resizable box; text flows inside
        text: "Note"
      };
      setItems(function (p) {
        return [].concat(_toConsumableArray(p), [_ni2]);
      });
      setSelectedId(_ni2.id);
      setEditingNoteId(_ni2.id); // start typing in the note immediately (text pre-selected)
      setActiveTool(null);
      setToast(null);
      return;
    }
    if (cfg.lineType) {
      var halfLenPx = cfg.width / 2 * scale;
      var cx = Math.max(20, Math.min(pt.x, PAGE_W - 20));
      var cy = Math.max(20, Math.min(pt.y, TEXT_BAND_TOP - 20));
      var _ni3 = {
        id: idCounter++,
        type: activeTool,
        wall: null,
        x1: Math.max(0, cx - halfLenPx),
        y1: cy,
        x2: Math.min(PAGE_W, cx + halfLenPx),
        y2: cy
      };
      setItems(function (p) {
        return [].concat(_toConsumableArray(p), [_ni3]);
      });
      setSelectedId(_ni3.id);
      setActiveTool(null);
      setToast(null);
      return;
    }

    // Door-snap items (ramp): find nearest door and snap to its outside
    if (cfg.doorSnap) {
      // fixtureDoor counts as a door here. It is the item type EVERY catalog door placement
      // creates, and it is treated as a door everywhere else — getFrontWall, checkDoorCollision via
      // wallOnly, the payload doors[] schedule — but the ramp tool filtered it out, so a shopper who
      // placed the tenant's own catalog door (a slide-up or garage door, the most natural ramp
      // companion) got "Place a door first, then add a ramp to it." with a door plainly on the plan.
      // Catalog doors are live: fixture_items has active category='door' rows today.
      var doors = items.filter(function (i) {
        return i.type === "singleDoor" || i.type === "doubleDoor" || i.type === "fixtureDoor";
      });
      if (doors.length === 0) {
        setToast("Place a door first, then add a ramp to it.");
        setTimeout(function () {
          return setToast(null);
        }, 5000);
        return;
      }
      // Find closest door to click
      var closest = null;
      var minDist = Infinity;
      doors.forEach(function (d) {
        var dx = pt.x - d.x;
        var dy = pt.y - d.y;
        var dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < minDist) {
          minDist = dist;
          closest = d;
        }
      });
      if (!closest) return;
      // Check if this door already has a ramp
      var existingRamp = items.find(function (i) {
        return i.type === "ramp" && i.snapDoorId === closest.id;
      });
      if (existingRamp) {
        setToast("This door already has a ramp. Delete it first to replace.");
        setTimeout(function () {
          return setToast(null);
        }, 5000);
        return;
      }
      // Custom ramp: open the picker for THIS door — placePickedRamp creates the ramp item.
      if (cfg.isRampPicker) {
        setRampPick({
          door: closest
        });
        setActiveTool(null);
        setToast(null);
        return;
      }
      // An INCLUDED catalog ramp chip: attach that EXACT ramp to this door (like a custom ramp).
      if (cfg.includedFixture) {
        var _fx = cfg.includedFixture;
        var _widthFt = (Number(_fx.widthIn) || 36) / 12;
        var rDepth = (Number(_fx.heightIn) || 0) / 12 || RAMP_SPACE_FT;
        var rDepthPx = rDepth * scale;
        var _rx, _ry, _rot;
        if (closest.wall === "north") {
          _rx = closest.x;
          _ry = mgY - rDepthPx / 2;
          _rot = 0;
        } else if (closest.wall === "south") {
          _rx = closest.x;
          _ry = mgY + pH + rDepthPx / 2;
          _rot = 0;
        } else if (closest.wall === "west") {
          _rx = mgX - rDepthPx / 2;
          _ry = closest.y;
          _rot = 90;
        } else if (closest.wall === "east") {
          _rx = mgX + pW + rDepthPx / 2;
          _ry = closest.y;
          _rot = 90;
        } else return;
        var _ni4 = {
          id: idCounter++,
          type: "ramp",
          x: _rx,
          y: _ry,
          rotation: _rot,
          wall: closest.wall,
          widthFt: _widthFt,
          heightFt: rDepth,
          snapDoorId: closest.id,
          fixtureItemId: _fx.id,
          rampName: _fx.name || "Ramp",
          planLabel: _fx.planLabel && String(_fx.planLabel).trim() || (_fx.name || "RAMP").toUpperCase().slice(0, 6),
          price: _fx.price != null ? _fx.price : null,
          widthIn: Number(_fx.widthIn) || null,
          heightIn: Number(_fx.heightIn) || null
        };
        setItems(function (p) {
          return [].concat(_toConsumableArray(p), [_ni4]);
        });
        setSelectedId(_ni4.id);
        setActiveTool(null);
        setToast(null);
        return;
      }
      var doorCfg = ITEMS[closest.type];
      var doorW = doorCfg ? doorCfg.width : 3;
      var rampDepth = RAMP_SPACE_FT; // visual ramp depth in feet
      var rampDepthPx = rampDepth * scale;
      var rampWidthPx = doorW * scale;
      var rx, ry, rot;
      if (closest.wall === "north") {
        rx = closest.x;
        ry = mgY - rampDepthPx / 2;
        rot = 0;
      } else if (closest.wall === "south") {
        rx = closest.x;
        ry = mgY + pH + rampDepthPx / 2;
        rot = 0;
      } else if (closest.wall === "west") {
        rx = mgX - rampDepthPx / 2;
        ry = closest.y;
        rot = 90;
      } else if (closest.wall === "east") {
        rx = mgX + pW + rampDepthPx / 2;
        ry = closest.y;
        rot = 90;
      } else return;
      var _ni5 = {
        id: idCounter++,
        type: activeTool,
        x: rx,
        y: ry,
        rotation: rot,
        wall: closest.wall,
        widthFt: doorW,
        heightFt: rampDepth,
        snapDoorId: closest.id
      };
      setItems(function (p) {
        return [].concat(_toConsumableArray(p), [_ni5]);
      });
      setActiveTool(null);
      setToast(null);
      return;
    }

    // (cfg.wallOnly is always assigned a wall above — no need to abort here)
    var ni;
    if (cfg.wallSnap) {
      var clickedWall = wall || getNearestWall(pt.x, pt.y, pW, pH, mgX, mgY);
      var _sn = snapToWallInterior(clickedWall, pt.x, pt.y, iwPx, ihPx, pW, pH, mgX, mgY);
      var candidate = _objectSpread(_objectSpread({
        id: idCounter,
        type: activeTool
      }, _sn), {}, {
        widthFt: cfg.width,
        heightFt: cfg.height
      });
      var others = items.filter(function (i) {
        return i.id !== candidate.id;
      });
      if (checkDoorCollision(candidate, cfg, others, ITEMS, scale)) {
        setToast("A door is blocking this wall! Try clicking a different wall, or move the door first.");
        setTimeout(function () {
          return setToast(null);
        }, 5000);
        return;
      }
      // Check workbench overlap on same wall during placement
      var isH = _sn.wall === "north" || _sn.wall === "south";
      var candPos = isH ? _sn.x : _sn.y;
      var candHalf = cfg.width * scale / 2;
      var _iterator15 = _createForOfIteratorHelper(others),
        _step15;
      try {
        for (_iterator15.s(); !(_step15 = _iterator15.n()).done;) {
          var ob = _step15.value;
          if (ob.type !== "workbench" || ob.wall !== _sn.wall) continue;
          var obW = (ob.widthFt || ITEMS[ob.type].width) * scale / 2;
          var obPos = isH ? ob.x : ob.y;
          if (Math.abs(candPos - obPos) < candHalf + obW - 2) {
            setToast("Another workbench is in the way. Try a different spot on the wall.");
            setTimeout(function () {
              return setToast(null);
            }, 4000);
            return;
          }
        }
      } catch (err) {
        _iterator15.e(err);
      } finally {
        _iterator15.f();
      }
      ni = candidate;
      idCounter++;
    } else if (activeTool === "loft") {
      // Auto-span wall-to-wall (full building width), positioned at click Y
      var loftH = cfg.height; // default 4ft
      var cyFtRound = Math.max(loftH / 2, Math.min(Math.round((pt.y - mgY) / scale), bldgH - loftH / 2));
      var cxFt = bldgW / 2;
      var nL = 0,
        nR = bldgW,
        nT = cyFtRound - loftH / 2,
        nB = cyFtRound + loftH / 2;
      // Prevent overlap with other lofts
      var otherLofts = items.filter(function (i) {
        return i.type === "loft";
      });
      var _iterator16 = _createForOfIteratorHelper(otherLofts),
        _step16;
      try {
        for (_iterator16.s(); !(_step16 = _iterator16.n()).done;) {
          var o = _step16.value;
          var ow = (o.widthFt || cfg.width) / 2,
            oh = (o.heightFt || cfg.height) / 2;
          var ocx = (o.x - mgX) / scale,
            ocy = (o.y - mgY) / scale;
          if (nL < ocx + ow - 0.1 && nR > ocx - ow + 0.1 && nT < ocy + oh - 0.1 && nB > ocy - oh + 0.1) {
            setToast("Can't place a loft overlapping another loft. Move the existing one or click a different spot.");
            setTimeout(function () {
              return setToast(null);
            }, 4000);
            return;
          }
        }
      } catch (err) {
        _iterator16.e(err);
      } finally {
        _iterator16.f();
      }
      ni = {
        id: idCounter++,
        type: "loft",
        x: mgX + cxFt * scale,
        y: mgY + cyFtRound * scale,
        rotation: 0,
        wall: null,
        widthFt: bldgW,
        heightFt: loftH
      };
    } else if (wall) {
      var _sn2 = snapToWall(wall, pt.x, pt.y, iwPx, ihPx, pW, pH, mgX, mgY);
      // Placing a door/window/RO had NO overlap check at all, so one could be click-placed straight
      // on top of another door, or onto a workbench’s wall span. Both checks now run here, matching
      // the wallSnap (workbench) branch, so the invariant holds whichever item is the one moving.
      var cand = _objectSpread(_objectSpread({
        id: -1,
        type: activeTool
      }, _sn2), {}, {
        widthFt: cfg.width,
        heightFt: cfg.height
      });
      if (checkDoorCollision(cand, cfg, items, ITEMS, scale)) {
        setToast("Something is already on that spot. Pick a clear part of the wall.");
        setTimeout(function () {
          return setToast(null);
        }, 4000);
        return;
      }
      if (checkWorkbenchOverlap(_sn2, iwPx, items, ITEMS, scale)) {
        setToast("A workbench is on that wall — place this somewhere else on the wall.");
        setTimeout(function () {
          return setToast(null);
        }, 4000);
        return;
      }
      ni = _objectSpread(_objectSpread({
        id: idCounter++,
        type: activeTool
      }, _sn2), {}, {
        widthFt: cfg.width,
        heightFt: cfg.height
      });
    } else {
      var x = Math.max(mgX + iwPx / 2, Math.min(pt.x, mgX + pW - iwPx / 2));
      var y = Math.max(mgY + ihPx / 2, Math.min(pt.y, mgY + pH - ihPx / 2));
      ni = {
        id: idCounter++,
        type: activeTool,
        x: x,
        y: y,
        rotation: 0,
        wall: null,
        widthFt: cfg.width,
        heightFt: cfg.height
      };
    }
    setItems(function (p) {
      return [].concat(_toConsumableArray(p), [ni]);
    });
    setActiveTool(null);
    setToast(null);
  }, [activeTool, dragging, getSvgPt, items, mgX, mgY, pW, pH, scale, ITEMS, pendingRemoval, selectedId, editingNoteId, gateRequired]);

  // Place the door chosen in the picker at the remembered wall/click point. Snapshots the
  // door's spec (so a later catalog edit never changes this saved design) + the shopper's
  // swing/operation choice onto a stable `fixtureDoor` item.
  var placePickedDoor = useCallback(function (fx, swing, operation) {
    // Swap mode: replace the selected door in place (keep its wall/position) with the chosen door.
    if (swapId != null && fx) {
      var wFt = (Number(fx.widthIn) || 36) / 12;
      setItems(function (p) {
        return p.map(function (it) {
          return it.id === swapId ? _objectSpread(_objectSpread({}, it), {}, {
            type: "fixtureDoor",
            fixtureItemId: fx.id,
            doorName: fx.name || "Door",
            planLabel: fx.planLabel && String(fx.planLabel).trim() || (fx.name || "DOOR").toUpperCase().slice(0, 6),
            price: fx.price != null ? fx.price : null,
            widthIn: Number(fx.widthIn) || null,
            heightIn: Number(fx.heightIn) || null,
            widthFt: wFt,
            swing: swing || it.swing || null,
            operation: operation || it.operation || null
          }) : it;
        });
      });
      setSwapId(null);
      setDoorPick(null);
      setToast(null);
      return;
    }
    if (!doorPick || !fx) return;
    var widthFt = (Number(fx.widthIn) || 36) / 12;
    var iwPx = widthFt * scale,
      ihPx = 0.5 * scale;
    var sn = snapToWall(doorPick.wall, doorPick.ptx, doorPick.pty, iwPx, ihPx, pW, pH, mgX, mgY);
    var ni = _objectSpread(_objectSpread({
      id: idCounter++,
      type: "fixtureDoor"
    }, sn), {}, {
      widthFt: widthFt,
      heightFt: 0.5,
      fixtureItemId: fx.id,
      doorName: fx.name || "Door",
      planLabel: fx.planLabel && String(fx.planLabel).trim() || (fx.name || "DOOR").toUpperCase().slice(0, 6),
      price: fx.price != null ? fx.price : null,
      widthIn: Number(fx.widthIn) || null,
      heightIn: Number(fx.heightIn) || null,
      swing: swing || null,
      operation: operation || null
    });
    if (checkDoorCollision(ni, {
      width: widthFt
    }, items, ITEMS, scale)) {
      setToast("A door is already there — pick a different spot on the wall.");
      setTimeout(function () {
        return setToast(null);
      }, 4000);
      setDoorPick(null);
      return;
    }
    setItems(function (p) {
      return [].concat(_toConsumableArray(p), [ni]);
    });
    setSelectedId(ni.id);
    setDoorPick(null);
    setToast(null);
  }, [swapId, doorPick, items, mgX, mgY, pW, pH, scale, ITEMS]);

  // Place the window style chosen in the picker at the remembered wall/point. A catalog window is
  // a normal type:"window" item (reuses the built-in window render/collision/payload) carrying the
  // style's width + a priced snapshot; fixtureItemId is what marks it as a catalog (vs built-in) window.
  var placePickedWindow = useCallback(function (fx) {
    if (swapId != null && fx) {
      var wFt = (Number(fx.widthIn) || 24) / 12;
      setItems(function (p) {
        return p.map(function (it) {
          return it.id === swapId ? _objectSpread(_objectSpread({}, it), {}, {
            type: "window",
            fixtureItemId: fx.id,
            windowName: fx.name || "Window",
            planLabel: fx.planLabel && String(fx.planLabel).trim() || (fx.name || "WIN").toUpperCase().slice(0, 6),
            price: fx.price != null ? fx.price : null,
            widthIn: Number(fx.widthIn) || null,
            heightIn: Number(fx.heightIn) || null,
            widthFt: wFt
          }) : it;
        });
      });
      setSwapId(null);
      setWindowPick(null);
      setToast(null);
      return;
    }
    if (!windowPick || !fx) return;
    var widthFt = (Number(fx.widthIn) || 24) / 12;
    var iwPx = widthFt * scale,
      ihPx = 0.5 * scale;
    var sn = snapToWall(windowPick.wall, windowPick.ptx, windowPick.pty, iwPx, ihPx, pW, pH, mgX, mgY);
    var ni = _objectSpread(_objectSpread({
      id: idCounter++,
      type: "window"
    }, sn), {}, {
      widthFt: widthFt,
      heightFt: 0.5,
      fixtureItemId: fx.id,
      windowName: fx.name || "Window",
      planLabel: fx.planLabel && String(fx.planLabel).trim() || (fx.name || "WIN").toUpperCase().slice(0, 6),
      price: fx.price != null ? fx.price : null,
      widthIn: Number(fx.widthIn) || null,
      heightIn: Number(fx.heightIn) || null
    });
    if (checkDoorCollision(ni, {
      width: widthFt
    }, items, ITEMS, scale)) {
      setToast("Something's already there — pick a different spot on the wall.");
      setTimeout(function () {
        return setToast(null);
      }, 4000);
      setWindowPick(null);
      return;
    }
    setItems(function (p) {
      return [].concat(_toConsumableArray(p), [ni]);
    });
    setSelectedId(ni.id);
    setWindowPick(null);
    setToast(null);
  }, [swapId, windowPick, items, mgX, mgY, pW, pH, scale, ITEMS]);

  // Place the ramp style chosen in the picker on the remembered door. A custom ramp is a normal
  // type:"ramp" item (so all ramp machinery applies) but takes the style's OWN width + length
  // (length = the ramp's run/depth out from the door) and snapshots its spec + price.
  var placePickedRamp = useCallback(function (fx) {
    if (swapId != null && fx) {
      var wFt = (Number(fx.widthIn) || 36) / 12;
      var dpt = (Number(fx.heightIn) || 0) / 12 || RAMP_SPACE_FT;
      setItems(function (p) {
        return p.map(function (it) {
          return it.id === swapId ? _objectSpread(_objectSpread({}, it), {}, {
            type: "ramp",
            fixtureItemId: fx.id,
            rampName: fx.name || "Ramp",
            planLabel: fx.planLabel && String(fx.planLabel).trim() || (fx.name || "RAMP").toUpperCase().slice(0, 6),
            price: fx.price != null ? fx.price : null,
            widthIn: Number(fx.widthIn) || null,
            heightIn: Number(fx.heightIn) || null,
            widthFt: wFt,
            heightFt: dpt
          }) : it;
        });
      });
      setSwapId(null);
      setRampPick(null);
      setToast(null);
      return;
    }
    if (!rampPick || !fx) return;
    var door = rampPick.door;
    var widthFt = (Number(fx.widthIn) || 36) / 12;
    var rampDepth = (Number(fx.heightIn) || 0) / 12 || RAMP_SPACE_FT; // style length = run out from the door
    var rampDepthPx = rampDepth * scale;
    var rx, ry, rot;
    if (door.wall === "north") {
      rx = door.x;
      ry = mgY - rampDepthPx / 2;
      rot = 0;
    } else if (door.wall === "south") {
      rx = door.x;
      ry = mgY + pH + rampDepthPx / 2;
      rot = 0;
    } else if (door.wall === "west") {
      rx = mgX - rampDepthPx / 2;
      ry = door.y;
      rot = 90;
    } else if (door.wall === "east") {
      rx = mgX + pW + rampDepthPx / 2;
      ry = door.y;
      rot = 90;
    } else {
      setRampPick(null);
      return;
    }
    var ni = {
      id: idCounter++,
      type: "ramp",
      x: rx,
      y: ry,
      rotation: rot,
      wall: door.wall,
      widthFt: widthFt,
      heightFt: rampDepth,
      snapDoorId: door.id,
      fixtureItemId: fx.id,
      rampName: fx.name || "Ramp",
      planLabel: fx.planLabel && String(fx.planLabel).trim() || (fx.name || "RAMP").toUpperCase().slice(0, 6),
      price: fx.price != null ? fx.price : null,
      widthIn: Number(fx.widthIn) || null,
      heightIn: Number(fx.heightIn) || null
    };
    setItems(function (p) {
      return [].concat(_toConsumableArray(p), [ni]);
    });
    setSelectedId(ni.id);
    setRampPick(null);
    setToast(null);
  }, [swapId, rampPick, mgX, mgY, pW, pH, scale, RAMP_SPACE_FT]);
  var onPtrDown = useCallback(function (e, item) {
    e.stopPropagation();
    if (planLockedRef.current) return; // no selecting or dragging a building that exists
    if (gateRequired) {
      setGateOpen(true);
      return;
    }
    if (pendingRemoval) return; // pick mode: overlays handle the pick; no select/drag
    if (activeTool) return;
    movedRef.current = false;
    gestureStartRef.current = {
      x: e.touches ? e.touches[0].clientX : e.clientX,
      y: e.touches ? e.touches[0].clientY : e.clientY
    };
    setSelectedId(item.id);
    var cfg = ITEMS[item.type];
    if (resizing || cfg && cfg.doorSnap) return; // don't drag ramps or while resizing
    var pt = getSvgPt(e);
    if (cfg && cfg.lineType) {
      // Line is stored as two endpoints; track midpoint offset + half-deltas
      // so a body drag translates both endpoints rigidly.
      var midX = (item.x1 + item.x2) / 2,
        midY = (item.y1 + item.y2) / 2;
      setDragging({
        id: item.id,
        kind: "line",
        ox: pt.x - midX,
        oy: pt.y - midY,
        halfDx: (item.x2 - item.x1) / 2,
        halfDy: (item.y2 - item.y1) / 2
      });
      return;
    }
    setDragging({
      id: item.id,
      ox: pt.x - item.x,
      oy: pt.y - item.y,
      startX: item.x,
      startY: item.y
    });
  }, [activeTool, getSvgPt, resizing, ITEMS, pendingRemoval, gateRequired]);
  var startResize = useCallback(function (e, item, handle) {
    e.preventDefault();
    if (planLockedRef.current) return;
    movedRef.current = false;
    gestureStartRef.current = {
      x: e.touches ? e.touches[0].clientX : e.clientX,
      y: e.touches ? e.touches[0].clientY : e.clientY
    };
    var pt = getSvgPt(e);
    setResizing({
      id: item.id,
      handle: handle,
      startPt: pt,
      origWidthFt: item.widthFt,
      origHeightFt: item.heightFt,
      origWidthPx: item.widthPx,
      origHeightPx: item.heightPx,
      origX: item.x,
      origY: item.y
    });
  }, [getSvgPt]);
  var getResizeBounds = useCallback(function (item) {
    var isHoriz = item.wall === "north" || item.wall === "south";
    var wallLen = isHoriz ? bldgW : bldgH;
    var minEdge = 0; // wall start in ft
    var maxEdge = wallLen; // wall end in ft

    // Find obstacles on same wall
    items.forEach(function (other) {
      if (other.id === item.id || other.wall !== item.wall) return;
      var oCfg = ITEMS[other.type];
      if (!oCfg) return;
      var oW = other.widthFt || oCfg.width;
      var oPos = isHoriz ? (other.x - mgX) / scale : (other.y - mgY) / scale;
      var oLeft = oPos - oW / 2;
      var oRight = oPos + oW / 2;
      var itemPos = isHoriz ? (item.x - mgX) / scale : (item.y - mgY) / scale;
      if (oRight <= itemPos) minEdge = Math.max(minEdge, oRight);
      if (oLeft >= itemPos) maxEdge = Math.min(maxEdge, oLeft);
    });
    return {
      minEdge: minEdge,
      maxEdge: maxEdge,
      isHoriz: isHoriz
    };
  }, [items, ITEMS, bldgW, bldgH, mgX, mgY, scale]);
  var onPtrMove = useCallback(function (e) {
    // Mark the gesture as a real drag/resize once the pointer travels past a
    // small jitter threshold — onPtrUp uses this to decide whether the
    // trailing click should be swallowed (see movedRef declaration).
    if (gestureStartRef.current && !movedRef.current) {
      var gx = e.touches ? e.touches[0].clientX : e.clientX;
      var gy = e.touches ? e.touches[0].clientY : e.clientY;
      if (Math.abs(gx - gestureStartRef.current.x) > 4 || Math.abs(gy - gestureStartRef.current.y) > 4) movedRef.current = true;
    }
    if (resizing) {
      var _pt = getSvgPt(e);
      var _it5 = items.find(function (i) {
        return i.id === resizing.id;
      });
      if (!_it5) return;

      // Note leader (pointer) drag: the target dot follows the cursor anywhere
      // on the visible sheet. Dropping it back onto the note removes the
      // pointer (handled in onPtrUp so the handle doesn't snap away mid-drag).
      if (_it5.type === "textNote" && resizing.handle === "leader") {
        var nx = Math.max(0, Math.min(_pt.x, PAGE_W));
        var ny = Math.max(0, Math.min(_pt.y, TEXT_BAND_TOP));
        setItems(function (p) {
          return p.map(function (i) {
            return i.id === resizing.id ? _objectSpread(_objectSpread({}, i), {}, {
              leader: {
                x: nx,
                y: ny
              }
            }) : i;
          });
        });
        return;
      }

      // Text-note resize: drag the bottom-right corner. The top-left stays
      // pinned, so the box grows toward the cursor and the text reflows live.
      if (_it5.type === "textNote") {
        var tlX = resizing.origX - resizing.origWidthPx / 2;
        var tlY = resizing.origY - resizing.origHeightPx / 2;
        var newW = Math.max(80, Math.min(_pt.x - tlX, PAGE_W - tlX - 4));
        var newH = Math.max(28, Math.min(_pt.y - tlY, TEXT_BAND_TOP - tlY - 4));
        setItems(function (p) {
          return p.map(function (i) {
            return i.id === resizing.id ? _objectSpread(_objectSpread({}, i), {}, {
              widthPx: newW,
              heightPx: newH,
              x: tlX + newW / 2,
              y: tlY + newH / 2
            }) : i;
          });
        });
        return;
      }

      // Line endpoint drag: snap the endpoint to the cursor, clamped to the visible page area
      if (_it5.type === "line") {
        var newX = Math.max(0, Math.min(_pt.x, PAGE_W));
        var newY = Math.max(0, Math.min(_pt.y, TEXT_BAND_TOP));
        setItems(function (p) {
          return p.map(function (i) {
            return i.id === resizing.id ? _objectSpread(_objectSpread({}, i), resizing.handle === "ep1" ? {
              x1: newX,
              y1: newY
            } : {
              x2: newX,
              y2: newY
            }) : i;
          });
        });
        return;
      }

      // Loft: free-floating 4-sided resize with collision
      if (_it5.type === "loft") {
        var hd = resizing.handle;
        var mouseXft = Math.round((_pt.x - mgX) / scale);
        var mouseYft = Math.round((_pt.y - mgY) / scale);
        var origCxFt = (resizing.origX - mgX) / scale;
        var origCyFt = (resizing.origY - mgY) / scale;
        var origW = resizing.origWidthFt;
        var origH = resizing.origHeightFt;
        var oL = Math.round(origCxFt - origW / 2),
          oR = oL + origW;
        var oT = Math.round(origCyFt - origH / 2),
          oB = oT + origH;
        var nL = oL,
          nR = oR,
          nT = oT,
          nB = oB;
        if (hd === "right") nR = Math.max(oL + 2, Math.min(mouseXft, bldgW));else if (hd === "left") nL = Math.min(oR - 2, Math.max(mouseXft, 0));else if (hd === "bottom") nB = Math.max(oT + 2, Math.min(mouseYft, bldgH));else if (hd === "top") nT = Math.min(oB - 2, Math.max(mouseYft, 0));

        // Check overlap with other lofts — clamp edge if it would overlap
        var otherLofts = items.filter(function (i) {
          return i.type === "loft" && i.id !== resizing.id;
        });
        var _iterator17 = _createForOfIteratorHelper(otherLofts),
          _step17;
        try {
          for (_iterator17.s(); !(_step17 = _iterator17.n()).done;) {
            var o = _step17.value;
            var ow = (o.widthFt || 6) / 2,
              oh = (o.heightFt || 4) / 2;
            var ocx = (o.x - mgX) / scale,
              ocy = (o.y - mgY) / scale;
            var olL = ocx - ow,
              olR = ocx + ow,
              olT = ocy - oh,
              olB = ocy + oh;
            // Only clamp if the other dimensions overlap (2D check)
            if (nT < olB && nB > olT) {
              // vertically overlapping
              if (hd === "right" && nR > olL && oL < olL) nR = Math.round(olL);
              if (hd === "left" && nL < olR && oR > olR) nL = Math.round(olR);
            }
            if (nL < olR && nR > olL) {
              // horizontally overlapping
              if (hd === "bottom" && nB > olT && oT < olT) nB = Math.round(olT);
              if (hd === "top" && nT < olB && oB > olB) nT = Math.round(olB);
            }
          }
        } catch (err) {
          _iterator17.e(err);
        } finally {
          _iterator17.f();
        }
        var nW = Math.max(2, nR - nL),
          nH = Math.max(2, nB - nT);
        setItems(function (p) {
          return p.map(function (i) {
            return i.id === resizing.id ? _objectSpread(_objectSpread({}, i), {}, {
              widthFt: nW,
              heightFt: nH,
              x: mgX + (nL + nR) / 2 * scale,
              y: mgY + (nT + nB) / 2 * scale
            }) : i;
          });
        });
        return;
      }

      // Wall-attached 1D resize: workbench snaps to integer feet, rough
      // opening resizes smoothly to whatever width the user drags to.
      var isHoriz = _it5.wall === "north" || _it5.wall === "south";
      var isRO = _it5.type === "roughOpening";

      // Mouse position in feet along the wall axis
      var mouseFt = isHoriz ? (_pt.x - mgX) / scale : (_pt.y - mgY) / scale;
      var mouseFtVal = isRO ? mouseFt : Math.round(mouseFt);
      var origCenterFt = isHoriz ? (resizing.origX - mgX) / scale : (resizing.origY - mgY) / scale;
      var origLeft = isRO ? origCenterFt - resizing.origWidthFt / 2 : Math.round(origCenterFt - resizing.origWidthFt / 2);
      var origRight = origLeft + resizing.origWidthFt;
      var origItem = _objectSpread(_objectSpread({}, _it5), {}, {
        x: resizing.origX,
        y: resizing.origY,
        widthFt: resizing.origWidthFt
      });
      var _getResizeBounds = getResizeBounds(origItem),
        minEdge = _getResizeBounds.minEdge,
        maxEdge = _getResizeBounds.maxEdge;
      var minWidth = isRO ? 0.5 : 2;
      var newLeft = origLeft,
        newRight = origRight;
      if (resizing.handle === "max") {
        newRight = Math.max(origLeft + minWidth, Math.min(mouseFtVal, isRO ? maxEdge : Math.floor(maxEdge)));
      } else {
        newLeft = Math.min(origRight - minWidth, Math.max(mouseFtVal, isRO ? minEdge : Math.ceil(minEdge)));
      }
      var newWidthFt = newRight - newLeft;
      var newCenterFt = (newLeft + newRight) / 2;
      var newPos = (isHoriz ? mgX : mgY) + newCenterFt * scale;
      setItems(function (p) {
        return p.map(function (i) {
          return i.id === resizing.id ? _objectSpread(_objectSpread({}, i), {}, {
            widthFt: newWidthFt,
            x: isHoriz ? newPos : i.x,
            y: isHoriz ? i.y : newPos
          }) : i;
        });
      });
      return;
    }
    if (!dragging) return;
    var pt = getSvgPt(e);
    var it = items.find(function (i) {
      return i.id === dragging.id;
    });
    if (!it) return;
    var cfg = ITEMS[it.type];
    if (!cfg) return;

    // Line body drag: translate both endpoints by the same delta, clamped so
    // neither endpoint leaves the visible page area.
    if (dragging.kind === "line") {
      var newMidX = pt.x - dragging.ox,
        newMidY = pt.y - dragging.oy;
      var ahx = Math.abs(dragging.halfDx),
        ahy = Math.abs(dragging.halfDy);
      var cMidX = Math.max(ahx, Math.min(newMidX, PAGE_W - ahx));
      var cMidY = Math.max(ahy, Math.min(newMidY, TEXT_BAND_TOP - ahy));
      setItems(function (p) {
        return p.map(function (i) {
          return i.id === dragging.id ? _objectSpread(_objectSpread({}, i), {}, {
            x1: cMidX - dragging.halfDx,
            y1: cMidY - dragging.halfDy,
            x2: cMidX + dragging.halfDx,
            y2: cMidY + dragging.halfDy
          }) : i;
        });
      });
      return;
    }
    var rx = pt.x - dragging.ox;
    var ry = pt.y - dragging.oy;
    var iWidthFt = it.widthFt || cfg.width;
    if (cfg.wallOnly) {
      // Always snap to nearest wall during drag so the door follows the mouse
      // and doesn't get stuck off-wall.
      var w = getWallFromClick(rx, ry, pW, pH, mgX, mgY) || getNearestWall(rx, ry, pW, pH, mgX, mgY);
      var sn = snapToWall(w, rx, ry, iWidthFt * scale, cfg.height * scale, pW, pH, mgX, mgY);
      // A ramp snapped to this door must follow it (position + wall); otherwise it
      // detaches and the stale geometry is rasterized into the exported PDF. (audit #F4)
      var rampDepthPx = RAMP_SPACE_FT * scale;
      var relocRamp = function relocRamp(rmp) {
        if (sn.wall === "north") return _objectSpread(_objectSpread({}, rmp), {}, {
          x: sn.x,
          y: mgY - rampDepthPx / 2,
          rotation: 0,
          wall: "north"
        });
        if (sn.wall === "south") return _objectSpread(_objectSpread({}, rmp), {}, {
          x: sn.x,
          y: mgY + pH + rampDepthPx / 2,
          rotation: 0,
          wall: "south"
        });
        if (sn.wall === "west") return _objectSpread(_objectSpread({}, rmp), {}, {
          x: mgX - rampDepthPx / 2,
          y: sn.y,
          rotation: 90,
          wall: "west"
        });
        if (sn.wall === "east") return _objectSpread(_objectSpread({}, rmp), {}, {
          x: mgX + pW + rampDepthPx / 2,
          y: sn.y,
          rotation: 90,
          wall: "east"
        });
        return rmp;
      };
      // Refuse the move rather than commit an overlap — same posture as the workbench branch
      // below, which simply returns. Without this, dragging a door onto another door or onto a
      // workbench silently succeeded, producing the exact layout the workbench-side toast prevents.
      var dOthers = items.filter(function (i) {
        return i.id !== dragging.id;
      });
      var dCand = _objectSpread(_objectSpread(_objectSpread({}, it), sn), {}, {
        widthFt: iWidthFt
      });
      if (checkDoorCollision(dCand, _objectSpread(_objectSpread({}, cfg), {}, {
        width: iWidthFt
      }), dOthers, ITEMS, scale)) return;
      if (checkWorkbenchOverlap(sn, iWidthFt * scale, dOthers, ITEMS, scale)) return;
      setItems(function (p) {
        return p.map(function (i) {
          return i.id === dragging.id ? _objectSpread(_objectSpread({}, i), sn) : i.type === "ramp" && i.snapDoorId === dragging.id ? relocRamp(i) : i;
        });
      });
    } else if (cfg.wallSnap) {
      var nw = getNearestWall(rx, ry, pW, pH, mgX, mgY);
      var _sn3 = snapToWallInterior(nw, rx, ry, iWidthFt * scale, cfg.height * scale, pW, pH, mgX, mgY);
      var cand = _objectSpread(_objectSpread({}, it), _sn3);
      // Check collision with doors AND other workbenches on same wall
      var others = items.filter(function (i) {
        return i.id !== dragging.id;
      });
      if (checkDoorCollision(cand, _objectSpread(_objectSpread({}, cfg), {}, {
        width: iWidthFt
      }), others, ITEMS, scale)) return;
      // Check workbench overlap on same wall
      var isH = _sn3.wall === "north" || _sn3.wall === "south";
      var candPos = isH ? _sn3.x : _sn3.y;
      var candHalf = iWidthFt * scale / 2;
      var _iterator18 = _createForOfIteratorHelper(others),
        _step18;
      try {
        for (_iterator18.s(); !(_step18 = _iterator18.n()).done;) {
          var ob = _step18.value;
          if (ob.type !== "workbench" || ob.wall !== _sn3.wall) continue;
          var obW = (ob.widthFt || ITEMS[ob.type].width) * scale / 2;
          var obPos = isH ? ob.x : ob.y;
          if (Math.abs(candPos - obPos) < candHalf + obW - 2) return; // overlap
        }
      } catch (err) {
        _iterator18.e(err);
      } finally {
        _iterator18.f();
      }
      setItems(function (p) {
        return p.map(function (i) {
          return i.id === dragging.id ? _objectSpread(_objectSpread({}, i), _sn3) : i;
        });
      });
    } else {
      // Notes drag anywhere on the visible page (no plan constraint)
      if (cfg.noteType) {
        var _x8 = Math.max(20, Math.min(rx, PAGE_W - 20));
        var _y = Math.max(20, Math.min(ry, TEXT_BAND_TOP - 20));
        setItems(function (p) {
          return p.map(function (i) {
            return i.id === dragging.id ? _objectSpread(_objectSpread({}, i), {}, {
              x: _x8,
              y: _y
            }) : i;
          });
        });
        return;
      }
      var iHeightFt = it.heightFt || cfg.height;
      var halfW = iWidthFt / 2,
        halfH = iHeightFt / 2;
      var snapFt = 1; // snap threshold in feet

      // Convert desired position to feet
      var cxFt = (rx - mgX) / scale;
      var cyFt = (ry - mgY) / scale;

      // Round to integer feet
      cxFt = Math.round(cxFt);
      cyFt = Math.round(cyFt);

      // Snap edges to walls
      if (cxFt - halfW < snapFt) cxFt = halfW;else if (cxFt + halfW > bldgW - snapFt) cxFt = bldgW - halfW;
      if (cyFt - halfH < snapFt) cyFt = halfH;else if (cyFt + halfH > bldgH - snapFt) cyFt = bldgH - halfH;

      // Snap edges to other lofts
      if (it.type === "loft") {
        var _otherLofts = items.filter(function (i) {
          return i.type === "loft" && i.id !== dragging.id;
        });
        var l = cxFt - halfW,
          r = cxFt + halfW,
          t = cyFt - halfH,
          b = cyFt + halfH;
        var _iterator19 = _createForOfIteratorHelper(_otherLofts),
          _step19;
        try {
          for (_iterator19.s(); !(_step19 = _iterator19.n()).done;) {
            var _o2 = _step19.value;
            var oW = (_o2.widthFt || cfg.width) / 2,
              oH = (_o2.heightFt || cfg.height) / 2;
            var oCx = (_o2.x - mgX) / scale,
              oCy = (_o2.y - mgY) / scale;
            var _oL = oCx - oW,
              _oR = oCx + oW,
              _oT = oCy - oH,
              _oB = oCy + oH;
            if (t < _oB && b > _oT) {
              if (Math.abs(r - _oL) < snapFt) cxFt = _oL - halfW;else if (Math.abs(l - _oR) < snapFt) cxFt = _oR + halfW;
            }
            if (l < _oR && r > _oL) {
              if (Math.abs(b - _oT) < snapFt) cyFt = _oT - halfH;else if (Math.abs(t - _oB) < snapFt) cyFt = _oB + halfH;
            }
            l = cxFt - halfW;
            r = cxFt + halfW;
            t = cyFt - halfH;
            b = cyFt + halfH;
          }

          // Constrain to building
        } catch (err) {
          _iterator19.e(err);
        } finally {
          _iterator19.f();
        }
        cxFt = Math.max(halfW, Math.min(cxFt, bldgW - halfW));
        cyFt = Math.max(halfH, Math.min(cyFt, bldgH - halfH));

        // Check overlap — reject if overlapping any loft
        var fL = cxFt - halfW,
          fR = cxFt + halfW,
          fT = cyFt - halfH,
          fB = cyFt + halfH;
        var _iterator20 = _createForOfIteratorHelper(_otherLofts),
          _step20;
        try {
          for (_iterator20.s(); !(_step20 = _iterator20.n()).done;) {
            var _o3 = _step20.value;
            var oW2 = (_o3.widthFt || cfg.width) / 2,
              oH2 = (_o3.heightFt || cfg.height) / 2;
            var oCx2 = (_o3.x - mgX) / scale,
              oCy2 = (_o3.y - mgY) / scale;
            if (fL < oCx2 + oW2 - 0.1 && fR > oCx2 - oW2 + 0.1 && fT < oCy2 + oH2 - 0.1 && fB > oCy2 - oH2 + 0.1) return;
          }

          // Validate attachment — both ends of at least one axis must touch walls or other lofts
        } catch (err) {
          _iterator20.e(err);
        } finally {
          _iterator20.f();
        }
        var olEdges = _otherLofts.map(function (o) {
          var ow = (o.widthFt || cfg.width) / 2,
            oh = (o.heightFt || cfg.height) / 2;
          var ox = (o.x - mgX) / scale,
            oy = (o.y - mgY) / scale;
          return {
            l: ox - ow,
            r: ox + ow,
            t: oy - oh,
            b: oy + oh
          };
        });
        if (!checkLoftAttached(fL, fR, fT, fB, bldgW, bldgH, olEdges)) {
          setItems(function (p) {
            return p.map(function (i) {
              return i.id === dragging.id ? _objectSpread(_objectSpread({}, i), {}, {
                x: mgX + cxFt * scale,
                y: mgY + cyFt * scale
              }) : i;
            });
          });
          return;
        }
      } else {
        cxFt = Math.max(halfW, Math.min(cxFt, bldgW - halfW));
        cyFt = Math.max(halfH, Math.min(cyFt, bldgH - halfH));
      }
      var x = mgX + cxFt * scale;
      var y = mgY + cyFt * scale;
      setItems(function (p) {
        return p.map(function (i) {
          return i.id === dragging.id ? _objectSpread(_objectSpread({}, i), {}, {
            x: x,
            y: y
          }) : i;
        });
      });
    }
  }, [dragging, resizing, getSvgPt, items, mgX, mgY, pW, pH, scale, ITEMS, getResizeBounds]);
  var onPtrUp = useCallback(function () {
    // Dropping a note's leader handle back onto the note removes the pointer
    // ("drag it home to delete it") — checked on release, not mid-drag, so the
    // handle doesn't vanish under the cursor while crossing the note.
    if (resizing && resizing.handle === "leader") {
      setItems(function (p) {
        return p.map(function (i) {
          if (i.id !== resizing.id || !i.leader) return i;
          var w = i.widthPx || 160,
            h = i.heightPx || 40;
          var inside = Math.abs(i.leader.x - i.x) < w / 2 + 6 && Math.abs(i.leader.y - i.y) < h / 2 + 6;
          return inside ? _objectSpread(_objectSpread({}, i), {}, {
            leader: undefined
          }) : i;
        });
      });
    }
    setDragging(null);
    setResizing(null);
    // Swallow the trailing click ONLY if the gesture actually moved — a
    // stationary press must remain a click so clicking a selected note can
    // enter in-place edit (an unconditional swallow made notes uneditable).
    justGesturedRef.current = movedRef.current;
    movedRef.current = false;
    gestureStartRef.current = null;
  }, [resizing]);
  useEffect(function () {
    if (dragging || resizing) {
      window.addEventListener("mousemove", onPtrMove);
      window.addEventListener("mouseup", onPtrUp);
      window.addEventListener("touchmove", onPtrMove, {
        passive: false
      });
      window.addEventListener("touchend", onPtrUp);
      return function () {
        window.removeEventListener("mousemove", onPtrMove);
        window.removeEventListener("mouseup", onPtrUp);
        window.removeEventListener("touchmove", onPtrMove);
        window.removeEventListener("touchend", onPtrUp);
      };
    }
  }, [dragging, resizing, onPtrMove, onPtrUp]);
  var delSel = function delSel() {
    if (selectedId) {
      setItems(function (p) {
        return p.filter(function (i) {
          return i.id !== selectedId && !(i.type === "ramp" && i.snapDoorId === selectedId);
        });
      });
      setSelectedId(null);
      setEditingNoteId(null);
    }
  };
  // Rotate the selection.
  //
  // Lofts are handled by SWAPPING widthFt/heightFt rather than by setting a rotation angle, and
  // that is the whole fix for the rotated-loft class of bug. Both renderers honour `rotation` (SVG
  // transform, canvas ctx.rotate) and the hit test swaps the bbox for 90/270 — but EVERY piece of
  // loft geometry ignored it: the loft-vs-loft overlap checks, the resize clamps, the drag
  // containment clamp (halfW/halfH from the UNROTATED widthFt/heightFt) and checkLoftAttached /
  // the unattachedLofts banner. So one click on Rotate could leave a 10x4 loft rendering as 4x10,
  // sticking 3ft outside the north wall with no warning, visually overlapping another loft, and
  // reporting attached/unattached wrongly — and that geometry is what gets rasterized into the PDF
  // the customer signs against and the shop builds from.
  //
  // A loft is an axis-aligned resizable rectangle, so a 90-degree turn IS a width/height swap;
  // expressing it that way keeps `rotation` at 0 and leaves every invariant above valid as
  // written, instead of teaching six separate places about rotation. The swap is validated exactly
  // like a drag: clamp the centre back inside the building, then refuse if the new footprint would
  // overlap another loft or no longer fit.
  //
  // doorSnap items (ramps) are excluded too: a ramp's position and rotation are DERIVED from the
  // door it is attached to, and it deliberately cannot be dragged — rotating it only desynced it
  // from its door.
  var rotSel = function rotSel() {
    if (!selectedId) return;
    var sel = items.find(function (i) {
      return i.id === selectedId;
    });
    if (!sel) return;
    var c = ITEMS[sel.type];
    if (c && (c.wallOnly || c.wallSnap || c.lineType || c.doorSnap)) return;
    if (sel.type === "loft") {
      var curW = sel.widthFt || c.width,
        curH = sel.heightFt || c.height;
      var newW = curH,
        newH = curW;
      if (newW > bldgW || newH > bldgH) {
        setToast("Turning this loft won't fit inside the building. Resize it first.");
        setTimeout(function () {
          return setToast(null);
        }, 4000);
        return;
      }
      var halfW = newW / 2,
        halfH = newH / 2;
      var cxFt = (sel.x - mgX) / scale,
        cyFt = (sel.y - mgY) / scale;
      cxFt = Math.max(halfW, Math.min(cxFt, bldgW - halfW));
      cyFt = Math.max(halfH, Math.min(cyFt, bldgH - halfH));
      var fL = cxFt - halfW,
        fR = cxFt + halfW,
        fT = cyFt - halfH,
        fB = cyFt + halfH;
      var _iterator21 = _createForOfIteratorHelper(items),
        _step21;
      try {
        for (_iterator21.s(); !(_step21 = _iterator21.n()).done;) {
          var o = _step21.value;
          if (o.id === sel.id || o.type !== "loft") continue;
          var oW = (o.widthFt || c.width) / 2,
            oH = (o.heightFt || c.height) / 2;
          var oCx = (o.x - mgX) / scale,
            oCy = (o.y - mgY) / scale;
          if (fL < oCx + oW - 0.1 && fR > oCx - oW + 0.1 && fT < oCy + oH - 0.1 && fB > oCy - oH + 0.1) {
            setToast("Turning this loft would overlap another loft. Move one of them first.");
            setTimeout(function () {
              return setToast(null);
            }, 4000);
            return;
          }
        }
      } catch (err) {
        _iterator21.e(err);
      } finally {
        _iterator21.f();
      }
      setItems(function (p) {
        return p.map(function (i) {
          return i.id !== selectedId ? i : _objectSpread(_objectSpread({}, i), {}, {
            widthFt: newW,
            heightFt: newH,
            rotation: 0,
            x: mgX + cxFt * scale,
            y: mgY + cyFt * scale
          });
        });
      });
      return;
    }
    setItems(function (p) {
      return p.map(function (i) {
        return i.id !== selectedId ? i : _objectSpread(_objectSpread({}, i), {}, {
          rotation: ((i.rotation || 0) + 90) % 360
        });
      });
    });
  };
  var clearAll = function clearAll() {
    setItems([]);
    setSelectedId(null);
    setEditingNoteId(null);
  };

  // ─── EXPORT RENDERING (shared by Export modal, PDF, and submit) ───
  // The on-screen SVG already uses page coordinates (cW × cH = 850 × 1100),
  // so the export is a straight 2× DPR rasterization — same scale, same mgX/mgY,
  // same item positions. No coordinate conversion needed.
  var renderExportCanvas = function renderExportCanvas() {
    var dpr = 2;
    var canvas = document.createElement("canvas");
    canvas.width = cW * dpr;
    canvas.height = cH * dpr;
    var ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.fillStyle = "#FFF";
    ctx.fillRect(0, 0, cW, cH);

    // Grid + plan border
    ctx.strokeStyle = "#E8ECF1";
    ctx.lineWidth = 0.5;
    for (var fx = 0; fx <= bldgW; fx++) {
      var x = mgX + fx * scale;
      ctx.beginPath();
      ctx.moveTo(x, mgY);
      ctx.lineTo(x, mgY + pH);
      ctx.stroke();
    }
    for (var fy = 0; fy <= bldgH; fy++) {
      var y = mgY + fy * scale;
      ctx.beginPath();
      ctx.moveTo(mgX, y);
      ctx.lineTo(mgX + pW, y);
      ctx.stroke();
    }
    ctx.strokeStyle = "#1E293B";
    ctx.lineWidth = WALL_THICKNESS;
    ctx.strokeRect(mgX, mgY, pW, pH);

    // Items render in page coordinates directly — same as the SVG.
    // Ramps render first so other items (workbench, doors, etc) sit on top of them.
    _toConsumableArray(items).sort(function (a, b) {
      return (a.type === "ramp" ? 0 : 1) - (b.type === "ramp" ? 0 : 1);
    }).forEach(function (item) {
      var cfg = ITEMS[item.type];
      if (!cfg) return;

      // Line: free-angle segment between two endpoints (page coords)
      if (cfg.lineType) {
        ctx.save();
        ctx.strokeStyle = cfg.color;
        ctx.lineWidth = 2.5;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(item.x1, item.y1);
        ctx.lineTo(item.x2, item.y2);
        ctx.stroke();
        ctx.restore();
        return;
      }

      // Text Note: resizable pill with word-wrapped text (page coords)
      if (cfg.noteType) {
        var text = (item.text || "").trim() || "Note";
        var w = item.widthPx || 160;
        var h = item.heightPx || 40;
        var padX = 8;
        // Leader (pointer) line: dashed from the pill's edge to the target dot.
        // Drawn first (absolute page coords) so the pill sits on top of it.
        if (item.leader) {
          var ep = noteEdgePoint(item.x, item.y, w, h, item.leader.x, item.leader.y);
          var ldx = item.leader.x - ep.x,
            ldy = item.leader.y - ep.y;
          if (Math.sqrt(ldx * ldx + ldy * ldy) > 10) {
            ctx.save();
            ctx.strokeStyle = cfg.color;
            ctx.lineWidth = 1.5;
            ctx.setLineDash([5, 4]);
            ctx.beginPath();
            ctx.moveTo(ep.x, ep.y);
            ctx.lineTo(item.leader.x, item.leader.y);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = cfg.color;
            ctx.beginPath();
            ctx.arc(item.leader.x, item.leader.y, 3.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
          }
        }
        ctx.save();
        ctx.translate(item.x, item.y);
        ctx.fillStyle = "#FFFBEB";
        ctx.strokeStyle = cfg.color;
        ctx.lineWidth = 1.25;
        var r = 4;
        ctx.beginPath();
        ctx.moveTo(-w / 2 + r, -h / 2);
        ctx.lineTo(w / 2 - r, -h / 2);
        ctx.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
        ctx.lineTo(w / 2, h / 2 - r);
        ctx.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2);
        ctx.lineTo(-w / 2 + r, h / 2);
        ctx.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r);
        ctx.lineTo(-w / 2, -h / 2 + r);
        ctx.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
        ctx.fill();
        ctx.stroke();
        ctx.font = "600 12px sans-serif";
        ctx.fillStyle = cfg.color;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        // Word-wrap to fit the box width
        var maxW = w - padX * 2;
        var words = text.split(/\s+/);
        var lines = [];
        var line = "";
        var _iterator22 = _createForOfIteratorHelper(words),
          _step22;
        try {
          for (_iterator22.s(); !(_step22 = _iterator22.n()).done;) {
            var word = _step22.value;
            var test = line ? line + " " + word : word;
            if (ctx.measureText(test).width > maxW && line) {
              lines.push(line);
              line = word;
            } else {
              line = test;
            }
          }
        } catch (err) {
          _iterator22.e(err);
        } finally {
          _iterator22.f();
        }
        if (line) lines.push(line);
        var lineHeight = 14;
        var totalH = lines.length * lineHeight;
        var ly = -totalH / 2 + lineHeight / 2;
        for (var _i4 = 0, _lines = lines; _i4 < _lines.length; _i4++) {
          var ln = _lines[_i4];
          ctx.fillText(ln, 0, ly);
          ly += lineHeight;
        }
        ctx.restore();
        return;
      }

      // Plan-bound items: position is already in page coords; widths are in feet
      var itemW = item.widthFt || cfg.width;
      var itemH = item.heightFt || cfg.height;
      var iw = itemW * scale;
      var ih = itemH * scale;
      ctx.save();
      ctx.translate(item.x, item.y);
      ctx.rotate(item.rotation * Math.PI / 180);
      if (item.type === "loft") {
        ctx.fillStyle = cfg.color + "25";
        ctx.strokeStyle = cfg.color;
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.fillRect(-iw / 2, -ih / 2, iw, ih);
        ctx.strokeRect(-iw / 2, -ih / 2, iw, ih);
        ctx.setLineDash([]);
        ctx.save();
        ctx.beginPath();
        ctx.rect(-iw / 2, -ih / 2, iw, ih);
        ctx.clip();
        ctx.strokeStyle = cfg.color + "40";
        ctx.lineWidth = 1;
        for (var d = -iw; d < iw + ih; d += 12) {
          ctx.beginPath();
          ctx.moveTo(-iw / 2 + d, -ih / 2);
          ctx.lineTo(-iw / 2 + d - ih, ih / 2);
          ctx.stroke();
        }
        ctx.restore();
      } else if (cfg.wallOnly) {
        // Rounded rect for door/window bar (matches SVG rx=1)
        var barH = 10,
          barR = 1;
        ctx.fillStyle = item.type === "roughOpening" ? "#FFFFFF" : item.type === "fixtureDoor" ? fixtureDoorColor(item) : cfg.color;
        ctx.beginPath();
        ctx.moveTo(-iw / 2 + barR, -barH / 2);
        ctx.lineTo(iw / 2 - barR, -barH / 2);
        ctx.quadraticCurveTo(iw / 2, -barH / 2, iw / 2, -barH / 2 + barR);
        ctx.lineTo(iw / 2, barH / 2 - barR);
        ctx.quadraticCurveTo(iw / 2, barH / 2, iw / 2 - barR, barH / 2);
        ctx.lineTo(-iw / 2 + barR, barH / 2);
        ctx.quadraticCurveTo(-iw / 2, barH / 2, -iw / 2, barH / 2 - barR);
        ctx.lineTo(-iw / 2, -barH / 2 + barR);
        ctx.quadraticCurveTo(-iw / 2, -barH / 2, -iw / 2 + barR, -barH / 2);
        ctx.fill();
        if (item.type === "roughOpening") {
          ctx.strokeStyle = "#000000";
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
        if (item.type === "singleDoor") {
          ctx.strokeStyle = cfg.color + "60";
          ctx.lineWidth = 1.5;
          ctx.setLineDash([4, 3]);
          var out = item.wall === "north" || item.wall === "east";
          ctx.beginPath();
          ctx.arc(-iw / 2, 0, iw * 0.8, 0, out ? -Math.PI / 2 : Math.PI / 2, out);
          ctx.stroke();
          ctx.setLineDash([]);
        } else if (item.type === "doubleDoor") {
          ctx.strokeStyle = cfg.color + "60";
          ctx.lineWidth = 1.5;
          ctx.setLineDash([4, 3]);
          var _out2 = item.wall === "north" || item.wall === "east";
          var _r3 = iw * 0.4;
          // Left leaf: hinge at left edge of door
          ctx.beginPath();
          ctx.arc(-iw / 2, 0, _r3, 0, _out2 ? -Math.PI / 2 : Math.PI / 2, _out2);
          ctx.stroke();
          // Right leaf: hinge at right edge of door
          ctx.beginPath();
          ctx.arc(iw / 2, 0, _r3, Math.PI, _out2 ? 3 * Math.PI / 2 : Math.PI / 2, !_out2);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.strokeStyle = "#FFF";
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(0, -5);
          ctx.lineTo(0, 5);
          ctx.stroke();
        } else if (item.type === "fixtureDoor") {
          fixtureDoorCanvas(ctx, item, iw, fixtureDoorColor(item));
        } else if (item.type === "window") {
          ctx.strokeStyle = "#FFF";
          ctx.lineWidth = 1.5;
          [0, -iw / 4, iw / 4].forEach(function (lx) {
            ctx.beginPath();
            ctx.moveTo(lx, -4);
            ctx.lineTo(lx, 4);
            ctx.stroke();
          });
        }
      } else {
        ctx.fillStyle = cfg.color + (item.type === "ramp" ? "12" : "30");
        ctx.strokeStyle = cfg.color + (item.type === "ramp" ? "80" : "FF");
        ctx.lineWidth = item.type === "ramp" ? 1.5 : 2;
        ctx.fillRect(-iw / 2, -ih / 2, iw, ih);
        ctx.strokeRect(-iw / 2, -ih / 2, iw, ih);
      }
      ctx.fillStyle = "#1E293B";
      ctx.font = "bold 11px sans-serif";
      ctx.textAlign = "center";
      if (item.type === "workbench") {
        ctx.fillText("".concat(itemW, " ft"), 0, 0);
        ctx.font = "9px sans-serif";
        ctx.fillText("Workbench", 0, 13);
      } else if (item.type === "ramp") {
        ctx.textAlign = "left";
        ctx.fillText(item.planLabel || "RAMP", -iw / 2 + 5, 4);
      } else if (item.type === "loft") {
        ctx.fillStyle = cfg.color;
        ctx.fillText("LOFT", 0, 0);
        ctx.font = "10px sans-serif";
        ctx.globalAlpha = 0.7;
        ctx.fillText("".concat(itemW, "\xD7").concat(itemH, " ft"), 0, 14);
        ctx.globalAlpha = 1;
      } else {
        var lblY = cfg.wallOnly ? item.wall === "north" || item.wall === "east" ? 14 : -10 : 4;
        var label = cfg.shortLabel;
        if (item.type === "fixtureDoor") label = item.planLabel || cfg.shortLabel;
        if (item.type === "window") label = item.planLabel || cfg.shortLabel;
        if (item.type === "roughOpening") {
          var idx = items.filter(function (i) {
            return i.type === "roughOpening";
          }).findIndex(function (r) {
            return r.id === item.id;
          });
          label = "RO-".concat(idx + 1);
        }
        // Doors + windows prefix their width, e.g. "6' DD".
        if (item.type === "singleDoor" || item.type === "doubleDoor" || item.type === "fixtureDoor" || item.type === "window") {
          var _w3 = fmtFtIn((item.widthFt || cfg.width) * 12);
          if (_w3) label = "".concat(_w3, " ").concat(label);
        }
        ctx.fillText(label, 0, lblY);
      }
      ctx.restore();
    });

    // Size labels + FRONT/BACK/LEFT/RIGHT — drawn after items so a centered ramp doesn't paint over the building chrome.
    ctx.fillStyle = "#475569";
    ctx.font = "bold 13px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("".concat(bldgW, " ft"), mgX + pW / 2, mgY - 16);
    ctx.fillText("".concat(bldgW, " ft"), mgX + pW / 2, mgY + pH + 26);
    ctx.save();
    ctx.translate(mgX - 20, mgY + pH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("".concat(bldgH, " ft"), 0, 0);
    ctx.restore();
    ctx.save();
    ctx.translate(mgX + pW + 24, mgY + pH / 2);
    ctx.rotate(Math.PI / 2);
    ctx.fillText("".concat(bldgH, " ft"), 0, 0);
    ctx.restore();
    if (frontWall) {
      ctx.fillStyle = "#94A3B8";
      ctx.font = "10px sans-serif";
      ctx.fillText(getDisplayLabel("north", frontWall), mgX + pW / 2, mgY - 32);
      ctx.fillText(getDisplayLabel("south", frontWall), mgX + pW / 2, mgY + pH + 42);
      ctx.save();
      ctx.translate(mgX - 38, mgY + pH / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(getDisplayLabel("west", frontWall), 0, 0);
      ctx.restore();
      ctx.save();
      ctx.translate(mgX + pW + 42, mgY + pH / 2);
      ctx.rotate(Math.PI / 2);
      ctx.fillText(getDisplayLabel("east", frontWall), 0, 0);
      ctx.restore();
    }

    // ─── Bottom text band ───
    var TEXT_X = 36;
    var TEXT_RIGHT = cW - 36;
    var TEXT_W = TEXT_RIGHT - TEXT_X;
    var textTop = TEXT_BAND_TOP;
    var textY = textTop + 24;

    // Separator
    ctx.strokeStyle = "#E2E8F0";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(TEXT_X, textTop);
    ctx.lineTo(TEXT_RIGHT, textTop);
    ctx.stroke();
    var customerName = contact.name || "Customer";
    var customerAddr = [contact.street, contact.city, contact.state, contact.zip].filter(Boolean).join(", ");

    // Line 1: Name (left) | Size + Style (right)
    ctx.fillStyle = "#1E293B";
    ctx.font = "bold 16px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(customerName, TEXT_X, textY);
    ctx.textAlign = "right";
    ctx.fillText("".concat(bldgW, "\xD7").concat(bldgH, "  ").concat(sel.style || ""), TEXT_RIGHT, textY);
    textY += 22;

    // Line 2-3: Contact info + address
    ctx.fillStyle = "#64748B";
    ctx.font = "13px sans-serif";
    ctx.textAlign = "left";
    var infoLine = [contact.phone, contact.email].filter(Boolean).join("  •  ");
    if (infoLine) {
      ctx.fillText(infoLine, TEXT_X, textY);
      textY += 17;
    }
    if (customerAddr) {
      ctx.fillText(customerAddr, TEXT_X, textY);
      textY += 19;
    }

    // Build bullet list (paint + placed items + custom options)
    var bullets = [];
    if (sel.paint === "Painted") {
      var body = paintColors.body || "TBD";
      var trim = paintColors.trim || "TBD";
      bullets.push("Painted \u2014 Body: ".concat(body, ", Trim: ").concat(trim));
    } else {
      bullets.push("Unpainted");
    }
    if (sel.roofType) bullets.push("Roof \u2014 ".concat(sel.roofType).concat(sel.roofColor ? ": ".concat(sel.roofColor) : ""));
    var sdCount = items.filter(function (i) {
      return i.type === "singleDoor";
    }).length;
    var ddCount = items.filter(function (i) {
      return i.type === "doubleDoor";
    }).length;
    if (sdCount > 0) bullets.push("Single Door".concat(sdCount > 1 ? " ×" + sdCount : ""));
    if (ddCount > 0) bullets.push("Double Door".concat(ddCount > 1 ? " ×" + ddCount : ""));
    // Catalog fixture doors — one bullet per placed door with its full spec (name, size,
    // swing, operation), driven by the placed items so ANY catalog door lists automatically
    // (nothing hard-coded per door). Windows/ramps will slot in the same way later.
    items.filter(function (i) {
      return i.type === "fixtureDoor";
    }).forEach(function (d) {
      var parts = [];
      if (d.widthIn && d.heightIn) parts.push("".concat(fmtFtIn(d.widthIn), "\xD7").concat(fmtFtIn(d.heightIn)));
      var sw = d.swing === "in" ? "in-swing" : d.swing === "out" ? "out-swing" : "";
      if (sw) parts.push(sw);
      var op = d.operation === "slideup" ? "slide up" : d.operation === "double" ? "double" : d.operation === "right" ? "right hinge" : d.operation === "left" ? "left hinge" : "";
      if (op) parts.push(op);
      bullets.push("".concat(d.doorName || "Door").concat(parts.length ? " — " + parts.join(", ") : ""));
    });
    var winCount = items.filter(function (i) {
      return i.type === "window";
    }).length;
    if (winCount > 0) bullets.push("Window".concat(winCount > 1 ? "s ×" + winCount : ""));
    items.filter(function (i) {
      return i.type === "workbench";
    }).forEach(function (wb) {
      return bullets.push("".concat(wb.widthFt, "ft Workbench"));
    });
    var loftItems = items.filter(function (i) {
      return i.type === "loft";
    });
    if (loftItems.length > 0) {
      var loftSqft = Math.round(loftItems.reduce(function (s, l) {
        return s + (Number(l.widthFt) || 0) * (Number(l.heightFt) || 0);
      }, 0));
      bullets.push("Loft".concat(loftItems.length > 1 ? " ×" + loftItems.length : "", " \u2014 ").concat(loftSqft, " sq ft"));
    }
    var rampCount = items.filter(function (i) {
      return i.type === "ramp";
    }).length;
    if (rampCount > 0) bullets.push("Ramp".concat(rampCount > 1 ? " ×" + rampCount : ""));
    items.filter(function (i) {
      return i.type === "roughOpening";
    }).forEach(function (ro, idx) {
      var d = (roDimensions[ro.id] || "").trim();
      var label = "RO-".concat(idx + 1);
      bullets.push(d ? "".concat(label, " \u2014 ").concat(d) : label);
    });
    // Lines and notes are not bulleted — they already render at their position on the page.
    customOptions.forEach(function (co) {
      if (co.name && co.name.trim()) {
        var q = co.qty && parseInt(co.qty) > 0 ? " (\xD7".concat(co.qty, ")") : "";
        bullets.push(co.name.trim() + q);
      }
    });

    // 2-column bullets
    if (bullets.length > 0) {
      textY += 6;
      ctx.fillStyle = "#334155";
      ctx.font = "13px sans-serif";
      ctx.textAlign = "left";
      var colW = TEXT_W / 2;
      var half = Math.ceil(bullets.length / 2);
      for (var i = 0; i < half; i++) {
        ctx.fillText("•  " + bullets[i], TEXT_X, textY);
        if (i + half < bullets.length) ctx.fillText("•  " + bullets[i + half], TEXT_X + colW, textY);
        textY += 18;
      }
    }
    return canvas;
  };
  var generatePNG = function generatePNG() {
    return renderExportCanvas().toDataURL("image/png");
  };
  var exportPNG = function exportPNG() {
    setExportUrl(generatePNG());
    setShowExport(true);
  };

  // ─── ADMIN: GHL credentials management ───
  // Both helpers call the admin-save-settings Edge Function; the password is verified
  // server-side against ADMIN_PASSWORD. The API key, once saved, is never returned to
  // the browser — checkAdminStatus only reports configured/not + a masked location ID.
  var checkAdminStatus = /*#__PURE__*/function () {
    var _ref20 = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee11() {
      var _yield$supabase$funct3, data, error;
      return _regeneratorRuntime().wrap(function _callee11$(_context11) {
        while (1) switch (_context11.prev = _context11.next) {
          case 0:
            if (supabase) {
              _context11.next = 3;
              break;
            }
            setAdminMsg({
              ok: false,
              msg: "Supabase not configured."
            });
            return _context11.abrupt("return");
          case 3:
            if (adminPwd) {
              _context11.next = 6;
              break;
            }
            setAdminMsg({
              ok: false,
              msg: "Enter the admin password first."
            });
            return _context11.abrupt("return");
          case 6:
            setAdminBusy(true);
            setAdminMsg(null);
            _context11.prev = 8;
            _context11.next = 11;
            return supabase.functions.invoke("admin-save-settings", {
              body: {
                adminPassword: adminPwd,
                clientId: C.clientId,
                action: "status"
              }
            });
          case 11:
            _yield$supabase$funct3 = _context11.sent;
            data = _yield$supabase$funct3.data;
            error = _yield$supabase$funct3.error;
            if (!error) {
              _context11.next = 16;
              break;
            }
            throw new Error(error.message || "Status check failed");
          case 16:
            if (data !== null && data !== void 0 && data.ok) {
              _context11.next = 18;
              break;
            }
            throw new Error((data === null || data === void 0 ? void 0 : data.error) || "Status check failed");
          case 18:
            setAdminStatus(data);
            _context11.next = 25;
            break;
          case 21:
            _context11.prev = 21;
            _context11.t0 = _context11["catch"](8);
            setAdminMsg({
              ok: false,
              msg: _context11.t0.message
            });
            setAdminStatus(null);
          case 25:
            _context11.prev = 25;
            setAdminBusy(false);
            return _context11.finish(25);
          case 28:
          case "end":
            return _context11.stop();
        }
      }, _callee11, null, [[8, 21, 25, 28]]);
    }));
    return function checkAdminStatus() {
      return _ref20.apply(this, arguments);
    };
  }();
  var saveAdminSettings = /*#__PURE__*/function () {
    var _ref21 = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee12() {
      var _yield$supabase$funct4, data, error, _yield$supabase$funct5, st;
      return _regeneratorRuntime().wrap(function _callee12$(_context12) {
        while (1) switch (_context12.prev = _context12.next) {
          case 0:
            if (supabase) {
              _context12.next = 3;
              break;
            }
            setAdminMsg({
              ok: false,
              msg: "Supabase not configured."
            });
            return _context12.abrupt("return");
          case 3:
            if (!(!adminPwd || !adminLocId || !adminApiKey)) {
              _context12.next = 6;
              break;
            }
            setAdminMsg({
              ok: false,
              msg: "Fill in admin password, location ID, and API key."
            });
            return _context12.abrupt("return");
          case 6:
            setAdminBusy(true);
            setAdminMsg(null);
            _context12.prev = 8;
            _context12.next = 11;
            return supabase.functions.invoke("admin-save-settings", {
              body: {
                adminPassword: adminPwd,
                clientId: C.clientId,
                ghlLocationId: adminLocId,
                ghlApiKey: adminApiKey
              }
            });
          case 11:
            _yield$supabase$funct4 = _context12.sent;
            data = _yield$supabase$funct4.data;
            error = _yield$supabase$funct4.error;
            if (!error) {
              _context12.next = 16;
              break;
            }
            throw new Error(error.message || "Save failed");
          case 16:
            if (data !== null && data !== void 0 && data.ok) {
              _context12.next = 18;
              break;
            }
            throw new Error((data === null || data === void 0 ? void 0 : data.error) || "Save failed");
          case 18:
            setAdminMsg({
              ok: true,
              msg: "GHL settings saved."
            });
            setAdminApiKey(""); // Clear the key from React state once it's persisted
            // Refresh status indicator
            _context12.next = 22;
            return supabase.functions.invoke("admin-save-settings", {
              body: {
                adminPassword: adminPwd,
                clientId: C.clientId,
                action: "status"
              }
            });
          case 22:
            _yield$supabase$funct5 = _context12.sent;
            st = _yield$supabase$funct5.data;
            if (st !== null && st !== void 0 && st.ok) setAdminStatus(st);
            _context12.next = 30;
            break;
          case 27:
            _context12.prev = 27;
            _context12.t0 = _context12["catch"](8);
            setAdminMsg({
              ok: false,
              msg: _context12.t0.message
            });
          case 30:
            _context12.prev = 30;
            setAdminBusy(false);
            return _context12.finish(30);
          case 33:
          case "end":
            return _context12.stop();
        }
      }, _callee12, null, [[8, 27, 30, 33]]);
    }));
    return function saveAdminSettings() {
      return _ref21.apply(this, arguments);
    };
  }();

  // ─── SUBMIT QUOTE ───
  var submitQuote = /*#__PURE__*/function () {
    var _ref22 = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee13() {
      var FIELD_LABEL, missing, declinedKeys, unplacedIncluded, names, canvas, shortCode, filePath, jpegDataUrl, jpegBin, jpegBytes, i, blob, _yield$supabase$stora, upErr, _supabase$storage$fro, urlData, imageUrl, _yield$supabase$rpc6, dbErr, shareParams, tenantParam, viewUrl, unitToLink, payload, betaMode, _yield$supabase$funct6, result, fnErr, detail, errBody;
      return _regeneratorRuntime().wrap(function _callee13$(_context13) {
        while (1) switch (_context13.prev = _context13.next) {
          case 0:
            if (!(inventoryMaster && currentDesignIdRef.current === inventoryMaster.code)) {
              _context13.next = 3;
              break;
            }
            setSubmitError("This is an inventory building. Use “Send estimate” on the Inventory tab to quote it to a customer, or “Update Inventory Building” to save design changes.");
            return _context13.abrupt("return");
          case 3:
            // Validate every contact field that's enabled in the config. Address fields
            // are required because downstream tax calc needs the full address.
            FIELD_LABEL = {
              name: "Name",
              email: "Email",
              phone: "Phone",
              street: "Street Address",
              city: "City",
              state: "State",
              zip: "Zip"
            };
            missing = ["name", "email", "phone", "street", "city", "state", "zip"].filter(function (f) {
              return C.contactFields.includes(f) && !String(contact[f] || "").trim();
            }).map(function (f) {
              return FIELD_LABEL[f];
            });
            if (!(missing.length > 0)) {
              _context13.next = 8;
              break;
            }
            setSubmitError("Please fill in: ".concat(missing.join(", "), "."));
            return _context13.abrupt("return");
          case 8:
            if (!(C.contactFields.includes("phone") && contact.phone.replace(/\D/g, "").length !== 10)) {
              _context13.next = 11;
              break;
            }
            setSubmitError("Phone number must be 10 digits.");
            return _context13.abrupt("return");
          case 11:
            if (!(C.contactFields.includes("zip") && !/^\d{5}$/.test(contact.zip))) {
              _context13.next = 14;
              break;
            }
            setSubmitError("Zip must be 5 digits.");
            return _context13.abrupt("return");
          case 14:
            if (!(!sel.style || !sel.size)) {
              _context13.next = 17;
              break;
            }
            setSubmitError("Please select a Building Style and Size.");
            return _context13.abrupt("return");
          case 17:
            // Every included item must be placed on the layout, or explicitly declined.
            declinedKeys = Array.isArray(sel.declinedItems) ? sel.declinedItems : [];
            unplacedIncluded = includedItemKeys.filter(function (k) {
              return !declinedKeys.includes(k) && !items.some(function (it) {
                return it.type === k || it.fixtureItemId === k;
              });
            });
            if (!(unplacedIncluded.length > 0)) {
              _context13.next = 23;
              break;
            }
            names = unplacedIncluded.map(function (k) {
              return ITEMS[k] && ITEMS[k].label || k;
            }).join(", ");
            setSubmitError("Please place all included items on your layout, or decline the ones you don't want: ".concat(names, "."));
            return _context13.abrupt("return");
          case 23:
            if (supabase) {
              _context13.next = 26;
              break;
            }
            setSubmitError("Storage isn't configured. Contact support.");
            return _context13.abrupt("return");
          case 26:
            setSubmitting(true);
            setSubmitError(null);
            _context13.prev = 28;
            // 1. Render the export canvas — wrapped in a single-page letter PDF and uploaded to
            //    Storage. The submit-estimate Edge Function attaches that PDF to the GHL estimate.
            canvas = renderExportCanvas(); // 2. Reuse the existing short_code if we loaded one; otherwise mint a fresh one
            shortCode = currentDesignIdRef.current || genShortCode(); // Store the PDF under a per-tenant prefix ({client_id}/<code>-<ts>.pdf). The
            // timestamp suffix keeps each submitted version's PDF instead of overwriting the
            // previous one (design_versions history); the storage policy allows the -<digits>.
            filePath = "".concat(C.clientId, "/").concat(shortCode, "-").concat(Date.now(), ".pdf"); // 3. Upload the PDF to the floor-plans bucket. The filename is unique per
            //    submit (short_code + timestamp) so there is never a conflict — use a
            //    plain insert (upsert:false), NOT an upsert. This matters for security:
            //    a storage upsert's RETURNING requires a public SELECT policy, and that
            //    same SELECT policy is what lets anyone list() a tenant prefix and
            //    enumerate every design short_code. A plain insert needs no SELECT
            //    policy, so the listable policy can be dropped (see 042_floor_plans_no_list).
            //    Uses the same hand-built JPEG-in-PDF wrapper that downloadPDF uses.
            jpegDataUrl = canvas.toDataURL("image/jpeg", 0.92);
            jpegBin = atob(jpegDataUrl.split(",")[1]);
            jpegBytes = new Uint8Array(jpegBin.length);
            for (i = 0; i < jpegBin.length; i++) jpegBytes[i] = jpegBin.charCodeAt(i);
            blob = buildPdfFromJpegBytes(jpegBytes, canvas.width, canvas.height);
            _context13.next = 39;
            return supabase.storage.from("floor-plans").upload(filePath, blob, {
              upsert: false,
              contentType: "application/pdf",
              cacheControl: "0"
            });
          case 39:
            _yield$supabase$stora = _context13.sent;
            upErr = _yield$supabase$stora.error;
            if (!upErr) {
              _context13.next = 43;
              break;
            }
            throw new Error("PDF upload failed: ".concat(upErr.message));
          case 43:
            _supabase$storage$fro = supabase.storage.from("floor-plans").getPublicUrl(filePath), urlData = _supabase$storage$fro.data;
            imageUrl = urlData.publicUrl; // 4. Save the design row via the capability RPC (insert on first save,
            //    update on subsequent saves; keyed by the unguessable short code).
            //    The RPC also pins client_id — a saved design can never be re-homed
            //    to a different tenant.
            _context13.next = 47;
            return supabase.rpc("save_design", {
              p_code: shortCode,
              p_client_id: C.clientId,
              p_contact: contact,
              p_selections: sel,
              p_paint_colors: paintColors,
              p_items: items,
              p_custom_options: customOptions,
              p_ro_dimensions: roDimensions,
              p_bldg_w: bldgW,
              p_bldg_h: bldgH,
              p_image_url: imageUrl
            });
          case 47:
            _yield$supabase$rpc6 = _context13.sent;
            dbErr = _yield$supabase$rpc6.error;
            if (!dbErr) {
              _context13.next = 51;
              break;
            }
            throw new Error("Save failed: ".concat(dbErr.message));
          case 51:
            // 5. Update the URL so a refresh / share-link reopens the same design.
            //    Keep the ?client= tenant param so the link reopens with the right branding.
            //    Embedded (in-portal): the page URL is /portal.html and carries no ?client,
            //    so build the share link from the config's tenant + the public root instead
            //    — and never rewrite the host page's URL.
            shareParams = new URLSearchParams();
            tenantParam = embedded ? C.clientId : new URLSearchParams(window.location.search).get("client");
            if (tenantParam) shareParams.set("client", tenantParam);
            shareParams.set("id", shortCode);
            viewUrl = "".concat(window.location.origin).concat(embedded ? "/" : window.location.pathname, "?").concat(shareParams.toString());
            if (!embedded) window.history.replaceState({}, "", "?".concat(shareParams.toString()));
            currentDesignIdRef.current = shortCode;
            // If this code began life as a silent draft, save_design just promoted it to 'sent'
            // — from here on it is a submitted design and draft saves must leave it alone.
            isDraftRef.current = false;
            draftStateRef.current = null;
            // Estimate sent from an inventory unit ("Send estimate"): tie the new design to its
            // unit so the Inventory tab lists it. Best-effort — a link failure must never break
            // a submitted estimate; the fire-and-forget catch keeps it silent.
            // Tie this submission to its inventory building — or deliberately UNTIE it when
            // staff designed a fresh build for the same customer ("Design a new build
            // instead"), so the new version reads New rather than inheriting Inventory.
            // newBuildMode is the ONLY thing that unties. An ordinary resubmit of a reopened
            // inventory estimate (adding a discount, say) must RE-STAMP the same unit: the
            // openDesign path deliberately clears inventoryUnitRef, so reading only that ref
            // sent unitId:null and silently severed the quote from its building — the lock then
            // survived exactly one submit and the unit never flipped Sold on acceptance.
            unitToLink = newBuildMode ? null : inventoryUnitRef.current || designUnit && designUnit.id || null;
            if (embedded && (unitToLink || newBuildMode && designUnit)) {
              try {
                supabase.functions.invoke("portal-settings", {
                  body: {
                    action: "link_design_to_unit",
                    targetClientId: C.clientId,
                    shortCode: shortCode,
                    unitId: unitToLink
                  }
                })["catch"](function () {});
              } catch (_e) {/* never block the estimate on the label */}
              if (unitToLink) setDesignUnit(function (d) {
                return d && d.id === unitToLink ? d : {
                  id: unitToLink,
                  serial: null
                };
              });else {
                setDesignUnit(null);
                setNewBuildMode(false);
              }
            }
            setDesignCode(shortCode);
            setViewingVersion(null);
            payload = {
              // New fields — n8n can use these for GHL linking + image embed
              designId: shortCode,
              imageUrl: imageUrl,
              viewUrl: viewUrl,
              source: "StructureStudio",
              clientId: C.clientId,
              deliveryFee: Number(sel.deliveryFee) || 0,
              // Included items the customer declined → the estimate adds a deduction line per item.
              declinedItems: (Array.isArray(sel.declinedItems) ? sel.declinedItems : []).filter(function (k) {
                return includedItemKeys.includes(k);
              }).map(function (k) {
                return {
                  key: k,
                  label: ITEMS[k] && ITEMS[k].label || k
                };
              }),
              contact: {
                name: contact.name,
                email: contact.email,
                // Strip display formatting; n8n/GHL store raw digits.
                phone: contact.phone.replace(/\D/g, ""),
                street: contact.street,
                city: contact.city,
                state: contact.state,
                zip: contact.zip
              },
              selections: _objectSpread(_objectSpread({
                buildingStyle: sel.style,
                buildingSize: sel.size,
                paint: sel.paint || "No Paint"
              }, sel.paint === "Painted" ? {
                paintBodyColor: paintColors.body || "TBD",
                paintTrimColor: paintColors.trim || "TBD"
              } : {}), Array.isArray(C.colors) && C.colors.some(function (c) {
                return c.shingle || c.metal;
              }) ? {
                roofType: sel.roofType || "",
                roofColor: sel.roofColor || ""
              } : {}),
              floorPlanItems: items.map(function (item) {
                var displayLabel = getDisplayLabel(item.wall, frontWall);
                if (item.type === "line") {
                  var dxFt = (item.x2 - item.x1) / scale;
                  var dyFt = (item.y2 - item.y1) / scale;
                  return {
                    type: "line",
                    wall: null,
                    lengthFt: Math.round(Math.sqrt(dxFt * dxFt + dyFt * dyFt) * 100) / 100,
                    angleDeg: Math.round(Math.atan2(dyFt, dxFt) * 180 / Math.PI * 10) / 10
                  };
                }
                if (item.type === "textNote") {
                  return {
                    type: "textNote",
                    wall: null,
                    text: (item.text || "").trim()
                  };
                }
                return _objectSpread(_objectSpread(_objectSpread(_objectSpread({
                  type: item.type,
                  wall: displayLabel ? displayLabel.toLowerCase() : item.wall || null
                }, item.type === "workbench" ? {
                  lengthFt: item.widthFt
                } : {}), item.type === "fixtureDoor" ? {
                  name: item.doorName,
                  widthIn: item.widthIn,
                  heightIn: item.heightIn,
                  swing: item.swing,
                  operation: item.operation,
                  price: item.price != null ? Number(item.price) : null,
                  fixtureItemId: item.fixtureItemId || null
                } : {}), item.type === "ramp" ? {
                  name: item.rampName || null,
                  widthIn: item.widthIn || null,
                  heightIn: item.heightIn || null,
                  price: item.price != null ? Number(item.price) : null,
                  fixtureItemId: item.fixtureItemId || null
                } : {}), item.type === "window" && item.fixtureItemId ? {
                  name: item.windowName || null,
                  widthIn: item.widthIn || null,
                  heightIn: item.heightIn || null,
                  price: item.price != null ? Number(item.price) : null,
                  fixtureItemId: item.fixtureItemId
                } : {});
              }),
              // Catalog door schedule: one row per placed fixture door, with its snapshotted spec +
              // price. submit-estimate turns each into a priced estimate line. Kept separate from
              // itemSummary (which counts the built-in door types) so the estimate engine has the
              // full per-door detail, not just a count.
              doors: items.filter(function (i) {
                return i.type === "fixtureDoor";
              }).map(function (d) {
                var lbl = getDisplayLabel(d.wall, frontWall);
                return {
                  name: d.doorName || "Door",
                  widthIn: d.widthIn != null ? Number(d.widthIn) : null,
                  heightIn: d.heightIn != null ? Number(d.heightIn) : null,
                  swing: d.swing || null,
                  operation: d.operation || null,
                  price: d.price != null ? Number(d.price) : null,
                  wall: lbl ? lbl.toLowerCase() : d.wall || null,
                  fixtureItemId: d.fixtureItemId || null
                };
              }),
              // Ramp schedule: one row per placed ramp. Custom ramps carry their snapshot price; simple
              // ramps leave price null and submit-estimate prices them from the tenant's ramp settings
              // (each, or per_ft × the attached door width, passed here as doorWidthFt).
              ramps: items.filter(function (i) {
                return i.type === "ramp";
              }).map(function (r) {
                var door = items.find(function (d) {
                  return d.id === r.snapDoorId;
                });
                var doorWidthFt = r.widthFt != null ? Number(r.widthFt) : null;
                if (door && door.type === "fixtureDoor" && door.widthIn) doorWidthFt = Number(door.widthIn) / 12;
                var lbl = getDisplayLabel(r.wall, frontWall);
                return {
                  name: r.rampName || null,
                  widthIn: r.widthIn != null ? Number(r.widthIn) : null,
                  heightIn: r.heightIn != null ? Number(r.heightIn) : null,
                  price: r.price != null ? Number(r.price) : null,
                  doorWidthFt: doorWidthFt != null ? Math.round(doorWidthFt * 100) / 100 : null,
                  wall: lbl ? lbl.toLowerCase() : r.wall || null,
                  fixtureItemId: r.fixtureItemId || null
                };
              }),
              // Catalog window schedule: one row per placed catalog window (has fixtureItemId), with its
              // snapshot price. Built-in windows aren't here — they're counted in itemSummary.windows.
              windows: items.filter(function (i) {
                return i.type === "window" && i.fixtureItemId;
              }).map(function (w) {
                var lbl = getDisplayLabel(w.wall, frontWall);
                return {
                  name: w.windowName || "Window",
                  widthIn: w.widthIn != null ? Number(w.widthIn) : null,
                  heightIn: w.heightIn != null ? Number(w.heightIn) : null,
                  price: w.price != null ? Number(w.price) : null,
                  wall: lbl ? lbl.toLowerCase() : w.wall || null,
                  fixtureItemId: w.fixtureItemId || null
                };
              }),
              itemSummary: {
                singleDoors: items.filter(function (i) {
                  return i.type === "singleDoor";
                }).length,
                doubleDoors: items.filter(function (i) {
                  return i.type === "doubleDoor";
                }).length,
                // Built-in windows only (catalog windows are priced from windows[] by snapshot).
                windows: items.filter(function (i) {
                  return i.type === "window" && !i.fixtureItemId;
                }).length,
                workbenches: items.filter(function (i) {
                  return i.type === "workbench";
                }).map(function (i) {
                  var lbl = getDisplayLabel(i.wall, frontWall);
                  return {
                    wall: lbl ? lbl.toLowerCase() : i.wall,
                    lengthFt: i.widthFt
                  };
                }),
                lofts: items.filter(function (i) {
                  return i.type === "loft";
                }).length,
                loftSqft: Math.round(items.filter(function (i) {
                  return i.type === "loft";
                }).reduce(function (s, i) {
                  return s + (i.widthFt || 0) * (i.heightFt || 0);
                }, 0)),
                ramp: items.filter(function (i) {
                  return i.type === "ramp";
                }).length,
                // count — ramp is priced "each" (one per door)
                lines: items.filter(function (i) {
                  return i.type === "line";
                }).length,
                notes: items.filter(function (i) {
                  return i.type === "textNote";
                }).map(function (n) {
                  return (n.text || "").trim();
                }).filter(Boolean)
              },
              customOptions: customOptions.filter(function (co) {
                return co.name && co.name.trim();
              }).map(function (co) {
                return {
                  name: co.name.trim(),
                  qty: co.qty ? parseInt(co.qty) || 0 : 0,
                  amount: co.amount ? parseFloat(co.amount) || 0 : 0
                };
              }),
              // Discounts → GHL invoice discount total (each shows as a $0 "Discount — <desc>" line).
              discounts: (Array.isArray(sel.discounts) ? sel.discounts : []).map(function (d) {
                return {
                  description: String(d.description || "").trim(),
                  amount: Math.abs(parseFloat(d.amount) || 0)
                };
              }).filter(function (d) {
                return d.amount > 0;
              }),
              roughOpenings: items.filter(function (i) {
                return i.type === "roughOpening";
              }).map(function (ro, idx) {
                return {
                  name: "RO-".concat(idx + 1),
                  dimensions: (roDimensions[ro.id] || "").trim(),
                  qty: 1
                };
              }),
              submittedAt: new Date().toISOString()
            }; // Call the submit-estimate Edge Function. It looks up the GHL credentials for
            // this clientId in Supabase (admin-configured), then either creates a new GHL
            // estimate or updates the existing one for this design and emails it.
            // ⚠️ This `betaMode` flag is TELEMETRY ONLY and does not redirect anything. It is
            // detected from the deploy host (beta.* on either apex, or a beta--* branch preview),
            // which nobody opts into — so it must never gain a side effect, or every submission
            // from the beta host would divert (and hard-fail for tenants with no test inbox).
            //
            // What DOES redirect is the tenant's own beta_mode switch in Settings → Branding →
            // Testing (restored 2026-08-07): with it on, submit-estimate mails that tenant's
            // beta_email instead of the customer, and refuses the submission outright if no valid
            // test inbox is set rather than falling back to the customer. So on a tenant WITHOUT
            // that switch on, a verification submit carrying a real lead's details still emails
            // that customer a live branded quote — turn beta mode on first, or use an address you
            // control. An earlier QA-inbox redirect pointed at one hard-coded non-deliverable
            // address so beta estimates silently failed to send; the per-tenant address plus the
            // refuse-if-unset rule are what make this version safe to have back.
            betaMode = typeof window !== "undefined" && /(^|\.)beta(\.|--)/.test(window.location.hostname);
            _context13.next = 68;
            return supabase.functions.invoke("submit-estimate", {
              body: _objectSpread(_objectSpread({}, payload), {}, {
                betaMode: betaMode
              })
            });
          case 68:
            _yield$supabase$funct6 = _context13.sent;
            result = _yield$supabase$funct6.data;
            fnErr = _yield$supabase$funct6.error;
            if (!fnErr) {
              _context13.next = 84;
              break;
            }
            detail = fnErr.message || "Submit failed";
            _context13.prev = 73;
            if (!(fnErr.context && typeof fnErr.context.json === "function")) {
              _context13.next = 79;
              break;
            }
            _context13.next = 77;
            return fnErr.context.json();
          case 77:
            errBody = _context13.sent;
            if (errBody && errBody.error) detail = errBody.error;
          case 79:
            _context13.next = 83;
            break;
          case 81:
            _context13.prev = 81;
            _context13.t0 = _context13["catch"](73);
          case 83:
            throw new Error(detail);
          case 84:
            if (result !== null && result !== void 0 && result.ok) {
              _context13.next = 86;
              break;
            }
            throw new Error((result === null || result === void 0 ? void 0 : result.error) || "Submit failed");
          case 86:
            // Persist the returned GHL IDs so subsequent edits update the same estimate.
            if (result.contactId) ghlContactIdRef.current = result.contactId;
            if (result.estimateId) {
              ghlEstimateIdRef.current = result.estimateId;
              setHasExistingEstimate(true);
            }
            if (result.estimateNumber) ghlEstimateNumberRef.current = result.estimateNumber;
            setSavedDesign({
              code: shortCode,
              viewUrl: viewUrl,
              imageUrl: imageUrl,
              estimateNumber: result.estimateNumber || null,
              updated: !!result.updated
            });
            setSubmitted(true);
            // Embedded (in-portal) mounts: tell the host page a design was submitted so it
            // can refresh its lists. Fired only after the full submit-estimate success so
            // estimateNumber/updated are real; purely additive — no payload change.
            if (typeof onSaved === "function") {
              try {
                onSaved({
                  code: shortCode,
                  clientId: C.clientId,
                  viewUrl: viewUrl,
                  imageUrl: imageUrl,
                  estimateNumber: result.estimateNumber || null,
                  updated: !!result.updated
                });
              } catch (_e) {}
            }
            _context13.next = 99;
            break;
          case 94:
            _context13.prev = 94;
            _context13.t1 = _context13["catch"](28);
            setSubmitError(_context13.t1.message || "Something went wrong submitting your quote. Please try again.");
            console.error("Submit error:", _context13.t1);
            if (window.ssLogError) window.ssLogError("designer", _context13.t1 && _context13.t1.message || "submit failed", null, {
              phase: "submitQuote",
              stack: _context13.t1 && _context13.t1.stack ? String(_context13.t1.stack).slice(0, 2000) : null
            });
          case 99:
            _context13.prev = 99;
            setSubmitting(false);
            return _context13.finish(99);
          case 102:
          case "end":
            return _context13.stop();
        }
      }, _callee13, null, [[28, 94, 99, 102], [73, 81]]);
    }));
    return function submitQuote() {
      return _ref22.apply(this, arguments);
    };
  }();
  var downloadPNG = function downloadPNG() {
    if (!exportUrl) return;
    var a = document.createElement("a");
    a.href = exportUrl;
    var nameSlug = contact.name.trim().replace(/\s+/g, "-").toLowerCase() || "customer";
    a.download = "structurestudio-".concat(nameSlug, "-").concat(bldgW, "x").concat(bldgH, ".png");
    a.click();
  };

  // Build a single-page US-Letter PDF that embeds a JPEG of the canvas.
  // Self-contained (no external library): the canvas is letter-shaped already, so
  // the JPEG is stretched to fill the 612×792 pt page (8.5"×11" at 72 DPI).
  var buildPdfFromJpegBytes = function buildPdfFromJpegBytes(jpegBytes, jpegW, jpegH) {
    var PT_W = 612,
      PT_H = 792;
    var enc = new TextEncoder();
    var contentStream = "q ".concat(PT_W, " 0 0 ").concat(PT_H, " 0 0 cm /Im0 Do Q\n");
    var contentBytes = enc.encode(contentStream);
    var chunks = [];
    var totalLen = 0;
    var offsets = [];
    var pushStr = function pushStr(s) {
      var b = enc.encode(s);
      chunks.push(b);
      totalLen += b.length;
    };
    var pushBytes = function pushBytes(b) {
      chunks.push(b);
      totalLen += b.length;
    };

    // Header + binary marker so PDF readers treat the file as binary
    pushStr("%PDF-1.4\n%\xC4\xE5\xF2\xE5\xEB\xA7\xF3\xA0\xD0\xC4\xC6\n");
    offsets[1] = totalLen;
    pushStr("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
    offsets[2] = totalLen;
    pushStr("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
    offsets[3] = totalLen;
    pushStr("3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ".concat(PT_W, " ").concat(PT_H, "] /Resources << /XObject << /Im0 4 0 R >> /ProcSet [/PDF /ImageC] >> /Contents 5 0 R >>\nendobj\n"));
    offsets[4] = totalLen;
    pushStr("4 0 obj\n<< /Type /XObject /Subtype /Image /Width ".concat(jpegW, " /Height ").concat(jpegH, " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ").concat(jpegBytes.length, " >>\nstream\n"));
    pushBytes(jpegBytes);
    pushStr("\nendstream\nendobj\n");
    offsets[5] = totalLen;
    pushStr("5 0 obj\n<< /Length ".concat(contentBytes.length, " >>\nstream\n"));
    pushBytes(contentBytes);
    pushStr("endstream\nendobj\n");
    var xrefOffset = totalLen;
    var xref = "xref\n0 6\n0000000000 65535 f \n";
    for (var i = 1; i <= 5; i++) xref += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
    pushStr(xref);
    pushStr("trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n".concat(xrefOffset, "\n%%EOF\n"));
    var out = new Uint8Array(totalLen);
    var off = 0;
    for (var _i5 = 0, _chunks = chunks; _i5 < _chunks.length; _i5++) {
      var c = _chunks[_i5];
      out.set(c, off);
      off += c.length;
    }
    return new Blob([out], {
      type: "application/pdf"
    });
  };
  var downloadPDF = function downloadPDF() {
    var canvas = renderExportCanvas();
    var dataUrl = canvas.toDataURL("image/jpeg", 0.92);
    var bin = atob(dataUrl.split(",")[1]);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    var blob = buildPdfFromJpegBytes(bytes, canvas.width, canvas.height);
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    var nameSlug = contact.name.trim().replace(/\s+/g, "-").toLowerCase() || "customer";
    a.download = "structurestudio-".concat(nameSlug, "-").concat(bldgW, "x").concat(bldgH, ".pdf");
    a.click();
    setTimeout(function () {
      return URL.revokeObjectURL(url);
    }, 1000);
  };

  // ─── STYLES ───
  var S = {
    sel: {
      border: "1px solid #CBD5E1",
      borderRadius: 6,
      padding: "5px 8px",
      fontSize: 13,
      fontWeight: 600,
      background: "#FFF",
      minWidth: 90
    },
    lbl: {
      fontSize: 11,
      fontWeight: 700,
      color: "#64748B",
      textTransform: "uppercase",
      letterSpacing: "0.06em"
    },
    btn: function btn(bg, fg) {
      return {
        background: bg,
        color: fg,
        border: "none",
        borderRadius: 6,
        padding: "5px 12px",
        fontSize: 12,
        fontWeight: 700,
        cursor: "pointer"
      };
    },
    card: function card(active) {
      return {
        cursor: "pointer",
        borderRadius: 10,
        overflow: "hidden",
        transition: "all 0.2s",
        border: "3px solid ".concat(active ? accent : "#E2E8F0"),
        boxShadow: active ? "0 0 0 2px ".concat(accent, ", 0 4px 12px ").concat(accent, "40") : "0 2px 8px rgba(0,0,0,0.06)",
        transform: active ? "scale(1.03)" : "scale(1)"
      };
    },
    cardLabel: function cardLabel(active) {
      return {
        padding: "6px 8px",
        textAlign: "center",
        fontWeight: 700,
        fontSize: 11,
        background: active ? "#FFFBEB" : "#FAFBFC",
        color: active ? "#92400E" : "#334155"
      };
    },
    check: {
      position: "absolute",
      top: 4,
      right: 4,
      width: 20,
      height: 20,
      borderRadius: 99,
      background: accent,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      color: "#FFF",
      fontSize: 11,
      fontWeight: 800
    },
    pill: function pill(active) {
      return {
        padding: "8px 14px",
        borderRadius: 8,
        cursor: "pointer",
        fontWeight: 700,
        fontSize: 13,
        transition: "all 0.15s",
        border: "2px solid ".concat(active ? accent : "#E2E8F0"),
        background: active ? "#FFFBEB" : "#FAFBFC",
        color: active ? "#92400E" : "#334155",
        boxShadow: active ? "0 0 0 2px ".concat(accent) : "none"
      };
    }
  };

  // ─── PAINT FIELDS (inline, beside Roof Options) ───
  // Body/Trim color pickers backed by the tenant palette (portal Colors tab).
  // Moved out of renderOption so the paint option can sit beside the roof
  // colors in the Size row, while other counter options keep rendering as
  // pill rows below. Logic is unchanged: "Unpainted" is just the tenant's
  // default palette color (owner-priced in the Colors tab) — it is NOT
  // synthesized here. sel.paint ("No Paint"/"Painted") stays the
  // save/load/estimate contract and is derived from the picks: the build is
  // "Painted" once a chosen Body/Trim color differs from that side's default
  // color (or is a custom color).
  var renderPaintFields = function renderPaintFields(opt) {
    var palette = Array.isArray(C.colors) ? C.colors : [];
    // flex-basis 170px (not flex:1) so on a phone each color field wraps onto
    // its own full-width row instead of overflowing the page horizontally.
    var PAINT_LBL = {
      display: "flex",
      alignItems: "center",
      gap: 4,
      flex: "1 1 170px",
      fontSize: 12,
      fontWeight: 600,
      color: "#475569",
      minWidth: 0
    };
    var PAINT_INPUT = {
      flex: 1,
      minWidth: 0,
      border: "1px solid #CBD5E1",
      borderRadius: 6,
      padding: "5px 8px",
      fontSize: 12,
      outline: "none"
    };
    var defaultLabel = function defaultLabel(k) {
      var d = palette.find(function (c) {
        return (k === "body" ? c.siding : c.trim) && c.isDefault;
      });
      return d ? d.label : "";
    };
    var sidePainted = function sidePainted(k, v, custom) {
      return custom || !!v && v !== defaultLabel(k);
    };
    var paintField = function paintField(kind) {
      var colors = palette.filter(function (c) {
        return kind === "body" ? c.siding : c.trim;
      });
      var val = paintColors[kind] || "";
      var set = function set(v) {
        return setPaintColors(function (p) {
          return _objectSpread(_objectSpread({}, p), {}, _defineProperty({}, kind, v));
        });
      };
      var labelTxt = kind === "body" ? "Body:" : "Trim:";
      var other = kind === "body" ? "trim" : "body";
      // No palette configured for this side → free-text. Any text on either side = painted.
      if (colors.length === 0) {
        return /*#__PURE__*/React.createElement("label", {
          style: PAINT_LBL
        }, labelTxt, /*#__PURE__*/React.createElement("input", {
          type: "text",
          value: val,
          onChange: function onChange(e) {
            var v = e.target.value;
            set(v);
            setSel(function (p) {
              return _objectSpread(_objectSpread({}, p), {}, _defineProperty({}, opt.id, v || paintColors[other] ? "Painted" : "No Paint"));
            });
          },
          placeholder: "Enter color or leave blank",
          style: PAINT_INPUT
        }));
      }
      var match = colors.find(function (c) {
        return c.label === val && !c.allowCustom;
      });
      var customColor = colors.find(function (c) {
        return c.allowCustom;
      });
      var isCustom = paintCustom[kind] || !match && !!val && !!customColor;
      var selectVal = isCustom && customColor ? customColor.label : match ? match.label : "";
      var onSel = function onSel(label) {
        var c = colors.find(function (x) {
          return x.label === label;
        });
        var custom = !!(c && c.allowCustom);
        if (custom) {
          setPaintCustom(function (p) {
            return _objectSpread(_objectSpread({}, p), {}, _defineProperty({}, kind, true));
          });
          set("");
        } else {
          setPaintCustom(function (p) {
            return _objectSpread(_objectSpread({}, p), {}, _defineProperty({}, kind, false));
          });
          set(label);
        }
        // Recompute the build's paint state from both sides (a custom pick counts as painted).
        var painted = sidePainted(kind, custom ? "" : label, custom) || sidePainted(other, paintColors[other], paintCustom[other]);
        setSel(function (p) {
          return _objectSpread(_objectSpread({}, p), {}, _defineProperty({}, opt.id, painted ? "Painted" : "No Paint"));
        });
      };
      return /*#__PURE__*/React.createElement("div", {
        style: _objectSpread(_objectSpread({}, PAINT_LBL), {}, {
          gap: 4
        })
      }, /*#__PURE__*/React.createElement("span", null, labelTxt), /*#__PURE__*/React.createElement(ColorSelect, {
        value: selectVal,
        colors: colors,
        onPick: onSel
      }), isCustom && /*#__PURE__*/React.createElement("input", {
        type: "text",
        value: val,
        onChange: function onChange(e) {
          return set(e.target.value);
        },
        placeholder: "Exact color",
        style: PAINT_INPUT
      }));
    };
    return /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: 6,
        flexWrap: "wrap",
        alignItems: "center",
        minWidth: 0
      }
    }, opt.img && /*#__PURE__*/React.createElement("div", {
      style: {
        flex: "0 0 auto",
        width: 100,
        borderRadius: 10,
        overflow: "hidden",
        border: "2px solid #E2E8F0"
      }
    }, /*#__PURE__*/React.createElement("img", {
      src: opt.img,
      alt: opt.label,
      style: {
        width: "100%",
        height: 80,
        objectFit: "cover",
        display: "block"
      }
    })), paintField("body"), paintField("trim"));
  };

  // ─── OPTION RENDERER ───
  var renderOption = function renderOption(opt) {
    if (opt.type === "image_cards") {
      return /*#__PURE__*/React.createElement("div", {
        key: opt.id,
        style: {
          marginBottom: 14
        }
      }, /*#__PURE__*/React.createElement("span", {
        style: _objectSpread(_objectSpread({}, S.lbl), {}, {
          display: "block",
          marginBottom: 8
        })
      }, opt.label), /*#__PURE__*/React.createElement("div", {
        style: {
          display: "flex",
          gap: 10,
          flexWrap: "wrap"
        }
      }, opt.choices.map(function (ch) {
        var active = sel[opt.id] === ch.value;
        return /*#__PURE__*/React.createElement("div", {
          key: ch.value,
          onClick: function onClick() {
            return setSel(function (p) {
              return _objectSpread(_objectSpread({}, p), {}, _defineProperty({}, opt.id, ch.value));
            });
          },
          style: _objectSpread(_objectSpread({}, S.card(active)), {}, {
            width: 130,
            flex: "0 0 auto"
          })
        }, ch.img ? /*#__PURE__*/React.createElement("div", {
          style: {
            position: "relative"
          }
        }, /*#__PURE__*/React.createElement("img", {
          src: ch.img,
          alt: ch.label,
          style: {
            width: "100%",
            height: 85,
            objectFit: "cover",
            display: "block"
          }
        }), active && /*#__PURE__*/React.createElement("div", {
          style: S.check
        }, "\u2713")) : /*#__PURE__*/React.createElement("div", {
          style: {
            height: 85,
            background: active ? "#FEF3C7" : "#F1F5F9",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 13,
            fontWeight: 700,
            color: active ? "#92400E" : "#64748B",
            position: "relative"
          }
        }, ch.label.includes("None") || ch.label.includes("No ") ? "None" : ch.label, active && /*#__PURE__*/React.createElement("div", {
          style: S.check
        }, "\u2713")), /*#__PURE__*/React.createElement("div", {
          style: S.cardLabel(active)
        }, ch.label));
      })));
    }
    if (opt.type === "counter") {
      // Paint renders inline beside Roof Options (see the Size/Roof/Paint row
      // and renderPaintFields); the map below filters it out — guard anyway.
      if (opt.id === "paint") return null;
      var hasImage = !!opt.img;
      return /*#__PURE__*/React.createElement("div", {
        key: opt.id,
        style: {
          marginBottom: 14
        }
      }, /*#__PURE__*/React.createElement("span", {
        style: _objectSpread(_objectSpread({}, S.lbl), {}, {
          display: "block",
          marginBottom: 8
        })
      }, opt.label), /*#__PURE__*/React.createElement("div", {
        style: {
          display: "flex",
          gap: 10,
          flexWrap: "wrap",
          alignItems: "flex-start"
        }
      }, hasImage && /*#__PURE__*/React.createElement("div", {
        style: {
          flex: "0 0 auto",
          width: 100,
          borderRadius: 10,
          overflow: "hidden",
          border: "2px solid #E2E8F0"
        }
      }, /*#__PURE__*/React.createElement("img", {
        src: opt.img,
        alt: opt.label,
        style: {
          width: "100%",
          height: 80,
          objectFit: "cover",
          display: "block"
        }
      })), /*#__PURE__*/React.createElement("div", {
        style: {
          display: "flex",
          gap: 6,
          flexWrap: "wrap",
          flex: 1,
          alignItems: "center",
          minWidth: 0
        }
      }, opt.options.map(function (o) {
        return /*#__PURE__*/React.createElement("div", {
          key: o,
          onClick: function onClick() {
            return setSel(function (p) {
              return _objectSpread(_objectSpread({}, p), {}, _defineProperty({}, opt.id, o));
            });
          },
          style: _objectSpread(_objectSpread({}, S.pill(sel[opt.id] === o)), {}, {
            flexShrink: 0
          })
        }, o);
      }))));
    }
    return null;
  };

  // ─── RENDER ───
  // Lead-capture gate (name + phone), shown as a dimmed/blurred modal over the live page.
  // While the modal is open the designer subtree is marked `inert` and page scroll is
  // locked; the gate is portaled to <body> so it stays interactive outside that subtree.
  // The gate is INTERACTION-triggered (Ahsan 2026-07-24): the page loads fully
  // visible and browsable; the popup appears only when a not-yet-captured visitor
  // tries to work the 2D canvas (arm a tool, place, or drag an item). gatePassed
  // (remembered browsers, ?id= reopens), the operator preview (isAdmin), and
  // embedded portal mounts never see it.
  var gateRequired = !gatePassed && !isAdmin && !embedded;
  var _useState127 = useState(false),
    _useState128 = _slicedToArray(_useState127, 2),
    gateOpen = _useState128[0],
    setGateOpen = _useState128[1];
  var showGate = gateRequired && gateOpen;
  // Gate identity chip (public page only): who this browser is remembered as, plus a
  // reset. contact.name is live right after passing the gate; the localStorage copy
  // covers return visits (the gate flag alone carries no name).
  var gateName = useMemo(function () {
    var live = (contact.name || "").trim();
    if (live) return live.split(/\s+/)[0];
    try {
      return (localStorage.getItem("ss_gate_name_" + (C.clientId || "")) || "").trim().split(/\s+/)[0] || "";
    } catch (_e) {
      return "";
    }
  }, [contact.name, C.clientId]);
  var resetGate = function resetGate() {
    try {
      localStorage.removeItem("ss_gate_" + (C.clientId || ""));
      localStorage.removeItem("ss_gate_name_" + (C.clientId || ""));
    } catch (_e) {}
    // Strip the design code (and version) from the URL — a bare reload would keep
    // ?id=, which re-passes the gate and rehydrates the same contact, making the
    // button a no-op on share-link reopens and post-submit pages.
    var p = new URLSearchParams(window.location.search);
    p["delete"]("id");
    p["delete"]("v");
    window.location.replace(window.location.pathname + (p.toString() ? "?" + p.toString() : ""));
  };
  var gateBgRef = useRef(null);
  useEffect(function () {
    var el = gateBgRef.current;
    if (el) {
      if (showGate) el.setAttribute("inert", "");else el.removeAttribute("inert");
    }
    document.body.style.overflow = showGate ? "hidden" : "";
    return function () {
      document.body.style.overflow = "";
    };
  }, [showGate]);
  var gateEl = showGate ? /*#__PURE__*/React.createElement(LeadGate, {
    config: C,
    supabase: supabase,
    accent: accent,
    onClose: function onClose() {
      return setGateOpen(false);
    },
    onPass: function onPass(info) {
      if (info && (info.name || info.phone)) setContact(function (p) {
        return _objectSpread(_objectSpread({}, p), {}, {
          name: info.name || p.name,
          phone: info.phone || p.phone
        });
      });
      try {
        localStorage.setItem("ss_gate_" + (C.clientId || ""), "1");
        if (info && info.name) localStorage.setItem("ss_gate_name_" + (C.clientId || ""), info.name);
      } catch (_e) {}
      setGatePassed(true);
      setGateOpen(false);
    }
  }) : null;
  return /*#__PURE__*/React.createElement("div", {
    ref: gateBgRef,
    style: {
      fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif",
      background: "#F8FAFC",
      minHeight: embedded ? "100%" : "100vh"
    }
  }, gateEl && createPortal(gateEl, document.body), doorPick && createPortal( /*#__PURE__*/React.createElement(DoorPicker, {
    doors: placeableDoors,
    showPricing: !!C.showPricing,
    onCancel: function onCancel() {
      setDoorPick(null);
      setSwapId(null);
    },
    onPlace: placePickedDoor
  }), document.body), rampPick && createPortal( /*#__PURE__*/React.createElement(RampPicker, {
    ramps: placeableRamps,
    showPricing: !!C.showPricing,
    onCancel: function onCancel() {
      setRampPick(null);
      setSwapId(null);
    },
    onPlace: placePickedRamp
  }), document.body), windowPick && createPortal( /*#__PURE__*/React.createElement(WindowPicker, {
    windows: placeableWindows,
    showPricing: !!C.showPricing,
    onCancel: function onCancel() {
      setWindowPick(null);
      setSwapId(null);
    },
    onPlace: placePickedWindow
  }), document.body), sizeBlock && createPortal( /*#__PURE__*/React.createElement("div", {
    onClick: function onClick() {
      return setSizeBlock(null);
    },
    style: {
      position: "fixed",
      inset: 0,
      background: "rgba(15,23,42,0.45)",
      zIndex: 9000,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: function onClick(e) {
      return e.stopPropagation();
    },
    style: {
      background: "#FFF",
      borderRadius: 14,
      width: "min(520px, 96vw)",
      maxHeight: "88vh",
      overflow: "auto",
      padding: 20,
      boxShadow: "0 20px 60px rgba(0,0,0,0.3)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 17,
      fontWeight: 800,
      color: "#1E293B",
      marginBottom: 6
    }
  }, sizeBlock.items.length === 1 ? "One item won't fit" : "".concat(sizeBlock.items.length, " items won't fit"), " in a ", sizeBlock.to), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: "#64748B",
      lineHeight: 1.5,
      marginBottom: 14
    }
  }, "Everything else would have moved across fine, but there's nowhere to put:"), /*#__PURE__*/React.createElement("ul", {
    style: {
      margin: "0 0 16px",
      paddingLeft: 20,
      fontSize: 13.5,
      color: "#1E293B",
      lineHeight: 1.7
    }
  }, sizeBlock.items.map(function (e) {
    return /*#__PURE__*/React.createElement("li", {
      key: e.id
    }, /*#__PURE__*/React.createElement("b", null, e.label));
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: "#64748B",
      lineHeight: 1.5,
      marginBottom: 16
    }
  }, "Your building is still ", /*#__PURE__*/React.createElement("b", null, sizeBlock.from), " and nothing on the plan has changed. Delete ", sizeBlock.items.length === 1 ? "it" : "them", " \u2014 or make room by removing something else \u2014 then pick the size again."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "flex-end"
    }
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: function onClick() {
      return setSizeBlock(null);
    },
    style: {
      background: accent,
      color: "#FFF",
      border: "none",
      borderRadius: 8,
      padding: "9px 18px",
      fontSize: 13.5,
      fontWeight: 700,
      cursor: "pointer",
      fontFamily: "inherit"
    }
  }, "Got it")))), document.body), !embedded && /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.branding.headerBg || "linear-gradient(135deg, #1E293B 0%, #334155 100%)",
      color: "#FFF",
      padding: "14px 20px",
      display: "flex",
      alignItems: "center",
      gap: 12
    }
  }, C.branding.logo ? /*#__PURE__*/React.createElement("img", {
    src: C.branding.logo,
    alt: C.branding.companyName || "logo",
    style: {
      width: 34,
      height: 34,
      borderRadius: 8,
      objectFit: "contain",
      flexShrink: 0,
      background: "rgba(255,255,255,0.12)"
    }
  }) : /*#__PURE__*/React.createElement("div", {
    style: {
      width: 34,
      height: 34,
      background: accent,
      borderRadius: 8,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontSize: 15,
      fontWeight: 800,
      flexShrink: 0,
      letterSpacing: "-0.05em",
      color: "#FFF"
    }
  }, initials), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 17,
      fontWeight: 700,
      letterSpacing: "-0.02em"
    }
  }, C.branding.companyName || "Design Studio"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: "#94A3B8",
      marginTop: 1
    }
  }, C.branding.tagline || "Design & Quote")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      alignItems: "flex-end",
      gap: 4,
      flexShrink: 0
    }
  }, gatePassed && !isAdmin && /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      whiteSpace: "nowrap"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: "#E2E8F0"
    }
  }, gateName ? "Designing as ".concat(gateName) : "Welcome back"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: resetGate,
    title: "Clear this browser's saved visitor and start fresh",
    style: {
      fontSize: 11,
      fontWeight: 700,
      color: "#FFF",
      background: "rgba(255,255,255,0.14)",
      border: "1px solid rgba(255,255,255,0.3)",
      borderRadius: 8,
      padding: "4px 10px",
      cursor: "pointer"
    }
  }, "Not you? Start over")), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: "#94A3B8",
      whiteSpace: "nowrap"
    }
  }, "Powered by Structure Studio"))), isAdmin && /*#__PURE__*/React.createElement("div", {
    style: {
      background: "#FEF3C7",
      borderBottom: "2px solid #F59E0B",
      padding: "14px 20px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 700,
      fontSize: 14,
      color: "#92400E"
    }
  }, "\uD83D\uDD12 GHL Integration \u2014 Admin"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      color: "#92400E"
    }
  }, "Client: ", /*#__PURE__*/React.createElement("code", null, C.clientId))), /*#__PURE__*/React.createElement("p", {
    style: {
      margin: "0 0 10px",
      fontSize: 12,
      color: "#92400E"
    }
  }, "Set the GHL Location ID and Private Integration Token for this client. Once saved, credentials live in Supabase and are only read server-side \u2014 they never reach customer browsers."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gap: 8,
      gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))"
    }
  }, /*#__PURE__*/React.createElement(PasswordInput, {
    value: adminPwd,
    onChange: function onChange(e) {
      return setAdminPwd(e.target.value);
    },
    placeholder: "Admin password",
    style: _objectSpread(_objectSpread({}, S.sel), {}, {
      width: "100%",
      boxSizing: "border-box"
    })
  }), /*#__PURE__*/React.createElement("input", {
    type: "text",
    value: adminLocId,
    onChange: function onChange(e) {
      return setAdminLocId(e.target.value);
    },
    placeholder: "GHL Location ID",
    style: _objectSpread(_objectSpread({}, S.sel), {}, {
      width: "100%",
      boxSizing: "border-box"
    })
  }), /*#__PURE__*/React.createElement(PasswordInput, {
    value: adminApiKey,
    onChange: function onChange(e) {
      return setAdminApiKey(e.target.value);
    },
    placeholder: "GHL API Key (pit-\u2026)",
    style: _objectSpread(_objectSpread({}, S.sel), {}, {
      width: "100%",
      boxSizing: "border-box"
    })
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      alignItems: "center",
      marginTop: 10,
      flexWrap: "wrap"
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: saveAdminSettings,
    disabled: adminBusy,
    style: _objectSpread(_objectSpread({}, S.btn(adminBusy ? "#9CA3AF" : "#92400E", "#FFF")), {}, {
      padding: "8px 18px",
      fontSize: 13,
      cursor: adminBusy ? "wait" : "pointer"
    })
  }, adminBusy ? "Saving…" : "Save GHL Settings"), /*#__PURE__*/React.createElement("button", {
    onClick: checkAdminStatus,
    disabled: adminBusy || !adminPwd,
    style: _objectSpread(_objectSpread({}, S.btn("#FFF", "#92400E")), {}, {
      border: "1px solid #FCD34D",
      fontSize: 12
    })
  }, "Check status"), adminStatus && adminStatus.configured && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: "#166534",
      fontWeight: 600
    }
  }, "\u2713 Configured \u2014 Loc ", adminStatus.ghlLocationIdMasked, ", saved ", new Date(adminStatus.updatedAt).toLocaleString()), adminStatus && !adminStatus.configured && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: "#92400E",
      fontWeight: 600
    }
  }, "Not yet configured for this client.")), adminMsg && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 8,
      fontSize: 12,
      color: adminMsg.ok ? "#166534" : "#DC2626",
      fontWeight: 600
    }
  }, adminMsg.msg)), planLocked && /*#__PURE__*/React.createElement("div", {
    style: {
      background: "#EFF6FF",
      borderBottom: "1px solid #BFDBFE",
      padding: "11px 20px",
      display: "flex",
      alignItems: "center",
      gap: 10,
      flexWrap: "wrap"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13,
      fontWeight: 700,
      color: "#1E3A8A"
    }
  }, "\uD83D\uDD12 Inventory building", designUnit && designUnit.serial != null ? " #".concat(designUnit.serial) : "", " \u2014 already built, so the plan can't be changed."), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12.5,
      color: "#1E40AF",
      fontWeight: 600
    }
  }, "Custom options, a discount and a delivery fee can still be added below."), embedded && /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: function onClick() {
      if (!window.confirm("Design a brand-new building for this customer instead?\n\nThe plan unlocks so you can change anything. Submitting saves it as another version of this quote, no longer tied to the inventory building.")) return;
      setNewBuildMode(true);
      inventoryUnitRef.current = null;
    },
    style: {
      marginLeft: "auto",
      background: "#FFF",
      color: "#1D4ED8",
      border: "1.5px solid #93C5FD",
      borderRadius: 8,
      padding: "7px 14px",
      fontSize: 12.5,
      fontWeight: 800,
      cursor: "pointer",
      whiteSpace: "nowrap"
    }
  }, "Design a new build instead")), embedded && newBuildMode && designUnit && /*#__PURE__*/React.createElement("div", {
    style: {
      background: "#F0FDF4",
      borderBottom: "1px solid #BBF7D0",
      padding: "10px 20px",
      fontSize: 12.5,
      fontWeight: 700,
      color: "#15803D"
    }
  }, "\u270E Designing a new build for this customer \u2014 submitting saves it as another version, no longer tied to building", designUnit.serial != null ? " #".concat(designUnit.serial) : "", "."), embedded && !planLocked && !newBuildMode && designUnit && designUnit.lifecycle && ((_INV_RANKS$designUnit2 = INV_RANKS[designUnit.lifecycle]) !== null && _INV_RANKS$designUnit2 !== void 0 ? _INV_RANKS$designUnit2 : INV_BUILT_RANK) < INV_BUILT_RANK && /*#__PURE__*/React.createElement("div", {
    style: {
      background: "#FFFBEB",
      borderBottom: "1px solid #FDE68A",
      padding: "10px 20px",
      fontSize: 12.5,
      fontWeight: 700,
      color: "#92400E"
    }
  }, "\u26A0 Building", designUnit.serial != null ? " #".concat(designUnit.serial) : "", " isn\u2019t built yet \u2014 what you change here is what gets built."),
  /*#__PURE__*/
  // A real <fieldset disabled> — pointerEvents alone leaves every <select>/<input>
  // in the tab order, so a keyboard user could still change Building Size, and the
  // size effect wipes every item off a plan that describes a building already built.
  // fieldset disables form controls including via keyboard; pointerEvents covers the
  // style cards, which are clickable divs rather than controls. Both, deliberately.
  React.createElement("fieldset", {
    disabled: planLocked || undefined,
    "aria-disabled": planLocked || undefined,
    style: _objectSpread({
      border: "none",
      margin: 0,
      minWidth: 0,
      background: "#FFF",
      borderBottom: "2px solid #E2E8F0",
      padding: "14px 20px"
    }, planLocked ? {
      pointerEvents: "none",
      opacity: 0.62
    } : {})
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: _objectSpread(_objectSpread({}, S.lbl), {}, {
      display: "block",
      marginBottom: 8
    })
  }, "Select Your Building Style"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 10,
      flexWrap: "wrap"
    }
  }, C.buildingStyles.map(function (s) {
    var active = sel.style === s.value;
    return /*#__PURE__*/React.createElement("div", {
      key: s.value,
      onClick: function onClick() {
        return setSel(function (p) {
          return _objectSpread(_objectSpread({}, p), {}, {
            style: s.value,
            size: ""
          });
        });
      },
      style: _objectSpread(_objectSpread({}, S.card(active)), {}, {
        flex: "1 1 120px",
        maxWidth: 160
      })
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        position: "relative"
      }
    }, /*#__PURE__*/React.createElement("img", {
      src: s.img,
      alt: s.label,
      style: {
        width: "100%",
        height: 100,
        objectFit: "cover",
        display: "block"
      }
    }), active && /*#__PURE__*/React.createElement("div", {
      style: S.check
    }, "\u2713")), /*#__PURE__*/React.createElement("div", {
      style: S.cardLabel(active)
    }, s.label));
  }))), (sizeOpts.length > 0 || roofTypes.length > 0 || paintOpt) && /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 24,
      flexWrap: "wrap",
      alignItems: "flex-start",
      marginBottom: 14
    }
  }, sizeOpts.length > 0 && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
    style: _objectSpread(_objectSpread({}, S.lbl), {}, {
      display: "block",
      marginBottom: 8
    })
  }, "Building Size"), /*#__PURE__*/React.createElement("select", {
    value: sel.size || "",
    onChange: function onChange(e) {
      return setSel(function (p) {
        return _objectSpread(_objectSpread({}, p), {}, {
          size: e.target.value
        });
      });
    },
    style: {
      minWidth: 160,
      border: "1px solid #CBD5E1",
      borderRadius: 6,
      padding: "5px 8px",
      fontSize: 12,
      color: sel.size ? "#334155" : "#94A3B8",
      background: "#FFF",
      cursor: "pointer"
    }
  }, /*#__PURE__*/React.createElement("option", {
    value: "",
    disabled: true
  }, "Select a size\u2026"), sizeOpts.map(function (s) {
    return /*#__PURE__*/React.createElement("option", {
      key: s,
      value: s
    }, s);
  }))), roofTypes.length > 0 && function () {
    // Roof color list depends on the chosen type. Custom-color handling mirrors paint.
    var roofList = roofColorsFor(sel.roofType);
    var rMatch = roofList.find(function (c) {
      return c.label === sel.roofColor && !c.allowCustom;
    });
    var rCustomColor = roofList.find(function (c) {
      return c.allowCustom;
    });
    var rIsCustom = roofCustom || !rMatch && !!sel.roofColor && !!rCustomColor;
    var rSelectVal = rIsCustom && rCustomColor ? rCustomColor.label : rMatch ? rMatch.label : "";
    var onRoofType = function onRoofType(type) {
      var dflt = roofColorsFor(type).find(function (c) {
        return c.isDefault;
      });
      setRoofCustom(false);
      setSel(function (p) {
        return _objectSpread(_objectSpread({}, p), {}, {
          roofType: type,
          roofColor: dflt ? dflt.label : ""
        });
      });
    };
    var onRoofColor = function onRoofColor(label) {
      var c = roofList.find(function (x) {
        return x.label === label;
      });
      if (c && c.allowCustom) {
        setRoofCustom(true);
        setSel(function (p) {
          return _objectSpread(_objectSpread({}, p), {}, {
            roofColor: ""
          });
        });
      } else {
        setRoofCustom(false);
        setSel(function (p) {
          return _objectSpread(_objectSpread({}, p), {}, {
            roofColor: label
          });
        });
      }
    };
    return /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1,
        minWidth: 240
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: _objectSpread(_objectSpread({}, S.lbl), {}, {
        display: "block",
        marginBottom: 8
      })
    }, "Roof Options"), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: 10,
        flexWrap: "wrap",
        alignItems: "center"
      }
    }, /*#__PURE__*/React.createElement("label", {
      style: {
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontSize: 12,
        fontWeight: 600,
        color: "#475569"
      }
    }, "Type:", /*#__PURE__*/React.createElement("select", {
      value: sel.roofType || "",
      onChange: function onChange(e) {
        return onRoofType(e.target.value);
      },
      style: {
        minWidth: 130,
        border: "1px solid #CBD5E1",
        borderRadius: 6,
        padding: "5px 8px",
        fontSize: 12,
        color: sel.roofType ? "#334155" : "#94A3B8",
        background: "#FFF",
        cursor: "pointer"
      }
    }, /*#__PURE__*/React.createElement("option", {
      value: ""
    }, "Select\u2026"), roofTypes.map(function (t) {
      return /*#__PURE__*/React.createElement("option", {
        key: t,
        value: t
      }, t);
    }))), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontSize: 12,
        fontWeight: 600,
        color: "#475569",
        flex: "1 1 200px",
        minWidth: 0
      }
    }, /*#__PURE__*/React.createElement("span", null, "Color:"), sel.roofType ? /*#__PURE__*/React.createElement(ColorSelect, {
      value: rSelectVal,
      colors: roofList,
      onPick: onRoofColor
    }) : /*#__PURE__*/React.createElement("span", {
      style: {
        flex: 1,
        fontSize: 12,
        color: "#94A3B8",
        fontStyle: "italic",
        fontWeight: 500
      }
    }, "pick a roof type first"), rIsCustom && sel.roofType && /*#__PURE__*/React.createElement("input", {
      type: "text",
      value: sel.roofColor || "",
      onChange: function onChange(e) {
        return setSel(function (p) {
          return _objectSpread(_objectSpread({}, p), {}, {
            roofColor: e.target.value
          });
        });
      },
      placeholder: "Exact color",
      style: {
        flex: 1,
        minWidth: 0,
        border: "1px solid #CBD5E1",
        borderRadius: 6,
        padding: "5px 8px",
        fontSize: 12,
        outline: "none"
      }
    }))));
  }(), paintOpt && /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 260
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: _objectSpread(_objectSpread({}, S.lbl), {}, {
      display: "block",
      marginBottom: 8
    })
  }, paintOpt.label), renderPaintFields(paintOpt))), visibleOptions.filter(function (o) {
    return o !== paintOpt;
  }).map(function (opt) {
    return renderOption(opt);
  })), unattachedLofts.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      background: "#FEF3C7",
      borderBottom: "1px solid #FCD34D",
      padding: "10px 16px",
      fontSize: 12,
      color: "#92400E"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 700,
      marginBottom: 4
    }
  }, "\u26A0\uFE0F Loft support warning \u2014 ", unattachedLofts.length, " loft", unattachedLofts.length > 1 ? "s" : "", " not properly supported"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 500
    }
  }, "Each loft must have ", /*#__PURE__*/React.createElement("b", null, "both ends"), " of at least one axis (left+right OR top+bottom) resting on a wall or another loft. Adjust position or size to fix.")), reflowNote && reflowNote.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      background: "#EFF6FF",
      borderBottom: "1px solid #BFDBFE",
      padding: "10px 16px",
      fontSize: 12,
      color: "#1E3A8A",
      display: "flex",
      gap: 10,
      alignItems: "flex-start"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      flexShrink: 0
    }
  }, "\uD83D\uDCD0"), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 700,
      marginBottom: 4
    }
  }, "Your layout moved to fit the new size"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 500
    }
  }, reflowNote.map(function (e, i) {
    return /*#__PURE__*/React.createElement("span", {
      key: e.id
    }, i > 0 ? "; " : "", /*#__PURE__*/React.createElement("b", null, e.label), e.kind === "movedWall" ? " moved to ".concat(wallPhrase(e.to, frontWall)) : " was shortened to ".concat(e.to, " ft"));
  }), ". Everything else kept its place.")), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: function onClick() {
      return setReflowNote(null);
    },
    style: {
      background: "none",
      border: "none",
      color: "#1E3A8A",
      cursor: "pointer",
      fontSize: 15,
      fontWeight: 800,
      lineHeight: 1,
      flexShrink: 0
    }
  }, "\u2715")), /*#__PURE__*/React.createElement("div", {
    style: {
      background: "#FFF",
      borderBottom: "1px solid #E2E8F0",
      padding: "10px 20px",
      display: "flex",
      gap: 6,
      flexWrap: "wrap",
      alignItems: "center"
    }
  }, !planLocked && function () {
    var btn = function btn(_ref23) {
      var _ref24 = _slicedToArray(_ref23, 2),
        key = _ref24[0],
        cfg = _ref24[1];
      return /*#__PURE__*/React.createElement("button", {
        key: key,
        onClick: function onClick() {
          if (gateRequired) {
            setGateOpen(true);
            return;
          }
          setActiveTool(activeTool === key ? null : key);
          setSelectedId(null);
        },
        style: {
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          padding: "5px 10px",
          borderRadius: 7,
          fontSize: 12,
          fontWeight: 600,
          cursor: "pointer",
          transition: "all 0.15s",
          position: "relative",
          background: activeTool === key ? cfg.color : "#F8FAFC",
          color: activeTool === key ? "#FFF" : "#334155",
          border: "2px solid ".concat(activeTool === key ? cfg.color : "#E2E8F0")
        }
      }, /*#__PURE__*/React.createElement("span", {
        style: {
          fontSize: 14,
          display: "inline-flex",
          alignItems: "center"
        }
      }, key === "singleDoor" || key === "doorPicker" ? /*#__PURE__*/React.createElement(DoorIcon, null) : key === "doubleDoor" ? /*#__PURE__*/React.createElement(DoorIcon, {
        "double": true
      }) : cfg.icon), cfg.label, (cfg.wallOnly || cfg.wallSnap) && /*#__PURE__*/React.createElement("span", {
        style: {
          fontSize: 9,
          opacity: 0.7,
          background: activeTool === key ? "rgba(255,255,255,0.25)" : "#F1F5F9",
          borderRadius: 3,
          padding: "1px 4px"
        }
      }, "wall"));
    };
    var entries = Object.entries(ITEMS).filter(function (_ref25) {
      var _ref26 = _slicedToArray(_ref25, 2),
        c = _ref26[1];
      return c && !c.noPalette && (embedded || !c.internalOnly);
    });
    var incl = includedItemKeys.length ? entries.filter(function (_ref27) {
      var _ref28 = _slicedToArray(_ref27, 1),
        k = _ref28[0];
      return includedItemKeys.includes(k);
    }) : [];
    var addl = includedItemKeys.length ? entries.filter(function (_ref29) {
      var _ref30 = _slicedToArray(_ref29, 1),
        k = _ref30[0];
      return !includedItemKeys.includes(k);
    }) : entries;
    // Decline control for an included item: X it off (a deduction line is added on the
    // estimate). Declined items don't have to be placed on the layout.
    var declined = Array.isArray(sel.declinedItems) ? sel.declinedItems : [];
    var toggleDecline = function toggleDecline(key) {
      var cur = Array.isArray(sel.declinedItems) ? sel.declinedItems : [];
      var declining = !cur.includes(key);
      if (declining) {
        // Declining removes it from the layout (like Delete) — a declined item can't be placed,
        // so any already-placed instances are cleared (cascading a door's snapped ramp, like
        // delSel) and the tool is deselected if active.
        setItems(function (its) {
          var removedIds = new Set(its.filter(function (it) {
            return it.type === key || it.fixtureItemId === key;
          }).map(function (it) {
            return it.id;
          }));
          return its.filter(function (it) {
            return !(it.type === key || it.fixtureItemId === key) && !(it.type === "ramp" && removedIds.has(it.snapDoorId));
          });
        });
        setActiveTool(function (t) {
          return t === key ? null : t;
        });
        setSelectedId(null);
      }
      setSel(function (p) {
        var c = Array.isArray(p.declinedItems) ? p.declinedItems : [];
        return _objectSpread(_objectSpread({}, p), {}, {
          declinedItems: c.includes(key) ? c.filter(function (k) {
            return k !== key;
          }) : [].concat(_toConsumableArray(c), [key])
        });
      });
    };
    // Included chips show the included quantity when it's more than a single unit
    // (loft quantities are square footage; everything else is a count).
    var withQty = function withQty(key, cfg) {
      var q = includedItemQty[key] || 1;
      if (q <= 1) return cfg;
      return _objectSpread(_objectSpread({}, cfg), {}, {
        label: key === "loft" ? "".concat(cfg.label, " (").concat(q, " sq ft)") : "".concat(cfg.label, " \xD7").concat(q)
      });
    };
    var inclBtn = function inclBtn(_ref31) {
      var _ref32 = _slicedToArray(_ref31, 2),
        key = _ref32[0],
        rawCfg = _ref32[1];
      var cfg = withQty(key, rawCfg);
      return declined.includes(key) ? /*#__PURE__*/React.createElement("span", {
        key: key,
        title: "You declined this included item \u2014 it'll show as a deduction on your estimate",
        style: {
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "5px 10px",
          borderRadius: 7,
          fontSize: 12,
          fontWeight: 600,
          background: "#F1F5F9",
          color: "#94A3B8",
          border: "2px dashed #CBD5E1"
        }
      }, /*#__PURE__*/React.createElement("span", {
        style: {
          textDecoration: "line-through"
        }
      }, cfg.label), /*#__PURE__*/React.createElement("button", {
        onClick: function onClick() {
          return toggleDecline(key);
        },
        title: "Add it back",
        style: {
          background: "transparent",
          border: "none",
          cursor: "pointer",
          color: "#334155",
          fontWeight: 700,
          fontSize: 11
        }
      }, "Undo")) : /*#__PURE__*/React.createElement("span", {
        key: key,
        style: {
          display: "inline-flex",
          alignItems: "center"
        }
      }, btn([key, cfg]), /*#__PURE__*/React.createElement("button", {
        onClick: function onClick() {
          return toggleDecline(key);
        },
        title: "Decline ".concat(cfg.label, " (deduction)"),
        style: {
          marginLeft: 2,
          background: "transparent",
          border: "none",
          cursor: "pointer",
          color: "#94A3B8",
          fontWeight: 800,
          fontSize: 13,
          lineHeight: 1
        }
      }, "\u2715"));
    };
    if (incl.length === 0) {
      return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("span", {
        style: _objectSpread(_objectSpread({}, S.lbl), {}, {
          marginRight: 4,
          fontSize: 10
        })
      }, "Place:"), addl.map(btn));
    }
    // Included items on their own row, a full-width horizontal rule, then the additional
    // options below (width:100% children force line breaks inside the wrapping flex row).
    return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 6,
        width: "100%"
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: _objectSpread(_objectSpread({}, S.lbl), {}, {
        marginRight: 4,
        fontSize: 10,
        color: "#15803D"
      })
    }, "\u2713 Included \u2014 place or decline:"), incl.map(inclBtn)), /*#__PURE__*/React.createElement("div", {
      style: {
        width: "100%",
        borderTop: "1px solid #CBD5E1",
        margin: "2px 0"
      }
    }), /*#__PURE__*/React.createElement("span", {
      style: _objectSpread(_objectSpread({}, S.lbl), {}, {
        marginRight: 4,
        fontSize: 10
      })
    }, "Additional options:"), addl.map(btn));
  }(), activeTool && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      color: accent,
      fontWeight: 600,
      marginLeft: 6
    }
  }, "\u2190 ", ITEMS[activeTool] && ITEMS[activeTool].doorSnap ? "Click near a door" : "Click ".concat(ITEMS[activeTool] && (ITEMS[activeTool].wallOnly || ITEMS[activeTool].wallSnap) ? "a wall" : "the layout")), /*#__PURE__*/React.createElement("div", {
    style: {
      marginLeft: "auto",
      display: "flex",
      gap: 6,
      alignItems: "center"
    }
  }, selectedId && function () {
    // Swap: change a placed door/window/ramp (built-in OR catalog) to a current catalog one,
    // in place. Deliberate click only — dragging/nudging never opens it. Essential for
    // replacing an ARCHIVED item; hidden if there's nothing to swap to.
    var si = items.find(function (i) {
      return i.id === selectedId;
    });
    if (!si) return null;
    if (planLocked) return null;
    var isDoor = si.type === "fixtureDoor" || si.type === "singleDoor" || si.type === "doubleDoor";
    var isWin = si.type === "window";
    var isRamp = si.type === "ramp";
    if (!(isDoor || isWin || isRamp)) return null;
    var pool = isDoor ? placeableDoors : isWin ? placeableWindows : placeableRamps;
    if (!pool || pool.length === 0) return null;
    var archived = isArchivedItem(si);
    var openSwap = function openSwap() {
      setSwapId(si.id);
      setActiveTool(null);
      setToast(null);
      if (isDoor) setDoorPick({
        swap: true
      });else if (isWin) setWindowPick({
        swap: true
      });else setRampPick({
        swap: true
      });
    };
    return /*#__PURE__*/React.createElement(React.Fragment, null, archived && /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 11,
        fontWeight: 700,
        color: "#B45309"
      }
    }, "\u26A0 Archived \u2014 swap it \u2192"), /*#__PURE__*/React.createElement("button", {
      onClick: openSwap,
      style: _objectSpread(_objectSpread({}, S.btn(archived ? "#FEF3C7" : "#ECFEFF", archived ? "#B45309" : "#0891B2")), {}, {
        border: "1px solid ".concat(archived ? "#FCD34D" : "#A5F0FC")
      })
    }, "\u21C4 Swap"));
  }(), selectedId && !planLocked && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("button", {
    onClick: rotSel,
    style: _objectSpread(_objectSpread({}, S.btn("#EEF2FF", "#4F46E5")), {}, {
      border: "1px solid #C7D2FE"
    })
  }, "\u21BB Rotate"), /*#__PURE__*/React.createElement("button", {
    onClick: delSel,
    style: _objectSpread(_objectSpread({}, S.btn("#FEF2F2", "#DC2626")), {}, {
      border: "1px solid #FECACA"
    })
  }, "\u2715 Delete")), !planLocked && /*#__PURE__*/React.createElement("button", {
    onClick: clearAll,
    style: _objectSpread(_objectSpread({}, S.btn("#F1F5F9", "#64748B")), {}, {
      border: "1px solid #E2E8F0"
    })
  }, "Clear"), /*#__PURE__*/React.createElement("button", {
    onClick: exportPNG,
    style: S.btn("#059669", "#FFF")
  }, "\uD83D\uDCF7 Export"), customerFacing && /*#__PURE__*/React.createElement("button", {
    disabled: true,
    title: "See your building in 3D \u2014 coming soon",
    style: _objectSpread(_objectSpread({}, S.btn("#F8FAFC", "#94A3B8")), {}, {
      border: "1px dashed #CBD5E1",
      cursor: "default",
      display: "inline-flex",
      alignItems: "center",
      gap: 5
    })
  }, "3D", /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 9,
      fontWeight: 800,
      letterSpacing: 0.4,
      textTransform: "uppercase",
      background: "#75E6DA",
      color: "#0F4C46",
      borderRadius: 5,
      padding: "1.5px 5px"
    }
  }, "Coming\xA0soon")))), pendingRemoval && function () {
    var prCfg = ITEMS[pendingRemoval.type];
    var prLbl = prCfg && prCfg.label || pendingRemoval.type;
    return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
      style: {
        position: "fixed",
        inset: 0,
        background: "rgba(15,23,42,0.45)",
        zIndex: 900
      }
    }), /*#__PURE__*/React.createElement("div", {
      style: {
        position: "fixed",
        top: 14,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 902,
        background: "#1E293B",
        color: "#FFF",
        borderRadius: 10,
        padding: "10px 16px",
        display: "flex",
        alignItems: "center",
        gap: 12,
        boxShadow: "0 8px 30px rgba(0,0,0,0.35)",
        maxWidth: "92vw",
        boxSizing: "border-box"
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 13,
        fontWeight: 600
      }
    }, "Removing one ", prLbl, " \u2014 click a highlighted item on the plan."), /*#__PURE__*/React.createElement("button", {
      onClick: function onClick() {
        return setPendingRemoval(null);
      },
      style: {
        background: "rgba(255,255,255,0.12)",
        color: "#FFF",
        border: "1px solid rgba(255,255,255,0.35)",
        borderRadius: 6,
        padding: "4px 12px",
        fontSize: 12,
        fontWeight: 700,
        cursor: "pointer",
        flexShrink: 0
      }
    }, "Cancel")));
  }(), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "center",
      padding: "16px 20px",
      background: "#F1F5F9",
      cursor: activeTool ? "crosshair" : dragging ? "grabbing" : "default"
    }
  }, /*#__PURE__*/React.createElement("svg", {
    ref: svgRef,
    viewBox: "".concat(frame.x, " ").concat(frame.y, " ").concat(frame.w, " ").concat(frame.h),
    style: {
      width: "100%",
      maxWidth: dispMaxW,
      height: "auto",
      background: "#FFF",
      borderRadius: 12,
      boxShadow: pendingRemoval ? "0 0 0 3px #F59E0B, 0 4px 24px rgba(0,0,0,0.35)" : "0 4px 24px rgba(0,0,0,0.08)",
      border: "1px solid #E2E8F0",
      userSelect: "none",
      position: "relative",
      zIndex: pendingRemoval ? 901 : "auto"
    },
    onClick: handleClick
  }, /*#__PURE__*/React.createElement("rect", {
    x: 0,
    y: 0,
    width: cW,
    height: TEXT_BAND_TOP,
    fill: "#FFF"
  }), /*#__PURE__*/React.createElement("rect", {
    x: mgX,
    y: mgY,
    width: pW,
    height: pH,
    fill: "#FAFBFD"
  }), Array.from({
    length: Math.floor(bldgW) + 1
  }, function (_, i) {
    return /*#__PURE__*/React.createElement("line", {
      key: "gx".concat(i),
      x1: mgX + i * scale,
      y1: mgY,
      x2: mgX + i * scale,
      y2: mgY + pH,
      stroke: "#E8ECF1",
      strokeWidth: 0.5
    });
  }), Array.from({
    length: Math.floor(bldgH) + 1
  }, function (_, i) {
    return /*#__PURE__*/React.createElement("line", {
      key: "gy".concat(i),
      x1: mgX,
      y1: mgY + i * scale,
      x2: mgX + pW,
      y2: mgY + i * scale,
      stroke: "#E8ECF1",
      strokeWidth: 0.5
    });
  }), /*#__PURE__*/React.createElement("rect", {
    x: mgX,
    y: mgY,
    width: pW,
    height: pH,
    fill: "none",
    stroke: "#1E293B",
    strokeWidth: WALL_THICKNESS
  }), _toConsumableArray(items).sort(function (a, b) {
    return (a.type === "ramp" ? 0 : 1) - (b.type === "ramp" ? 0 : 1);
  }).map(function (item) {
    var cfg = ITEMS[item.type];
    if (!cfg) return null;
    var isSel = item.id === selectedId;

    // ─── Line: rendered as a free-angle segment with two endpoint handles ───
    if (cfg.lineType) {
      var midX = (item.x1 + item.x2) / 2,
        midY = (item.y1 + item.y2) / 2;
      return /*#__PURE__*/React.createElement("g", {
        key: item.id,
        style: {
          cursor: activeTool ? "crosshair" : "grab"
        }
      }, /*#__PURE__*/React.createElement("line", {
        x1: item.x1,
        y1: item.y1,
        x2: item.x2,
        y2: item.y2,
        stroke: "transparent",
        strokeWidth: 14,
        strokeLinecap: "round",
        onMouseDown: function onMouseDown(e) {
          return onPtrDown(e, item);
        },
        onTouchStart: function onTouchStart(e) {
          return onPtrDown(e, item);
        }
      }), /*#__PURE__*/React.createElement("line", {
        x1: item.x1,
        y1: item.y1,
        x2: item.x2,
        y2: item.y2,
        stroke: cfg.color,
        strokeWidth: isSel ? 3 : 2.5,
        strokeLinecap: "round",
        pointerEvents: "none"
      }), isSel && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("line", {
        x1: item.x1,
        y1: item.y1,
        x2: item.x2,
        y2: item.y2,
        stroke: "#3B82F6",
        strokeWidth: 1,
        strokeDasharray: "4 3",
        pointerEvents: "none"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: item.x1,
        cy: item.y1,
        r: 7,
        fill: "#FFF",
        stroke: "#3B82F6",
        strokeWidth: 2,
        style: {
          cursor: "move"
        },
        onMouseDown: function onMouseDown(e) {
          e.stopPropagation();
          startResize(e, item, "ep1");
        },
        onTouchStart: function onTouchStart(e) {
          e.stopPropagation();
          startResize(e, item, "ep1");
        }
      }), /*#__PURE__*/React.createElement("circle", {
        cx: item.x2,
        cy: item.y2,
        r: 7,
        fill: "#FFF",
        stroke: "#3B82F6",
        strokeWidth: 2,
        style: {
          cursor: "move"
        },
        onMouseDown: function onMouseDown(e) {
          e.stopPropagation();
          startResize(e, item, "ep2");
        },
        onTouchStart: function onTouchStart(e) {
          e.stopPropagation();
          startResize(e, item, "ep2");
        }
      })), isSel && resizing && resizing.id === item.id && function () {
        var lenFt = Math.sqrt(Math.pow((item.x2 - item.x1) / scale, 2) + Math.pow((item.y2 - item.y1) / scale, 2));
        return /*#__PURE__*/React.createElement("g", {
          transform: "translate(".concat(midX, ",").concat(midY - 14, ")"),
          pointerEvents: "none"
        }, /*#__PURE__*/React.createElement("rect", {
          x: -26,
          y: -11,
          width: 52,
          height: 20,
          rx: 5,
          fill: "#1E293B"
        }), /*#__PURE__*/React.createElement("text", {
          x: 0,
          y: 3,
          textAnchor: "middle",
          fill: "#FFF",
          fontSize: 11,
          fontWeight: "700"
        }, lenFt.toFixed(1), " ft"));
      }());
    }

    // ─── Text Note: resizable box; text is edited IN PLACE on the canvas ───
    if (cfg.noteType) {
      var w = item.widthPx || 160;
      var h = item.heightPx || 40;
      var isEditing = editingNoteId === item.id;
      // Leader target in coords relative to this g's translate.
      var lt = item.leader ? {
        x: item.leader.x - item.x,
        y: item.leader.y - item.y
      } : null;
      return /*#__PURE__*/React.createElement("g", {
        key: item.id,
        transform: "translate(".concat(item.x, ",").concat(item.y, ")"),
        onMouseDown: function onMouseDown(e) {
          if (isEditing) return;
          onPtrDown(e, item);
        },
        onTouchStart: function onTouchStart(e) {
          if (isEditing) return;
          onPtrDown(e, item);
        },
        style: {
          cursor: isEditing ? "text" : activeTool ? "crosshair" : "grab"
        }
      }, lt && function () {
        var ep = noteEdgePoint(0, 0, w, h, lt.x, lt.y);
        var dx = lt.x - ep.x,
          dy = lt.y - ep.y;
        if (Math.sqrt(dx * dx + dy * dy) <= 10) return null;
        return /*#__PURE__*/React.createElement("g", {
          pointerEvents: "none"
        }, /*#__PURE__*/React.createElement("line", {
          x1: ep.x,
          y1: ep.y,
          x2: lt.x,
          y2: lt.y,
          stroke: cfg.color,
          strokeWidth: 1.5,
          strokeDasharray: "5 4"
        }), /*#__PURE__*/React.createElement("circle", {
          cx: lt.x,
          cy: lt.y,
          r: 3.5,
          fill: cfg.color
        }));
      }(), isSel && /*#__PURE__*/React.createElement("rect", {
        x: -w / 2 - 4,
        y: -h / 2 - 4,
        width: w + 8,
        height: h + 8,
        fill: "none",
        stroke: "#3B82F6",
        strokeWidth: 2,
        strokeDasharray: "4 2",
        rx: 6
      }), /*#__PURE__*/React.createElement("rect", {
        x: -w / 2,
        y: -h / 2,
        width: w,
        height: h,
        fill: "#FFFBEB",
        stroke: cfg.color,
        strokeWidth: 1.25,
        rx: 4
      }), /*#__PURE__*/React.createElement("foreignObject", {
        x: -w / 2,
        y: -h / 2,
        width: w,
        height: h
      }, isEditing ? /*#__PURE__*/React.createElement("div", {
        xmlns: "http://www.w3.org/1999/xhtml",
        key: "edit" + item.id,
        contentEditable: true,
        suppressContentEditableWarning: true,
        ref: function ref(el) {
          if (el && el.dataset.init !== "1") {
            el.dataset.init = "1";
            el.textContent = item.text || "";
            setTimeout(function () {
              el.focus();
              // Select-all so typing replaces the "Note" placeholder.
              try {
                var s = window.getSelection();
                var rg = document.createRange();
                rg.selectNodeContents(el);
                s.removeAllRanges();
                s.addRange(rg);
              } catch (_e) {/* selection APIs unavailable */}
            }, 0);
          }
        },
        onMouseDown: function onMouseDown(e) {
          return e.stopPropagation();
        },
        onTouchStart: function onTouchStart(e) {
          return e.stopPropagation();
        },
        onClick: function onClick(e) {
          return e.stopPropagation();
        },
        onPaste: function onPaste(e) {
          // Paste as PLAIN text: rich-HTML pastes would render their own
          // markup mid-edit, and textContent drops element boundaries so
          // multi-line pastes would silently concatenate without spaces.
          e.preventDefault();
          var t = (e.clipboardData && e.clipboardData.getData("text/plain") || "").replace(/\s+/g, " ");
          document.execCommand("insertText", false, t);
        },
        onInput: function onInput(e) {
          var v = e.currentTarget.textContent;
          setItems(function (p) {
            return p.map(function (i) {
              return i.id === item.id ? _objectSpread(_objectSpread({}, i), {}, {
                text: v
              }) : i;
            });
          });
        },
        onKeyDown: function onKeyDown(e) {
          e.stopPropagation();
          if (e.key === "Enter" || e.key === "Escape") {
            e.preventDefault();
            e.currentTarget.blur();
          }
        },
        onBlur: function onBlur(e) {
          var v = (e.currentTarget.textContent || "").trim();
          setItems(function (p) {
            return p.map(function (i) {
              return i.id === item.id ? _objectSpread(_objectSpread({}, i), {}, {
                text: v
              }) : i;
            });
          });
          setEditingNoteId(null);
        },
        style: {
          width: "100%",
          height: "100%",
          padding: "4px 8px",
          boxSizing: "border-box",
          font: "600 12px sans-serif",
          color: cfg.color,
          lineHeight: 1.3,
          textAlign: "center",
          wordWrap: "break-word",
          overflowWrap: "break-word",
          overflow: "hidden",
          whiteSpace: "pre-wrap",
          outline: "none",
          cursor: "text",
          userSelect: "text",
          WebkitUserSelect: "text"
        }
      }) : /*#__PURE__*/React.createElement("div", {
        xmlns: "http://www.w3.org/1999/xhtml",
        key: "view" + item.id,
        style: {
          width: "100%",
          height: "100%",
          padding: "4px 8px",
          boxSizing: "border-box",
          font: "600 12px sans-serif",
          color: cfg.color,
          lineHeight: 1.3,
          textAlign: "center",
          wordWrap: "break-word",
          overflowWrap: "break-word",
          overflow: "hidden",
          display: "flex",
          alignItems: "center",
          justifyContent: "center"
        }
      }, item.text || "Note")), isSel && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("rect", {
        x: w / 2 - 14,
        y: h / 2 - 14,
        width: 28,
        height: 28,
        fill: "transparent",
        style: {
          cursor: "nwse-resize"
        },
        onClick: function onClick(e) {
          return e.stopPropagation();
        },
        onMouseDown: function onMouseDown(e) {
          e.stopPropagation();
          startResize(e, item, "br");
        },
        onTouchStart: function onTouchStart(e) {
          e.stopPropagation();
          startResize(e, item, "br");
        }
      }), /*#__PURE__*/React.createElement("rect", {
        x: w / 2 - 7,
        y: h / 2 - 7,
        width: 14,
        height: 14,
        fill: "#3B82F6",
        stroke: "#FFF",
        strokeWidth: 1.5,
        rx: 2,
        pointerEvents: "none"
      }), /*#__PURE__*/React.createElement("g", {
        transform: "translate(".concat(w / 2 + 2, ",").concat(-h / 2 - 2, ")"),
        style: {
          cursor: "pointer"
        },
        onMouseDown: function onMouseDown(e) {
          return e.stopPropagation();
        },
        onTouchStart: function onTouchStart(e) {
          return e.stopPropagation();
        },
        onClick: function onClick(e) {
          e.stopPropagation();
          delSel();
        }
      }, /*#__PURE__*/React.createElement("circle", {
        r: 9,
        fill: "#DC2626",
        stroke: "#FFF",
        strokeWidth: 1.5
      }), /*#__PURE__*/React.createElement("line", {
        x1: -3.5,
        y1: -3.5,
        x2: 3.5,
        y2: 3.5,
        stroke: "#FFF",
        strokeWidth: 1.8,
        strokeLinecap: "round"
      }), /*#__PURE__*/React.createElement("line", {
        x1: -3.5,
        y1: 3.5,
        x2: 3.5,
        y2: -3.5,
        stroke: "#FFF",
        strokeWidth: 1.8,
        strokeLinecap: "round"
      })), !isEditing && function () {
        var hx = lt ? lt.x : -w / 2 - 18,
          hy = lt ? lt.y : 0;
        return /*#__PURE__*/React.createElement("g", null, !lt && /*#__PURE__*/React.createElement("line", {
          x1: -w / 2,
          y1: 0,
          x2: hx + 7,
          y2: hy,
          stroke: "#94A3B8",
          strokeWidth: 1,
          strokeDasharray: "2 3",
          pointerEvents: "none"
        }), /*#__PURE__*/React.createElement("circle", {
          cx: hx,
          cy: hy,
          r: 7,
          fill: "#FFF",
          stroke: "#3B82F6",
          strokeWidth: 2,
          style: {
            cursor: "move"
          },
          onClick: function onClick(e) {
            return e.stopPropagation();
          },
          onMouseDown: function onMouseDown(e) {
            e.stopPropagation();
            startResize(e, item, "leader");
          },
          onTouchStart: function onTouchStart(e) {
            e.stopPropagation();
            startResize(e, item, "leader");
          }
        }, /*#__PURE__*/React.createElement("title", null, "Drag to point this note at something \xB7 drop back on the note to remove")));
      }()));
    }
    var itemW = item.widthFt || cfg.width;
    var itemH = item.heightFt || cfg.height;
    var iw = itemW * scale;
    var ih = itemH * scale;
    var isWB = item.type === "workbench";
    return /*#__PURE__*/React.createElement("g", {
      key: item.id,
      transform: "translate(".concat(item.x, ",").concat(item.y, ") rotate(").concat(item.rotation, ")"),
      onMouseDown: function onMouseDown(e) {
        return onPtrDown(e, item);
      },
      onTouchStart: function onTouchStart(e) {
        return onPtrDown(e, item);
      },
      style: {
        cursor: activeTool ? "crosshair" : "grab"
      }
    }, isSel && /*#__PURE__*/React.createElement("rect", {
      x: -iw / 2 - 4,
      y: (cfg.wallOnly ? -8 : -ih / 2) - 4,
      width: iw + 8,
      height: (cfg.wallOnly ? 16 : ih) + 8,
      fill: "none",
      stroke: "#3B82F6",
      strokeWidth: 2,
      strokeDasharray: "4 2",
      rx: 3
    }), isArchivedItem(item) && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("rect", {
      x: -iw / 2 - 3,
      y: (cfg.wallOnly ? -8 : -ih / 2) - 3,
      width: iw + 6,
      height: (cfg.wallOnly ? 16 : ih) + 6,
      fill: "none",
      stroke: "#F59E0B",
      strokeWidth: 2,
      strokeDasharray: "2 2",
      rx: 3
    }), /*#__PURE__*/React.createElement("text", {
      x: 0,
      y: cfg.wallOnly ? item.wall === "north" || item.wall === "east" ? 27 : -23 : -ih / 2 - 6,
      textAnchor: "middle",
      fontSize: 9,
      fontWeight: "800",
      fill: "#B45309"
    }, "\u26A0 archived")), item.type === "loft" ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("defs", null, /*#__PURE__*/React.createElement("clipPath", {
      id: "loftClip".concat(item.id)
    }, /*#__PURE__*/React.createElement("rect", {
      x: -iw / 2,
      y: -ih / 2,
      width: iw,
      height: ih,
      rx: 2
    }))), /*#__PURE__*/React.createElement("rect", {
      x: -iw / 2,
      y: -ih / 2,
      width: iw,
      height: ih,
      fill: cfg.color + "18",
      stroke: cfg.color,
      strokeWidth: 2,
      strokeDasharray: "6 4",
      rx: 2
    }), /*#__PURE__*/React.createElement("g", {
      opacity: 0.15,
      clipPath: "url(#loftClip".concat(item.id, ")")
    }, Array.from({
      length: Math.ceil((iw + ih) / 10) + 2
    }, function (_, d) {
      return /*#__PURE__*/React.createElement("line", {
        key: d,
        x1: -iw / 2 + d * 10,
        y1: -ih / 2,
        x2: -iw / 2 + d * 10 - ih,
        y2: ih / 2,
        stroke: cfg.color,
        strokeWidth: 1
      });
    })), /*#__PURE__*/React.createElement("text", {
      x: 0,
      y: 4,
      textAnchor: "middle",
      fill: cfg.color,
      fontSize: 10,
      fontWeight: "700"
    }, "LOFT"), /*#__PURE__*/React.createElement("text", {
      x: 0,
      y: 16,
      textAnchor: "middle",
      fill: cfg.color,
      fontSize: 9,
      opacity: 0.7
    }, itemW, "\xD7", itemH, " ft"), isSel && function () {
      var hz = Math.min(Math.max(ih / 3, 22), 36, ih * 0.5);
      var vz = Math.min(Math.max(iw / 3, 22), 36, iw * 0.5);
      return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("rect", {
        x: -vz / 2,
        y: -ih / 2 - 1,
        width: vz,
        height: hz / 2 + 1,
        fill: "transparent",
        style: {
          cursor: "ns-resize"
        },
        onMouseDown: function onMouseDown(e) {
          e.stopPropagation();
          startResize(e, item, "top");
        },
        onTouchStart: function onTouchStart(e) {
          e.stopPropagation();
          startResize(e, item, "top");
        }
      }), /*#__PURE__*/React.createElement("rect", {
        x: -vz / 2,
        y: ih / 2 - hz / 2,
        width: vz,
        height: hz / 2 + 1,
        fill: "transparent",
        style: {
          cursor: "ns-resize"
        },
        onMouseDown: function onMouseDown(e) {
          e.stopPropagation();
          startResize(e, item, "bottom");
        },
        onTouchStart: function onTouchStart(e) {
          e.stopPropagation();
          startResize(e, item, "bottom");
        }
      }), /*#__PURE__*/React.createElement("rect", {
        x: -iw / 2 - 1,
        y: -hz / 2,
        width: vz / 2 + 1,
        height: hz,
        fill: "transparent",
        style: {
          cursor: "ew-resize"
        },
        onMouseDown: function onMouseDown(e) {
          e.stopPropagation();
          startResize(e, item, "left");
        },
        onTouchStart: function onTouchStart(e) {
          e.stopPropagation();
          startResize(e, item, "left");
        }
      }), /*#__PURE__*/React.createElement("rect", {
        x: iw / 2 - vz / 2,
        y: -hz / 2,
        width: vz / 2 + 1,
        height: hz,
        fill: "transparent",
        style: {
          cursor: "ew-resize"
        },
        onMouseDown: function onMouseDown(e) {
          e.stopPropagation();
          startResize(e, item, "right");
        },
        onTouchStart: function onTouchStart(e) {
          e.stopPropagation();
          startResize(e, item, "right");
        }
      }), /*#__PURE__*/React.createElement("line", {
        x1: -vz / 3,
        y1: -ih / 2,
        x2: vz / 3,
        y2: -ih / 2,
        stroke: "#3B82F6",
        strokeWidth: 3,
        strokeLinecap: "round",
        pointerEvents: "none"
      }), /*#__PURE__*/React.createElement("line", {
        x1: -vz / 3,
        y1: ih / 2,
        x2: vz / 3,
        y2: ih / 2,
        stroke: "#3B82F6",
        strokeWidth: 3,
        strokeLinecap: "round",
        pointerEvents: "none"
      }), /*#__PURE__*/React.createElement("line", {
        x1: -iw / 2,
        y1: -hz / 3,
        x2: -iw / 2,
        y2: hz / 3,
        stroke: "#3B82F6",
        strokeWidth: 3,
        strokeLinecap: "round",
        pointerEvents: "none"
      }), /*#__PURE__*/React.createElement("line", {
        x1: iw / 2,
        y1: -hz / 3,
        x2: iw / 2,
        y2: hz / 3,
        stroke: "#3B82F6",
        strokeWidth: 3,
        strokeLinecap: "round",
        pointerEvents: "none"
      }));
    }()) : cfg.wallOnly ? /*#__PURE__*/React.createElement(React.Fragment, null, item.type === "roughOpening" ? /*#__PURE__*/React.createElement("rect", {
      x: -iw / 2,
      y: -5,
      width: iw,
      height: 10,
      fill: "#FFFFFF",
      stroke: "#000000",
      strokeWidth: 1.5,
      rx: 1
    }) : /*#__PURE__*/React.createElement("rect", {
      x: -iw / 2,
      y: -5,
      width: iw,
      height: 10,
      fill: item.type === "fixtureDoor" ? fixtureDoorColor(item) : cfg.color,
      rx: 1
    }), item.type === "singleDoor" && function () {
      var r = iw * 0.8,
        out = item.wall === "north" || item.wall === "east";
      return /*#__PURE__*/React.createElement("path", {
        d: "M ".concat(-iw / 2 + r, " 0 A ").concat(r, " ").concat(r, " 0 0 ").concat(out ? 0 : 1, " ").concat(-iw / 2, " ").concat(out ? -r : r),
        fill: "none",
        stroke: cfg.color + "60",
        strokeWidth: 1.5,
        strokeDasharray: "4 3"
      });
    }(), item.type === "doubleDoor" && function () {
      var r = iw * 0.4,
        out = item.wall === "north" || item.wall === "east";
      var s = out ? -1 : 1;
      return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
        d: "M ".concat(-iw / 2 + r, " 0 A ").concat(r, " ").concat(r, " 0 0 ").concat(out ? 0 : 1, " ").concat(-iw / 2, " ").concat(s * r),
        fill: "none",
        stroke: cfg.color + "60",
        strokeWidth: 1.5,
        strokeDasharray: "4 3"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M ".concat(iw / 2 - r, " 0 A ").concat(r, " ").concat(r, " 0 0 ").concat(out ? 1 : 0, " ").concat(iw / 2, " ").concat(s * r),
        fill: "none",
        stroke: cfg.color + "60",
        strokeWidth: 1.5,
        strokeDasharray: "4 3"
      }), /*#__PURE__*/React.createElement("line", {
        x1: 0,
        y1: -5,
        x2: 0,
        y2: 5,
        stroke: "#FFF",
        strokeWidth: 1.5
      }));
    }(), item.type === "fixtureDoor" && fixtureDoorSVG(item, iw, fixtureDoorColor(item)), item.type === "window" && /*#__PURE__*/React.createElement("g", null, /*#__PURE__*/React.createElement("line", {
      x1: 0,
      y1: -4,
      x2: 0,
      y2: 4,
      stroke: "#FFF",
      strokeWidth: 1.5
    }), /*#__PURE__*/React.createElement("line", {
      x1: -iw / 4,
      y1: -4,
      x2: -iw / 4,
      y2: 4,
      stroke: "#FFF",
      strokeWidth: 1
    }), /*#__PURE__*/React.createElement("line", {
      x1: iw / 4,
      y1: -4,
      x2: iw / 4,
      y2: 4,
      stroke: "#FFF",
      strokeWidth: 1
    })), /*#__PURE__*/React.createElement("text", {
      x: 0,
      y: item.wall === "north" || item.wall === "east" ? 14 : -10,
      textAnchor: "middle",
      fill: "#1E293B",
      fontSize: 9,
      fontWeight: "700"
    }, function () {
      if (item.type === "roughOpening") {
        var idx = items.filter(function (i) {
          return i.type === "roughOpening";
        }).findIndex(function (r) {
          return r.id === item.id;
        });
        return "RO-".concat(idx + 1);
      }
      var base = (item.type === "fixtureDoor" || item.type === "window") && item.planLabel ? item.planLabel : cfg.shortLabel;
      // Doors + windows prefix their width, e.g. "6' DD", so the size reads off the plan.
      var isDoorOrWin = item.type === "singleDoor" || item.type === "doubleDoor" || item.type === "fixtureDoor" || item.type === "window";
      var w = isDoorOrWin ? fmtFtIn((item.widthFt || cfg.width) * 12) : "";
      return w ? "".concat(w, " ").concat(base) : base;
    }()), item.type === "roughOpening" && isSel && function () {
      var cursor = item.wall === "north" || item.wall === "south" ? "ew-resize" : "ns-resize";
      var endZoneW = Math.min(Math.max(iw / 5, 10), 22, iw * 0.4);
      return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("rect", {
        x: -iw / 2 + 1,
        y: -4,
        width: endZoneW - 2,
        height: 8,
        fill: "#3B82F640",
        stroke: "#3B82F680",
        strokeWidth: 1,
        pointerEvents: "none",
        rx: 1
      }), /*#__PURE__*/React.createElement("rect", {
        x: iw / 2 - endZoneW + 1,
        y: -4,
        width: endZoneW - 2,
        height: 8,
        fill: "#3B82F640",
        stroke: "#3B82F680",
        strokeWidth: 1,
        pointerEvents: "none",
        rx: 1
      }), /*#__PURE__*/React.createElement("rect", {
        x: -iw / 2 - 4,
        y: -9,
        width: endZoneW + 4,
        height: 18,
        fill: "transparent",
        style: {
          cursor: cursor
        },
        onMouseDown: function onMouseDown(e) {
          e.stopPropagation();
          startResize(e, item, "min");
        },
        onTouchStart: function onTouchStart(e) {
          e.stopPropagation();
          startResize(e, item, "min");
        }
      }), /*#__PURE__*/React.createElement("rect", {
        x: iw / 2 - endZoneW,
        y: -9,
        width: endZoneW + 4,
        height: 18,
        fill: "transparent",
        style: {
          cursor: cursor
        },
        onMouseDown: function onMouseDown(e) {
          e.stopPropagation();
          startResize(e, item, "max");
        },
        onTouchStart: function onTouchStart(e) {
          e.stopPropagation();
          startResize(e, item, "max");
        }
      }));
    }()) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("rect", {
      x: -iw / 2,
      y: -ih / 2,
      width: iw,
      height: ih,
      fill: cfg.color + (item.type === "ramp" ? "12" : "30"),
      stroke: cfg.color + (item.type === "ramp" ? "80" : "FF"),
      strokeWidth: item.type === "ramp" ? 1.5 : 2,
      rx: 2
    }), item.type === "ramp" ? /*#__PURE__*/React.createElement("text", {
      x: -iw / 2 + 5,
      y: 4,
      textAnchor: "start",
      fill: cfg.color,
      fontSize: 9,
      fontWeight: "700"
    }, item.planLabel || "RAMP") : isWB ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("text", {
      x: 0,
      y: 0,
      textAnchor: "middle",
      fill: cfg.color,
      fontSize: 11,
      fontWeight: "700"
    }, itemW, " ft"), /*#__PURE__*/React.createElement("text", {
      x: 0,
      y: 13,
      textAnchor: "middle",
      fill: cfg.color,
      fontSize: 8,
      opacity: 0.7
    }, "Workbench")) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("text", {
      x: 0,
      y: 2,
      textAnchor: "middle",
      fill: cfg.color,
      fontSize: 10,
      fontWeight: "700"
    }, cfg.shortLabel), /*#__PURE__*/React.createElement("text", {
      x: 0,
      y: 14,
      textAnchor: "middle",
      fill: cfg.color,
      fontSize: 8,
      opacity: 0.7
    }, itemW, "\xD7", itemH)), isWB && isSel && function () {
      var isHoriz = item.wall === "north" || item.wall === "south";
      var cursor = isHoriz ? "ew-resize" : "ns-resize";
      var endZoneW = Math.min(Math.max(iw / 4, 16), 30, iw * 0.45);
      var handleX1 = -iw / 2 + endZoneW / 2;
      var handleX2 = iw / 2 - endZoneW / 2;
      return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("rect", {
        x: -iw / 2 + 1,
        y: -ih / 2 + 1,
        width: endZoneW - 2,
        height: ih - 2,
        fill: "#3B82F618",
        stroke: "#3B82F680",
        strokeWidth: 1.5,
        pointerEvents: "none",
        rx: 2
      }), /*#__PURE__*/React.createElement("rect", {
        x: iw / 2 - endZoneW + 1,
        y: -ih / 2 + 1,
        width: endZoneW - 2,
        height: ih - 2,
        fill: "#3B82F618",
        stroke: "#3B82F680",
        strokeWidth: 1.5,
        pointerEvents: "none",
        rx: 2
      }), /*#__PURE__*/React.createElement("text", {
        x: handleX1,
        y: 5,
        textAnchor: "middle",
        fill: "#3B82F6",
        fontSize: 14,
        fontWeight: "700",
        pointerEvents: "none"
      }, "\u25C4"), /*#__PURE__*/React.createElement("text", {
        x: handleX2,
        y: 5,
        textAnchor: "middle",
        fill: "#3B82F6",
        fontSize: 14,
        fontWeight: "700",
        pointerEvents: "none"
      }, "\u25BA"), /*#__PURE__*/React.createElement("rect", {
        x: -iw / 2,
        y: -ih / 2,
        width: endZoneW,
        height: ih,
        fill: "transparent",
        style: {
          cursor: cursor
        },
        onMouseDown: function onMouseDown(e) {
          e.stopPropagation();
          startResize(e, item, "min");
        },
        onTouchStart: function onTouchStart(e) {
          e.stopPropagation();
          startResize(e, item, "min");
        }
      }), /*#__PURE__*/React.createElement("rect", {
        x: iw / 2 - endZoneW,
        y: -ih / 2,
        width: endZoneW,
        height: ih,
        fill: "transparent",
        style: {
          cursor: cursor
        },
        onMouseDown: function onMouseDown(e) {
          e.stopPropagation();
          startResize(e, item, "max");
        },
        onTouchStart: function onTouchStart(e) {
          e.stopPropagation();
          startResize(e, item, "max");
        }
      }));
    }()));
  }), /*#__PURE__*/React.createElement("text", {
    x: mgX + pW / 2,
    y: mgY - 16,
    textAnchor: "middle",
    fill: "#475569",
    fontSize: 13,
    fontWeight: "bold"
  }, bldgW, " ft"), /*#__PURE__*/React.createElement("text", {
    x: mgX + pW / 2,
    y: mgY + pH + 26,
    textAnchor: "middle",
    fill: "#475569",
    fontSize: 13,
    fontWeight: "bold"
  }, bldgW, " ft"), /*#__PURE__*/React.createElement("text", {
    x: mgX - 20,
    y: mgY + pH / 2,
    textAnchor: "middle",
    fill: "#475569",
    fontSize: 13,
    fontWeight: "bold",
    transform: "rotate(-90,".concat(mgX - 20, ",").concat(mgY + pH / 2, ")")
  }, bldgH, " ft"), /*#__PURE__*/React.createElement("text", {
    x: mgX + pW + 24,
    y: mgY + pH / 2,
    textAnchor: "middle",
    fill: "#475569",
    fontSize: 13,
    fontWeight: "bold",
    transform: "rotate(90,".concat(mgX + pW + 24, ",").concat(mgY + pH / 2, ")")
  }, bldgH, " ft"), frontWall && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("text", {
    x: mgX + pW / 2,
    y: mgY - 32,
    textAnchor: "middle",
    fill: "#94A3B8",
    fontSize: 10,
    fontWeight: "600",
    letterSpacing: "0.1em"
  }, getDisplayLabel("north", frontWall)), /*#__PURE__*/React.createElement("text", {
    x: mgX + pW / 2,
    y: mgY + pH + 42,
    textAnchor: "middle",
    fill: "#94A3B8",
    fontSize: 10,
    fontWeight: "600",
    letterSpacing: "0.1em"
  }, getDisplayLabel("south", frontWall)), /*#__PURE__*/React.createElement("text", {
    x: mgX - 38,
    y: mgY + pH / 2,
    textAnchor: "middle",
    fill: "#94A3B8",
    fontSize: 10,
    fontWeight: "600",
    letterSpacing: "0.1em",
    transform: "rotate(-90,".concat(mgX - 38, ",").concat(mgY + pH / 2, ")")
  }, getDisplayLabel("west", frontWall)), /*#__PURE__*/React.createElement("text", {
    x: mgX + pW + 42,
    y: mgY + pH / 2,
    textAnchor: "middle",
    fill: "#94A3B8",
    fontSize: 10,
    fontWeight: "600",
    letterSpacing: "0.1em",
    transform: "rotate(90,".concat(mgX + pW + 42, ",").concat(mgY + pH / 2, ")")
  }, getDisplayLabel("east", frontWall))), resizing && function () {
    var ri = items.find(function (i) {
      return i.id === resizing.id;
    });
    if (!ri || ri.type === "line" || !Number.isFinite(ri.widthFt)) return null; // line shows its own length inline; notes have no widthFt → skip the 'ft' badge (audit #F3)
    return /*#__PURE__*/React.createElement("g", {
      transform: "translate(".concat(ri.x, ",").concat(ri.y - 28, ")")
    }, /*#__PURE__*/React.createElement("rect", {
      x: -30,
      y: -12,
      width: 60,
      height: 24,
      rx: 6,
      fill: "#1E293B"
    }), /*#__PURE__*/React.createElement("text", {
      x: 0,
      y: 4,
      textAnchor: "middle",
      fill: "#FFF",
      fontSize: 13,
      fontWeight: "700"
    }, Math.round(ri.widthFt * 10) / 10, " ft"));
  }(), pendingRemoval && items.filter(function (i) {
    return i.type === pendingRemoval.type;
  }).map(function (it) {
    var c = ITEMS[it.type];
    if (!c) return null;
    var iwFt = it.widthFt || c.width,
      ihFt = it.heightFt || c.height;
    var iw = iwFt * scale,
      ih = ihFt * scale;
    var rot = it.rotation === 90 || it.rotation === 270;
    var hw = (rot ? ih : iw) / 2,
      hh = (rot ? iw : ih) / 2;
    return /*#__PURE__*/React.createElement("rect", {
      key: "pr-".concat(it.id),
      x: it.x - hw - 5,
      y: it.y - hh - 5,
      width: hw * 2 + 10,
      height: hh * 2 + 10,
      rx: 5,
      fill: "rgba(220,38,38,0.10)",
      stroke: "#DC2626",
      strokeWidth: 2.5,
      style: {
        cursor: "pointer"
      },
      onMouseDown: function onMouseDown(e) {
        return e.stopPropagation();
      },
      onTouchStart: function onTouchStart(e) {
        return e.stopPropagation();
      },
      onClick: function onClick(e) {
        e.stopPropagation();
        setItems(function (p) {
          return p.filter(function (x) {
            return x.id !== it.id && !(x.type === "ramp" && x.snapDoorId === it.id);
          });
        });
        setPendingRemoval(null);
        setSelectedId(null);
      }
    }, /*#__PURE__*/React.createElement("animate", {
      attributeName: "stroke-opacity",
      values: "1;0.25;1",
      dur: "1.1s",
      repeatCount: "indefinite"
    }));
  }))), !submitted && /*#__PURE__*/React.createElement("div", {
    style: {
      background: "#FFF",
      borderTop: "2px solid #E2E8F0",
      padding: "14px 20px"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: _objectSpread(_objectSpread({}, S.lbl), {}, {
      display: "block",
      marginBottom: 10,
      fontSize: 12
    })
  }, "Customer Information"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexWrap: "wrap",
      gap: 10,
      marginBottom: 10
    }
  }, C.contactFields.includes("name") && /*#__PURE__*/React.createElement("div", {
    style: {
      flex: "1 1 180px"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: _objectSpread(_objectSpread({}, S.lbl), {}, {
      fontSize: 10,
      display: "block",
      marginBottom: 3
    })
  }, "Name *"), /*#__PURE__*/React.createElement("input", {
    type: "text",
    value: contact.name,
    onChange: function onChange(e) {
      return setContact(function (p) {
        return _objectSpread(_objectSpread({}, p), {}, {
          name: e.target.value
        });
      });
    },
    placeholder: "Full Name",
    style: _objectSpread(_objectSpread({}, S.sel), {}, {
      width: "100%",
      boxSizing: "border-box"
    })
  })), C.contactFields.includes("email") && /*#__PURE__*/React.createElement("div", {
    style: {
      flex: "1 1 200px"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: _objectSpread(_objectSpread({}, S.lbl), {}, {
      fontSize: 10,
      display: "block",
      marginBottom: 3
    })
  }, "Email *"), /*#__PURE__*/React.createElement("input", {
    type: "email",
    value: contact.email,
    onChange: function onChange(e) {
      return setContact(function (p) {
        return _objectSpread(_objectSpread({}, p), {}, {
          email: e.target.value
        });
      });
    },
    placeholder: "email@example.com",
    style: _objectSpread(_objectSpread({}, S.sel), {}, {
      width: "100%",
      boxSizing: "border-box"
    })
  })), C.contactFields.includes("phone") && /*#__PURE__*/React.createElement("div", {
    style: {
      flex: "1 1 140px"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: _objectSpread(_objectSpread({}, S.lbl), {}, {
      fontSize: 10,
      display: "block",
      marginBottom: 3
    })
  }, "Phone *"), /*#__PURE__*/React.createElement("input", {
    type: "tel",
    inputMode: "tel",
    autoComplete: "tel",
    value: formatPhoneDisplay(contact.phone),
    onChange: function onChange(e) {
      return setContact(function (p) {
        return _objectSpread(_objectSpread({}, p), {}, {
          phone: formatPhoneDisplay(e.target.value)
        });
      });
    },
    placeholder: "(555) 555-5555",
    style: _objectSpread(_objectSpread({}, S.sel), {}, {
      width: "100%",
      boxSizing: "border-box"
    })
  }))), (C.googleMapsApiKey || DEFAULT_GOOGLE_MAPS_API_KEY) && C.contactFields.includes("street") && /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10,
      marginBottom: 10
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: _objectSpread(_objectSpread({}, S.lbl), {}, {
      fontSize: 10,
      whiteSpace: "nowrap"
    })
  }, "Search for address"), /*#__PURE__*/React.createElement("div", {
    ref: attachStreetAutocomplete,
    style: {
      flex: 1,
      minWidth: 0,
      display: "flex",
      alignItems: "stretch",
      boxSizing: "border-box"
    }
  }), function () {
    // Open Google Maps directly to the address typed in the fields below. Built from the
    // customer's own street/city/state/zip; disabled until at least one is filled.
    var addr = [contact.street, contact.city, contact.state, contact.zip].map(function (s) {
      return (s || "").trim();
    }).filter(Boolean).join(", ");
    return /*#__PURE__*/React.createElement("button", {
      type: "button",
      disabled: !addr,
      onClick: function onClick() {
        if (addr) window.open("https://www.google.com/maps/search/?api=1&query=".concat(encodeURIComponent(addr)), "_blank", "noopener,noreferrer");
      },
      title: addr ? "Open this address in Google Maps" : "Enter an address below first",
      style: _objectSpread(_objectSpread({}, S.btn("#EEF2FF", "#4F46E5")), {}, {
        border: "1px solid #C7D2FE",
        flexShrink: 0,
        whiteSpace: "nowrap",
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        opacity: addr ? 1 : 0.5,
        cursor: addr ? "pointer" : "not-allowed"
      })
    }, "\uD83D\uDCCD View Property");
  }()), (C.contactFields.includes("street") || C.contactFields.includes("city")) && /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexWrap: "wrap",
      gap: 10
    }
  }, C.contactFields.includes("street") && /*#__PURE__*/React.createElement("div", {
    style: {
      flex: "2 1 200px"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: _objectSpread(_objectSpread({}, S.lbl), {}, {
      fontSize: 10,
      display: "block",
      marginBottom: 3
    })
  }, "Street Address *"), /*#__PURE__*/React.createElement("input", {
    type: "text",
    autoComplete: "street-address",
    value: contact.street,
    onChange: function onChange(e) {
      return setContact(function (p) {
        return _objectSpread(_objectSpread({}, p), {}, {
          street: e.target.value
        });
      });
    },
    placeholder: "123 Main St",
    style: _objectSpread(_objectSpread({}, S.sel), {}, {
      width: "100%",
      boxSizing: "border-box"
    })
  })), C.contactFields.includes("city") && /*#__PURE__*/React.createElement("div", {
    style: {
      flex: "1 1 130px"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: _objectSpread(_objectSpread({}, S.lbl), {}, {
      fontSize: 10,
      display: "block",
      marginBottom: 3
    })
  }, "City *"), /*#__PURE__*/React.createElement("input", {
    type: "text",
    autoComplete: "address-level2",
    value: contact.city,
    onChange: function onChange(e) {
      return setContact(function (p) {
        return _objectSpread(_objectSpread({}, p), {}, {
          city: e.target.value
        });
      });
    },
    placeholder: "City",
    style: _objectSpread(_objectSpread({}, S.sel), {}, {
      width: "100%",
      boxSizing: "border-box"
    })
  })), C.contactFields.includes("state") && /*#__PURE__*/React.createElement("div", {
    style: {
      flex: "1 1 160px"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: _objectSpread(_objectSpread({}, S.lbl), {}, {
      fontSize: 10,
      display: "block",
      marginBottom: 3
    })
  }, "State *"), /*#__PURE__*/React.createElement("select", {
    autoComplete: "address-level1",
    value: contact.state,
    onChange: function onChange(e) {
      return setContact(function (p) {
        return _objectSpread(_objectSpread({}, p), {}, {
          state: e.target.value
        });
      });
    },
    style: _objectSpread(_objectSpread({}, S.sel), {}, {
      width: "100%",
      boxSizing: "border-box",
      color: contact.state ? undefined : "#94A3B8"
    })
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "Select state\u2026"), ["Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "Delaware", "District of Columbia", "Florida", "Georgia", "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky", "Louisiana", "Maine", "Maryland", "Massachusetts", "Michigan", "Minnesota", "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire", "New Jersey", "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island", "South Carolina", "South Dakota", "Tennessee", "Texas", "Utah", "Vermont", "Virginia", "Washington", "West Virginia", "Wisconsin", "Wyoming"].map(function (s) {
    return /*#__PURE__*/React.createElement("option", {
      key: s,
      value: s,
      style: {
        color: "#1E293B"
      }
    }, s);
  }))), C.contactFields.includes("zip") && /*#__PURE__*/React.createElement("div", {
    style: {
      flex: "0 1 100px"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: _objectSpread(_objectSpread({}, S.lbl), {}, {
      fontSize: 10,
      display: "block",
      marginBottom: 3
    })
  }, "Zip *"), /*#__PURE__*/React.createElement("input", {
    type: "text",
    inputMode: "numeric",
    autoComplete: "postal-code",
    value: contact.zip,
    onChange: function onChange(e) {
      return setContact(function (p) {
        return _objectSpread(_objectSpread({}, p), {}, {
          zip: e.target.value.replace(/\D/g, "").slice(0, 5)
        });
      });
    },
    placeholder: "00000",
    maxLength: 5,
    style: _objectSpread(_objectSpread({}, S.sel), {}, {
      width: "100%",
      boxSizing: "border-box"
    })
  })))), !submitted && /*#__PURE__*/React.createElement("div", {
    style: {
      background: "#FFF",
      borderTop: "2px solid #E2E8F0",
      padding: "14px 20px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: function onClick() {
      if (!detailsLocked) setAdditionalOpen(function (o) {
        return !o;
      });
    },
    style: _objectSpread({
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 10,
      cursor: detailsLocked ? "default" : "pointer",
      userSelect: "none"
    }, customerFacing ? {
      // Unlocked = a SOLID accent bar with the submit button's shadow — it is the
      // page's "see your price" call to action and reads like one. Locked stays
      // quiet: the contact form is the customer's current job, not this bar.
      background: detailsLocked ? "#F8FAFC" : accent,
      border: "1.5px solid ".concat(detailsLocked ? "#E2E8F0" : accent),
      borderRadius: 10,
      padding: "14px 18px",
      boxShadow: detailsLocked ? "none" : "0 4px 14px ".concat(accent, "50"),
      transition: "all 0.2s"
    } : {})
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: customerFacing ? 14.5 : 12,
      fontWeight: customerFacing ? 800 : 700,
      color: customerFacing && !detailsLocked ? textOnAccent(accent) : "#64748B",
      letterSpacing: 0.2
    }
  }, "Details"), detailsLocked ? /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: customerFacing ? 12.5 : 11.5,
      fontWeight: 600,
      color: customerFacing ? "#64748B" : "#94A3B8",
      textAlign: "right"
    }
  }, "\uD83D\uDD12 Enter all your contact information to see the quote details.") : customerFacing ? /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13,
      fontWeight: 800,
      color: textOnAccent(accent),
      textAlign: "right"
    }
  }, additionalOpen ? "Hide quote details ▾" : "See your quote details ▸") : /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      color: "#94A3B8"
    }
  }, additionalOpen ? "▾" : "▸")), additionalOpen && !detailsLocked && function () {
    // ── Invoice-style detail rows ─────────────────────────────────────────
    // Every row shares the same right-anchored grid: [qty 50px] [amount 85px]
    // [action 28px], gap 6 — so every amount lines up in one column. Rows with
    // no action get a 28px spacer; rows with no qty just omit that cell.
    var selRows = computeSelectionRows(sel, paintColors, C, items);
    var priceRows = C.showPricing ? computeLayoutPricingRows(items, sel, customOptions, C, paintColors).rows : [];
    var roList = items.filter(function (i) {
      return i.type === "roughOpening";
    });
    // Rough-opening rate: same per-style resolution as the estimate (layoutPricing,
    // byStyle override wins) — the old C.layoutPrices read was a stale key that
    // showed $0.00 while the estimate charged the real rate.
    var roRate = function () {
      var lp = C.layoutPricing && C.layoutPricing.roughOpening;
      if (!lp) return 0;
      var ov = lp.byStyle && sel.style ? lp.byStyle[sel.style] : null;
      return Number(ov && ov.rate != null ? ov.rate : lp.rate) || 0;
    }();
    var customTotal = customOptions.reduce(function (s, r) {
      if (!r || !r.name || !String(r.name).trim()) return s;
      var amt = Math.max(0, parseFloat(r.amount) || 0);
      var q = r.qty ? Math.abs(parseInt(r.qty, 10)) || 1 : 1; // abs: the edge bills |qty|
      return s + amt * q;
    }, 0);
    var discountTotal = (sel.discounts || []).reduce(function (s, r) {
      return s + Math.max(0, parseFloat(r && r.amount) || 0);
    }, 0);
    var deliveryAmt = parseFloat(sel.deliveryFee) || 0;
    var showDelivery = deliveryOpen || String(sel.deliveryFee || "") !== "";
    // Mirrors the estimate's pre-tax total: all line items + delivery − discounts.
    var subtotal = Math.max(0, selRows.reduce(function (s, r) {
      return s + (Number(r.total) || 0);
    }, 0) + priceRows.reduce(function (s, r) {
      return s + (Number(r.total) || 0);
    }, 0) + (C.showPricing ? roList.length * roRate : 0) + customTotal + deliveryAmt - discountTotal);
    var qtyCell = {
      width: 50,
      flex: "0 0 auto",
      textAlign: "center",
      fontSize: 12,
      color: "#64748B",
      border: "1px solid #E2E8F0",
      borderRadius: 6,
      padding: "6px 0",
      background: "#F8FAFC",
      boxSizing: "border-box"
    };
    var amtCell = {
      width: 85,
      flex: "0 0 auto",
      textAlign: "right",
      fontSize: 12,
      fontWeight: 600,
      color: "#334155",
      border: "1px solid #E2E8F0",
      borderRadius: 6,
      padding: "6px 8px",
      background: "#F8FAFC",
      boxSizing: "border-box"
    };
    var amtInputWrap = {
      display: "flex",
      alignItems: "center",
      border: "1px solid #CBD5E1",
      borderRadius: 6,
      padding: "0 6px",
      background: "#FFF",
      width: 85,
      flex: "0 0 auto",
      boxSizing: "border-box"
    };
    var actSpacer = {
      width: 28,
      flex: "0 0 auto"
    };
    var delBtn = {
      background: "#FEF2F2",
      color: "#DC2626",
      border: "1px solid #FECACA",
      borderRadius: 6,
      width: 28,
      height: 30,
      cursor: "pointer",
      fontSize: 14,
      fontWeight: 700,
      flexShrink: 0
    };
    var dashBtn = {
      background: "#F1F5F9",
      color: "#334155",
      border: "1px dashed #94A3B8",
      borderRadius: 6,
      padding: "6px 12px",
      fontSize: 12,
      fontWeight: 600,
      cursor: "pointer"
    };
    return /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 8
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        marginBottom: 4
      }
    }, selRows.map(function (r) {
      return /*#__PURE__*/React.createElement("div", {
        key: r.key,
        style: {
          display: "flex",
          gap: 6,
          alignItems: "center",
          marginBottom: 6
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          flex: 1,
          minWidth: 0
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: 12,
          fontWeight: 700,
          color: "#334155"
        }
      }, r.label), /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: 10.5,
          color: "#94A3B8",
          whiteSpace: "pre-line"
        }
      }, r.detail)), r.total != null && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
        style: amtCell
      }, fmtMoney2(r.total)), /*#__PURE__*/React.createElement("div", {
        style: actSpacer
      })));
    })), priceRows.length > 0 && /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 14
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: _objectSpread(_objectSpread({}, S.lbl), {}, {
        marginBottom: 8
      })
    }, "Options on your plan"), priceRows.map(function (r) {
      return /*#__PURE__*/React.createElement("div", {
        key: r.key,
        style: {
          display: "flex",
          gap: 6,
          alignItems: "center",
          marginBottom: 6
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          flex: 1,
          minWidth: 0
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: 12,
          fontWeight: 700,
          color: "#334155"
        }
      }, r.label), /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: 10.5,
          color: "#94A3B8"
        }
      }, r.unit)), /*#__PURE__*/React.createElement("div", {
        style: qtyCell
      }, Number.isInteger(r.qty) ? r.qty : Number(r.qty).toFixed(1)), /*#__PURE__*/React.createElement("div", {
        style: amtCell
      }, fmtMoney2(r.total)), !planLocked && /*#__PURE__*/React.createElement("button", {
        title: r.method === "each" ? "Remove one from the plan" : "Remove from the plan",
        onClick: function onClick() {
          // "each"-priced items step down one at a time (when several are
          // placed, the plan asks which one); everything else clears the line
          // and removes all of that type from the layout.
          var placed = items.filter(function (i) {
            return i.type === r.key;
          });
          if (r.method === "each" && placed.length > 1) {
            setPendingRemoval({
              type: r.key
            });
            setSelectedId(null);
            setActiveTool(null);
            setTimeout(function () {
              try {
                svgRef.current && svgRef.current.scrollIntoView({
                  behavior: "smooth",
                  block: "center"
                });
              } catch (_) {}
            }, 0);
          } else {
            // Cascade like delSel: removing a door also removes its snapped ramp.
            var removedIds = new Set(placed.map(function (i) {
              return i.id;
            }));
            setItems(function (p) {
              return p.filter(function (i) {
                return i.type !== r.key && !(i.type === "ramp" && removedIds.has(i.snapDoorId));
              });
            });
            setSelectedId(null);
          }
        },
        style: delBtn
      }, "\xD7"));
    })), roList.length > 0 && /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 14
      }
    }, roList.map(function (ro, idx) {
      var dim = roDimensions[ro.id] || "";
      var invalid = !dim.trim();
      return /*#__PURE__*/React.createElement("div", {
        key: ro.id,
        style: {
          display: "flex",
          gap: 6,
          alignItems: "center",
          marginBottom: 6
        }
      }, /*#__PURE__*/React.createElement("span", {
        style: {
          flex: "0 0 auto",
          fontSize: 12,
          fontWeight: 700,
          color: "#334155",
          minWidth: 60
        }
      }, "RO-", idx + 1), /*#__PURE__*/React.createElement("input", {
        type: "text",
        value: dim,
        placeholder: "Enter Rough Opening size: e.g. 3 x 6 or 29\u215E \xD7 34\xBD\"",
        readOnly: planLocked || undefined,
        onChange: function onChange(e) {
          if (planLocked) return;
          setRoDimensions(function (p) {
            return _objectSpread(_objectSpread({}, p), {}, _defineProperty({}, ro.id, e.target.value));
          });
        },
        style: {
          flex: 1,
          minWidth: 0,
          border: "1px solid ".concat(invalid ? "#DC2626" : "#CBD5E1"),
          borderRadius: 6,
          padding: "6px 8px",
          fontSize: 12,
          outline: "none",
          background: invalid ? "#FEF2F2" : "#FFF"
        }
      }), C.showPricing && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
        style: qtyCell
      }, "1"), /*#__PURE__*/React.createElement("div", {
        style: amtCell
      }, fmtMoney2(roRate))), !planLocked && /*#__PURE__*/React.createElement("button", {
        title: "Remove this rough opening from the plan",
        onClick: function onClick() {
          setItems(function (p) {
            return p.filter(function (i) {
              return i.id !== ro.id;
            });
          });
          setSelectedId(null);
        },
        style: delBtn
      }, "\xD7"));
    })), customOptions.length > 0 && /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 14
      }
    }, customOptions.map(function (row, idx) {
      var invalid = !row.name || !row.name.trim();
      return /*#__PURE__*/React.createElement("div", {
        key: idx,
        style: {
          display: "flex",
          gap: 6,
          alignItems: "center",
          marginBottom: 6
        }
      }, /*#__PURE__*/React.createElement("input", {
        type: "text",
        value: row.name,
        placeholder: "Item name (required)",
        onChange: function onChange(e) {
          return setCustomOptions(function (p) {
            return p.map(function (r, i) {
              return i === idx ? _objectSpread(_objectSpread({}, r), {}, {
                name: e.target.value
              }) : r;
            });
          });
        },
        style: {
          flex: 1,
          minWidth: 0,
          border: "1px solid ".concat(invalid ? "#DC2626" : "#CBD5E1"),
          borderRadius: 6,
          padding: "6px 8px",
          fontSize: 12,
          outline: "none",
          background: invalid ? "#FEF2F2" : "#FFF",
          wordBreak: "break-word"
        }
      }), /*#__PURE__*/React.createElement("input", {
        type: "number",
        min: "0",
        value: row.qty,
        placeholder: "Qty",
        onChange: function onChange(e) {
          var v = e.target.value.replace(/[^0-9]/g, "");
          setCustomOptions(function (p) {
            return p.map(function (r, i) {
              return i === idx ? _objectSpread(_objectSpread({}, r), {}, {
                qty: v
              }) : r;
            });
          });
        },
        style: {
          width: 50,
          flex: "0 0 auto",
          border: "1px solid #CBD5E1",
          borderRadius: 6,
          padding: "6px 4px",
          fontSize: 12,
          outline: "none",
          textAlign: "center",
          boxSizing: "border-box"
        }
      }), /*#__PURE__*/React.createElement("div", {
        style: amtInputWrap
      }, /*#__PURE__*/React.createElement("span", {
        style: {
          fontSize: 12,
          color: "#64748B",
          marginRight: 2,
          flexShrink: 0
        }
      }, "$"), /*#__PURE__*/React.createElement("input", {
        type: "number",
        min: "0",
        value: row.amount,
        placeholder: "0.00",
        onChange: function onChange(e) {
          return setCustomOptions(function (p) {
            return p.map(function (r, i) {
              return i === idx ? _objectSpread(_objectSpread({}, r), {}, {
                amount: e.target.value.replace(/[^0-9.]/g, "")
              }) : r;
            });
          });
        },
        style: {
          flex: 1,
          minWidth: 0,
          width: "100%",
          border: "none",
          padding: "6px 0",
          fontSize: 12,
          outline: "none"
        }
      })), /*#__PURE__*/React.createElement("button", {
        onClick: function onClick() {
          return setCustomOptions(function (p) {
            return p.filter(function (_, i) {
              return i !== idx;
            });
          });
        },
        style: delBtn
      }, "\xD7"));
    })), (sel.discounts || []).length > 0 && /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 14
      }
    }, (sel.discounts || []).map(function (row, idx) {
      return /*#__PURE__*/React.createElement("div", {
        key: idx,
        style: {
          display: "flex",
          gap: 6,
          alignItems: "center",
          marginBottom: 6
        }
      }, embedded ? /*#__PURE__*/React.createElement("input", {
        type: "text",
        value: row.description || "",
        placeholder: "Discount description",
        onChange: function onChange(e) {
          return setSel(function (p) {
            return _objectSpread(_objectSpread({}, p), {}, {
              discounts: (p.discounts || []).map(function (r, i) {
                return i === idx ? _objectSpread(_objectSpread({}, r), {}, {
                  description: e.target.value
                }) : r;
              })
            });
          });
        },
        style: {
          flex: 1,
          minWidth: 0,
          border: "1px solid #CBD5E1",
          borderRadius: 6,
          padding: "6px 8px",
          fontSize: 12,
          outline: "none",
          background: "#FFF",
          wordBreak: "break-word"
        }
      }) : /*#__PURE__*/React.createElement("div", {
        style: {
          flex: 1,
          minWidth: 0,
          fontSize: 12,
          fontWeight: 700,
          color: "#334155",
          padding: "6px 0",
          wordBreak: "break-word"
        }
      }, row.description || "Discount"), embedded ? /*#__PURE__*/React.createElement("div", {
        style: amtInputWrap
      }, /*#__PURE__*/React.createElement("span", {
        style: {
          fontSize: 12,
          color: "#64748B",
          marginRight: 2,
          flexShrink: 0,
          whiteSpace: "nowrap"
        }
      }, "\u2212$"), /*#__PURE__*/React.createElement("input", {
        type: "number",
        min: "0",
        value: row.amount || "",
        placeholder: "0.00",
        onChange: function onChange(e) {
          var v = e.target.value.replace(/[^0-9.]/g, "");
          setSel(function (p) {
            return _objectSpread(_objectSpread({}, p), {}, {
              discounts: (p.discounts || []).map(function (r, i) {
                return i === idx ? _objectSpread(_objectSpread({}, r), {}, {
                  amount: v
                }) : r;
              })
            });
          });
        },
        style: {
          flex: 1,
          minWidth: 0,
          width: "100%",
          border: "none",
          padding: "6px 0",
          fontSize: 12,
          outline: "none"
        }
      })) : /*#__PURE__*/React.createElement("div", {
        style: {
          width: 85,
          textAlign: "right",
          fontSize: 12,
          fontWeight: 700,
          color: "#059669",
          flexShrink: 0
        }
      }, "\u2212$", Number(row.amount || 0).toFixed(2)), embedded ? /*#__PURE__*/React.createElement("button", {
        onClick: function onClick() {
          return setSel(function (p) {
            return _objectSpread(_objectSpread({}, p), {}, {
              discounts: (p.discounts || []).filter(function (_, i) {
                return i !== idx;
              })
            });
          });
        },
        style: delBtn
      }, "\xD7") : /*#__PURE__*/React.createElement("span", {
        style: {
          width: 28,
          flexShrink: 0
        }
      }));
    })), showDelivery && /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 14,
        display: "flex",
        gap: 6,
        alignItems: "center",
        marginBottom: 6
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1,
        minWidth: 0
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 12,
        fontWeight: 700,
        color: "#334155"
      }
    }, "Delivery Fee"), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 10.5,
        color: "#94A3B8"
      }
    }, "Non-taxable line on the estimate")), embedded ? /*#__PURE__*/React.createElement("div", {
      style: amtInputWrap
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 12,
        color: "#64748B",
        marginRight: 2,
        flexShrink: 0
      }
    }, "$"), /*#__PURE__*/React.createElement("input", {
      type: "text",
      inputMode: "decimal",
      value: sel.deliveryFee || "",
      placeholder: "0.00",
      onChange: function onChange(e) {
        var v = e.target.value.replace(/[^0-9.]/g, "");
        setSel(function (p) {
          return _objectSpread(_objectSpread({}, p), {}, {
            deliveryFee: v
          });
        });
      },
      style: {
        flex: 1,
        minWidth: 0,
        width: "100%",
        border: "none",
        padding: "6px 0",
        fontSize: 12,
        outline: "none"
      }
    })) : /*#__PURE__*/React.createElement("div", {
      style: {
        width: 85,
        textAlign: "right",
        fontSize: 12,
        fontWeight: 700,
        color: "#334155",
        flexShrink: 0
      }
    }, "$", Number(sel.deliveryFee || 0).toFixed(2)), embedded ? /*#__PURE__*/React.createElement("button", {
      title: "Remove the delivery fee",
      onClick: function onClick() {
        setDeliveryOpen(false);
        setSel(function (p) {
          return _objectSpread(_objectSpread({}, p), {}, {
            deliveryFee: ""
          });
        });
      },
      style: delBtn
    }, "\xD7") : /*#__PURE__*/React.createElement("span", {
      style: {
        width: 28,
        flexShrink: 0
      }
    })), C.showPricing && /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: 6,
        alignItems: "center",
        borderTop: "2px solid #E2E8F0",
        marginTop: 12,
        paddingTop: 8
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1,
        minWidth: 0,
        fontSize: 12,
        fontWeight: 800,
        color: "#1E293B"
      }
    }, "Subtotal ", /*#__PURE__*/React.createElement("span", {
      style: {
        fontWeight: 600,
        color: "#94A3B8",
        fontSize: 10.5
      }
    }, "(before tax)")), /*#__PURE__*/React.createElement("div", {
      style: {
        width: 85,
        flex: "0 0 auto",
        textAlign: "right",
        fontSize: 13,
        fontWeight: 800,
        color: "#1E293B",
        padding: "6px 8px",
        boxSizing: "border-box"
      }
    }, fmtMoney2(subtotal)), /*#__PURE__*/React.createElement("div", {
      style: actSpacer
    })), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: 8,
        flexWrap: "wrap",
        marginTop: 12
      }
    }, /*#__PURE__*/React.createElement("button", {
      onClick: function onClick() {
        return setCustomOptions(function (p) {
          return [].concat(_toConsumableArray(p), [{
            name: "",
            qty: "",
            amount: ""
          }]);
        });
      },
      style: dashBtn
    }, "+ Add Custom Option"), embedded && /*#__PURE__*/React.createElement("button", {
      onClick: function onClick() {
        return setSel(function (p) {
          return _objectSpread(_objectSpread({}, p), {}, {
            discounts: [].concat(_toConsumableArray(p.discounts || []), [{
              description: "",
              amount: ""
            }])
          });
        });
      },
      style: dashBtn
    }, "+ Add Discount"), embedded && !showDelivery && /*#__PURE__*/React.createElement("button", {
      onClick: function onClick() {
        return setDeliveryOpen(true);
      },
      style: dashBtn
    }, "+ Add Delivery Fee")), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 10.5,
        color: "#94A3B8",
        marginTop: 6
      }
    }, "Custom options add charges \xB7 discounts reduce the estimate total \xB7 delivery is added as a non-taxable line."));
  }()), embedded && invDialog && /*#__PURE__*/React.createElement("div", {
    onClick: function onClick() {
      return setInvDialog(null);
    },
    style: {
      position: "fixed",
      inset: 0,
      background: "rgba(15,23,42,0.45)",
      zIndex: 9000,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: function onClick(e) {
      return e.stopPropagation();
    },
    style: {
      background: "#FFF",
      borderRadius: 14,
      width: "min(440px, 96vw)",
      padding: 20,
      boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
      fontFamily: "system-ui, -apple-system, sans-serif"
    }
  }, invDialog.done ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 17,
      fontWeight: 800,
      color: "#15803D",
      marginBottom: 6
    }
  }, invDialog.done.updated ? "Inventory building updated" : "Requested".concat(invDialog.done.serial != null ? " \u2014 Serial #".concat(invDialog.done.serial) : "")), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: "#475569",
      marginBottom: 16
    }
  }, invDialog.done.updated ? /*#__PURE__*/React.createElement(React.Fragment, null, "Find it on your portal's Inventory tab.") : /*#__PURE__*/React.createElement(React.Fragment, null, "Find it on your portal's Inventory tab, and put it on the ", /*#__PURE__*/React.createElement("strong", null, "Build Schedule"), " when you're ready to make it. You can quote it to a customer at any time \u2014 a building can be sold before it's built.")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "flex-end"
    }
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: function onClick() {
      return setInvDialog(null);
    },
    style: {
      background: "#1E293B",
      color: "#FFF",
      border: "none",
      borderRadius: 8,
      padding: "9px 18px",
      fontSize: 13,
      fontWeight: 700,
      cursor: "pointer"
    }
  }, "Done"))) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 17,
      fontWeight: 800,
      color: "#1E293B",
      marginBottom: 4
    }
  }, inventoryMaster && inventoryMaster.unitId ? "Update inventory building" : "Request this build"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12.5,
      color: "#64748B",
      marginBottom: 14,
      lineHeight: 1.5
    }
  }, inventoryMaster && inventoryMaster.unitId ? "Saves your design changes to this building. Its serial number and any estimates already sent are unaffected." : "No customer needed. This goes on your Inventory list as a REQUEST and takes the next serial number automatically — it isn't on the lot yet, and won't show as available to sell until it's built and brought to a location."), invDialog.err && /*#__PURE__*/React.createElement("div", {
    style: {
      background: "#FEF2F2",
      border: "1px solid #FECACA",
      borderRadius: 8,
      padding: "8px 12px",
      marginBottom: 12,
      color: "#DC2626",
      fontSize: 12.5,
      fontWeight: 600
    }
  }, invDialog.err), function () {
    var loc = invLocations.find(function (l) {
      return String(l.id) === String(invLocationId);
    });
    var name = loc ? loc.city && loc.city !== loc.name ? "".concat(loc.name, " \u2014 ").concat(loc.city) : loc.name : "none yet";
    return /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 12.5,
        color: "#475569",
        marginBottom: 12
      }
    }, "Location: ", /*#__PURE__*/React.createElement("b", null, name));
  }(), /*#__PURE__*/React.createElement("label", {
    style: {
      display: "block",
      fontSize: 10.5,
      fontWeight: 800,
      letterSpacing: 0.5,
      textTransform: "uppercase",
      color: "#94A3B8",
      marginBottom: 4
    }
  }, "Asking price"), /*#__PURE__*/React.createElement("input", {
    value: invDialog.price,
    inputMode: "decimal",
    placeholder: "0.00",
    onChange: function onChange(e) {
      return setInvDialog(function (d) {
        return d && _objectSpread(_objectSpread({}, d), {}, {
          price: e.target.value
        });
      });
    },
    disabled: invDialog.busy,
    style: {
      width: "100%",
      boxSizing: "border-box",
      border: "1px solid #E2E8F0",
      borderRadius: 8,
      padding: "9px 10px",
      fontSize: 13.5,
      background: "#FFF",
      color: "#1E293B"
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: "#94A3B8",
      margin: "5px 0 14px"
    }
  }, "Starts at this design's quoted price \u2014 a markdown here never changes your catalog."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "flex-end",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: function onClick() {
      return setInvDialog(null);
    },
    style: {
      background: "#F1F5F9",
      color: "#334155",
      border: "1px solid #E2E8F0",
      borderRadius: 8,
      padding: "9px 16px",
      fontSize: 13,
      fontWeight: 700,
      cursor: "pointer"
    }
  }, "Cancel"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: saveInventory,
    disabled: invDialog.busy,
    style: {
      background: invDialog.busy ? "#9CA3AF" : accent,
      color: "#FFF",
      border: "none",
      borderRadius: 8,
      padding: "9px 18px",
      fontSize: 13,
      fontWeight: 800,
      cursor: invDialog.busy ? "wait" : "pointer"
    }
  }, invDialog.busy ? "Saving…" : inventoryMaster && inventoryMaster.unitId ? "Save changes" : "Send request"))))), !submitted && /*#__PURE__*/React.createElement("div", {
    style: {
      background: "#FFF",
      borderTop: "2px solid #E2E8F0",
      padding: "16px 20px"
    }
  }, submitError && /*#__PURE__*/React.createElement("div", {
    style: {
      background: "#FEF2F2",
      border: "1px solid #FECACA",
      borderRadius: 8,
      padding: "10px 14px",
      marginBottom: 12,
      color: "#DC2626",
      fontSize: 13,
      fontWeight: 600
    }
  }, submitError), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 10,
      alignItems: "center",
      justifyContent: "space-between"
    }
  }, /*#__PURE__*/React.createElement("p", {
    style: {
      margin: 0,
      fontSize: 12,
      color: "#64748B",
      flex: 1
    }
  }, inventoryNew || inventoryMaster ? inventoryMaster && inventoryMaster.unitId ? /*#__PURE__*/React.createElement(React.Fragment, null, "Design the building and pick its location, then click ", /*#__PURE__*/React.createElement("strong", null, "Update Inventory Building"), ".") : /*#__PURE__*/React.createElement(React.Fragment, null, "Design the building and pick where it will sit, then click ", /*#__PURE__*/React.createElement("strong", null, "Request this build"), ". It lands on your Inventory list as a request \u2014 put it on the Build Schedule when you're ready to make it.") : hasExistingEstimate ? /*#__PURE__*/React.createElement(React.Fragment, null, "Update your selections, then click ", /*#__PURE__*/React.createElement("strong", null, "Resubmit for Updated Estimate"), " to refresh and re-send your quote.") : /*#__PURE__*/React.createElement(React.Fragment, null, "Place your options on the layout above, then click ", /*#__PURE__*/React.createElement("strong", null, "Get Quote"), " to receive a detailed estimate.")), embedded && (inventoryNew || inventoryMaster) && /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      whiteSpace: "nowrap"
    }
  }, /*#__PURE__*/React.createElement("select", {
    value: invLocationId,
    onChange: function onChange(e) {
      return setInvLocationId(e.target.value);
    },
    title: "Location \u2014 where this building sits on your lot",
    style: {
      border: "1.5px solid #CBD5E1",
      borderRadius: 10,
      padding: "12px 12px",
      fontSize: 14,
      fontWeight: 700,
      color: "#334155",
      background: "#FFF",
      cursor: "pointer",
      maxWidth: 210
    }
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, invLocations.length ? "No location yet" : "Loading locations…"), invLocations.map(function (l) {
    return /*#__PURE__*/React.createElement("option", {
      key: l.id,
      value: l.id
    }, l.name, l.city ? " \u2014 ".concat(l.city) : "");
  })), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: openInventoryDialog,
    disabled: submitting || Boolean(invDialog && invDialog.busy),
    style: {
      background: submitting || invDialog && invDialog.busy ? "#9CA3AF" : accent,
      color: "#FFF",
      border: "none",
      borderRadius: 10,
      padding: "12px 22px",
      fontSize: 14,
      fontWeight: 800,
      cursor: submitting || invDialog && invDialog.busy ? "wait" : "pointer",
      letterSpacing: "-0.01em",
      whiteSpace: "nowrap",
      boxShadow: submitting || invDialog && invDialog.busy ? "none" : "0 4px 14px ".concat(accent, "50")
    }
  }, inventoryMaster && inventoryMaster.unitId ? "Update Inventory Building" : "Request this build")), !(inventoryNew || inventoryMaster) && /*#__PURE__*/React.createElement("button", {
    onClick: submitQuote,
    disabled: submitting,
    style: {
      background: submitting ? "#9CA3AF" : accent,
      color: "#FFF",
      border: "none",
      borderRadius: 10,
      padding: "12px 32px",
      fontSize: 16,
      fontWeight: 800,
      cursor: submitting ? "wait" : "pointer",
      letterSpacing: "-0.01em",
      boxShadow: submitting ? "none" : "0 4px 14px ".concat(accent, "50"),
      transition: "all 0.2s",
      minWidth: 160
    }
  }, submitting ? "Submitting..." : hasExistingEstimate ? "Resubmit for Updated Estimate" : "Get Quote")), estimateVersions.length > 0 && function () {
    var cur = viewingVersion == null ? estimateVersions[0] : estimateVersions.find(function (v) {
      return v.version === viewingVersion;
    }) || estimateVersions[0];
    var others = estimateVersions.filter(function (v) {
      return v.version !== cur.version;
    });
    var csel = cur.selections || {};
    return /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 14,
        borderTop: "1px solid #F1F5F9",
        paddingTop: 12
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11,
        fontWeight: 700,
        color: "#64748B",
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        marginBottom: 4
      }
    }, "All designs on this estimate"), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        padding: "8px 0"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        minWidth: 0
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 13,
        fontWeight: 700,
        color: "#1E293B"
      }
    }, [capWords(csel.style), csel.size].filter(Boolean).join(" ") || "Design"), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 12,
        color: "#94A3B8",
        fontWeight: 600
      }
    }, " \xB7 v", cur.version, " (viewing)"), others.length > 0 && /*#__PURE__*/React.createElement("button", {
      onClick: function onClick() {
        return setVersionsOpen(function (o) {
          return !o;
        });
      },
      style: {
        marginLeft: 8,
        background: "transparent",
        border: "none",
        padding: 0,
        cursor: "pointer",
        color: accent,
        fontSize: 12,
        fontWeight: 700
      }
    }, versionsOpen ? "▴ hide" : "\u25BE ".concat(estimateVersions.length, " versions"))), /*#__PURE__*/React.createElement("div", {
      style: {
        whiteSpace: "nowrap",
        flexShrink: 0
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        color: "#94A3B8",
        fontWeight: 700,
        marginRight: 12,
        fontSize: 13
      }
    }, "Viewing"), ssSafeUrl(cur.image_url) && /*#__PURE__*/React.createElement("a", {
      href: ssSafeUrl(cur.image_url),
      target: "_blank",
      rel: "noopener",
      style: {
        color: "#334155",
        fontWeight: 700,
        textDecoration: "none",
        fontSize: 13
      }
    }, "PDF"))), versionsOpen && others.map(function (v) {
      var vsel = v.selections || {};
      var dstr = "";
      try {
        dstr = new Date(v.created_at).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric"
        });
      } catch (_unused3) {/* ignore */}
      return /*#__PURE__*/React.createElement("div", {
        key: v.version,
        style: {
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          padding: "7px 0 7px 12px",
          borderTop: "1px solid #F1F5F9",
          background: "#F8FAFC"
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          minWidth: 0,
          fontSize: 13,
          color: "#64748B"
        }
      }, "\u21B3 v", v.version, " \xB7 ", [capWords(vsel.style), vsel.size].filter(Boolean).join(" ") || "Design", dstr ? " \xB7 ".concat(dstr) : ""), /*#__PURE__*/React.createElement("div", {
        style: {
          whiteSpace: "nowrap",
          flexShrink: 0
        }
      }, /*#__PURE__*/React.createElement("button", {
        onClick: function onClick() {
          return openVersion(v.version);
        },
        style: {
          background: "transparent",
          border: "none",
          padding: 0,
          cursor: "pointer",
          color: accent,
          fontWeight: 700,
          marginRight: 12,
          fontSize: 13
        }
      }, "Open"), ssSafeUrl(v.image_url) && /*#__PURE__*/React.createElement("a", {
        href: ssSafeUrl(v.image_url),
        target: "_blank",
        rel: "noopener",
        style: {
          color: "#334155",
          fontWeight: 700,
          textDecoration: "none",
          fontSize: 13
        }
      }, "PDF")));
    }));
  }()), submitted && /*#__PURE__*/React.createElement("div", {
    style: {
      background: "#F0FDF4",
      borderTop: "2px solid #BBF7D0",
      padding: "32px 20px",
      textAlign: "center"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 48,
      marginBottom: 12
    }
  }, "\u2705"), /*#__PURE__*/React.createElement("h3", {
    style: {
      margin: "0 0 8px",
      fontSize: 20,
      fontWeight: 700,
      color: "#166534"
    }
  }, savedDesign && savedDesign.updated ? "Estimate Updated!" : "Quote Request Submitted!"), /*#__PURE__*/React.createElement("p", {
    style: {
      margin: 0,
      fontSize: 14,
      color: "#15803D",
      maxWidth: 460,
      marginLeft: "auto",
      marginRight: "auto"
    }
  }, savedDesign && savedDesign.updated ? "Thank you, ".concat(contact.name || "", "! Your existing estimate has been updated and re-sent by email.") : "Thank you, ".concat(contact.name || "", "! We've received your building configuration and layout. A team member will prepare your detailed estimate and reach out shortly.")), savedDesign && /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 520,
      margin: "20px auto 0",
      background: "#FFF",
      border: "1px solid #BBF7D0",
      borderRadius: 10,
      padding: 14,
      textAlign: "left"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: 10
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      fontWeight: 700,
      color: "#64748B",
      textTransform: "uppercase",
      letterSpacing: "0.06em"
    }
  }, "Design ID"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 16,
      fontWeight: 800,
      color: "#1E293B",
      letterSpacing: "0.05em",
      fontFamily: "monospace"
    }
  }, savedDesign.code)), savedDesign.estimateNumber && /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: 10
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      fontWeight: 700,
      color: "#64748B",
      textTransform: "uppercase",
      letterSpacing: "0.06em"
    }
  }, "Estimate #"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 14,
      fontWeight: 700,
      color: "#1E293B",
      fontFamily: "monospace"
    }
  }, "EST-", savedDesign.estimateNumber))), estimateVersions.length > 0 && function () {
    var cur = estimateVersions[0];
    var others = estimateVersions.slice(1);
    var csel = cur.selections || {};
    return /*#__PURE__*/React.createElement("div", {
      style: {
        maxWidth: 520,
        margin: "16px auto 0",
        background: "#FFF",
        border: "1px solid #BBF7D0",
        borderRadius: 10,
        padding: 14,
        textAlign: "left"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11,
        fontWeight: 700,
        color: "#64748B",
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        marginBottom: 4
      }
    }, "All designs on this estimate"), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        padding: "8px 0"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        minWidth: 0
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 13,
        fontWeight: 700,
        color: "#1E293B"
      }
    }, [capWords(csel.style), csel.size].filter(Boolean).join(" ") || "Design"), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 12,
        color: "#94A3B8",
        fontWeight: 600
      }
    }, " \xB7 v", cur.version, " (current)"), others.length > 0 && /*#__PURE__*/React.createElement("button", {
      onClick: function onClick() {
        return setVersionsOpen(function (o) {
          return !o;
        });
      },
      style: {
        marginLeft: 8,
        background: "transparent",
        border: "none",
        padding: 0,
        cursor: "pointer",
        color: accent,
        fontSize: 12,
        fontWeight: 700
      }
    }, versionsOpen ? "▴ hide" : "\u25BE ".concat(estimateVersions.length, " versions"))), ssSafeUrl(cur.image_url) && /*#__PURE__*/React.createElement("a", {
      href: ssSafeUrl(cur.image_url),
      target: "_blank",
      rel: "noopener",
      style: {
        color: "#334155",
        fontWeight: 700,
        textDecoration: "none",
        fontSize: 13,
        whiteSpace: "nowrap",
        flexShrink: 0
      }
    }, "PDF")), versionsOpen && others.map(function (v) {
      var vsel = v.selections || {};
      var dstr = "";
      try {
        dstr = new Date(v.created_at).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric"
        });
      } catch (_unused4) {/* ignore */}
      return /*#__PURE__*/React.createElement("div", {
        key: v.version,
        style: {
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          padding: "7px 0 7px 12px",
          borderTop: "1px solid #F1F5F9",
          background: "#F8FAFC"
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          minWidth: 0,
          fontSize: 13,
          color: "#64748B"
        }
      }, "\u21B3 v", v.version, " \xB7 ", [capWords(vsel.style), vsel.size].filter(Boolean).join(" ") || "Design", dstr ? " \xB7 ".concat(dstr) : ""), /*#__PURE__*/React.createElement("div", {
        style: {
          whiteSpace: "nowrap",
          flexShrink: 0
        }
      }, /*#__PURE__*/React.createElement("button", {
        onClick: function onClick() {
          setSubmitted(false);
          openVersion(v.version);
        },
        style: {
          background: "transparent",
          border: "none",
          padding: 0,
          cursor: "pointer",
          color: accent,
          fontWeight: 700,
          marginRight: 12,
          fontSize: 13
        }
      }, "Open"), ssSafeUrl(v.image_url) && /*#__PURE__*/React.createElement("a", {
        href: ssSafeUrl(v.image_url),
        target: "_blank",
        rel: "noopener",
        style: {
          color: "#334155",
          fontWeight: 700,
          textDecoration: "none",
          fontSize: 13
        }
      }, "PDF")));
    }));
  }(), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 10,
      justifyContent: "center",
      flexWrap: "wrap",
      marginTop: 20
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: function onClick() {
      setSubmitted(false);
    },
    style: _objectSpread(_objectSpread({}, S.btn("#FFF", accent)), {}, {
      border: "2px solid ".concat(accent),
      padding: "10px 24px",
      fontSize: 14
    })
  }, "Review to make additional changes"), /*#__PURE__*/React.createElement("button", {
    onClick: function onClick() {
      setSubmitted(false);
      setSavedDesign(null);
      setItems([]);
      setSel(function (p) {
        var n = _objectSpread({}, p);
        Object.keys(n).forEach(function (k) {
          return n[k] = "";
        });
        return n;
      });
      setContact({
        name: "",
        phone: "",
        email: "",
        street: "",
        city: "",
        state: "",
        zip: ""
      });
      setPaintColors({
        body: "",
        trim: ""
      });
      setCustomOptions([]);
      setRoDimensions({});
      currentDesignIdRef.current = null;
      isDraftRef.current = false;
      draftStateRef.current = null;
      ghlContactIdRef.current = null;
      ghlEstimateIdRef.current = null;
      ghlEstimateNumberRef.current = null;
      // Inventory state MUST reset with everything else: a stale inventoryUnitRef
      // would silently link the NEXT, unrelated customer's estimate to the last
      // unit quoted — and that estimate going accepted would then flip a building
      // that never sold to Sold, false-warning every real prospect on it.
      inventoryUnitRef.current = null;
      setInventoryMaster(null);
      setDesignUnit(null);
      setNewBuildMode(false);
      setHasExistingEstimate(false);
      setDesignCode(null);
      setEstimateVersions([]);
      setViewingVersion(null);
      if (!embedded) window.history.replaceState({}, "", window.location.pathname);
    },
    style: _objectSpread(_objectSpread({}, S.btn(accent, "#FFF")), {}, {
      padding: "10px 24px",
      fontSize: 14
    })
  }, "Start New Quote"))), toast && /*#__PURE__*/React.createElement("div", {
    style: {
      position: "fixed",
      top: 20,
      left: "50%",
      transform: "translateX(-50%)",
      zIndex: 1100,
      maxWidth: 460,
      width: "90%"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      background: "#FFFBEB",
      border: "2px solid #F59E0B",
      borderRadius: 12,
      padding: "14px 20px",
      boxShadow: "0 8px 30px rgba(0,0,0,0.15)",
      display: "flex",
      gap: 12,
      alignItems: "flex-start"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 24,
      lineHeight: 1,
      flexShrink: 0
    }
  }, "\u26A0\uFE0F"), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 700,
      fontSize: 14,
      color: "#92400E",
      marginBottom: 4
    }
  }, "Can't place here"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: "#A16207",
      lineHeight: 1.4
    }
  }, toast)), /*#__PURE__*/React.createElement("button", {
    onClick: function onClick() {
      return setToast(null);
    },
    style: {
      background: "none",
      border: "none",
      fontSize: 18,
      cursor: "pointer",
      color: "#92400E",
      flexShrink: 0,
      padding: 0
    }
  }, "\u2715"))), showExport && /*#__PURE__*/React.createElement("div", {
    style: {
      position: "fixed",
      inset: 0,
      background: "rgba(0,0,0,0.6)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      zIndex: 1000,
      padding: 20
    },
    onClick: function onClick() {
      setShowExport(false);
      setExportUrl(null);
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      background: "#FFF",
      borderRadius: 16,
      padding: 24,
      maxWidth: 580,
      width: "100%",
      boxShadow: "0 20px 60px rgba(0,0,0,0.2)"
    },
    onClick: function onClick(e) {
      return e.stopPropagation();
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement("h3", {
    style: {
      margin: 0,
      fontSize: 18,
      fontWeight: 700,
      color: "#1E293B"
    }
  }, C.branding.companyName || "Design Studio", " Export"), /*#__PURE__*/React.createElement("button", {
    onClick: function onClick() {
      setShowExport(false);
      setExportUrl(null);
    },
    style: {
      background: "none",
      border: "none",
      fontSize: 20,
      cursor: "pointer",
      color: "#94A3B8"
    }
  }, "\u2715")), exportUrl && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("img", {
    src: exportUrl,
    alt: "Floor Plan",
    style: {
      width: "100%",
      borderRadius: 8,
      border: "1px solid #E2E8F0"
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      marginTop: 16
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: downloadPDF,
    style: _objectSpread(_objectSpread({
      flex: 1
    }, S.btn("#B91C1C", "#FFF")), {}, {
      padding: 10,
      fontSize: 14
    })
  }, "\u2B07 Download PDF"), /*#__PURE__*/React.createElement("button", {
    onClick: downloadPNG,
    style: _objectSpread(_objectSpread({
      flex: 1
    }, S.btn("#1E293B", "#FFF")), {}, {
      padding: 10,
      fontSize: 14
    })
  }, "\u2B07 Download PNG"), /*#__PURE__*/React.createElement("button", {
    onClick: function onClick() {
      fetch(exportUrl).then(function (r) {
        return r.blob();
      }).then(function (b) {
        navigator.clipboard.write([new ClipboardItem({
          "image/png": b
        })])["catch"](function () {});
      });
    },
    style: _objectSpread(_objectSpread({
      flex: 1
    }, S.btn("#F1F5F9", "#334155")), {}, {
      border: "1px solid #E2E8F0",
      padding: 10,
      fontSize: 14
    })
  }, "\uD83D\uDCCB Copy")), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 11,
      color: "#94A3B8",
      marginTop: 12,
      textAlign: "center"
    }
  }, "8.5\"\xD711\" letter \u2014 attach to your GHL estimate or invoice")))));
}

// ─── FeedbackWidget: REMOVED from the designer (2026-07-26) ───
// The bug/feature widget now lives in portal.html only. A submission has to be
// attributable to a signed-in portal user and their tenant (portal-feedback resolves
// both server-side from the JWT), and the public designer's visitors are anonymous
// shed-shoppers who should never have seen a "Report a bug" button on a tenant's
// customer-facing page. Mirror note: StructureStudio.jsx dropped its
// `import FeedbackWidget from "./FeedbackWidget.jsx"` in the same change.

// ─── Client-config loader (default export) ───
// Every page load fetches the tenant's config from public.client_configs — there
// is no in-source copy of any client. Resolution order:
//   1. `config` prop (e.g. supplied by index.html's postMessage re-render handler)
//      wins and is used as-is, no fetch.
//   2. `?client=<id>` URL param — explicit override, wins over hostname.
//   3. Subdomain — `juniorbarns.structurestudio.app` → "juniorbarns", on either
//      apex we serve (structurestudio.app and structurestudiosuite.com — both live
//      during the migration). Skipped for the apexes themselves, IPs, localhost,
//      *.pages.dev / *.netlify.app / *.workers.dev deploy hosts, and the reserved
//      env labels (www/beta/dev/staging/app).
//   4. `?id=<short_code>` share-link — the design row records its owning tenant;
//      resolved via the load_design RPC (NOT a direct table read — that dies at
//      cutover) so a rep clicking someone else's link gets that tenant's branding.
//   5. Fallback: DEFAULT_CLIENT_ID.
// On fetch failure (network error or unknown client_id) we render an error screen
// with a retry button rather than silently falling back to a wrong-tenant config.
// The fetched config's clientId is always forced to the row key so a config blob
// can never point a tenant's designs at another tenant.

// A partial config row (e.g. branding-only) would crash the designer mid-render,
// so fail loud on the error screen instead. Every row must be authored complete —
// see the onboarding runbook in CLAUDE.md.
var REQUIRED_CONFIG_KEYS = ["branding", "contactFields", "buildingStyles", "defaultSizes", "options", "layoutItems"];

// Catches render-time throws inside the designer (e.g. a malformed-but-complete
// config row that passes REQUIRED_CONFIG_KEYS but has a bad nested shape) so the
// user gets a recoverable message instead of a blank white screen.
var DesignerErrorBoundary = /*#__PURE__*/function (_Component) {
  _inherits(DesignerErrorBoundary, _Component);
  function DesignerErrorBoundary(props) {
    var _this;
    _classCallCheck(this, DesignerErrorBoundary);
    _this = _callSuper(this, DesignerErrorBoundary, [props]);
    _this.state = {
      err: null
    };
    return _this;
  }
  _createClass(DesignerErrorBoundary, [{
    key: "componentDidCatch",
    value: function componentDidCatch(err) {
      console.error("[StructureStudio] designer render error:", err);
      if (window.ssLogError) window.ssLogError("designer", err && err.message || "render error", err && err.name, {
        phase: "render",
        stack: err && err.stack ? String(err.stack).slice(0, 2000) : null
      });
    }
  }, {
    key: "render",
    value: function render() {
      if (this.state.err) {
        return /*#__PURE__*/React.createElement("div", {
          style: {
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            minHeight: this.props.embedded ? "40vh" : "100vh",
            padding: "0 24px",
            fontFamily: "system-ui, -apple-system, sans-serif",
            color: "#1E293B",
            textAlign: "center"
          }
        }, /*#__PURE__*/React.createElement("div", {
          style: {
            fontSize: 18,
            fontWeight: 700,
            marginBottom: 8
          }
        }, "This designer couldn't be displayed"), /*#__PURE__*/React.createElement("div", {
          style: {
            fontSize: 13,
            color: "#64748B",
            maxWidth: 480,
            marginBottom: 4
          }
        }, "There's a problem with this builder's configuration. Please contact support."), /*#__PURE__*/React.createElement("button", {
          onClick: function onClick() {
            return window.location.reload();
          },
          style: {
            marginTop: 20,
            padding: "8px 16px",
            background: "#1E293B",
            color: "#FFF",
            border: "none",
            borderRadius: 6,
            fontSize: 13,
            cursor: "pointer"
          }
        }, "Reload"));
      }
      return this.props.children;
    }
  }], [{
    key: "getDerivedStateFromError",
    value: function getDerivedStateFromError(err) {
      return {
        err: err
      };
    }
  }]);
  return DesignerErrorBoundary;
}(Component); // Cutover marker: lets us verify from the deployed site which data path this
// bundle uses (multi-tenant RPC vs. legacy direct table access).
console.log("[StructureStudio] multi-tenant build: config-loader + RPC data path");
function StructureStudio(_ref33) {
  var _ref33$config = _ref33.config,
    configProp = _ref33$config === void 0 ? null : _ref33$config,
    _ref33$clientId = _ref33.clientId,
    clientIdProp = _ref33$clientId === void 0 ? null : _ref33$clientId,
    _ref33$embedded = _ref33.embedded,
    embedded = _ref33$embedded === void 0 ? false : _ref33$embedded,
    _ref33$onSaved = _ref33.onSaved,
    onSaved = _ref33$onSaved === void 0 ? null : _ref33$onSaved,
    _ref33$openDesign = _ref33.openDesign,
    openDesign = _ref33$openDesign === void 0 ? null : _ref33$openDesign;
  // state shape: { status: "ready", config } | { status: "loading" } | { status: "error", clientId, message }
  var _useState129 = useState(function () {
      return configProp ? {
        status: "ready",
        config: configProp
      } : {
        status: "loading"
      };
    }),
    _useState130 = _slicedToArray(_useState129, 2),
    state = _useState130[0],
    setState = _useState130[1];

  // White-label the browser tab: show the tenant's business name once config loads.
  // Skipped when embedded — the host page (the portal) owns its own tab title.
  useEffect(function () {
    if (embedded) return;
    if (state.status === "ready" && typeof document !== "undefined") {
      document.title = state.config.branding && state.config.branding.companyName || "Design Studio";
    }
  }, [state]);
  useEffect(function () {
    if (state.status !== "loading") return;
    if (typeof window === "undefined") return;
    var params = new URLSearchParams(window.location.search);
    // Embedded hosts (the owner portal) pass the tenant directly; the URL never
    // decides the tenant for an embedded mount.
    var clientId = clientIdProp || params.get("client");
    var designShortCode = params.get("id");
    // Tenant subdomains: derive a client_id from <sub>.<apex> on EITHER apex we serve.
    // Both are live during the Netlify → Cloudflare migration (structurestudio.app is
    // production today; structurestudiosuite.com is where we are moving, beta already
    // on it), so a branded link must resolve identically on both — supporting only the
    // old apex breaks every tenant's subdomain the day production cuts over, and only
    // the new one breaks them all today. Retire an entry here when its apex is retired.
    // Anything else (either apex itself, *.pages.dev / *.netlify.app / *.workers.dev
    // deploy hosts, localhost, IPs, env labels) falls through — a deploy hostname is
    // never a tenant.
    if (!clientId) {
      var host = window.location.hostname.toLowerCase();
      var TENANT_APEXES = ["structurestudio.app", "structurestudiosuite.com"];
      var RESERVED_SUBDOMAINS = ["www", "beta", "dev", "staging", "app"];
      for (var _i6 = 0, _TENANT_APEXES = TENANT_APEXES; _i6 < _TENANT_APEXES.length; _i6++) {
        var base = _TENANT_APEXES[_i6];
        if (!host.endsWith("." + base)) continue;
        var sub = host.slice(0, host.length - base.length - 1);
        if (sub && !sub.includes(".") && !RESERVED_SUBDOMAINS.includes(sub)) clientId = sub;
        break;
      }
    }
    // Bare product root: no tenant link (?client= / subdomain) and no design code.
    // This isn't any tenant's page — it's where business owners land, so send
    // them to the portal; they copy their customer design link from the dashboard.
    if (!clientId && !designShortCode) {
      if (embedded) {
        // An embedded mount must never navigate the host page — redirecting to
        // /portal.html from inside the portal would loop. Show the error screen.
        setState({
          status: "error",
          clientId: "",
          message: "No client id was supplied to the embedded designer."
        });
        return;
      }
      // Carry the query AND hash across. Supabase delivers auth-email outcomes in the
      // URL — `#access_token=…&type=invite|recovery` (implicit), `?code=…` (PKCE), or
      // `#error=…&error_code=otp_expired` — and a bare replace("/portal") DESTROYS them,
      // so the portal booted with a clean URL, found no session, and showed a login form
      // instead of the set-password screen. That is the "invite/reset link just takes me
      // to login" bug (Carolyn, 2026-07-28). It reaches this page at all whenever the
      // link's redirect_to is not in Supabase's allow-list, because Supabase then falls
      // back to Site URL (the apex root). portal.html already handles all three shapes.
      window.location.replace("/portal" + window.location.search + window.location.hash);
      return;
    }
    var cancelled = false;
    _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee14() {
      var sb, _yield$sb$rpc, rows, dErr, design, _yield$sb$rpc2, cfg, error, missing, fixtures, rampSettings, fxRes, fx;
      return _regeneratorRuntime().wrap(function _callee14$(_context14) {
        while (1) switch (_context14.prev = _context14.next) {
          case 0:
            _context14.prev = 0;
            sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY); // Share-link path: ?id=<short_code> without ?client= or a tenant subdomain
            // means someone opened a saved design's bare link. The design row records
            // which tenant owns it; look that up so the right config wraps the load.
            if (!(!clientId && designShortCode)) {
              _context14.next = 12;
              break;
            }
            _context14.next = 5;
            return sb.rpc("load_design", {
              p_code: designShortCode
            });
          case 5:
            _yield$sb$rpc = _context14.sent;
            rows = _yield$sb$rpc.data;
            dErr = _yield$sb$rpc.error;
            design = Array.isArray(rows) ? rows[0] : rows;
            if (!cancelled) {
              _context14.next = 11;
              break;
            }
            return _context14.abrupt("return");
          case 11:
            if (dErr || !design || !design.client_id) {
              console.warn("Design \"".concat(designShortCode, "\" not found while resolving client; using default."), dErr);
              clientId = DEFAULT_CLIENT_ID;
            } else {
              clientId = design.client_id;
            }
          case 12:
            if (!clientId) clientId = DEFAULT_CLIENT_ID;
            // Fetch this tenant's config via the get_config RPC (capability read),
            // not a direct client_configs table query: anon can no longer bulk-read
            // every tenant's config — only the one client_id it asks for. The RPC is
            // SECURITY DEFINER, so it keeps working after the table's anon SELECT is
            // revoked at cutover. Returns the config jsonb, or null for an unknown
            // client (→ the error screen, same as a missing row used to do).
            _context14.next = 15;
            return sb.rpc("get_config", {
              p_client_id: clientId
            });
          case 15:
            _yield$sb$rpc2 = _context14.sent;
            cfg = _yield$sb$rpc2.data;
            error = _yield$sb$rpc2.error;
            if (!cancelled) {
              _context14.next = 20;
              break;
            }
            return _context14.abrupt("return");
          case 20:
            if (!(error || !cfg)) {
              _context14.next = 24;
              break;
            }
            console.warn("Could not load config for client \"".concat(clientId, "\":"), error);
            setState({
              status: "error",
              clientId: clientId,
              message: error && error.message || "Configuration not found."
            });
            return _context14.abrupt("return");
          case 24:
            missing = REQUIRED_CONFIG_KEYS.filter(function (k) {
              return !cfg[k];
            });
            if (!(missing.length > 0)) {
              _context14.next = 28;
              break;
            }
            setState({
              status: "error",
              clientId: clientId,
              message: "Configuration row is incomplete (missing: ".concat(missing.join(", "), ").")
            });
            return _context14.abrupt("return");
          case 28:
            // Fixtures catalog (Options → Doors; windows/ramps later) — best-effort: a failure
            // just means no catalog doors in the palette, it never blocks the designer.
            fixtures = [], rampSettings = null;
            _context14.prev = 29;
            _context14.next = 32;
            return sb.rpc("get_fixtures", {
              p_client_id: clientId
            });
          case 32:
            fxRes = _context14.sent;
            fx = fxRes && fxRes.data;
            if (!cancelled && fx) {
              // get_fixtures returns either the legacy array or { items, ramp }.
              if (Array.isArray(fx)) fixtures = fx;else {
                if (Array.isArray(fx.items)) fixtures = fx.items;
                if (fx.ramp) rampSettings = fx.ramp;
              }
            }
            _context14.next = 39;
            break;
          case 37:
            _context14.prev = 37;
            _context14.t0 = _context14["catch"](29);
          case 39:
            if (!cancelled) {
              _context14.next = 41;
              break;
            }
            return _context14.abrupt("return");
          case 41:
            setState({
              status: "ready",
              config: _objectSpread(_objectSpread({}, cfg), {}, {
                clientId: clientId,
                fixtures: fixtures,
                rampSettings: rampSettings
              })
            });
            _context14.next = 50;
            break;
          case 44:
            _context14.prev = 44;
            _context14.t1 = _context14["catch"](0);
            if (!cancelled) {
              _context14.next = 48;
              break;
            }
            return _context14.abrupt("return");
          case 48:
            console.warn("Client config fetch error:", _context14.t1);
            setState({
              status: "error",
              clientId: clientId || DEFAULT_CLIENT_ID,
              message: _context14.t1 && _context14.t1.message || "Network error."
            });
          case 50:
          case "end":
            return _context14.stop();
        }
      }, _callee14, null, [[0, 44], [29, 37]]);
    }))();
    return function () {
      cancelled = true;
    };
  }, [state.status]);
  if (state.status === "loading") {
    return /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: embedded ? "40vh" : "100vh",
        fontFamily: "system-ui, -apple-system, sans-serif",
        color: "#64748B",
        fontSize: 14
      }
    }, "Loading\u2026");
  }
  if (state.status === "error") {
    return /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: embedded ? "40vh" : "100vh",
        padding: "0 24px",
        fontFamily: "system-ui, -apple-system, sans-serif",
        color: "#1E293B",
        textAlign: "center"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 18,
        fontWeight: 700,
        marginBottom: 8
      }
    }, "Could not load configuration"), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 13,
        color: "#64748B",
        marginBottom: 4
      }
    }, "Client: ", /*#__PURE__*/React.createElement("code", null, state.clientId)), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 13,
        color: "#64748B",
        maxWidth: 480
      }
    }, state.message), /*#__PURE__*/React.createElement("button", {
      onClick: function onClick() {
        return setState({
          status: "loading"
        });
      },
      style: {
        marginTop: 20,
        padding: "8px 16px",
        background: "#1E293B",
        color: "#FFF",
        border: "none",
        borderRadius: 6,
        fontSize: 13,
        cursor: "pointer"
      }
    }, "Retry"));
  }
  return /*#__PURE__*/React.createElement(DesignerErrorBoundary, {
    embedded: embedded
  }, /*#__PURE__*/React.createElement(StructureStudioInner, {
    config: state.config,
    embedded: embedded,
    onSaved: onSaved,
    openDesign: openDesign
  }));
}

// Publish for the host pages' thin mount blocks (cross-block const sharing does not
// exist under Babel-standalone; JSX also needs a capitalized in-scope identifier).
window.StructureStudio = StructureStudio;
window.ssAllowedOrigin = ssAllowedOrigin;
}).call(window);
