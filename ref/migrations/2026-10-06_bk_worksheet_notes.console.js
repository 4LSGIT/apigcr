/*
 * ref/migrations/2026-10-06_bk_worksheet_notes.console.js
 *
 * BK Worksheet: case notes + alerts. Paste into the DevTools console of a
 * logged-in app.4lsg.com tab (the SHELL, where `apiSend` is defined) as an SU —
 * the view is locked and has no owner, so only an administrator can edit it.
 *
 * DEPLOY ORDER: ship the customView.html row-expand change FIRST. On the old
 * renderer a 260px Notes column auto-wraps every note longer than 60 chars and
 * the rows go tall — the exact thing this pair exists to avoid.
 *
 * 1. VIEW  report_definitions #13 (bk_worksheet), via PUT /api/reports/13 —
 *    the report validator runs and the outgoing state is snapshotted as a
 *    version (restorable from the Reports editor's history).
 *      · new `notes` column after Lead Source: the case alert, prefixed ⚠,
 *        then the case notes, newline-joined. Alerts get no column of their
 *        own — 1 row in the whole DB carries one (2026-10-06), so a column
 *        would be blank on every real row; folded in, an alert can never be
 *        missed. Edge whitespace is stripped with REGEXP_REPLACE, not TRIM:
 *        TRIM() strips spaces only, and the one live alert ends in '\n'.
 *        CHAR(10 USING utf8mb4), NOT bare CHAR(10): a binary separator makes
 *        CONCAT_WS return VARBINARY, which mysql2 hands back as a Buffer
 *        (verified live — the cell would render as an object).
 *      · caveat "Birth Date is intentionally omitted …" is replaced: it has
 *        been false since the 2026-09-24 ruling took contact_dob off the
 *        report denylist.
 *
 * 2. FORM  form_templates #9 (bk_worksheet), via PUT + publish — a "Notes &
 *    Alerts" section at the bottom of the Case tab: case_notes (10,000-char
 *    cap = lib/noteLimits NOTE_MAX_CHARS, so the browser stops a note the
 *    server would 400) and case_alerts (5,000, as casedetails.html). Both
 *    write through the form's existing onSubmit.patch → PATCH /api/cases/:id,
 *    which sends only changed fields, so opening the modal never rewrites a
 *    note edited elsewhere. Publishing bumps schema_version (new fields).
 *
 * Every write is preceded by assertions on the base it expects and followed
 * by a read-back check (CLAUDE.md: a printed diff is not a check). Re-running
 * after success aborts at the "already applied" assertion and changes nothing.
 */
(async () => {
  const assert = (c, m) => { if (!c) throw new Error('ABORT: ' + m); };
  // MySQL JSON reorders object keys on storage — compare key-sorted.
  const canon = (x) => JSON.stringify(x, (k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.keys(v).sort().reduce((o, key) => (o[key] = v[key], o), {}) : v);

  // ── 1. VIEW ────────────────────────────────────────────────────────────
  const { report: v } = await apiSend('/api/reports/13', 'GET');
  assert(v.report_key === 'bk_worksheet', 'report 13 is not bk_worksheet');
  const keys = v.columns_meta.map((c) => c.key);
  assert(!keys.includes('notes') && !/ AS notes\b/.test(v.sql_text), 'notes already present — already applied?');
  assert(keys.length === 42, `expected 42 columns, found ${keys.length}`);
  const leadIx = keys.indexOf('lead_source');
  assert(leadIx === 9, `lead_source expected at index 9, found ${leadIx}`);
  const ANCHOR = '       c.case_source AS lead_source,\n';
  assert(v.sql_text.split(ANCHOR).length === 2, 'SQL anchor (c.case_source AS lead_source) not found exactly once');
  assert((v.params || []).length === 5, `expected 5 params, found ${(v.params || []).length}`);
  const DOB = 'Birth Date is intentionally omitted';
  const dobIx = (v.caveats || []).findIndex((c) => c.startsWith(DOB));
  assert(dobIx !== -1, 'DOB caveat not found');

  const NOTES_SQL =
    '       CONCAT_WS(CHAR(10 USING utf8mb4),\n' +
    "         CONCAT('⚠ ', NULLIF(REGEXP_REPLACE(c.case_alerts, '^[[:space:]]+|[[:space:]]+$', ''), '')),\n" +
    "         NULLIF(REGEXP_REPLACE(c.case_notes, '^[[:space:]]+|[[:space:]]+$', ''), '')) AS notes,\n";
  // split/join, NOT String.replace: the regex literal ends in `$'`, which a
  // replace() replacement string expands to "everything after the match" —
  // it silently duplicated the whole WHERE clause in the dry run.
  const [head, tail] = v.sql_text.split(ANCHOR);
  const sql_text = head + ANCHOR + NOTES_SQL + tail;
  assert(sql_text.length === v.sql_text.length + NOTES_SQL.length, 'SQL splice length mismatch');
  const columns_meta = v.columns_meta.slice();
  columns_meta.splice(leadIx + 1, 0, { key: 'notes', label: 'Notes', width: 260 });
  const caveats = v.caveats.slice();
  caveats[dobIx] = 'Notes shows the case alert first, marked ⚠, when one is set. ' +
    'Click a row to show its long cells in full; "Expand rows" under the table opens every row.';

  const { report: v2 } = await apiSend('/api/reports/13', 'PUT', { sql_text, columns_meta, caveats });
  assert(v2.sql_text === sql_text, 'view: saved SQL differs from what was sent');
  assert(v2.columns_meta.map((c) => c.key)[leadIx + 1] === 'notes', 'view: notes column not saved after lead_source');
  assert(v2.columns_meta.length === 43, `view: expected 43 columns after save, found ${v2.columns_meta.length}`);
  // Run it: every row must carry `notes` as a STRING (a Buffer here = the CHAR(10) trap).
  const run = await apiSend('/api/reports/13/run', 'POST', { params: { filed_from: '2000-01-01' } });
  assert(run.rows.length > 0, 'view: run returned no rows');
  const bad = run.rows.filter((r) => typeof r.notes !== 'string');
  assert(bad.length === 0, `view: ${bad.length} row(s) with non-string notes`);
  console.log(`✔ view: notes column live — ${run.rows.filter((r) => r.notes).length}/${run.rows.length} rows carry notes or an alert`);

  // ── 2. FORM ────────────────────────────────────────────────────────────
  const { template: t } = await apiSend('/api/form-templates/9', 'GET');
  assert(t.form_key === 'bk_worksheet', 'template 9 is not bk_worksheet');
  assert(canon(t.draft_definition) === canon(t.definition),
    'form: the draft has unpublished edits — publish or discard them in the Form Builder first');
  const d = JSON.parse(JSON.stringify(t.draft_definition));
  assert(!/"name":"case_(notes|alerts)"/.test(JSON.stringify(d)), 'form: case_notes/case_alerts already present — already applied?');
  assert(Array.isArray(d.tabs) && d.tabs.length === 6 && d.tabs[0].label === 'Case', 'form: expected 6 tabs, first "Case"');
  assert(d.tabs[0].sections.length === 1 && d.tabs[0].sections[0].title === 'Case', 'form: Case tab expected to hold exactly one section, "Case"');
  assert(d.onSubmit && d.onSubmit.patch && d.onSubmit.patch.url === '/api/cases/{linkId}', 'form: onSubmit.patch is not the case PATCH');

  d.tabs[0].sections.push({
    title: 'Notes & Alerts',
    rows: [
      { fields: [{ name: 'case_notes', type: 'textarea', label: 'Case Notes', rows: 6,
                   maxLength: 10000, apiColumn: 'case_notes' }] },
      { fields: [{ name: 'case_alerts', type: 'textarea', label: 'Alerts', rows: 2,
                   maxLength: 5000, apiColumn: 'case_alerts',
                   sublabel: 'Shown as a banner at the top of the case, and first in the worksheet’s Notes column.' }] },
    ],
  });

  await apiSend('/api/form-templates/9', 'PUT', { draft_definition: d });
  const pub = await apiSend('/api/form-templates/9/publish', 'POST', {});
  assert(pub.bumped === true && pub.schema_version === t.schema_version + 1,
    `form: expected a schema bump to v${t.schema_version + 1}, got ${JSON.stringify(pub)}`);
  const { template: t2 } = await apiSend('/api/form-templates/9', 'GET');
  assert(canon(t2.definition) === canon(d), 'form: published definition differs from what was sent');
  console.log(`✔ form: Notes & Alerts section published (schema v${pub.schema_version})`);
})().catch((e) => console.error(e));
