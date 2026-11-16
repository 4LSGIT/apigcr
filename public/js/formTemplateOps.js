/* public/js/formTemplateOps.js — the form template DRAFT operations behind the
 * Ask Casey field-level template cards (A12X / A12Y, 2026-11-16).
 *
 * ONE pure implementation shared by the server (services/assistantService.js
 * `require`s it — the public/js/mailboxColor.js precedent) and the browser
 * (public/assistant.html loads it as a script): the normalizer applies the
 * reviewed operation to the draft it read and puts the operation plus the
 * SHA-256 of the canonical result (`next_hash`) on the card — never the result
 * itself (an 85 KB questionnaire's draft made every card refuse); the click
 * re-reads the draft, re-applies the SAME operation with these SAME functions
 * and sends the result only when its hash equals `next_hash`. Equal hashes
 * mean identical canonical bytes, so "what was reviewed is what is sent" holds
 * exactly as it did when the card carried the whole definition.
 *
 * Pure: no DOM, no Node API, no require — it must load in a bare `vm` context
 * (tests/formTemplateOps.test.js proves it). Every refusal is thrown as an
 * Error with `code: 'FORM_TEMPLATE_OP'`; the server wraps it as its 422 and the
 * page as a card refusal. The texts are the normalizer's own (A12X), unchanged.
 *
 * Message texts and placement rules here are pinned by
 * tests/caseyFormTemplates.test.js; the hash equality server ↔ page by
 * tests/formTemplateOps.test.js.
 */
(function (root) {
  'use strict';

  function opError(message) {
    var e = new Error(message);
    e.code = 'FORM_TEMPLATE_OP';
    return e;
  }

  var hasOwn = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
  var clone = function (v) { return JSON.parse(JSON.stringify(v)); };

  // Key-order-insensitive serialization: MySQL re-orders JSON object keys on
  // write, so a hash of a stored draft must not depend on key order. The
  // server's formDataHash and the page's formDataHash are SHA-256 over this
  // exact text (utf8).
  function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') {
      return '{' + Object.keys(value).sort().map(function (k) { return JSON.stringify(k) + ':' + canonical(value[k]); }).join(',') + '}';
    }
    return JSON.stringify(value === undefined ? null : value);
  }

  // Every section of a definition with the path validateDefinition names it by
  // (sections mode: sections[i]; tabs mode: stickyTop[i], tabs[t].sections[i],
  // stickyBottom[i] — the order extFormService.buildValueRegistry walks).
  function sections(def) {
    var out = [];
    if (!def || typeof def !== 'object' || Array.isArray(def)) return out;
    var push = function (list, prefix) {
      if (!Array.isArray(list)) return;
      list.forEach(function (s, i) { if (s && typeof s === 'object' && !Array.isArray(s)) out.push({ section: s, path: prefix + '[' + i + ']' }); });
    };
    if (Array.isArray(def.tabs)) {
      push(def.stickyTop, 'stickyTop');
      def.tabs.forEach(function (t, ti) { push(t && t.sections, 'tabs[' + ti + '].sections'); });
      push(def.stickyBottom, 'stickyBottom');
    } else {
      push(def.sections, 'sections');
    }
    return out;
  }

  function sectionLabel(s) {
    if (s.section.title) return '"' + String(s.section.title).slice(0, 80) + '"';
    if (hasOwn(s.section, 'repeater')) return 'repeater "' + s.section.repeater + '"';
    return s.path;
  }

  // The section a card names: by its title (case-insensitive, spaces
  // collapsed), its repeater key, or its path (sections[2],
  // tabs[0].sections[1]); omitted only when the draft has ONE section. `name`
  // is the template as the card names it (the messages).
  function sectionRef(list, ref, name) {
    var want = ref == null ? '' : String(ref).trim();
    var all = list.map(function (s, index) { return { section: s.section, path: s.path, index: index, label: sectionLabel(s) }; });
    var labels = function () { return all.map(function (s) { return s.label; }).join(', '); };
    if (!want) {
      if (all.length === 1) return all[0];
      throw opError(name + ' has ' + all.length + ' sections — name the one the field goes into in "section" (its title): ' + labels());
    }
    var norm = function (s) { return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim(); };
    var hits = all.filter(function (s) { return (s.section.title != null && norm(s.section.title) === norm(want)) || s.section.repeater === want || s.path === want; });
    if (!hits.length) throw opError(name + ' has no section "' + want.slice(0, 80) + '" — its sections: ' + labels());
    if (hits.length > 1) throw opError('"' + want.slice(0, 80) + '" names ' + hits.length + ' sections of ' + name + ' (' + hits.map(function (h) { return h.path; }).join(', ') + ') — name it by its path instead');
    return hits[0];
  }

  // Where ONE answer field lives: the array holding it, its index, its section
  // and (for a repeater's row field) the repeater key. The name is a top-level
  // field name or "<repeater>.<field>" — the keys of the card's diff.
  function locate(def, fieldName) {
    var dot = fieldName.indexOf('.');
    var rep = dot > 0 ? fieldName.slice(0, dot) : null;
    var fname = dot > 0 ? fieldName.slice(dot + 1) : fieldName;
    var all = sections(def);
    for (var si = 0; si < all.length; si++) {
      var section = all[si].section; var path = all[si].path;
      if (hasOwn(section, 'repeater')) {
        if (rep !== null && section.repeater === rep && Array.isArray(section.fields)) {
          var ri = section.fields.findIndex(function (f) { return f && f.name === fname; });
          if (ri >= 0) return { holder: section.fields, index: ri, field: section.fields[ri], section: section, path: path + '.fields[' + ri + ']', repeater: rep };
        }
        continue;
      }
      if (rep !== null) continue;
      var rows = Array.isArray(section.rows) ? section.rows : [];
      for (var r = 0; r < rows.length; r++) {
        var row = rows[r];
        if (!row || !Array.isArray(row.fields)) continue;
        var i = row.fields.findIndex(function (f) { return f && f.name === fname; });
        if (i >= 0) return { holder: row.fields, index: i, field: row.fields[i], section: section, row: row, path: path + '.rows[' + r + '].fields[' + i + ']', repeater: null };
      }
    }
    return null;
  }

  // Everything in a definition that still names a top-level field: conditions
  // (showWhen / showWhenAny / requiredWhen on sections, rows and fields) and
  // derive rules — what validateDefinition 400s as a dangling target once the
  // field is gone (the builder cascade-removes them after a confirm; a card
  // refuses instead and names them).
  function references(def, fieldName) {
    var out = [];
    var conds = function (slot) { return slot == null ? [] : Array.isArray(slot) ? slot : [slot]; };
    var scan = function (node, path) {
      if (!node || typeof node !== 'object') return;
      ['showWhen', 'showWhenAny', 'requiredWhen'].forEach(function (key) {
        if (conds(node[key]).some(function (c) { return c && c.field === fieldName; })) out.push(path + '.' + key);
      });
    };
    sections(def).forEach(function (s) {
      var section = s.section; var path = s.path;
      scan(section, path);
      if (hasOwn(section, 'repeater')) {
        (Array.isArray(section.fields) ? section.fields : []).forEach(function (f, i) { scan(f, path + '.fields[' + i + ']'); });
      } else {
        (Array.isArray(section.rows) ? section.rows : []).forEach(function (row, r) {
          scan(row, path + '.rows[' + r + ']');
          (row && Array.isArray(row.fields) ? row.fields : []).forEach(function (f, i) { scan(f, path + '.rows[' + r + '].fields[' + i + ']'); });
        });
      }
    });
    (Array.isArray(def.derive) ? def.derive : []).forEach(function (rule, i) {
      if (rule && (rule.target === fieldName || rule.from === fieldName)) out.push('derive[' + i + ']');
    });
    return out;
  }

  // form.template.field.add.v1 — op = {section, field, after}: ONE answer
  // field into ONE section of a COPY of the draft (a new row at the end of a
  // standard section, right after `after` in its row, or appended to a
  // repeater's row list). Returns the copy and where the field went.
  function fieldAdd(draft, op, name) {
    var list = sections(draft);
    if (!list.length) throw opError(name + ' has no section to add a field to — the user adds one in the form builder first');
    var field = op && op.field;
    if (!field || typeof field !== 'object' || Array.isArray(field) || typeof field.name !== 'string') throw opError('field add: the field must be an object with a name');
    var target = sectionRef(list, op.section, name);
    var isRep = hasOwn(target.section, 'repeater');
    var key = isRep ? target.section.repeater + '.' + field.name : field.name;
    if (locate(draft, key) || list.some(function (s) { return s.section.repeater === field.name; })) {
      throw opError('FIELD EXISTS: ' + name + ' already has a field or repeater named "' + key + '" — change it with form.template.field.update.v1, or pick another name');
    }
    var after = op.after == null || String(op.after).trim() === '' ? null : String(op.after).trim();
    var next = clone(draft);
    var tNext = sections(next)[target.index].section;
    var copy = clone(field);
    var placed;
    if (isRep) {
      var rows0 = Array.isArray(tNext.fields) ? tNext.fields : (tNext.fields = []);
      var at = rows0.length;
      if (after !== null) {
        var ai = rows0.findIndex(function (f) { return f && f.name === after; });
        if (ai < 0) throw opError('"after" names "' + after + '", which is not a row field of repeater "' + target.section.repeater + '"');
        at = ai + 1;
      }
      rows0.splice(at, 0, copy);
      placed = 'row field ' + (at + 1) + ' of ' + rows0.length + ' in repeater "' + target.section.repeater + '"';
    } else {
      var rows = Array.isArray(tNext.rows) ? tNext.rows : (tNext.rows = []);
      if (after !== null) {
        var hit = null;
        rows.forEach(function (row, r) {
          if (hit || !row || !Array.isArray(row.fields)) return;
          var i = row.fields.findIndex(function (f) { return f && f.name === after; });
          if (i >= 0) hit = { row: row, r: r, i: i };
        });
        if (!hit) throw opError('"after" names "' + after + '", which is not a field of section ' + target.label);
        hit.row.fields.splice(hit.i + 1, 0, copy);
        placed = 'right after "' + after + '" in row ' + (hit.r + 1) + ' of section ' + target.label;
      } else {
        rows.push({ fields: [copy] });
        placed = 'a new row (row ' + rows.length + ') at the end of section ' + target.label;
      }
    }
    return { next: next, field: copy, key: key, placed: placed, after: after, target: target, repeater: isRep ? target.section.repeater : null };
  }

  // form.template.field.update.v1 — op = {field_name, changes}: ONE field's
  // own keys set on a COPY of the draft; a null drops the key.
  function fieldUpdate(draft, op, name) {
    var fieldName = String(op && op.field_name == null ? '' : op.field_name).trim();
    var loc = locate(draft, fieldName);
    if (!loc) throw opError(name + ' has no answer field "' + fieldName.slice(0, 60) + '" in its draft');
    var changes = op.changes;
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw opError('changes must be an object');
    var next = clone(draft);
    var target = locate(next, fieldName);
    var set = []; var dropped = [];
    Object.keys(changes).forEach(function (k) {
      var v = changes[k];
      if (v === null) { if (hasOwn(target.field, k)) { delete target.field[k]; dropped.push(k); } }
      else { target.field[k] = clone(v); set.push(k); }
    });
    if (!set.length && !dropped.length) throw opError('NOTHING TO CHANGE: changes drops keys "' + fieldName + '" does not have');
    return { next: next, loc: loc, field: target.field, set: set, dropped: dropped };
  }

  // form.template.field.remove.v1 — op = {field_name}: ONE field out of a
  // COPY of the draft; an emptied row is left in place. Refused while a
  // condition or derive rule still names it, and for a repeater's last row field.
  function fieldRemove(draft, op, name) {
    var fieldName = String(op && op.field_name == null ? '' : op.field_name).trim();
    var loc = locate(draft, fieldName);
    if (!loc) {
      if (sections(draft).some(function (s) { return s.section.repeater === fieldName; })) {
        throw opError('REPEATER refused: "' + fieldName + '" is a repeater section of ' + name + ', not a field — removing a whole section (and every answer row it holds) is the form builder\'s');
      }
      throw opError(name + ' has no answer field "' + fieldName.slice(0, 60) + '" in its draft');
    }
    if (!loc.repeater) {
      var refsTo = references(draft, fieldName);
      if (refsTo.length) {
        throw opError('STILL REFERENCED refused: ' + refsTo.join(', ') + ' ' + (refsTo.length === 1 ? 'names' : 'name') + ' "' + fieldName + '" (a visibility / required-when condition or a derive rule) — the draft would not save with a dangling target. Clear ' + (refsTo.length === 1 ? 'it' : 'them') + ' first (a field\'s condition with form.template.field.update.v1 {showWhen: null}; a section\'s, a row\'s or a derive rule in the form builder, whose delete cascade-removes them after a confirm)');
      }
    }
    if (loc.repeater && loc.holder.length === 1) {
      throw opError('LAST ROW FIELD refused: "' + fieldName + '" is the only row field of repeater "' + loc.repeater + '" — a repeater needs one, so removing it means removing the repeater section, which is the form builder\'s');
    }
    var next = clone(draft);
    var target = locate(next, fieldName);
    target.holder.splice(target.index, 1);
    return { next: next, loc: loc };
  }

  // form.template.create.v1 — the one deterministic shape a create builds: ONE
  // standard section — the builder's "Section 1" — with one row per reviewed
  // field (the builder's own click-to-add makes a row per drop too).
  function createDefinition(fields) {
    if (!Array.isArray(fields)) throw opError('create: fields must be a list');
    return { sections: [{ title: 'Section 1', rows: fields.map(function (f) { return { fields: [clone(f)] }; }) }] };
  }

  // The one entry the page uses at the click: the kind, the draft as re-read
  // (null for a create) and the card's `apply` → the full result to send.
  function apply(kind, draft, op, name) {
    if (kind === 'form.template.field.add.v1') return fieldAdd(draft, op, name).next;
    if (kind === 'form.template.field.update.v1') return fieldUpdate(draft, op, name).next;
    if (kind === 'form.template.field.remove.v1') return fieldRemove(draft, op, name).next;
    if (kind === 'form.template.create.v1') return createDefinition(op && op.fields);
    throw opError('no draft operation for ' + String(kind));
  }

  root.YCFormTemplateOps = {
    canonical: canonical,
    sections: sections,
    sectionLabel: sectionLabel,
    sectionRef: sectionRef,
    locate: locate,
    references: references,
    fieldAdd: fieldAdd,
    fieldUpdate: fieldUpdate,
    fieldRemove: fieldRemove,
    createDefinition: createDefinition,
    apply: apply,
  };
})(typeof window !== 'undefined' ? window : globalThis);

/* Node/CommonJS export (the normalizer; unit tests). */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).YCFormTemplateOps;
}
