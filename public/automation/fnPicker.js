// public/automation/fnPicker.js
//
// ─────────────────────────────────────────────────────────────
// Shared grouped function-picker builder (internal_functions Slice C).
//
// Replaces the mirrored builders that Slice B added to workflows.html
// (WF_FN_CATEGORY_ORDER / wfBuildFnOptions) and sequences.html
// (SEQ_FN_CATEGORY_ORDER / seqBuildFnOptions), and upgrades the four
// remaining flat pickers to the same grouped rendering.
//
// Consumers (all plain <script src> — these are non-module pages):
//   1. workflows.html      — step editor  (applyHidden: true)
//   2. sequences.html      — step editor  (applyHidden: true)
//   3. scheduledJobs.html  — New Job dialog (applyHidden: true, currentFn null)
//   4. hooks.html          — target editor (applyHidden: true)
//   5. emailIngest.html    — action editor (applyHidden: false)
//   6. phoneIngest.html    — action editor (applyHidden: false)
//
// Contract:
//   buildFnOptions(fnList, metaMap, currentFn, opts) → string of <optgroup>s
//
//   fnList    string[]           function names to render
//   metaMap   { name: __meta }   from /workflows/functions `meta`, or the
//                                ingest /meta payload's internal_function_meta.
//                                Pass {} on fetch failure — everything then
//                                lands in 'other', matching the old flat
//                                single-list behavior.
//   currentFn string|null        the function currently saved on the step /
//                                action being edited. null for create-only
//                                dialogs — nothing gets `selected`, so the
//                                browser defaults to the first option of the
//                                first group. Callers that need a specific
//                                default (e.g. first non-hidden function) must
//                                compute it themselves and pass it here.
//   opts      { applyHidden? }   default true.
//     applyHidden: true  — metaMap[name].uiHidden === true is filtered from
//                          the picker UNLESS name === currentFn, in which
//                          case it stays in its category group with a
//                          " (hidden)" label suffix so existing configs stay
//                          viewable/editable. value="${name}" is always set
//                          explicitly so the suffix never leaks into the
//                          saved function_name.
//     applyHidden: false — uiHidden is ignored entirely (no filtering, no
//                          suffix). Used by the ingest surfaces, which
//                          deliberately show everything.
//
// Grouping: <optgroup> per metaMap[name].category; 'other' when meta-less.
// Category order is FN_CATEGORY_ORDER below; unknown categories rank just
// before 'other' (alphabetical among themselves); functions sort
// alphabetically within each group.
// ─────────────────────────────────────────────────────────────

const FN_CATEGORY_ORDER = ['communication','contacts','cases','appointments','events','tasks','log',
  'sequences','calendar','dropbox','ai','general','control','timing',
  'variables','connections','system','dev','other'];

window.buildFnOptions = function buildFnOptions(fnList, metaMap, currentFn, opts) {
  const applyHidden = !opts || opts.applyHidden !== false;
  const meta = metaMap || {};
  const groups = new Map();
  for (const f of fnList) {
    const m = meta[f];
    if (applyHidden && m && m.uiHidden === true && f !== currentFn) continue;
    const cat = (m && m.category) || 'other';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(f);
  }
  const otherIdx = FN_CATEGORY_ORDER.indexOf('other');
  const rank = c => {
    const i = FN_CATEGORY_ORDER.indexOf(c);
    return i === -1 ? otherIdx - 0.5 : i;  // unknown categories append before 'other'
  };
  const cats = [...groups.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return cats.map(cat =>
    `<optgroup label="${cat}">` +
    groups.get(cat).sort().map(f => {
      const hidden = applyHidden && meta[f]?.uiHidden === true;
      return `<option value="${f}" ${currentFn === f ? 'selected' : ''}>${f}${hidden ? ' (hidden)' : ''}</option>`;
    }).join('') +
    `</optgroup>`
  ).join('');
};