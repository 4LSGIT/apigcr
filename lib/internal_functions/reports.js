// lib/internal_functions/reports.js
//
// Report delivery: run a saved report and email it. One function —
// `report_email` — registered here so it is immediately schedulable from the
// scheduled-jobs editor, and equally callable from workflows, sequences, and
// hooks (e.g. a workflow could mail the stage breakdown when a case closes)
// with zero extra wiring.
//
// ── WHY report_key, NOT report id ───────────────────────────────────────────
// A job row should survive a report being deleted and recreated, and should be
// readable by a human. report_key is immutable after creation (enforced in
// reportService.updateReport) precisely so stored references like this one
// can't be broken by a rename.
//
// ── EVERY GUARD STILL APPLIES ───────────────────────────────────────────────
// Execution goes through reportService.runReport: manifest allowlist, column
// denylist, EXPLAIN gate, row caps, and a report_runs log row — identical to a
// user clicking Run in the UI. run_by is stamped 0 (the Automations
// pseudo-user), so scheduled runs are distinguishable in the run history.
//
// ── CHARTS IN EMAIL ─────────────────────────────────────────────────────────
// No headless browser, no third-party chart-image service (firm data stays
// in-house), no native canvas deps on Cloud Run. Charts render as table-based
// horizontal bars — <td bgcolor width%> — which is the one charting technique
// that survives Gmail, Outlook's Word engine, and Apple Mail alike. The shape
// decision reuses the SAME pure module the browser uses
// (public/js/reportCharts.js: profileColumns / normalizeViz / inferViz /
// formatValue / colorForLabel), so an email and the on-screen chart agree
// about what kind of thing they are drawing. viz types map as: stat → big
// number cards; pie/doughnut → bars + a share column; bar/line/area/combo →
// bars per series (a bar-of-months is an honest rendering of a time series in
// a medium that cannot do lines).
//
// Bars are skipped (table only, with a note) when any value is negative —
// same philosophy as the browser's pie fallback: never draw a shape that lies.

const { cfg } = require('../firmConfig');
const emailService = require('../../services/emailService');
const reportService = require('../../services/reportService');
const RC = require('../../public/js/reportCharts');

const fns = {};

// ── formatting helpers (email-safe: inline styles + tables only) ────────────

const FONT = "font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;";

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** Resolve the display format for a series key: viz > columns_meta > guess. */
function fmtFor(key, series, columnsMeta) {
  const s = (series || []).find((x) => x.key === key);
  if (s && s.format) return s.format;
  const c = (columnsMeta || []).find((x) => x.key === key);
  if (c && c.format && c.format !== 'text') return c.format;
  return RC.guessFormat(key);
}

/** One horizontal bar row. width in [0,100]; 0-value shows no bar but the number. */
function barRow(label, valueDisplay, widthPct, color) {
  const w = Math.max(0, Math.min(100, Math.round(widthPct)));
  const bar = w > 0
    ? `<table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>` +
      `<td bgcolor="${color}" width="${w}%" style="height:16px;border-radius:3px;font-size:1px;line-height:16px;">&nbsp;</td>` +
      (w < 100 ? `<td width="${100 - w}%" style="font-size:1px;">&nbsp;</td>` : '') +
      `</tr></table>`
    : `<span style="color:#9ca3af;font-size:11px;">&mdash;</span>`;
  return `<tr>` +
    `<td style="${FONT}font-size:12px;color:#374151;padding:3px 10px 3px 0;white-space:nowrap;" align="right">${esc(label)}</td>` +
    `<td width="55%" style="padding:3px 0;">${bar}</td>` +
    `<td style="${FONT}font-size:12px;color:#111827;padding:3px 0 3px 10px;white-space:nowrap;font-weight:600;">${valueDisplay}</td>` +
    `</tr>`;
}

/** Bars for one numeric series across category rows. */
function seriesBars({ title, rows, xKey, yKey, fmt, perCategoryColor, seriesColor, showShare, allInteger }) {
  const vals = rows.map((r) => RC.num(r[yKey]) || 0);
  const max = Math.max(...vals, 0);
  const total = vals.reduce((a, b) => a + b, 0);
  const body = rows.map((r, i) => {
    const v = RC.num(r[yKey]) || 0;
    const label = r[xKey] === null || r[xKey] === '' ? '(blank)' : RC.shortDate(r[xKey]);
    let display = esc(RC.formatValue(r[yKey], fmt, allInteger));
    if (showShare && total > 0) {
      display += ` <span style="color:#6b7280;font-weight:400;">(${RC.round((v / total) * 100, 1)}%)</span>`;
    }
    const color = perCategoryColor ? RC.colorForLabel(label, i) : seriesColor;
    return barRow(label, display, max > 0 ? (v / max) * 100 : 0, color);
  }).join('');
  const head = title
    ? `<tr><td colspan="3" style="${FONT}font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;padding:12px 0 4px;font-weight:600;">${esc(title)}</td></tr>`
    : '';
  return head + body;
}

/** Big-number stat cards. */
function statCards(cards) {
  const tds = cards.map((c) =>
    `<td align="center" style="border:1px solid #e5e7eb;border-radius:8px;padding:14px 10px;">` +
    `<div style="${FONT}font-size:24px;font-weight:700;color:#2563eb;">${esc(c.display)}</div>` +
    `<div style="${FONT}font-size:10.5px;color:#6b7280;text-transform:uppercase;letter-spacing:.03em;padding-top:4px;">${esc(c.label)}</div>` +
    `</td>`
  ).join('<td width="10" style="font-size:1px;">&nbsp;</td>');
  return `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:8px 0;"><tr>${tds}</tr></table>`;
}

/** Compact data table. */
function dataTable(rows, fields, columnsMeta, series, cap) {
  const shown = rows.slice(0, cap);
  const cols = Object.keys(shown[0] || {});
  const profile = RC.profileColumns(rows, fields);
  const kind = Object.fromEntries(profile.map((c) => [c.key, c]));
  const th = cols.map((c) =>
    `<th align="${kind[c] && kind[c].kind === 'number' ? 'right' : 'left'}" ` +
    `style="${FONT}font-size:11px;color:#6b7280;padding:5px 8px;border-bottom:1px solid #e5e7eb;font-weight:600;">${esc(RC.humanize(c))}</th>`
  ).join('');
  const trs = shown.map((r) =>
    `<tr>` + cols.map((c) => {
      const p = kind[c] || {};
      const isNum = p.kind === 'number';
      const val = isNum
        ? RC.formatValue(r[c], fmtFor(c, series, columnsMeta), p.allInteger)
        : (r[c] === null || r[c] === '' ? '—' : RC.shortDate(r[c]));
      return `<td align="${isNum ? 'right' : 'left'}" style="${FONT}font-size:12px;color:#111827;padding:4px 8px;border-bottom:1px solid #f3f4f6;">${esc(val)}</td>`;
    }).join('') + `</tr>`
  ).join('');
  const more = rows.length > cap
    ? `<div style="${FONT}font-size:11px;color:#6b7280;padding-top:5px;">…and ${rows.length - cap} more rows.</div>`
    : '';
  return `<table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>${th}</tr>${trs}</table>${more}`;
}

/** Plain aligned <pre> table for format='text'. */
function preTable(rows, fields, cap) {
  const shown = rows.slice(0, cap);
  if (!shown.length) return '<pre>no rows</pre>';
  const cols = Object.keys(shown[0]);
  const cells = shown.map((r) => cols.map((c) =>
    r[c] === null || r[c] === '' ? '-' : RC.shortDate(String(r[c]))));
  const widths = cols.map((c, i) =>
    Math.max(c.length, ...cells.map((row) => row[i].length)));
  const line = (arr) => arr.map((v, i) => String(v).padEnd(widths[i] + 2)).join('');
  const txt = [line(cols), line(widths.map((w) => '-'.repeat(w)))]
    .concat(cells.map(line)).join('\n');
  const more = rows.length > cap ? `\n…and ${rows.length - cap} more rows.` : '';
  return `<pre style="font-family:Menlo,Consolas,monospace;font-size:12px;color:#111827;">${esc(txt + more)}</pre>`;
}

/**
 * Assemble the full email body for a report run.
 * Pure: (report, runResult, format) → html string. Kept separate from the
 * send loop so it can be tested headlessly against real run results.
 */
function buildReportEmailHtml(report, result, format) {
  const rows = result.rows || [];
  const fields = result.fields || [];
  const sections = [];

  // Header
  sections.push(
    `<div style="${FONT}font-size:19px;font-weight:700;color:#111827;">${esc(report.title)}</div>`
  );
  if (report.description) {
    sections.push(`<div style="${FONT}font-size:12.5px;color:#6b7280;line-height:1.5;padding-top:4px;">${esc(report.description)}</div>`);
  }
  if (result.boundValues && result.boundValues.length) {
    const labels = (report.params || []).map((p, i) => {
      const v = String(result.boundValues[i] ?? '').replace(/ 00:00:00$| 23:59:59$/, '');
      return `${p.label || p.name}: ${v}`;
    });
    sections.push(`<div style="${FONT}font-size:11.5px;color:#9ca3af;padding-top:5px;">${esc(labels.join('   ·   '))}</div>`);
  }
  sections.push(`<div style="height:12px;font-size:1px;">&nbsp;</div>`);

  if (!rows.length) {
    sections.push(`<div style="${FONT}font-size:13px;color:#6b7280;">No rows matched.</div>`);
  } else if (format === 'text') {
    sections.push(preTable(rows, fields, 100));
  } else {
    const profile = RC.profileColumns(rows, fields);
    const viz = RC.normalizeViz(report.viz, rows, profile) || RC.inferViz(rows, profile);
    const kind = Object.fromEntries(profile.map((c) => [c.key, c]));

    if (format === 'chart' && viz) {
      if (viz.type === 'stat') {
        const row0 = rows[0];
        const cards = viz.series.map((s) => {
          const p = kind[s.key] || {};
          return {
            label: s.label || RC.humanize(s.key),
            display: RC.formatValue(row0[s.key], fmtFor(s.key, viz.series, report.columns_meta), p.allInteger),
          };
        });
        sections.push(statCards(cards));
      } else if (viz.type !== 'table') {
        const chartRows = rows.slice(0, 30);
        const anyNegative = (viz.series || []).some((s) =>
          chartRows.some((r) => (RC.num(r[s.key]) || 0) < 0));
        if (anyNegative) {
          sections.push(`<div style="${FONT}font-size:11.5px;color:#6b7280;padding-bottom:4px;">Values include negatives, so no bar chart is drawn — see the table below.</div>`);
        } else {
          const isPie = viz.type === 'pie' || viz.type === 'doughnut';
          const series = isPie ? viz.series.slice(0, 1) : viz.series.slice(0, 2);
          const single = series.length === 1;
          const barsHtml = series.map((s, i) => {
            const p = kind[s.key] || {};
            return seriesBars({
              title: single && !isPie ? null : (s.label || RC.humanize(s.key)),
              rows: chartRows,
              xKey: viz.x,
              yKey: s.key,
              fmt: fmtFor(s.key, viz.series, report.columns_meta),
              perCategoryColor: single && !/^(month|week|day|date|year)/i.test(viz.x),
              seriesColor: RC.PALETTE[i % RC.PALETTE.length],
              showShare: isPie,
              allInteger: p.allInteger,
            });
          }).join('');
          sections.push(`<table cellpadding="0" cellspacing="0" border="0" width="100%">${barsHtml}</table>`);
          if (rows.length > 30) {
            sections.push(`<div style="${FONT}font-size:11px;color:#6b7280;padding-top:4px;">Chart shows the first 30 rows.</div>`);
          }
        }
        sections.push(`<div style="height:14px;font-size:1px;">&nbsp;</div>`);
      }
    }

    // Data table rides along for chart + table formats (audit trail).
    if (!(format === 'chart' && viz && viz.type === 'stat')) {
      sections.push(dataTable(rows, fields, report.columns_meta, viz && viz.series, 50));
    }
  }

  if (result.truncated) {
    sections.push(`<div style="${FONT}font-size:11px;color:#6b7280;padding-top:5px;">Result was truncated at ${rows.length} rows.</div>`);
  }

  // Caveats — the trust layer travels with the number.
  const caveats = report.caveats || [];
  if (caveats.length) {
    sections.push(
      `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:14px;"><tr>` +
      `<td width="3" bgcolor="#d97706" style="font-size:1px;">&nbsp;</td>` +
      `<td style="background:#fffbeb;padding:9px 12px;">` +
      `<div style="${FONT}font-size:11px;font-weight:700;color:#92400e;padding-bottom:3px;">WHAT THIS DOES AND DOESN'T COVER</div>` +
      caveats.map((c) => `<div style="${FONT}font-size:11.5px;color:#78350f;line-height:1.5;padding:1px 0;">&bull; ${esc(c)}</div>`).join('') +
      `</td></tr></table>`
    );
  }

  sections.push(
    `<div style="${FONT}font-size:10.5px;color:#9ca3af;padding-top:16px;border-top:1px solid #f3f4f6;margin-top:16px;">` +
    `Generated automatically by YisraCase Reports &middot; ${esc(report.report_key)} &middot; ${result.rowCount} row${result.rowCount === 1 ? '' : 's'} &middot; ${result.durationMs} ms</div>`
  );

  return `<table cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="#f5f6f8"><tr><td align="center" style="padding:18px 8px;">` +
    `<table cellpadding="0" cellspacing="0" border="0" width="640" style="max-width:640px;background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;"><tr><td style="padding:22px 24px;">` +
    sections.join('') +
    `</td></tr></table></td></tr></table>`;
}

// ── the function ────────────────────────────────────────────────────────────

fns.report_email = async (
  { report_key, to, format = 'chart', report_params = {}, from = null, subject = null, skip_if_empty = false } = {},
  db
) => {
  const { DateTime } = require('luxon'); // lazy require (file convention)
  const firmTz = process.env.FIRM_TIMEZONE || 'America/Detroit';

  if (!report_key || !String(report_key).trim()) {
    return { success: false, error: 'report_key is required' };
  }
  if (!to || !String(to).trim()) {
    // Deliberately no default recipient list: unlike the fixed court digest,
    // an arbitrary report going to an assumed audience is how the wrong
    // numbers reach the wrong inbox. The job row must name its readers.
    return { success: false, error: 'to is required (comma-separated recipients)' };
  }
  const fmt = ['chart', 'table', 'text'].includes(String(format)) ? String(format) : 'chart';

  // Job editors sometimes deliver nested JSON as a string — accept it.
  let rp = report_params;
  if (typeof rp === 'string') {
    try { rp = rp.trim() ? JSON.parse(rp) : {}; }
    catch { return { success: false, error: 'report_params is not valid JSON' }; }
  }
  if (rp == null || typeof rp !== 'object' || Array.isArray(rp)) rp = {};

  // Resolve the report by its stable key.
  const [defRows] = await db.query(
    'SELECT id, is_active FROM report_definitions WHERE report_key = ? LIMIT 1',
    [String(report_key).trim()]
  );
  if (!defRows.length) {
    return { success: false, error: `No report with report_key "${report_key}"` };
  }
  if (!defRows[0].is_active) {
    return { success: false, error: `Report "${report_key}" is inactive` };
  }

  // Run with every guard, stamped as the Automations pseudo-user (0).
  let result;
  try {
    result = await reportService.runReport(db, defRows[0].id, rp, 0);
  } catch (e) {
    return { success: false, error: `Report failed: ${e.message}${e.detail ? ' — ' + e.detail : ''}` };
  }

  if (skip_if_empty && result.rowCount === 0) {
    console.log(`[REPORT_EMAIL] ${report_key}: 0 rows — skip_if_empty set, nothing sent`);
    return { success: true, output: { report_key, rows: 0, sent: false, to: null, format: fmt } };
  }

  const html = buildReportEmailHtml(result.report, result, fmt);

  // Sender fallback chain — identical to court_activity_summary.
  const fromAddr = from || cfg('email_automations') || 'automations@4lsg.com';
  const subj = subject
    || `${result.report.title} — ${DateTime.now().setZone(firmTz).toFormat('LLL d, yyyy')}`;

  // Per-recipient, each in its own try/catch so one bad address can't sink
  // the rest (mirrors the digest / run_task_digest pattern).
  const recipients = String(to).split(',').map((s) => s.trim()).filter(Boolean);
  let sentCount = 0;
  const failures = [];
  for (const addr of recipients) {
    try {
      await emailService.sendEmail(db, { from: fromAddr, to: addr, subject: subj, html });
      sentCount++;
    } catch (e) {
      console.error(`[REPORT_EMAIL] send failed for ${addr}: ${e.message}`);
      failures.push(`${addr}: ${e.message}`);
    }
  }

  console.log(
    `[REPORT_EMAIL] ${report_key} format=${fmt} rows=${result.rowCount} ` +
    `sent=${sentCount}/${recipients.length}`
  );

  if (sentCount === 0) {
    return { success: false, error: `All sends failed — ${failures.join('; ')}` };
  }
  return {
    success: true,
    output: {
      report_key,
      rows: result.rowCount,
      sent: true,
      sentCount,
      failed: failures.length ? failures : undefined,
      to: recipients.join(', '),
      format: fmt,
      subject: subj,
    },
  };
};
fns.report_email.__meta = {
  category: 'system',
  description:
    'Run a saved report (by report_key) and email it. format: chart = email-safe bar ' +
    'chart / stat cards + data table; table = data table only; text = plain aligned ' +
    'columns. All report guards apply (allowlist, denylist, query-plan gate) and the run ' +
    'is logged to report_runs as user 0 (Automations). Caveats travel with the number.',
  params: [
    { name: 'report_key', type: 'string', required: true, placeholderAllowed: true,
      description: 'The report_definitions.report_key of a saved, active report (e.g. cases_by_stage).' },
    { name: 'to', type: 'string', required: true, placeholderAllowed: true,
      description: 'Comma-separated recipients. Required — no default audience. One send per address.' },
    { name: 'format', type: 'enum', enum: ['chart', 'table', 'text'], required: false, default: 'chart',
      description: "'chart' (bars/stat cards + table), 'table', or 'text' (plain aligned columns)." },
    { name: 'report_params', type: 'object', required: false,
      description: 'Values for the report\'s declared parameters, e.g. {"start":"-30d","end":"today"}. Omitted params use the report\'s defaults; relative date tokens resolve at send time, so "-30d" always means the last 30 days.' },
    { name: 'from', type: 'string', required: false,
      description: 'Sender override (must exist in email_credentials). Default: setting email_automations → automations@4lsg.com.' },
    { name: 'subject', type: 'string', required: false,
      description: 'Subject override. Default: "<report title> — <date>".' },
    { name: 'skip_if_empty', type: 'boolean', required: false, default: false,
      description: 'If true and the report returns 0 rows, send nothing (returns sent:false).' },
  ],
  example: { report_key: 'appointment_no_show_trend', to: 'stuart@4lsg.com', format: 'chart', report_params: { start: '-30d' } },
};

module.exports = fns;