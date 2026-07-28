/* public/js/reportCharts.js
 *
 * Chart layer for the reports engine (Slice 4).
 *
 * ── WHY THIS IS A SEPARATE FILE ─────────────────────────────────────────────
 * buildChartConfig() is a PURE function: (viz, rows, profile, theme) → a
 * Chart.js config object. No DOM, no globals, no Chart.js import. That means
 * the whole chart-selection and data-shaping story is unit-testable in Node
 * without a browser, which is the only way to have any confidence in it — the
 * failure modes here (wrong axis, string-sorted categories, silently empty
 * series) all render as a *plausible-looking wrong chart* rather than an error.
 *
 * ── THE STRING-NUMBER TRAP ──────────────────────────────────────────────────
 * mysql2 returns BIGINT (COUNT) and DECIMAL (ROUND/AVG) as JS STRINGS, to avoid
 * precision loss. So a stage-count query hands back {stage:"Open", n:"707"} —
 * and Chart.js will happily plot strings, sorting "707" before "9" and scaling
 * the axis nonsensically. EVERY numeric value must go through num() before it
 * reaches a dataset. This is the single most likely source of a wrong-looking
 * chart, and it does not throw.
 *
 * We classify columns from the MySQL field type codes the API returns
 * (fields[].type), falling back to value sniffing when metadata is absent.
 * Type codes beat sniffing: a column of all-integer-looking strings that is
 * really a VARCHAR (a case number, a zip) must stay categorical.
 */

(function (global) {
  "use strict";

  // ── MySQL field type codes (mysql2 columnType) ────────────────────────────
  // Numeric: TINY 1, SHORT 2, LONG 3, FLOAT 4, DOUBLE 5, INT24 9,
  //          LONGLONG 8, NEWDECIMAL 246, DECIMAL 0, YEAR 13, BIT 16
  // Temporal: DATE 10, DATETIME 12, TIMESTAMP 7, NEWDATE 14, TIME 11
  const NUMERIC_TYPES = new Set([0, 1, 2, 3, 4, 5, 8, 9, 13, 16, 246]);
  const TEMPORAL_TYPES = new Set([7, 10, 11, 12, 14]);

  // Tailwind 500-weight hues: chosen because they stay legible on both a white
  // and a dark panel, which a single palette otherwise struggles to do.
  const PALETTE = [
    "#3b82f6", "#f59e0b", "#10b981", "#f43f5e", "#8b5cf6",
    "#06b6d4", "#84cc16", "#f97316", "#ec4899", "#14b8a6",
  ];

  // Category labels with an obvious meaning get a matching colour, so a chart
  // of appointment outcomes reads correctly at a glance instead of assigning
  // "No Show" a cheerful green. Matched case-insensitively on the whole label.
  const SEMANTIC_COLORS = {
    // good
    attended: "#10b981", completed: "#10b981", complete: "#10b981",
    sent: "#10b981", active: "#10b981", signed: "#10b981", closed: "#10b981",
    // bad
    "no show": "#ef4444", failed: "#ef4444", overdue: "#ef4444",
    declined: "#ef4444", error: "#ef4444", bounced: "#ef4444",
    // neutral-negative
    canceled: "#94a3b8", cancelled: "#94a3b8", deleted: "#94a3b8",
    skipped: "#94a3b8", expired: "#94a3b8", "(blank)": "#94a3b8",
    // in-flight
    scheduled: "#3b82f6", pending: "#f59e0b", rescheduled: "#f59e0b",
    draft: "#94a3b8", open: "#3b82f6", filed: "#8b5cf6", sending: "#06b6d4",
  };

  const CHART_TYPES = new Set([
    "bar", "line", "area", "pie", "doughnut", "combo", "stat", "table",
  ]);
  const VALUE_FORMATS = new Set([
    "number", "percent", "currency", "days", "text", "date",
  ]);

  // ── coercion ──────────────────────────────────────────────────────────────

  /** Coerce a mysql2 value to a finite number, or null. THE critical helper. */
  function num(v) {
    if (v === null || v === undefined || v === "") return null;
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  /** Human label for a raw column key: appt_status → "Appt status". */
  function humanize(key) {
    return String(key)
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .replace(/\bPct\b/i, "%")
      .trim();
  }

  /** Trim mysql2's ISO datetimes down to something a chart axis can show. */
  function shortDate(v) {
    const s = String(v);
    const m = s.match(/^(\d{4}-\d{2}-\d{2})T/);
    return m ? m[1] : s;
  }

  // ── column profiling ──────────────────────────────────────────────────────

  /**
   * Classify each column as number / date / text.
   *
   * @param {Array<object>} rows
   * @param {Array<{name:string,type:number}>|null} fields
   * @returns {Array<{key,kind,label,allInteger,hasNegative,distinct}>}
   */
  function profileColumns(rows, fields) {
    if (!rows || !rows.length) return [];
    const keys = Object.keys(rows[0]);
    const typeByName = {};
    if (Array.isArray(fields)) {
      for (const f of fields) if (f && f.name != null) typeByName[f.name] = f.type;
    }

    return keys.map((key) => {
      const code = typeByName[key];
      let kind;

      if (code !== undefined && NUMERIC_TYPES.has(code)) kind = "number";
      else if (code !== undefined && TEMPORAL_TYPES.has(code)) kind = "date";
      else if (code !== undefined) kind = "text";
      else {
        // No metadata — sniff. Require EVERY non-null value to be numeric, so a
        // mostly-numeric text column doesn't get promoted to an axis.
        const vals = rows.map((r) => r[key]).filter((v) => v !== null && v !== "");
        const allNum = vals.length > 0 && vals.every((v) => num(v) !== null);
        const looksDate = vals.length > 0 && vals.every((v) =>
          typeof v === "string" && /^\d{4}-\d{2}(-\d{2})?/.test(v));
        kind = looksDate ? "date" : allNum ? "number" : "text";
      }

      const nums = kind === "number"
        ? rows.map((r) => num(r[key])).filter((n) => n !== null)
        : [];

      return {
        key,
        kind,
        label: humanize(key),
        allInteger: nums.length > 0 && nums.every((n) => Number.isInteger(n)),
        hasNegative: nums.some((n) => n < 0),
        distinct: new Set(rows.map((r) => String(r[key]))).size,
      };
    });
  }

  // ── viz inference & normalisation ─────────────────────────────────────────

  /**
   * Pick a sensible chart when a report has no saved `viz`. Every report gets
   * a chart this way, including ones authored before charts existed.
   */
  function inferViz(rows, profile) {
    if (!rows || !rows.length || !profile.length) return null;

    const nums = profile.filter((c) => c.kind === "number");
    const cats = profile.filter((c) => c.kind !== "number");

    // Single row of numbers — a bar chart of one bar is silly; show the figures.
    if (rows.length === 1 && nums.length >= 1) {
      return { type: "stat", series: nums.map((c) => ({ key: c.key, label: c.label })) };
    }
    if (!nums.length || !cats.length) return null;

    const x = cats[0];
    // A date-ish or YYYY-MM axis is a time series — lines read better than bars.
    const temporal = x.kind === "date" || /^(month|week|day|date|period|yr|year)$/i.test(x.key);
    const type = temporal ? "line" : "bar";

    // More than ~25 categories is unreadable as bars; cap it.
    const limit = temporal ? null : 25;

    return {
      type,
      x: x.key,
      series: nums.slice(0, 4).map((c) => ({ key: c.key, label: c.label })),
      limit,
    };
  }

  /**
   * Normalise a stored viz into the v2 shape, accepting the v1
   * {type, x, y} form that Slice 1 seeds and early AI drafts used.
   * Returns null when the spec can't be made sense of, which sends the caller
   * to inferViz — a bad chart hint must never cost you the report.
   */
  function normalizeViz(viz, rows, profile) {
    if (!viz || typeof viz !== "object") return null;

    const type = String(viz.type || "").toLowerCase();
    if (!CHART_TYPES.has(type)) return null;
    if (type === "table") return { type: "table" };

    const keys = new Set(profile.map((c) => c.key));

    let series = [];
    if (Array.isArray(viz.series) && viz.series.length) {
      series = viz.series
        .filter((s) => s && keys.has(s.key))
        .map((s) => ({
          key: s.key,
          label: s.label || humanize(s.key),
          type: ["bar", "line", "area"].includes(String(s.type).toLowerCase())
            ? String(s.type).toLowerCase() : null,
          axis: s.axis === "y1" ? "y1" : "y",
          format: VALUE_FORMATS.has(s.format) ? s.format : null,
        }));
    } else if (viz.y && keys.has(viz.y)) {
      series = [{ key: viz.y, label: humanize(viz.y), type: null, axis: "y", format: null }];
    }

    if (type === "stat") {
      if (!series.length) {
        series = profile.filter((c) => c.kind === "number")
          .map((c) => ({ key: c.key, label: c.label, format: null }));
      }
      return series.length ? { type: "stat", series } : null;
    }

    const x = viz.x && keys.has(viz.x)
      ? viz.x
      : (profile.find((c) => c.kind !== "number") || {}).key;

    if (!x || !series.length) return null;

    return {
      type,
      x,
      series,
      stacked: !!viz.stacked,
      horizontal: !!viz.horizontal,
      yLabel: viz.yLabel || null,
      y1Label: viz.y1Label || null,
      limit: Number.isFinite(Number(viz.limit)) ? Number(viz.limit) : null,
    };
  }

  // ── formatting ────────────────────────────────────────────────────────────

  function formatValue(v, format, allInteger) {
    const n = num(v);
    if (n === null) return v == null || v === "" ? "—" : String(v);
    switch (format) {
      case "percent": return `${round(n, 1)}%`;
      case "currency": return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      case "days": return `${round(n, 1)} ${Math.abs(n) === 1 ? "day" : "days"}`;
      default:
        return allInteger
          ? n.toLocaleString()
          : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
    }
  }

  function round(n, dp) {
    const f = Math.pow(10, dp);
    return Math.round(n * f) / f;
  }

  /** Infer a display format from the column name when none was declared. */
  function guessFormat(key) {
    if (/(_pct|_percent|percentage|rate)$/i.test(key) || /^pct_/i.test(key)) return "percent";
    if (/(_days|days_)/i.test(key)) return "days";
    if (/(amount|revenue|fee|cost|price|total_paid)/i.test(key)) return "currency";
    return "number";
  }

  // ── colour ────────────────────────────────────────────────────────────────

  function colorForLabel(label, index) {
    const key = String(label).trim().toLowerCase();
    return SEMANTIC_COLORS[key] || PALETTE[index % PALETTE.length];
  }

  function withAlpha(hex, alpha) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!m) return hex;
    return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${alpha})`;
  }

  // ── the pure config builder ───────────────────────────────────────────────

  /**
   * Build a Chart.js config from a normalised viz + rows.
   *
   * @param {object} viz      normalised (see normalizeViz)
   * @param {Array}  rows
   * @param {Array}  profile  from profileColumns
   * @param {object} theme    { text, grid, dark }
   * @returns {{kind:'chart', config:object} | {kind:'stat', cards:Array} |
   *           {kind:'none', reason:string}}
   */
  function buildChartConfig(viz, rows, profile, theme) {
    theme = theme || { text: "#6b7280", grid: "#e5e7eb", dark: false };
    if (!viz) return { kind: "none", reason: "no chart for this shape" };
    if (viz.type === "table") return { kind: "none", reason: "table only" };
    if (!rows || !rows.length) return { kind: "none", reason: "no rows" };

    const byKey = {};
    for (const c of profile) byKey[c.key] = c;

    // ── stat cards ──────────────────────────────────────────────────────────
    if (viz.type === "stat") {
      const row = rows[0];
      const cards = viz.series.map((s) => {
        const col = byKey[s.key] || {};
        const fmt = s.format || guessFormat(s.key);
        return {
          key: s.key,
          label: s.label || humanize(s.key),
          raw: num(row[s.key]),
          display: formatValue(row[s.key], fmt, col.allInteger),
        };
      });
      return { kind: "stat", cards };
    }

    // ── category axis ───────────────────────────────────────────────────────
    const xCol = byKey[viz.x] || { kind: "text" };
    let working = rows.slice();

    // Pie/doughnut: one slice per row, and too many slices is unreadable.
    const isPie = viz.type === "pie" || viz.type === "doughnut";
    const metric = viz.series[0];

    if (isPie) {
      const vals = working.map((r) => num(r[metric.key]));
      if (vals.some((v) => v !== null && v < 0)) {
        // A pie cannot represent negative magnitudes. Silently drawing one
        // would be a lie, so fall back to bars.
        viz = Object.assign({}, viz, { type: "bar" });
      }
    }

    const cap = viz.limit || (isPie ? 12 : null);
    if (cap && working.length > cap) {
      // Sort by the metric so the cap keeps the biggest, then bucket the rest.
      const sorted = working.slice().sort((a, b) =>
        (num(b[metric.key]) || 0) - (num(a[metric.key]) || 0));
      const head = sorted.slice(0, cap - 1);
      const tail = sorted.slice(cap - 1);
      const otherRow = { [viz.x]: `Other (${tail.length})` };
      for (const s of viz.series) {
        otherRow[s.key] = tail.reduce((acc, r) => acc + (num(r[s.key]) || 0), 0);
      }
      working = head.concat([otherRow]);
    }

    const labels = working.map((r) => {
      const v = r[viz.x];
      return xCol.kind === "date" ? shortDate(v) : (v === null || v === "" ? "(blank)" : String(v));
    });

    // ── pie / doughnut ──────────────────────────────────────────────────────
    if (viz.type === "pie" || viz.type === "doughnut") {
      const data = working.map((r) => num(r[metric.key]) || 0);
      const colors = labels.map((l, i) => colorForLabel(l, i));
      const fmt = metric.format || guessFormat(metric.key);
      const total = data.reduce((a, b) => a + b, 0);

      return {
        kind: "chart",
        config: {
          type: viz.type,
          data: {
            labels,
            datasets: [{
              data,
              backgroundColor: colors,
              borderColor: theme.dark ? "#151a23" : "#ffffff",
              borderWidth: 2,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { position: "right", labels: { color: theme.text, boxWidth: 12, padding: 10 } },
              tooltip: {
                callbacks: {
                  label(ctx) {
                    const v = ctx.parsed;
                    const pct = total ? ` (${round((v / total) * 100, 1)}%)` : "";
                    return `${ctx.label}: ${formatValue(v, fmt, byKey[metric.key] && byKey[metric.key].allInteger)}${pct}`;
                  },
                },
              },
            },
          },
        },
      };
    }

    // ── bar / line / area / combo ───────────────────────────────────────────
    const usesRightAxis = viz.series.some((s) => s.axis === "y1");

    const datasets = viz.series.map((s, i) => {
      const col = byKey[s.key] || {};
      const fmt = s.format || guessFormat(s.key);
      // In combo mode each series carries its own type; otherwise the chart's.
      const seriesType = viz.type === "combo" ? (s.type || (i === 0 ? "bar" : "line")) : viz.type;
      const isArea = seriesType === "area";
      const drawn = isArea ? "line" : seriesType;
      const color = PALETTE[i % PALETTE.length];

      const ds = {
        type: drawn,
        label: s.label || humanize(s.key),
        data: working.map((r) => num(r[s.key])),
        borderColor: color,
        backgroundColor: drawn === "line" ? withAlpha(color, isArea ? 0.18 : 0.9) : withAlpha(color, 0.85),
        borderWidth: drawn === "line" ? 2 : 0,
        borderRadius: drawn === "bar" ? 4 : 0,
        yAxisID: s.axis === "y1" ? "y1" : "y",
        _format: fmt,
        _allInteger: col.allInteger,
      };
      if (drawn === "line") {
        ds.fill = isArea;
        ds.tension = 0.3;
        ds.pointRadius = working.length > 30 ? 0 : 3;
        ds.pointHoverRadius = 5;
      }
      // A single-series bar chart looks better with per-category colours; with
      // several series, colour must distinguish the SERIES instead.
      if (drawn === "bar" && viz.series.length === 1) {
        ds.backgroundColor = labels.map((l, j) => withAlpha(colorForLabel(l, j), 0.85));
        ds.borderColor = labels.map((l, j) => colorForLabel(l, j));
      }
      return ds;
    });

    const scales = {
      x: {
        stacked: !!viz.stacked,
        ticks: { color: theme.text, maxRotation: 45, minRotation: 0, autoSkip: true },
        grid: { display: false },
        title: viz.xLabel ? { display: true, text: viz.xLabel, color: theme.text } : undefined,
      },
      y: {
        stacked: !!viz.stacked,
        beginAtZero: true,
        position: "left",
        ticks: {
          color: theme.text,
          callback(v) { return formatValue(v, datasets[0] && datasets[0]._format, true); },
        },
        grid: { color: theme.grid, drawBorder: false },
        title: viz.yLabel ? { display: true, text: viz.yLabel, color: theme.text } : undefined,
      },
    };
    if (usesRightAxis) {
      const rightDs = datasets.find((d) => d.yAxisID === "y1");
      scales.y1 = {
        beginAtZero: true,
        position: "right",
        ticks: {
          color: theme.text,
          callback(v) { return formatValue(v, rightDs && rightDs._format, true); },
        },
        grid: { drawOnChartArea: false },
        title: viz.y1Label ? { display: true, text: viz.y1Label, color: theme.text } : undefined,
      };
    }

    return {
      kind: "chart",
      config: {
        type: viz.type === "combo" ? "bar" : (viz.type === "area" ? "line" : viz.type),
        data: { labels, datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          indexAxis: viz.horizontal ? "y" : "x",
          interaction: { mode: "index", intersect: false },
          plugins: {
            legend: {
              display: datasets.length > 1,
              position: "top",
              labels: { color: theme.text, boxWidth: 12, padding: 12, usePointStyle: true },
            },
            tooltip: {
              callbacks: {
                label(ctx) {
                  const ds = ctx.dataset;
                  return `${ds.label}: ${formatValue(ctx.parsed[viz.horizontal ? "x" : "y"], ds._format, ds._allInteger)}`;
                },
              },
            },
          },
          scales,
        },
      },
    };
  }

  /** Read theme colours off the live stylesheet so charts match the app. */
  function currentTheme() {
    try {
      const cs = getComputedStyle(document.body);
      return {
        text: cs.getPropertyValue("--muted").trim() || "#6b7280",
        grid: cs.getPropertyValue("--line").trim() || "#e5e7eb",
        dark: document.body.classList.contains("dark"),
      };
    } catch (_) {
      return { text: "#6b7280", grid: "#e5e7eb", dark: false };
    }
  }

  global.ReportCharts = {
    num, humanize, shortDate, round,
    profileColumns, inferViz, normalizeViz,
    buildChartConfig, formatValue, guessFormat,
    colorForLabel, currentTheme,
    PALETTE, CHART_TYPES, VALUE_FORMATS,
  };
})(typeof window !== "undefined" ? window : globalThis);

/* Node/CommonJS export so the pure logic can be unit-tested headlessly. */
if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).ReportCharts;
}