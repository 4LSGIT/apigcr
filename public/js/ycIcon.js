/* public/js/ycIcon.js — the stored icon value → Font Awesome classes
 * (ui-custom S6a). ONE helper for every place that renders a stored icon:
 * the shell's launcher (Home, sidebar, More's firm row, drawers), the All tab
 * and Ctrl-K palette (ycAll.js), the layout editor (ycLayoutEditor.js), the
 * custom tab (index.html applyCustomTab), the icon picker (ycIconPicker.js)
 * and, through window.top, the Firm tab (caseconfig/firm.html) and Settings.
 *
 * THE VALUE GRAMMAR — stored in ui_config (firm items, a user's buttons and
 * drawers) and in users.user_custom_tab.icon:
 *
 *     ^(?:(?:solid|regular|brands):)?[a-z0-9-]{1,40}$
 *
 *   star            fa-solid fa-star     (a bare slug means solid: every value
 *                                          stored before S6a stays valid and
 *                                          renders identically)
 *   solid:star      fa-solid fa-star     (accepted; the picker writes solid
 *                                          bare, never with the prefix)
 *   regular:star    fa-regular fa-star
 *   brands:github   fa-brands fa-github
 *
 * Linear by construction: anchored, one optional group, one character class.
 * The server copies are lib/uiConfigShape.js ICON_RE and
 * routes/auth.customTab.js ICON_RE; tests/ycIconS6a.test.js pins all three
 * (and the launcher's own copy in index.html) to this one.
 *
 * A value that fails the grammar renders FALLBACK (fa-solid fa-circle-question)
 * — never anything built from the bad value, so the class string can only ever
 * hold a family from the list above and a slug of [a-z0-9-].
 *
 * Pure: no DOM. Loaded by a plain <script src> in index.html's <head>, before
 * the launcher. Also loads under node (module.exports) for the tests.
 */
(function (root) {
  'use strict';
  var RE = /^(?:(?:solid|regular|brands):)?[a-z0-9-]{1,40}$/;
  var FAMILIES = ['solid', 'regular', 'brands'];
  var FALLBACK = 'circle-question';

  /** true when v is a string the grammar accepts. */
  function valid(v) { return typeof v === 'string' && RE.test(v); }

  /** v → { family, name }, or null when it fails the grammar. */
  function parse(v) {
    if (!valid(v)) return null;
    var i = v.indexOf(':');
    return i < 0 ? { family: 'solid', name: v } : { family: v.slice(0, i), name: v.slice(i + 1) };
  }

  /** The stored value for a family + name: solid is written BARE (what every
   *  value before S6a looks like), the others prefixed. null when the pair
   *  would not round-trip through the grammar. */
  function value(family, name) {
    var v = family === 'solid' ? name : family + ':' + name;
    return FAMILIES.indexOf(family) >= 0 && valid(v) ? v : null;
  }

  /** The class string for a stored value, plus optional extra classes
   *  (e.g. 'fa-2xl'; leading/trailing space ignored). */
  function cls(v, extra) {
    var p = parse(v) || { family: 'solid', name: FALLBACK };
    var x = typeof extra === 'string' ? extra.trim() : '';
    return 'fa-' + p.family + ' fa-' + p.name + (x ? ' ' + x : '');
  }

  /** Two values that name the same icon ('star' and 'solid:star'). */
  function same(a, b) {
    var p = parse(a), q = parse(b);
    return !!(p && q && p.family === q.family && p.name === q.name);
  }

  var api = { RE: RE, FAMILIES: FAMILIES.slice(), FALLBACK: FALLBACK, valid: valid, parse: parse, value: value, cls: cls, same: same };
  Object.freeze(api.FAMILIES);
  Object.freeze(api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ycIcon = api;
})(typeof window !== 'undefined' ? window : null);
