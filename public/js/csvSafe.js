/* public/js/csvSafe.js — the ONE CSV cell builder for every human export.
 *
 * FORMULA INJECTION (OWASP "CSV Injection"): a spreadsheet runs a cell that
 * starts with = + - @ — or a tab / carriage return, which some importers strip
 * first — as a formula, and the text staff export (contact names, notes,
 * intake answers, SMS and email bodies) is partly client-written. Such a cell
 * is prefixed with a single quote so it opens as text. A plain number
 * ("-12.50", "+3", -7) is not a formula and keeps its value — the carve-out is
 * exactly /^[+-]?\d+(?:\.\d+)?$/ on the cell's text. Then the usual quoting:
 * a cell holding a comma, a quote, CR or LF is wrapped in quotes, quotes
 * doubled. null/undefined → empty; an object → its JSON.
 *
 * Every CSV exporter routes every cell AND every header through cell():
 *   public/reports.html    downloadCsv → csvText  (saved-report runs)
 *   public/customView.html exportCsv              (views)
 *   public/scripts.js      buildCsv               (list exports: the log from
 *                                                  case, contact and the log
 *                                                  tab; the shell's Cases,
 *                                                  Contacts, Appts, Events,
 *                                                  Calendar list; tasks.html)
 *   public/dbConsole.html  CSV button             (SU database console)
 * and the one tabular clipboard copy — dbConsole's Copy (TSV, built to paste
 * straight into a spreadsheet, where a pasted "=…" cell becomes a formula
 * too) — through tsvCell(): the same neutraliser, then unquoted with tabs and
 * newlines flattened so the grid holds.
 * tests/csvSafe.test.js pins the rule set and that each exporter uses it.
 * Fred's GO 2026-10-27 (A16 + manager ruling on "every human export").
 *
 * Plain script: exposes window.ycCsvSafe = { cell, line, tsvCell, tsvLine };
 * no DOM at load.
 * Also CommonJS-exportable so the rule set is unit-tested headlessly.
 */
(function (root) {
  'use strict';

  var FORMULA_START = /^[=+\-@\t\r]/;
  var PLAIN_NUMBER = /^[+-]?\d+(?:\.\d+)?$/;
  var NEEDS_QUOTES = /[",\r\n]/;

  /** The cell's text with a formula start neutralised (the one rule). */
  function neutral(v) {
    if (v === null || v === undefined) return '';
    var s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return FORMULA_START.test(s) && !PLAIN_NUMBER.test(s) ? "'" + s : s;
  }

  /** One CSV cell, neutralised and quoted. */
  function cell(v) {
    var s = neutral(v);
    return NEEDS_QUOTES.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /** One TSV cell (clipboard): neutralised, unquoted, tabs/newlines flattened. */
  function tsvCell(v) {
    return neutral(v).replace(/\t/g, '    ').replace(/\r?\n|\r/g, ' ');
  }

  function tsvLine(values) {
    return values.map(tsvCell).join('\t');
  }

  /** One CSV line: every value through cell(), comma-joined. */
  function line(values) {
    return values.map(cell).join(',');
  }

  var api = Object.freeze({ cell: cell, line: line, tsvCell: tsvCell, tsvLine: tsvLine });
  root.ycCsvSafe = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
