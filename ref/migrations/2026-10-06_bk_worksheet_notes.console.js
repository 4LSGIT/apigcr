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
 *      · new `notes` column before Lead Source: the case alert, prefixed ⚠,
 *        then the case notes, newline-joined. Alerts get no column of their
 *        own — 1 row in the whole DB carries one (2026-10-06), so a column
 *        would be blank on every real row; folded in, an alert can never be
 *        missed. Edge whitespace is stripped with REGEXP_REPLACE, not TRIM:
 *        TRIM() strips spaces only, and the one live alert ends in '\n'.
 *        CHAR(10 USING utf8mb4), NOT bare CHAR(10): a binary separator makes
 *        CONCAT_WS return VARBINARY, which mysql2 hands back as a Buffer
 *        (verified live — the cell would render as an object).
 *      · Primary client's `phone` (formatted "(248) 555-0100", copy action)
 *        before Email, and `dob` (Birth Date — the sheet's column) after it,
 *        at the end. DOB came off the report denylist with the 2026-09-24
 *        ruling, so the "Birth Date is intentionally omitted …" caveat is
 *        replaced. contact_phone is char(10): all live values are 10 digits
 *        or blank (2026-10-06); anything else passes through unformatted.
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
  for (const k of ['notes', 'phone', 'dob']) {
    assert(!keys.includes(k) && !new RegExp(` AS ${k}\\b`).test(v.sql_text), `${k} already present — already applied?`);
  }
  assert(keys.length === 42, `expected 42 columns, found ${keys.length}`);
  const leadIx = keys.indexOf('lead_source');
  assert(leadIx === 9, `lead_source expected at index 9, found ${leadIx}`);
  assert(keys.indexOf('email') === 41, `email expected last (index 41), found ${keys.indexOf('email')}`);
  const ANCHOR = '       c.case_source AS lead_source,\n';
  assert(v.sql_text.split(ANCHOR).length === 2, 'SQL anchor (c.case_source AS lead_source) not found exactly once');
  const EMAIL = '       ct.contact_email AS email\n';
  assert(v.sql_text.split(EMAIL).length === 2, 'SQL anchor (ct.contact_email AS email) not found exactly once');
  assert((v.params || []).length === 5, `expected 5 params, found ${(v.params || []).length}`);
  const DOB = 'Birth Date is intentionally omitted';
  const dobIx = (v.caveats || []).findIndex((c) => c.startsWith(DOB));
  assert(dobIx !== -1, 'DOB caveat not found');

  const NOTES_SQL =
    '       CONCAT_WS(CHAR(10 USING utf8mb4),\n' +
    "         CONCAT('⚠ ', NULLIF(REGEXP_REPLACE(c.case_alerts, '^[[:space:]]+|[[:space:]]+$', ''), '')),\n" +
    "         NULLIF(REGEXP_REPLACE(c.case_notes, '^[[:space:]]+|[[:space:]]+$', ''), '')) AS notes,\n";
  const CONTACT_SQL =
    "       IF(ct.contact_phone REGEXP '^[0-9]{10}$',\n" +
    "          CONCAT('(', LEFT(ct.contact_phone, 3), ') ', MID(ct.contact_phone, 4, 3), '-', RIGHT(ct.contact_phone, 4)),\n" +
    "          NULLIF(ct.contact_phone, '')) AS phone,\n" +
    '       ct.contact_email AS email,\n' +
    '       ct.contact_dob AS dob\n';
  // split/join, NOT String.replace: the regex literals end in `$'`, which a
  // replace() replacement string expands to "everything after the match" —
  // it silently duplicated the whole WHERE clause in the first dry run.
  const [lead0, lead1] = v.sql_text.split(ANCHOR);
  const step1 = lead0 + NOTES_SQL + ANCHOR + lead1;
  const [mail0, mail1] = step1.split(EMAIL);
  const sql_text = mail0 + CONTACT_SQL + mail1;
  assert(sql_text.length === v.sql_text.length + NOTES_SQL.length + CONTACT_SQL.length - EMAIL.length,
    'SQL splice length mismatch');
  const columns_meta = v.columns_meta.slice();
  columns_meta.splice(leadIx, 0, { key: 'notes', label: 'Notes', width: 260 });
  columns_meta.splice(columns_meta.length - 1, 0, { key: 'phone', label: 'Phone', action: { type: 'copy' } });
  columns_meta.push({ key: 'dob', label: 'Birth Date', format: 'date' });
  const want = ['case_trustee', 'notes', 'lead_source'];
  assert(canon(columns_meta.slice(leadIx - 1, leadIx + 2).map((c) => c.key)) === canon(want), 'notes not placed before lead_source');
  assert(canon(columns_meta.slice(-3).map((c) => c.key)) === canon(['phone', 'email', 'dob']), 'tail is not phone, email, dob');
  const caveats = v.caveats.slice();
  caveats[dobIx] = 'Notes shows the case alert first, marked ⚠, when one is set. ' +
    'Click a row to show its long cells in full; "Expand rows" under the table opens every row.';

  const { report: v2 } = await apiSend('/api/reports/13', 'PUT', { sql_text, columns_meta, caveats });
  assert(v2.sql_text === sql_text, 'view: saved SQL differs from what was sent');
  assert(canon(v2.columns_meta) === canon(columns_meta), 'view: saved columns_meta differs from what was sent');
  assert(v2.columns_meta.length === 45, `view: expected 45 columns after save, found ${v2.columns_meta.length}`);
  // Run it: notes must be a STRING on every row (a Buffer here = the CHAR(10)
  // trap); phone a string or null; every row carries all three new keys.
  const run = await apiSend('/api/reports/13/run', 'POST', { params: { filed_from: '2000-01-01' } });
  assert(run.rows.length > 0, 'view: run returned no rows');
  const bad = run.rows.filter((r) => typeof r.notes !== 'string' ||
    !(r.phone === null || typeof r.phone === 'string') || !('dob' in r));
  assert(bad.length === 0, `view: ${bad.length} row(s) with a malformed notes/phone/dob`);
  const n = (f) => run.rows.filter(f).length;
  console.log(`✔ view live — notes/alert on ${n((r) => r.notes)}, phone on ${n((r) => r.phone)}, ` +
    `birth date on ${n((r) => r.dob)} of ${run.rows.length} rows`);

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
