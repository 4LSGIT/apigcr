// lib/internal_functions/documents.js
//
/**
 * Documents category — the recurring entry points for the Dropbox → registry
 * sync engine (Documents S2).
 *
 * Auto-scanned by index.js: dropping this file in registers both functions,
 * no edit anywhere else. See README.md for the module convention.
 *
 * ── THE KILL SWITCH ───────────────────────────────────────────────────────
 * app_settings key `documents_sync_enabled`. FAIL-CLOSED: absent, blank, or
 * anything other than the exact string '1' means DISABLED. A feature that
 * walks 150,000 files and writes to a live registry does not get to default
 * itself on because a settings row was never created.
 *
 * Read through settingsService.getSetting — an UNCACHED read, per invocation.
 * The obvious alternative was lib/firmConfig's cfg(), which is how
 * cloud_tasks_enabled is checked, and it was rejected for three reasons:
 *   1. cfg() caches for 60s, so writing '0' to stop a runaway backfill would
 *      keep syncing for up to a minute per Cloud Run instance. A kill switch
 *      that takes effect "soon" is not a kill switch.
 *   2. cfg() throws on keys absent from its REGISTRY, so it would need a
 *      firmConfig edit — and would come with an env-var fallback, creating a
 *      second control surface (DOCUMENTS_SYNC_ENABLED) nobody asked for.
 *   3. cfg() is sync because ~25 call sites read config at module load. These
 *      functions are async and already hold `db`. There is nothing to buy.
 * The COMPARISON is identical to the cloud_tasks_enabled idiom (=== '1',
 * everything else off); only the reader differs.
 *
 * Both functions are safe to invoke by hand WHILE the recurring jobs are
 * running. What makes that true is the claim in documentSyncService.syncRoot:
 * a conditional UPDATE on document_sync_roots.syncing_since means two runners
 * can never process the same root, and a manual run that loses the race
 * simply reports the root as skipped. refresh_case_cache needs no claim — its
 * writes are idempotent per case_id and two concurrent runs would at worst
 * resolve the same shared links twice.
 */

const fns = {};

/**
 * Fail-closed kill-switch read. See the header for why not firmConfig.
 *
 * S3.2 moved the comparison itself into documentSyncService.isSyncEnabled and
 * this delegates to it. The switch now has exactly one reader: the admin
 * panel's manual sync-now button needs the same gate (a button that overrode
 * the kill switch would be a second control surface, which is the thing the
 * firmConfig rejection above was about), and two copies of `=== '1'` is two
 * chances for them to drift on what "1 " means.
 */
async function _syncEnabled(db) {
  const sync = require('../../services/documentSyncService'); // lazy require (convention)
  return sync.isSyncEnabled(db);
}

/**
 * documents_sync — one bounded increment of the Dropbox sync.
 *
 * Every invocation does as much as its page and time budget allow and then
 * stops, having persisted a cursor for each root it touched. The backfill of
 * ~150k files therefore completes across successive runs of the recurring
 * job rather than in any single execution — there is no long-running process
 * in this architecture, and this function is not pretending to be one.
 *
 * With `root_id`, syncs THAT ROOT ONLY and does so even if the root is
 * disabled: naming a specific root by hand is an explicit override, and the
 * `enabled` flag exists to keep a root out of the AUTOMATIC rotation, not to
 * make it unreachable for debugging. The kill switch is NOT overridable this
 * way — it is the one control that means "this engine does not run".
 *
 * The reconcile sweep runs at the end of a full (non-targeted) invocation,
 * picking up files whose case folder was not yet cached when they registered.
 *
 * params:
 *   root_id   {number?}  — sync only this root (override; ignores `enabled`)
 *   max_pages {number?}  — page budget shared across roots (default 25)
 *   sweep     {boolean?} — run the reconcile sweep (default true)
 */
fns.documents_sync = async (params = {}, db) => {
  const sync = require('../../services/documentSyncService'); // lazy require (convention)

  if (!await _syncEnabled(db)) {
    return {
      success: true,
      output: { skipped: true, reason: 'documents_sync_enabled is not "1"' },
    };
  }

  const maxPages = Number(params.max_pages) > 0 ? Math.floor(Number(params.max_pages)) : undefined;
  const startedAt = Date.now();

  // Targeted: one root, no rotation, no sweep unless asked.
  if (params.root_id != null && params.root_id !== '') {
    const [[root]] = await db.query(
      'SELECT * FROM document_sync_roots WHERE id = ?', [params.root_id],
    );
    if (!root) throw new Error(`documents_sync: no sync root with id ${params.root_id}`);

    const result = await sync.syncRoot(db, root, {
      ...(maxPages ? { maxPages } : {}),
    });
    const output = { targeted: true, roots: [result], elapsed_ms: Date.now() - startedAt };

    if (params.sweep === true) {
      output.sweep = await sync.attributeUnlinked(db, {});
    }
    console.log(`[DOCUMENTS SYNC] root=${root.id} ${JSON.stringify(result)}`);
    return { success: true, output };
  }

  const result = await sync.syncAll(db, { ...(maxPages ? { maxPages } : {}) });

  const output = { ...result };
  if (params.sweep !== false) {
    output.sweep = await sync.attributeUnlinked(db, {});
  }
  output.elapsed_ms = Date.now() - startedAt;

  console.log(
    `[DOCUMENTS SYNC] roots=${result.roots.length} pages=${result.pages_used} ` +
    `files=${result.roots.reduce((a, r) => a + (r.files || 0), 0)} ` +
    `linked=${result.roots.reduce((a, r) => a + (r.linked || 0), 0)} ` +
    `sweep_linked=${output.sweep ? output.sweep.linked : 'off'}`
  );

  return { success: true, output };
};

fns.documents_sync.__meta = {
  category: 'documents',
  description:
    'One bounded increment of the Dropbox → documents sync. Walks enabled sync roots under a ' +
    'shared page budget (oldest-synced first), registering files and linking them to cases by ' +
    'folder path, then runs the reconcile sweep. A root with no cursor runs in BACKFILL mode ' +
    '(bulk writes, NO domain events); a root with a cursor runs INCREMENTAL (per-row writes, ' +
    'document.created / document.updated / document.linked emitted). The cursor is persisted ' +
    'after every page, so the ~150k-file backfill completes across successive runs. Fail-closed ' +
    'on app_settings documents_sync_enabled != "1".',
  params: [
    { name: 'root_id', type: 'integer', required: false,
      description: 'Sync only this document_sync_roots id. Explicit override — runs even if the root is disabled. Omit for the normal all-roots rotation.' },
    { name: 'max_pages', type: 'integer', required: false, default: 25,
      description: 'Page budget (2000 entries/page) shared across all roots for this invocation. The whole estate is roughly 80 pages.' },
    { name: 'sweep', type: 'boolean', required: false, default: true,
      description: 'Run the reconcile sweep (silently links documents whose case folder was not cached at ingest time). Defaults on for a full run, off for a targeted root_id run.' },
  ],
  example: {}
};

/**
 * documents_refresh_case_cache — refill case_folder_cache from cases.case_dropbox.
 *
 * Resolves shared links to live folder paths, oldest-first, so attribution
 * has something to match against. Runs on a slower schedule than the sync
 * itself because each row costs a Dropbox API call and case folders move
 * rarely — and because the sync's folder-delta handling already heals the
 * cache for free when a cached folder is moved or renamed.
 *
 * `out_of_root` in the return value is the report that matters: case IDs
 * whose Dropbox folder sits under NO enabled sync root. Documents in those
 * folders will never be registered by any amount of correct sync code. It
 * lands in job_results, which is deliberately the whole reporting mechanism
 * — there is no second persistence layer to keep in sync.
 *
 * params:
 *   limit {number?} — cases to resolve this run (default 300)
 */
fns.documents_refresh_case_cache = async (params = {}, db) => {
  const sync = require('../../services/documentSyncService'); // lazy require (convention)

  if (!await _syncEnabled(db)) {
    return {
      success: true,
      output: { skipped: true, reason: 'documents_sync_enabled is not "1"' },
    };
  }

  const limit = Number(params.limit) > 0 ? Math.floor(Number(params.limit)) : undefined;
  const maxRuntimeMs = Number(params.max_runtime_ms) > 0
    ? Math.floor(Number(params.max_runtime_ms)) : undefined;
  const out = await sync.refreshCaseFolderCache(db, {
    ...(limit ? { limit } : {}),
    ...(maxRuntimeMs ? { maxRuntimeMs } : {}),
  });

  console.log(
    `[DOCUMENTS CACHE] scanned=${out.scanned}/${out.candidates} resolved=${out.resolved} ` +
    `failed=${out.failed} out_of_root=${out.out_of_root.length} timed_out=${out.timed_out}`
  );

  return { success: true, output: out };
};

fns.documents_refresh_case_cache.__meta = {
  category: 'documents',
  description:
    'Resolve cases.case_dropbox shared links into case_folder_cache (folder path + Dropbox id), ' +
    'oldest-first, so the sync engine can attribute documents to cases by path. A failed ' +
    'resolution records resolve_error and LEAVES THE PRIOR PATH INTACT — a revoked link must not ' +
    'unfile a case. Returns out_of_root: cases whose folder sits under no enabled sync root, ' +
    'whose documents would therefore never be registered. Bounded by BOTH a case count and a ' +
    'wall clock; hitting either is a normal outcome (timed_out in the output), and the next run ' +
    'resumes at the unreached tail. Fail-closed on app_settings documents_sync_enabled != "1".',
  params: [
    { name: 'limit', type: 'integer', required: false, default: 300,
      description: 'Cases to resolve this run, oldest-resolved first (never-resolved counts as oldest). Sequential, measured at ~1s per case in production — so 300 is roughly a five-minute call and the wall-clock bound below usually binds first.' },
    { name: 'max_runtime_ms', type: 'integer', required: false, default: 240000,
      description: 'Wall-clock bound (default 4 min — safely inside the job runner\'s 15-min stuck-job recovery). Checked before each Dropbox call, so it never overshoots by a round trip. Stopping early loses nothing: oldest-first ordering means the next run resumes at the unreached tail.' },
  ],
  example: {}
};

/**
 * documents_attribution_report — READ-ONLY. Writes nothing, links nothing,
 * emits nothing.
 *
 * Answers the question out_of_root structurally cannot: which cases have a
 * folder that resolves perfectly and yet hold no documents? That is the
 * signature of a stale `cases.case_dropbox` — the shared link minted at
 * intake, never re-pointed after the case was filed and its contents moved to
 * a new working folder.
 *
 * Also counts, per such case, how many registered documents still sit under
 * the cached path, split by WHY they are still there. That split is the test
 * of the single-folder ruling: `deleted` residue means files moved out
 * (supports single-folder); `active_linked_elsewhere` means live files under
 * one case's folder attributed to another (re-opens multi-folder);
 * `active_unlinked` should be impossible after a sweep lap and indicates a
 * sweep bug rather than anything about case lifecycle.
 *
 * NOT wired to a recurring job. It is a decision-support instrument, not
 * monitoring — run it by hand, read the verdict, charter accordingly. It also
 * scans the whole documents table, which is not something to do on a timer
 * without a reason.
 *
 * params:
 *   sample         {number?} — cases listed individually (default 50, max 500)
 *   max_runtime_ms {number?} — wall-clock bound (default 3 min)
 */
fns.documents_attribution_report = async (params = {}, db) => {
  const sync = require('../../services/documentSyncService'); // lazy require (convention)

  // Gated on the same switch as the rest of the engine: if the sync is off,
  // the attribution picture is a stale snapshot and reporting on it invites
  // decisions from data nobody is maintaining.
  if (!await _syncEnabled(db)) {
    return {
      success: true,
      output: { skipped: true, reason: 'documents_sync_enabled is not "1"' },
    };
  }

  const sample = Number(params.sample) > 0 ? Math.floor(Number(params.sample)) : undefined;
  const maxRuntimeMs = Number(params.max_runtime_ms) > 0
    ? Math.floor(Number(params.max_runtime_ms)) : undefined;

  const out = await sync.attributionReport(db, {
    ...(sample ? { sample } : {}),
    ...(maxRuntimeMs ? { maxRuntimeMs } : {}),
  });

  console.log(
    `[DOCUMENTS REPORT] cached=${out.cached_folders} zero_attribution=${out.zero_attribution_cases} ` +
    `with_residue=${out.cases_with_residue} residue=${out.residue_total} ` +
    `(deleted=${out.residue_deleted} linked_elsewhere=${out.residue_active_linked_elsewhere} ` +
    `unlinked=${out.residue_active_unlinked}) verdict=${out.verdict}`
  );

  return { success: true, output: out };
};

fns.documents_attribution_report.__meta = {
  category: 'documents',
  description:
    'READ-ONLY diagnostic. Lists cases whose Dropbox folder resolved cleanly but hold ZERO ' +
    'attributed documents — the signature of a stale cases.case_dropbox left pointing at the ' +
    'intake folder after a case was filed and its contents moved elsewhere. For each, counts ' +
    'registered documents still under the cached path, split into deleted / active-linked-to-' +
    'another-case / active-unlinked. Returns a verdict on whether the one-folder-per-case model ' +
    'holds. Writes nothing and emits nothing. Scans the whole documents table, so run it ' +
    'deliberately rather than on a schedule. Fail-closed on documents_sync_enabled != "1".',
  params: [
    { name: 'sample', type: 'integer', required: false, default: 50,
      description: 'How many affected cases to list individually in the output, worst-residue first. Max 500. Counts are always over the full set regardless.' },
    { name: 'max_runtime_ms', type: 'integer', required: false, default: 180000,
      description: 'Wall-clock bound (default 3 min). Hitting it yields verdict "incomplete_scan" — the counts are then a lower bound, not an answer.' },
  ],
  example: {}
};

module.exports = fns;
