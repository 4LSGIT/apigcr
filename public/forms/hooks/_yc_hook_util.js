/**
 * /forms/hooks/_yc_hook_util.js — shared helpers for templated-form hooks.
 *
 * NOT a hooks file itself (a template's `hooks` key never names it). Hook files
 * and definition `code` (2.6) load it with a plain <script src> ahead of their
 * own body; render.html awaits only the named hooks file, so anything needing
 * these helpers must inline-load this one first and gate on it (the loadUtil
 * pattern — see tests/fixtures/slice26/legacy_notes_341.js).
 *
 * Everything here is deliberately DOM/runtime-level: hooks run inside
 * render.html, which has no build step and no module system.
 */
(function (w) {
  'use strict';
  if (w.ycHookUtil) return;

  /**
   * Walk up the iframe chain for a property the shell exposes. render.html may
   * sit under case.html / contact.html (which relay apiSend AND firmData) or
   * under formBuilder.html (which today relays apiSend ONLY). Walking makes a
   * hook work in every host.
   */
  function fromChain(prop) {
    var win = w, hops = 0;
    while (win && hops++ < 6) {
      try { if (win[prop]) return win[prop]; } catch (e) { /* cross-origin */ }
      if (win === win.parent) break;
      win = win.parent;
    }
    return null;
  }

  function api(url, method, body) {
    var send = fromChain('apiSend');
    if (!send) return Promise.reject(new Error('apiSend not reachable from this frame'));
    return send(url, method, body);
  }

  var firmData = function () { return fromChain('firmData') || {}; };

  /** The Primary / Secondary contact rows from a case load payload. */
  function clients(form) {
    var lr = form._loadResult || {};
    var list = lr.clients || [];
    return {
      all: list,
      primary: list.filter(function (c) { return c.relate_type === 'Primary'; })[0] || null,
      secondary: list.filter(function (c) { return c.relate_type === 'Secondary'; })[0] || null,
    };
  }

  /** Raw entity row as loaded (NOT apiMap-translated). */
  function entity(form) { return form._liveData || {}; }

  function elFor(form, name) { return form.el.querySelector('[name="' + name + '"]'); }

  /**
   * Write a value the way the hand-built onLoad hooks do: only when the control
   * is empty, so a snapshot/draft value is never clobbered. Runs before
   * init step 13c, so nothing written here dirties the form.
   */
  function setIfEmpty(form, name, value) {
    var el = elFor(form, name);
    if (!el || value == null || value === '') return false;
    if (el.value) return false;
    el.value = normalize(el, value);
    return true;
  }

  function setAlways(form, name, value) {
    var el = elFor(form, name);
    if (!el) return false;
    el.value = value == null ? '' : normalize(el, value);
    return true;
  }

  /** date / datetime-local normalization (mirrors YCForm._formatForDisplay). */
  function normalize(el, value) {
    var str = (value instanceof Date) ? value.toISOString() : String(value);
    if (el.type === 'date') {
      var d = str.split('T')[0];
      return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : '';
    }
    if (el.type === 'datetime-local') {
      var local = str.replace('Z', '').split('.')[0].slice(0, 16);
      return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local) ? local : '';
    }
    return str;
  }

  /** Check a radio by value, only if nothing in the group is checked yet. */
  function setRadioIfEmpty(form, name, value) {
    if (!value) return false;
    if (form.el.querySelector('input[name="' + name + '"]:checked')) return false;
    var r = form.el.querySelector('input[name="' + name + '"][value="' + String(value).replace(/"/g, '\\"') + '"]');
    if (!r) return false;
    r.checked = true;
    return true;
  }

  /** The .yc-row (or .yc-section) wrapping a named field — for JS-driven toggles. */
  function rowOf(form, name) {
    var el = elFor(form, name);
    return el ? el.closest('.yc-row') : null;
  }
  function sectionOf(form, name) {
    var el = elFor(form, name);
    return el ? el.closest('.yc-section') : null;
  }

  /** Is a given value ticked inside a checkgroup? */
  function cgHas(form, group, value) {
    var g = form.el.querySelector('[data-yc-checkgroup="' + group + '"]');
    if (!g) return false;
    var cb = g.querySelector('input[type="checkbox"][value="' + String(value).replace(/"/g, '\\"') + '"]');
    return !!(cb && cb.checked);
  }

  /**
   * Toggle `node` from a checkgroup's state and keep it in sync.
   * Exists only because YCForm._evaluateConditionals resolves its watched field
   * with querySelector('[name=…]') and checkgroup members carry no name — so
   * `showWhen` cannot target them. See REPORT.md gap 3.
   */
  function bindCheckgroupToggle(form, group, values, node) {
    if (!node) return;
    var g = form.el.querySelector('[data-yc-checkgroup="' + group + '"]');
    if (!g) return;
    var apply = function () {
      var on = values.some(function (v) { return cgHas(form, group, v); });
      node.style.display = on ? '' : 'none';
    };
    g.addEventListener('change', apply);
    apply();
  }

  w.ycHookUtil = {
    fromChain: fromChain, api: api, firmData: firmData,
    clients: clients, entity: entity,
    elFor: elFor, setIfEmpty: setIfEmpty, setAlways: setAlways, normalize: normalize,
    setRadioIfEmpty: setRadioIfEmpty, rowOf: rowOf, sectionOf: sectionOf,
    cgHas: cgHas, bindCheckgroupToggle: bindCheckgroupToggle,
  };
})(window);