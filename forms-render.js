/* StructureStudio website lead forms — THE renderer (migration 325, Carolyn 2026-10-22).
 *
 * ONE FILE DRAWS EVERY FORM: the public page (form.html, and through it every builder's website
 * embed) and the portal's designer canvas and Preview (Settings → Customer Hub → Forms) all call
 * SSForm.build here, so the designer can never show a builder something their website does not.
 *
 * Plain ES5, no dependencies, no build step (the portal loads it on demand; form.html with a tag).
 * Every piece of text goes in through textContent or an attribute — never innerHTML — so nothing a
 * builder or a visitor typed can become markup. Colours are #hex only (the server's cleaner
 * guarantees it), so the generated CSS cannot be broken out of either.
 *
 *   SSForm.build(def, opts) -> HTMLElement
 *     def   the cleaned definition (supabase/functions/_shared/leadForms.ts is the source of truth)
 *     opts  { consentSentence, catalog: {styles, sizes}, designer: bool, selectedId,
 *             onSubmit(answers, meta) -> Promise<{ok, errors?, afterSubmit?, error?}>,
 *             onStart(), privacyUrl, termsUrl }
 *   SSForm.FONTS  the font stacks, mirrored from leadForms.ts FONTS
 */
(function () {
  "use strict";
  var FONTS = {
    system: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
    inter: "Inter,-apple-system,'Segoe UI',Roboto,Arial,sans-serif",
    georgia: "Georgia,'Times New Roman',serif",
    verdana: "Verdana,Geneva,sans-serif",
    trebuchet: "'Trebuchet MS',Helvetica,sans-serif",
    mono: "ui-monospace,Menlo,Consolas,monospace"
  };
  var HEX = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;
  function hex(v, d) { return typeof v === "string" && HEX.test(v) ? v : d; }
  function n(v, lo, hi, d) { v = Number(v); return isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d; }
  var seq = 0;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null && text !== "") e.textContent = text;
    return e;
  }

  function css(def, scope) {
    var st = def.style || {};
    var c = st.colors || {};
    var b = st.button || {};
    var S = "." + scope;
    var radius = n(st.radius, 0, 30, 6);
    var inputRadius = st.inputStyle === "rounded" ? Math.max(radius, 18) : st.inputStyle === "underline" ? 0 : radius;
    var border = hex(c.border, "#D1D5DB");
    var accent = hex(c.accent, "#2563EB");
    var font = FONTS[st.font] || FONTS.system;
    var fs = n(st.fontSize, 12, 22, 15);
    var gap = n(st.fieldSpacing, 0, 48, 16);
    var pad = n(st.padding, 0, 64, 24);
    var lw = n(st.labelWidth, 80, 400, 200);
    var bsize = b.size === "sm" ? "8px 16px" : b.size === "lg" ? "16px 28px" : "12px 22px";
    var rules = [
      S + "{box-sizing:border-box;width:100%;max-width:" + n(st.width, 280, 1200, 640) + "px;margin:0 auto;background:" + hex(c.formBg, "#FFF") + ";color:" + hex(c.text, "#111827") + ";font-family:" + font + ";font-size:" + fs + "px;line-height:1.45;padding:" + pad + "px;border-radius:" + Math.min(radius, 16) + "px;" + (st.shadow ? "box-shadow:0 1px 3px rgba(0,0,0,.08),0 8px 24px rgba(0,0,0,.06);" : "") + "}",
      S + " *{box-sizing:border-box}",
      S + " .ssf-head{margin-bottom:" + gap + "px}",
      S + " .ssf-head img{display:block;max-width:100%;max-height:160px;margin:0 auto 12px;border-radius:6px}",
      S + " .ssf-title{font-size:" + (fs + 9) + "px;font-weight:700;margin:0 0 4px}",
      S + " .ssf-sub{margin:0;opacity:.8}",
      S + " .ssf-grid{display:grid;grid-template-columns:1fr 1fr;column-gap:16px;row-gap:" + gap + "px}",
      S + " .ssf-f{grid-column:span 2;min-width:0}",
      S + " .ssf-half{grid-column:span 1}",
      // Two columns puts every ordinary field side by side; Single column uses each field's own width.
      S + ".ssf-two .ssf-f:not(.ssf-wide){grid-column:span 1}",
      S + " .ssf-label{display:block;font-weight:600;margin-bottom:6px;color:" + hex(c.label, "#111827") + "}",
      S + " .ssf-req{color:#DC2626;margin-left:2px}",
      S + ".ssf-left .ssf-row," + S + ".ssf-right .ssf-row{display:flex;gap:12px;align-items:flex-start}",
      S + ".ssf-left .ssf-row>.ssf-label," + S + ".ssf-right .ssf-row>.ssf-label{flex:0 0 " + lw + "px;margin:10px 0 0}",
      S + ".ssf-right .ssf-row>.ssf-label{text-align:right}",
      S + " .ssf-ctl{flex:1;min-width:0}",
      S + " .ssf-in{display:block;width:100%;font:inherit;color:" + hex(c.text, "#111827") + ";background:" + hex(c.inputBg, "#FFF") + ";padding:10px 12px;border-radius:" + inputRadius + "px;" + (st.inputStyle === "underline" ? "border:0;border-bottom:1px solid " + border + ";padding-left:2px;background:transparent;" : "border:1px solid " + border + ";") + "outline:none;transition:border-color .15s,box-shadow .15s}",
      S + " textarea.ssf-in{min-height:110px;resize:vertical}",
      S + " .ssf-in:focus{border-color:" + accent + ";box-shadow:0 0 0 3px " + accent + "33}",
      S + " .ssf-in::placeholder{color:" + hex(c.text, "#111827") + ";opacity:.45}",
      S + " .ssf-opt{display:flex;gap:8px;align-items:flex-start;margin:4px 0;cursor:pointer;font-weight:400}",
      S + " .ssf-opt input{margin-top:3px;accent-color:" + accent + ";flex:0 0 auto;width:16px;height:16px}",
      S + " .ssf-help{font-size:" + (fs - 2) + "px;opacity:.7;margin-top:4px}",
      S + " .ssf-err{font-size:" + (fs - 2) + "px;color:#DC2626;margin-top:4px}",
      S + " .ssf-err:empty{display:none}",
      S + " .ssf-bad .ssf-in{border-color:#DC2626}",
      S + " .ssf-h1{font-size:" + (fs + 7) + "px;font-weight:700;margin:4px 0 0}",
      S + " .ssf-h2{font-size:" + (fs + 3) + "px;font-weight:700;margin:4px 0 0}",
      S + " .ssf-p{margin:0;white-space:pre-wrap}",
      S + " .ssf-hr{border:0;border-top:1px solid " + border + ";margin:4px 0}",
      S + " .ssf-img{display:block;max-width:100%;border-radius:6px;margin:0 auto}",
      S + " .ssf-actions{margin-top:" + Math.max(gap, 12) + "px;text-align:" + (b.align === "left" || b.align === "right" ? b.align : "center") + "}",
      S + " .ssf-btn{font:inherit;font-weight:700;cursor:pointer;border:0;padding:" + bsize + ";border-radius:" + n(b.radius, 0, 30, radius) + "px;background:" + hex(c.buttonBg, accent) + ";color:" + hex(c.buttonText, "#FFF") + ";" + (b.fullWidth === false ? "" : "width:100%;") + "}",
      S + " .ssf-btn[disabled]{opacity:.6;cursor:wait}",
      S + " .ssf-links{margin-top:14px;text-align:center;font-size:" + (fs - 2) + "px}",
      S + " .ssf-links a{color:" + accent + "}",
      S + " .ssf-done{text-align:center;padding:24px 8px;font-size:" + (fs + 1) + "px}",
      S + " .ssf-done b{display:block;font-size:" + (fs + 7) + "px;margin-bottom:6px}",
      S + " .ssf-formerr{color:#DC2626;margin-top:10px;text-align:center}",
      S + " .ssf-hp{position:absolute!important;left:-10000px!important;width:1px;height:1px;overflow:hidden}",
      S + " .ssf-hiddenchip{font-size:12px;opacity:.6;border:1px dashed " + border + ";border-radius:6px;padding:6px 10px}",
      "@media (max-width:520px){" + S + " .ssf-half{grid-column:span 2}" + S + ".ssf-left .ssf-row," + S + ".ssf-right .ssf-row{display:block}" + S + ".ssf-left .ssf-row>.ssf-label," + S + ".ssf-right .ssf-row>.ssf-label{margin:0 0 6px;text-align:left}}"
    ];
    return rules.join("\n");
  }

  function optionsFor(f, opts) {
    if (f.type === "building_style") return (opts.catalog && opts.catalog.styles) || [];
    if (f.type === "building_size") return (opts.catalog && opts.catalog.sizes) || [];
    return f.options || [];
  }

  function control(f, opts) {
    var t = f.type;
    // A `custom` field is one of the builder's own contact fields (crm_field_defs). It has no type
    // of its own here: it draws whatever that definition's type asks for, which is why cft is
    // folded into the branches below rather than given a branch of its own.
    var cft = t === "custom" ? (f.fieldType || "text") : "";
    var input;
    if (t === "textarea" || cft === "textarea") {
      input = el("textarea", "ssf-in");
    } else if (cft === "checkbox") {
      // A plain tick box labelled with the builder's own wording — NOT the consent branch below,
      // whose sentence and links are ours and must stay ours.
      var l3 = el("label", "ssf-opt");
      var cb3 = el("input");
      cb3.type = "checkbox";
      cb3.name = f.id;
      l3.appendChild(cb3);
      var s3 = el("span", "", f.label || "Yes");
      if (f.required) s3.appendChild(el("span", "ssf-req", "*"));
      l3.appendChild(s3);
      return l3;
    } else if (t === "select" || cft === "select" || t === "timeframe" || t === "building_style" || t === "building_size") {
      input = el("select", "ssf-in");
      var first = el("option", "", f.placeholder || "Choose…");
      first.value = "";
      input.appendChild(first);
      var list = optionsFor(f, opts);
      if (!list.length && opts.designer && (t === "building_style" || t === "building_size")) list = ["(your " + (t === "building_style" ? "styles" : "sizes") + " appear here)"];
      for (var i = 0; i < list.length; i++) { var o = el("option", "", list[i]); o.value = list[i]; input.appendChild(o); }
    } else if (t === "radio" || t === "checkboxes") {
      var wrap = el("div", "ssf-choices");
      var os = f.options || [];
      for (var j = 0; j < os.length; j++) {
        var lab = el("label", "ssf-opt");
        var box = el("input");
        box.type = t === "radio" ? "radio" : "checkbox";
        box.name = f.id;
        box.value = os[j];
        lab.appendChild(box);
        lab.appendChild(el("span", "", os[j]));
        wrap.appendChild(lab);
      }
      return wrap;
    } else if (t === "sms_consent" || t === "terms") {
      var l2 = el("label", "ssf-opt");
      var cb = el("input");
      cb.type = "checkbox";
      cb.name = f.id;
      l2.appendChild(cb);
      var span = el("span");
      if (t === "sms_consent") {
        // The sentence is the server's (smsConsentSentence), never the builder's own words.
        span.textContent = opts.consentSentence || "By checking this box, you agree that we may send you text messages about your quote and your building. Message frequency varies. Message and data rates may apply. Reply STOP to opt out at any time.";
      } else {
        span.appendChild(document.createTextNode(f.label && f.label !== "Terms & privacy" ? f.label + " " : "I agree to the "));
        var pv = opts.privacyUrl, tm = opts.termsUrl;
        if (tm) { var a1 = el("a", "", "Terms of Service"); a1.href = tm; a1.target = "_blank"; a1.rel = "noopener"; span.appendChild(a1); }
        if (tm && pv) span.appendChild(document.createTextNode(" and "));
        if (pv) { var a2 = el("a", "", "Privacy Policy"); a2.href = pv; a2.target = "_blank"; a2.rel = "noopener"; span.appendChild(a2); }
        if (!tm && !pv) span.appendChild(document.createTextNode("terms."));
        if (f.required) span.appendChild(el("span", "ssf-req", "*"));
      }
      l2.appendChild(span);
      return l2;
    } else {
      input = el("input", "ssf-in");
      input.type = cft
        ? (cft === "number" ? "number" : cft === "date" ? "date" : cft === "phone" ? "tel" : cft === "url" ? "url" : "text")
        : t === "email" ? "email" : t === "phone" ? "tel" : t === "number" ? "number" : (t === "date" || t === "date_of_birth") ? "date" : t === "website" ? "url" : "text";
      if (cft === "phone") input.setAttribute("inputmode", "tel");
      var ac = { full_name: "name", first_name: "given-name", last_name: "family-name", email: "email", phone: "tel", address: "street-address", city: "address-level2", state: "address-level1", postal_code: "postal-code", delivery_zip: "postal-code", country: "country-name", organization: "organization", website: "url" }[t];
      if (ac) input.setAttribute("autocomplete", ac);
      if (t === "phone") input.setAttribute("inputmode", "tel");
    }
    input.name = f.id;
    input.id = "ssf-" + f.id + "-" + seq;
    if (f.placeholder && input.tagName !== "SELECT") input.placeholder = f.placeholder;
    return input;
  }

  function read(form, def) {
    var out = {};
    for (var i = 0; i < def.fields.length; i++) {
      var f = def.fields[i];
      if (f.type === "checkboxes") {
        var picked = [];
        var bs = form.querySelectorAll('input[name="' + f.id + '"]');
        for (var k = 0; k < bs.length; k++) if (bs[k].checked) picked.push(bs[k].value);
        out[f.id] = picked;
      } else if (f.type === "radio") {
        var r = form.querySelector('input[name="' + f.id + '"]:checked');
        out[f.id] = r ? r.value : "";
      } else if (f.type === "sms_consent" || f.type === "terms" || (f.type === "custom" && f.fieldType === "checkbox")) {
        var c = form.querySelector('input[name="' + f.id + '"]');
        out[f.id] = !!(c && c.checked);
      } else {
        var x = form.querySelector('[name="' + f.id + '"]');
        if (x) out[f.id] = x.value;
      }
    }
    return out;
  }

  var EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]{2,}$/;
  function check(def, v) {
    var errs = {};
    for (var i = 0; i < def.fields.length; i++) {
      var f = def.fields[i], val = v[f.id];
      var empty = val == null || val === "" || val === false || (val.length === 0);
      if (f.required && empty) errs[f.id] = f.type === "terms" ? "Please agree to continue." : "This field is required.";
      else if (!empty && f.type === "email" && !EMAIL.test(String(val).trim())) errs[f.id] = "Enter a valid email address.";
      else if (!empty && f.type === "phone") { var d = String(val).replace(/\D/g, ""); if (d.length < 10 || d.length > 15) errs[f.id] = "Enter a valid phone number."; }
      else if (!empty && f.type === "custom" && f.fieldType === "number" && !/^-?\d+(\.\d+)?$/.test(String(val).replace(/,/g, "").trim())) errs[f.id] = "Enter a number.";
      else if (!empty && f.type === "custom" && f.fieldType === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(String(val).trim())) errs[f.id] = "Enter a date.";
    }
    return errs;
  }

  function build(def, opts) {
    opts = opts || {};
    def = def || { fields: [], style: {} };
    var st = def.style || {};
    seq++;
    var scope = "ssf-s" + seq + "-" + Math.random().toString(36).slice(2, 7);
    var root = el("div", "ssf " + scope + " ssf-" + (st.layout === "two" ? "two" : "single") + " ssf-" + (st.labelAlign === "left" || st.labelAlign === "right" ? st.labelAlign : "top") + (st.cssClass ? " " + st.cssClass : ""));
    var style = el("style");
    style.textContent = css(def, scope);
    root.appendChild(style);

    var h = def.header || {};
    if (h.imageUrl || h.title || h.subtitle) {
      var head = el("div", "ssf-head");
      if (h.imageUrl) { var im = el("img"); im.src = h.imageUrl; im.alt = ""; head.appendChild(im); }
      if (h.title) head.appendChild(el("h2", "ssf-title", h.title));
      if (h.subtitle) head.appendChild(el("p", "ssf-sub", h.subtitle));
      root.appendChild(head);
    }

    var form = el("form", "ssf-grid");
    form.setAttribute("novalidate", "");
    var privacy = opts.privacyUrl || (def.footerLinks && def.footerLinks.privacy) || "";
    var terms = opts.termsUrl || (def.footerLinks && def.footerLinks.terms) || "";
    var ctlOpts = { consentSentence: opts.consentSentence, catalog: opts.catalog, designer: opts.designer, privacyUrl: privacy, termsUrl: terms };
    var fieldEls = {};
    for (var i = 0; i < def.fields.length; i++) {
      var f = def.fields[i];
      var wide = ["heading", "paragraph", "divider", "image", "textarea", "sms_consent", "terms", "checkboxes", "radio"].indexOf(f.type) >= 0
        || (f.type === "custom" && (f.fieldType === "textarea" || f.fieldType === "checkbox"));
      var box = el("div", "ssf-f" + (f.width === "half" ? " ssf-half" : "") + (wide ? " ssf-wide" : ""));
      box.setAttribute("data-field-id", f.id);
      if (f.type === "hidden") {
        if (!opts.designer) continue;
        box.appendChild(el("div", "ssf-hiddenchip", "Hidden: " + (f.label || f.id) + " ← " + (f.source === "static" ? "“" + (f.value || "") + "”" : f.source)));
      } else if (f.type === "heading") {
        box.appendChild(el(f.level === 2 ? "h3" : "h2", f.level === 2 ? "ssf-h2" : "ssf-h1", f.text || "Heading"));
      } else if (f.type === "paragraph") {
        box.appendChild(el("p", "ssf-p", f.text || (opts.designer ? "Text block — write something here." : "")));
      } else if (f.type === "divider") {
        box.appendChild(el("hr", "ssf-hr"));
      } else if (f.type === "image") {
        if (f.imageUrl) { var ig = el("img", "ssf-img"); ig.src = f.imageUrl; ig.alt = f.label || ""; box.appendChild(ig); }
        else if (opts.designer) box.appendChild(el("div", "ssf-hiddenchip", "Image — upload one in the panel on the right"));
        else continue;
      } else {
        var row = el("div", "ssf-row");
        var ctl = control(f, ctlOpts);
        var showLabel = st.showLabels !== false && f.type !== "sms_consent" && f.type !== "terms";
        if (showLabel) {
          var lab = el("label", "ssf-label", f.label);
          if (ctl.id) lab.htmlFor = ctl.id;
          if (f.required) lab.appendChild(el("span", "ssf-req", "*"));
          row.appendChild(lab);
        } else if (ctl.setAttribute && ctl.tagName !== "LABEL" && ctl.tagName !== "DIV") {
          ctl.setAttribute("aria-label", f.label);
        }
        var wrap = el("div", "ssf-ctl");
        wrap.appendChild(ctl);
        if (f.help) wrap.appendChild(el("div", "ssf-help", f.help));
        wrap.appendChild(el("div", "ssf-err"));
        row.appendChild(wrap);
        box.appendChild(row);
      }
      fieldEls[f.id] = box;
      form.appendChild(box);
    }
    // The honeypot: real people never see it, so anything typed here marks the submission as spam.
    var hp = el("div", "ssf-hp");
    hp.setAttribute("aria-hidden", "true");
    var hpIn = el("input");
    hpIn.type = "text"; hpIn.name = "ssf_website_hp"; hpIn.tabIndex = -1; hpIn.setAttribute("autocomplete", "off");
    hp.appendChild(hpIn);
    form.appendChild(hp);

    var actions = el("div", "ssf-actions ssf-f ssf-wide");
    var btn = el("button", "ssf-btn", (st.button && st.button.text) || "Submit");
    btn.type = "submit";
    actions.appendChild(btn);
    var formErr = el("div", "ssf-formerr");
    actions.appendChild(formErr);
    form.appendChild(actions);
    root.appendChild(form);

    if ((privacy || terms) && !def.fields.some(function (x) { return x.type === "terms"; })) {
      var links = el("div", "ssf-links");
      if (privacy) { var p1 = el("a", "", "Privacy Policy"); p1.href = privacy; p1.target = "_blank"; p1.rel = "noopener"; links.appendChild(p1); }
      if (privacy && terms) links.appendChild(document.createTextNode(" | "));
      if (terms) { var t1 = el("a", "", "Terms of Service"); t1.href = terms; t1.target = "_blank"; t1.rel = "noopener"; links.appendChild(t1); }
      root.appendChild(links);
    }

    var t0 = Date.now(), started = false;
    function onTouch() { if (!started) { started = true; if (opts.onStart) try { opts.onStart(); } catch (e) {} } }
    form.addEventListener("input", onTouch);
    form.addEventListener("change", onTouch);

    function showErrors(errs) {
      for (var id in fieldEls) {
        var box = fieldEls[id];
        var e = box.querySelector(".ssf-err");
        if (!e) continue;
        e.textContent = errs[id] || "";
        if (errs[id]) box.classList.add("ssf-bad"); else box.classList.remove("ssf-bad");
      }
      for (var k in errs) { if (fieldEls[k]) { var focus = fieldEls[k].querySelector("input,select,textarea"); if (focus) { try { focus.focus(); } catch (x) {} } break; } }
    }

    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (opts.designer) return;
      formErr.textContent = "";
      var values = read(form, def);
      var errs = check(def, values);
      showErrors(errs);
      if (Object.keys(errs).length) return;
      if (!opts.onSubmit) return;
      btn.disabled = true;
      var label = btn.textContent;
      btn.textContent = "Sending…";
      Promise.resolve(opts.onSubmit(values, { hp: hpIn.value, elapsedMs: Date.now() - t0 })).then(function (res) {
        btn.disabled = false; btn.textContent = label;
        if (res && res.ok) {
          var a = res.afterSubmit || {};
          if (a.mode === "redirect" && /^https:\/\//i.test(a.redirectUrl || "")) {
            try { (window.top || window).location.href = a.redirectUrl; } catch (e) { window.location.href = a.redirectUrl; }
            return;
          }
          form.style.display = "none";
          var done = el("div", "ssf-done");
          done.appendChild(el("b", "", "Thank you!"));
          done.appendChild(el("div", "", a.message || "We got your information and will be in touch soon."));
          // Right where the form was, above the legal links.
          root.insertBefore(done, form.nextSibling);
          if (opts.onDone) try { opts.onDone(); } catch (e) {}
        } else if (res && res.errors) {
          showErrors(res.errors);
        } else {
          formErr.textContent = (res && res.error) || "We couldn't send that. Please try again.";
        }
      }, function () {
        btn.disabled = false; btn.textContent = label;
        formErr.textContent = "We couldn't send that. Check your connection and try again.";
      });
    });

    if (opts.designer) {
      // The designer canvas: nothing submits, nothing focuses, every field box is a target.
      form.addEventListener("click", function (e) { if (e.target && e.target.tagName === "BUTTON") e.preventDefault(); }, true);
      var ins = form.querySelectorAll("input,select,textarea,button");
      for (var q = 0; q < ins.length; q++) { ins[q].tabIndex = -1; ins[q].style.pointerEvents = "none"; }
    }
    return root;
  }

  window.SSForm = { build: build, css: css, FONTS: FONTS, version: 1 };
})();
