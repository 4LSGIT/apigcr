// scripts/customFieldsS5Wf37Repoint.js
//
/**
 * Custom Fields S5-A — repoint wf37 ("Payment Failed — Intake") off
 * `contacts.contact_clio_id` and onto the custom field `cf_clio_id`.
 *
 * ┌───────────────────────────────────────────────────────────────────────┐
 * │  THIS IS A BROWSER-CONSOLE SCRIPT. Paste the whole file into the      │
 * │  console on app.4lsg.com (the top-level shell, where apiSend lives)   │
 * │  and call it. It is checked in so the asserted base is reviewable,    │
 * │  not because node runs it.                                            │
 * │                                                                        │
 * │    await s5Wf37Repoint()            — dry run: assert + print, write  │
 * │                                       nothing                         │
 * │    await s5Wf37Repoint('apply')     — PATCH the draft, assert the     │
 * │                                       result, STOP before publishing  │
 * │    await s5Wf37Repoint('publish')   — the same, then publish          │
 * │                                                                        │
 * │    await s5Wf37Repoint('publish-draft')                                │
 * │        — publish a draft an EARLIER 'apply' already left, re-asserting │
 * │          it first. 'publish' CANNOT do this: it restarts from the base │
 * │          assertion, which refuses to run while a draft is open.        │
 * │          Publishing is not enabling — see publishDraft() below.        │
 * └───────────────────────────────────────────────────────────────────────┘
 *
 * WHY IT IS THIS PARANOID (CLAUDE.md, wf27 v6, 2026-09-22): a console script
 * that mutated workflow steps against a base it had assumed rather than
 * checked shipped a duplicated block, and the runaway loop produced 480 tasks
 * and a pile of emails. So:
 *
 *   - the BASE is asserted before any write: workflow id, version state,
 *     step count, in-flight runs, and the exact current `config` of every
 *     step this script touches, compared as canonical JSON;
 *   - the RESULT is asserted before the publish: the full draft is diffed
 *     against the base with only the expected edits applied. Any step that
 *     changed and should not have — or did not change and should have —
 *     aborts. A printed diff is not a check; these throw;
 *   - PATCH (one step, by number) is used rather than PUT-the-list, so the
 *     script can never append, renumber, or drop a step;
 *   - publishing is a separate, explicit argument.
 *
 * PREREQUISITES — in order. This script is step 5 of 5:
 *   1. scripts/customFieldsS5Seed.js --apply      (defs + virtual columns)
 *   2. ref/migrations/2026-09-25_clio_pilot_backfill.sql   (the values)
 *   3. its four verification queries, all clean
 *   4. backend deployed (write freeze + repointed reads)
 *   5. THIS
 * Run before step 4 and the workflow would write a cf_ key the deployed
 * `update_contact` cannot yet validate.
 *
 * WHAT IT CHANGES — three steps, nothing else:
 *   #8  (id 405) query_db      where[0].column  contacts.contact_clio_id → contacts.cf_clio_id
 *   #28 (id 424) update_contact fields key      contact_clio_id          → cf_clio_id
 *   #3  (id 400) evaluate_condition             NOTE TEXT ONLY — the note
 *       explains the guard in terms of `contact_clio_id = ''`, which stops
 *       being true the moment the values live in the bag (an unbackfilled
 *       row reads NULL from the virtual column, not ''). No config change.
 *
 * WHAT IT DELIBERATELY DOES NOT TOUCH:
 *   #32 (id 428) create_log — its `data.clio_matter` is a LOG PAYLOAD KEY
 *       holding {{clioMatterNo}} parsed from the Clio email. It is not a
 *       reference to `cases.clio_matter` and repointing it would corrupt the
 *       shape of every log row this workflow writes. Asserted UNCHANGED.
 *
 * wf37 IS INACTIVE and has never executed (0 rows in workflow_executions,
 * against a retention window back to 2026-02-26). Its starter,
 * email_ingest_rule_actions #24 on the active rule 21 "clio payment failed",
 * is also disabled. Confirmed intentional (Fred, 2026-09-25: awaiting
 * approval to test). So this repoint is correct-by-construction rather than
 * observed: the success criterion is the asserted draft, and the first real
 * run happens whenever the workflow is turned on.
 */

/* eslint-disable no-console */
'use strict';

(function (root) {

  // ── the asserted BASE: wf37 v1 as it stands 2026-09-25 ──────────────────
  // Canonical JSON (sorted keys) of the CURRENT config of every touched step.
  // If any of these no longer matches, someone edited the workflow and this
  // script must be re-derived rather than forced.
  const BASE = {
    workflow_id: 37,
    name: 'Payment Failed — Intake',
    current_version: 1,
    step_count: 38,
    steps: {
      3: {
        label: 'Have a Clio contact id?',
        type: 'internal_function',
        config: { function_name: 'evaluate_condition',
          params: { else: 8, then: 4, operator: 'is_not_empty', variable: 'clioContactId' } },
      },
      8: {
        label: 'Match tier 1: Clio id',
        type: 'internal_function',
        config: { function_name: 'query_db',
          params: { count_var: 'clioIdCount', format: 'raw', from: 'contacts', limit: 5,
            output_var: 'clioIdMatches',
            select: ['contacts.contact_id', 'contacts.contact_name'],
            where: [{ column: 'contacts.contact_clio_id', op: '=', value: '{{clioContactId}}' }] } },
      },
      28: {
        label: 'Write contacts.contact_clio_id',
        type: 'internal_function',
        config: { function_name: 'update_contact',
          params: { contact_id: '{{contactId}}', fields: { contact_clio_id: '{{clioContactId}}' } } },
      },
      32: {
        label: 'Log to timeline',   // asserted unchanged — see header
        type: 'internal_function',
      },
    },
  };

  // ── the EDITS ───────────────────────────────────────────────────────────
  const EDITS = [
    {
      step: 8,
      why: 'tier-1 match reads the live Clio id',
      label: 'Match tier 1: Clio id',
      note: 'Exact, and free once the Clio id is populated. 245 contacts carried a '
          + 'Clio id at the S5 migration; tiers 2/3 write it back so this tier grows '
          + 'on its own. Reads the cf_clio_id custom field (S5, 2026-09-25) — the '
          + 'contact_clio_id column is frozen and dropped in S5-B.',
      config: { function_name: 'query_db',
        params: { count_var: 'clioIdCount', format: 'raw', from: 'contacts', limit: 5,
          output_var: 'clioIdMatches',
          select: ['contacts.contact_id', 'contacts.contact_name'],
          where: [{ column: 'contacts.cf_clio_id', op: '=', value: '{{clioContactId}}' }] } },
    },
    {
      step: 28,
      why: 'the self-healing write-back targets the custom field',
      label: 'Write the contact\'s Clio id',
      note: 'Self-healing: a tier-2/3 match teaches the system the mapping so the '
          + 'next failure for this client is an exact tier-1 hit. Writes the '
          + 'cf_clio_id custom field (S5, 2026-09-25); update_contact REFUSES '
          + 'contact_clio_id from here on.',
      config: { function_name: 'update_contact',
        params: { contact_id: '{{contactId}}', fields: { cf_clio_id: '{{clioContactId}}' } } },
    },
    {
      step: 3,
      why: 'note only — the guard\'s rationale changes shape with the column',
      noteOnly: true,
      note: 'HARD GUARD. An empty client_id is NOT ignored by Clio — it returns all '
          + '549 matters, so data[0].id would attach both tasks to an unrelated 2018 '
          + 'case. Also guards the tier-1 lookup: a contact with no Clio id reads '
          + 'NULL from cf_clio_id (the key is absent from the bag, never empty), so '
          + 'an unguarded blank would still be a pointless query.',
    },
  ];

  /** Stable stringify — key order must not decide whether two configs match. */
  function canon(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  }

  /** workflow_steps.config arrives parsed or as a JSON string, depending. */
  function cfg(step) {
    const c = step.config;
    return typeof c === 'string' ? JSON.parse(c) : c;
  }

  function fail(msg) { throw new Error('S5 wf37 repoint ABORTED — ' + msg); }

  /**
   * GET /workflows/:id answers `{ success, workflow, steps, editing_version,
   * has_draft }` — the METADATA (name, current_version, draft_version,
   * in_flight_executions, active) is nested under `.workflow`, while `steps`
   * is top level. Split them here once rather than at five call sites, and
   * fail loudly if the shape is not what it was: a silent fallback to the
   * envelope would compare `undefined` against `undefined` and pass.
   */
  function split(res, where) {
    if (!res || typeof res !== 'object') fail(`${where}: no response`);
    if (!res.workflow) fail(`${where}: response has no .workflow — the route's shape changed; re-derive this script`);
    if (!Array.isArray(res.steps)) fail(`${where}: response has no steps array`);
    return { meta: res.workflow, steps: res.steps };
  }

  /**
   * PUBLISH-ONLY — for a draft a previous 'apply' already created.
   *
   * Needed because 'publish' re-enters at the base assertion, which
   * (correctly) refuses to run while a draft is open. The two modes are "do
   * it all from a clean state" and "finish what was started", and only the
   * first existed.
   *
   * It does NOT trust the earlier run. It re-asserts the draft as an END
   * STATE — the edited steps exactly as EDITS specifies them, the step count,
   * no `contact_clio_id` anywhere, #32's log key intact — rather than as a
   * diff, because a fresh page has no before-snapshot to diff against.
   *
   * PUBLISHING IS NOT ENABLING. It moves draft_version into current_version;
   * `workflows.active` is a different column that this never touches, and the
   * post-publish check below FAILS if active came back non-zero. wf37 stays
   * off until someone deliberately turns it on.
   */
  async function publishDraft(send) {
    console.log('\n=== S5-A wf37 — PUBLISH AN EXISTING DRAFT (does NOT enable the workflow) ===\n');

    const { meta, steps } = split(await send(`/workflows/${BASE.workflow_id}`, 'GET'), 'pre-publish GET');
    if (meta.draft_version == null) {
      fail('there is no draft to publish. To make the edits, run s5Wf37Repoint(\'apply\').');
    }
    if (steps.length !== BASE.step_count)        fail(`draft has ${steps.length} steps, expected ${BASE.step_count}`);
    if (Number(meta.in_flight_executions) !== 0) fail(`${meta.in_flight_executions} execution(s) in flight — wait for them`);

    const byNum = new Map(steps.map(s => [Number(s.step_number), s]));
    const problems = [];
    for (const e of EDITS) {
      const s = byNum.get(e.step);
      if (!s) { problems.push(`#${e.step} is missing from the draft`); continue; }
      if (!e.noteOnly && canon(cfg(s)) !== canon(e.config)) {
        problems.push(`#${e.step} config is not the S5 value\n      got:  ${canon(cfg(s))}\n      want: ${canon(e.config)}`);
      }
      if (e.label && s.label !== e.label) problems.push(`#${e.step} label is "${s.label}", expected "${e.label}"`);
      if ((s.note || '') !== e.note)      problems.push(`#${e.step} note is not the S5 text`);
    }
    const leak = steps.filter(s => canon(cfg(s)).includes('contact_clio_id'));
    if (leak.length) problems.push(`"contact_clio_id" still appears in step(s) ${leak.map(s => '#' + s.step_number).join(', ')}`);
    const log32 = byNum.get(32);
    if (!log32 || !canon(cfg(log32)).includes('"clio_matter"')) {
      problems.push('step #32\'s create_log payload lost its `clio_matter` key — that is a LOG FIELD, not a column');
    }
    if (problems.length) fail(`this draft is NOT the S5 repoint — refusing to publish it:\n  - ${problems.join('\n  - ')}`);

    console.log(`DRAFT v${meta.draft_version} RE-ASSERTED — ${steps.length} steps, ${EDITS.length} carry the S5 values, ` +
      `no "contact_clio_id" anywhere, step #32's log payload intact.`);

    const pub = await send(`/workflows/${BASE.workflow_id}/publish`, 'POST', {});
    console.log(`PUBLISHED: ${JSON.stringify(pub)}`);

    const { meta: final, steps: finalSteps } = split(await send(`/workflows/${BASE.workflow_id}`, 'GET'), 'post-publish GET');
    if (final.draft_version != null) fail(`draft_version is still ${final.draft_version} after publish`);
    if (Number(final.current_version) !== Number(meta.draft_version)) {
      fail(`current_version is ${final.current_version}, expected ${meta.draft_version}`);
    }
    if (Number(final.active) !== 0) {
      fail(`wf37 came back active=${final.active} — publishing must NOT enable it. Investigate before going further.`);
    }
    console.log(`\nDONE — wf37 is now v${final.current_version}, ${finalSteps.length} steps, and STILL INACTIVE ` +
      `(active=0). Publishing changed WHICH definition would run, not WHETHER it runs.`);
    return { applied: false, published: true, current_version: final.current_version, active: Number(final.active) };
  }

  async function s5Wf37Repoint(mode) {
    const APPLY   = mode === 'apply' || mode === 'publish';
    const PUBLISH = mode === 'publish';
    if (mode && mode !== 'publish-draft' && !APPLY) {
      fail(`unknown mode "${mode}" — use '', 'apply', 'publish' or 'publish-draft'`);
    }

    const send = root.apiSend;
    if (typeof send !== 'function') fail('apiSend is not on this page — run this in the top-level app shell');

    if (mode === 'publish-draft') return publishDraft(send);

    console.log(`\n=== S5-A wf37 repoint — ${PUBLISH ? 'APPLY + PUBLISH' : APPLY ? 'APPLY (no publish)' : 'DRY RUN'} ===\n`);

    // ── 1. ASSERT THE BASE ────────────────────────────────────────────────
    const { meta: wf, steps: wfSteps } = split(await send(`/workflows/${BASE.workflow_id}`, 'GET'), 'base GET');

    if (wf.name !== BASE.name)                       fail(`name is "${wf.name}", expected "${BASE.name}"`);
    if (Number(wf.current_version) !== BASE.current_version) fail(`current_version is ${wf.current_version}, expected ${BASE.current_version}`);
    if (wf.draft_version != null)                    fail(`an UNPUBLISHED DRAFT already exists (v${wf.draft_version}). Someone is mid-edit — resolve that first; this script must start from a clean published state.`);
    if (wfSteps.length !== BASE.step_count)          fail(`step count is ${wfSteps.length}, expected ${BASE.step_count}`);
    if (Number(wf.in_flight_executions) !== 0)       fail(`${wf.in_flight_executions} execution(s) in flight — wait for them`);

    const byNum = new Map(wfSteps.map(s => [Number(s.step_number), s]));
    for (const [numStr, want] of Object.entries(BASE.steps)) {
      const n = Number(numStr);
      const got = byNum.get(n);
      if (!got)                          fail(`step #${n} is missing`);
      if (got.label !== want.label)      fail(`step #${n} label is "${got.label}", expected "${want.label}"`);
      if (got.type !== want.type)        fail(`step #${n} type is "${got.type}", expected "${want.type}"`);
      if (want.config && canon(cfg(got)) !== canon(want.config)) {
        fail(`step #${n} config is not the asserted base.\n  live:     ${canon(cfg(got))}\n  expected: ${canon(want.config)}`);
      }
    }
    console.log(`BASE OK — wf37 v${wf.current_version}, ${wfSteps.length} steps, no draft, 0 in flight; ` +
      `steps ${Object.keys(BASE.steps).join(', ')} match byte for byte.`);

    // Snapshot every step so the post-write assertion covers the WHOLE draft,
    // not just the steps this script meant to touch.
    const before = new Map(wfSteps.map(s => [Number(s.step_number),
      { label: s.label, note: s.note, type: s.type, config: canon(cfg(s)) }]));

    console.log('\nPlanned edits:');
    for (const e of EDITS) {
      console.log(`  #${e.step} — ${e.why}`);
      if (!e.noteOnly) console.log(`      config → ${canon(e.config)}`);
      if (e.label)     console.log(`      label  → "${e.label}"`);
      console.log(`      note   → "${String(e.note).slice(0, 72)}…"`);
    }

    if (!APPLY) {
      console.log('\nDRY RUN — nothing written. Re-run as s5Wf37Repoint(\'apply\').');
      return { applied: false };
    }

    // ── 2. WRITE (PATCH, one step at a time, by step number) ──────────────
    console.log('');
    for (const e of EDITS) {
      const body = { note: e.note };
      if (!e.noteOnly) body.config = e.config;
      if (e.label) body.label = e.label;
      const res = await send(`/workflows/${BASE.workflow_id}/steps/${e.step}`, 'PATCH', body);
      console.log(`PATCHed #${e.step}: ${res && res.message ? res.message : JSON.stringify(res)}`);
    }

    // ── 3. ASSERT THE RESULTING DRAFT ─────────────────────────────────────
    const { meta: after, steps: afterSteps } = split(await send(`/workflows/${BASE.workflow_id}`, 'GET'), 'draft GET');
    if (after.draft_version == null)           fail('no draft exists after the PATCHes — nothing was written');
    if (afterSteps.length !== BASE.step_count) fail(`draft has ${afterSteps.length} steps, expected ${BASE.step_count} — a step was added or lost`);

    const edited = new Map(EDITS.map(e => [e.step, e]));
    const problems = [];
    for (const s of afterSteps) {
      const n = Number(s.step_number);
      const base = before.get(n);
      if (!base) { problems.push(`#${n} is NEW — it was not in the published version`); continue; }
      const e = edited.get(n);
      const nowCfg = canon(cfg(s));

      if (!e) {
        // Untouched step: must be identical in every field this script can write.
        if (nowCfg !== base.config)   problems.push(`#${n} config CHANGED but no edit targeted it`);
        if (s.label !== base.label)   problems.push(`#${n} label CHANGED but no edit targeted it`);
        if ((s.note || '') !== (base.note || '')) problems.push(`#${n} note CHANGED but no edit targeted it`);
        continue;
      }
      // Edited step: must be EXACTLY what was asked for.
      const wantCfg = e.noteOnly ? base.config : canon(e.config);
      if (nowCfg !== wantCfg) problems.push(`#${n} config is not the requested value\n      got:  ${nowCfg}\n      want: ${wantCfg}`);
      if (e.label && s.label !== e.label) problems.push(`#${n} label is "${s.label}", expected "${e.label}"`);
      if ((s.note || '') !== e.note)      problems.push(`#${n} note was not applied`);
    }
    for (const n of before.keys()) {
      if (!afterSteps.some(s => Number(s.step_number) === n)) problems.push(`#${n} DISAPPEARED from the draft`);
    }
    if (problems.length) fail(`the draft is not what was asked for:\n  - ${problems.join('\n  - ')}`);

    // Belt and braces: the old column name must be gone from the two configs
    // and must NOT have leaked anywhere else in the draft.
    const leak = afterSteps.filter(s => canon(cfg(s)).includes('contact_clio_id'));
    if (leak.length) fail(`"contact_clio_id" still appears in step(s) ${leak.map(s => '#' + s.step_number).join(', ')}`);
    const log32 = afterSteps.find(s => Number(s.step_number) === 32);
    if (!log32 || !canon(cfg(log32)).includes('"clio_matter"')) {
      fail('step #32\'s create_log payload lost its `clio_matter` key — that is a LOG FIELD, not a column, and must survive');
    }

    console.log(`\nDRAFT OK — v${after.draft_version}: ${afterSteps.length} steps, ` +
      `${EDITS.length} edited exactly as specified, ${afterSteps.length - EDITS.length} byte-identical, ` +
      `no "contact_clio_id" anywhere, step #32's log payload intact.`);

    if (!PUBLISH) {
      console.log('\nNOT PUBLISHED. Review the draft in Automation → Workflows → wf37, ' +
        'then either publish there or re-run as s5Wf37Repoint(\'publish\').');
      return { applied: true, published: false, draft_version: after.draft_version };
    }

    // ── 4. PUBLISH ────────────────────────────────────────────────────────
    // migrate_in_flight is deliberately NOT sent: 0 runs in flight (asserted
    // above) and wf37 has never executed at all, so there is nothing to carry.
    const pub = await send(`/workflows/${BASE.workflow_id}/publish`, 'POST', {});
    console.log(`\nPUBLISHED: ${JSON.stringify(pub)}`);

    const { meta: final, steps: finalSteps } = split(await send(`/workflows/${BASE.workflow_id}`, 'GET'), 'post-publish GET');
    if (final.draft_version != null) fail(`draft_version is still ${final.draft_version} after publish`);
    if (Number(final.current_version) !== Number(after.draft_version)) {
      fail(`current_version is ${final.current_version}, expected ${after.draft_version}`);
    }
    console.log(`\nDONE — wf37 is now v${final.current_version}, ${finalSteps.length} steps. ` +
      `The workflow remains INACTIVE (active=${final.active}); turning it on is a separate decision.`);
    return { applied: true, published: true, current_version: final.current_version };
  }

  /**
   * THE WATCH QUERY — for whenever wf37 is finally switched on.
   *
   * Two switches guard it, both off today and both deliberate: the workflow
   * (`workflows.active`) and its starter (`email_ingest_rule_actions` #24 on
   * rule 21 "clio payment failed", which is active and has matched 123 times
   * with nowhere to send them). Flipping them is a decision of its own; this
   * query is what to watch once they are flipped.
   *
   * Run it against the readonly SQL endpoint. It answers the only question
   * S5 raises about wf37: did the repointed tier-1 READ (#8) find the contact,
   * and did the repointed WRITE-BACK (#28) land on the custom field?
   *
   *   SELECT e.id, e.status, e.created_at, e.steps_executed_count,
   *          s.step_number, s.status AS step_status, s.error_message,
   *          JSON_EXTRACT(s.resolved_config, '$.params') AS resolved_params,
   *          JSON_EXTRACT(s.output_data,     '$')        AS output
   *     FROM workflow_executions e
   *     JOIN workflow_execution_steps s ON s.execution_id = e.id
   *    WHERE e.workflow_id = 37
   *      AND s.step_number IN (3, 8, 28)
   *    ORDER BY e.id DESC, s.step_number ASC
   *    LIMIT 60;
   *
   * READ IT LIKE THIS:
   *   #8  resolved_params.where[0].column MUST be `contacts.cf_clio_id`.
   *       A `contacts.contact_clio_id` there means the publish did not take.
   *       output.clioIdCount > 0 is a tier-1 hit; 0 is normal for a contact
   *       whose Clio id the firm has never seen, and the run falls through to
   *       tiers 2/3 — 0 is NOT a failure on its own.
   *   #28 resolved_params.fields MUST have the key `cf_clio_id`. If it still
   *       says `contact_clio_id` the step will now FAIL outright, with
   *       `"contact_clio_id" is retired — write "cf_clio_id" instead` in
   *       error_message — which is the freeze doing its job, not a new bug.
   *   #3  is the hard guard; it only routes.
   *
   * Then confirm the write actually landed, rather than trusting the step:
   *
   *   SELECT contact_id, cf_clio_id, JSON_EXTRACT(custom,'$.cf_clio_id') AS bag
   *     FROM contacts WHERE contact_id = <the contact from the run>;
   *
   * The column and the bag must agree. And post-commit side effects on this
   * path are fire-and-forget (CLAUDE.md) — the step reporting success is not
   * proof the row changed.
   */
  root.s5Wf37Repoint = s5Wf37Repoint;
  console.log('s5Wf37Repoint() loaded — call await s5Wf37Repoint() for a dry run.');

})(typeof window !== 'undefined' ? window : globalThis);
