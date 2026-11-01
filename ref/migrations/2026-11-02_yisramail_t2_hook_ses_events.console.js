/*
 * ref/migrations/2026-11-02_yisramail_t2_hook_ses_events.console.js
 *
 * Hook `ses-events` (YisraMail T2 — ref/YISRAMAIL_DESIGN.md §5.4): the record of
 * its definition, and the way to recreate it. Paste into the DevTools console
 * of a logged-in app.4lsg.com tab (the SHELL, where `apiSend` is defined), as a
 * user holding automations.manage.
 *
 * THE DEFINITION
 *   slug ses-events · auth api_key, header x-api-key (the receiver strips
 *   x-api-key from what it stores; the default x-hook-key would not have been
 *   stripped before 2026-11-02) · filter none · transform passthrough ·
 *   dedup_path body.id (the EventBridge event id: a retry or a DLQ replay of an
 *   event already received is answered 200 and recorded nowhere) · active.
 *   Target: internal_function mail_event_ingest, params_mapping event ← body
 *   (passthrough hands the target {body, headers, query, method, meta}; body is
 *   the EventBridge event).
 *   AWS side (runbook): EventBridge rule yisramail-ses-events (source aws.ses)
 *   → API destination yisramail-hook (POST https://app.4lsg.com/hooks/ses-events,
 *   10/s) through Connection yisramail-hook-conn (API key, header x-api-key =
 *   this hook's key), DLQ yisramail-ses-dlq.
 *
 * RUN: paste once; it defines window.sesHook and runs sesHook.check()
 * (READ-ONLY): the hook present or absent, and every field above compared. It
 * returns a REDACTED summary (has_key: 'yes' | 'no') — never the hook row,
 * whose auth_config the editor route hands back decrypted.
 *   await sesHook.create()      — only when ABSENT: creates the hook with a
 *     freshly generated key and puts the key on the CLIPBOARD (DevTools copy();
 *     never printed). Paste it into the EventBridge Connection's API key value
 *     at once (Connections → yisramail-hook-conn → Edit). Then re-checks.
 *   await sesHook.addTarget()   — adds the mail_event_ingest target when it is
 *     missing (the slice's land: SQL migration → backend deploy → THIS), then
 *     re-checks.
 * Each ends on ONE line: GO — … / NO-GO — paste this to Claude.
 */
await (async () => {
  const SLUG = 'ses-events';
  const HOOK = {
    slug: SLUG,
    name: 'SES events (YisraMail)',
    description: 'Amazon SES events for the marketing transport (config set yisramail-marketing) via an EventBridge API destination. YisraMail T2; ref/YISRAMAIL_DESIGN.md §5.4.',
    auth_type: 'api_key',
    filter_mode: 'none',
    transform_mode: 'passthrough',
    dedup_path: 'body.id',
    active: 1,
  };
  const HEADER = 'x-api-key';
  const TARGET = {
    name: 'mail_event_ingest', target_type: 'internal_function', position: 0,
    config: { function_name: 'mail_event_ingest', params_mapping: { event: 'body' } },
    transform_mode: 'passthrough', active: 1,
  };
  const cfgOf = (v) => (typeof v === 'string' ? JSON.parse(v) : (v || {}));

  async function load() {
    const list = await apiSend('/api/hooks');
    const row = (list.hooks || []).find((h) => h.slug === SLUG);
    if (!row) return null;
    const r = await apiSend(`/api/hooks/${row.id}`);
    return r.hook;
  }

  /** → { hook, problems[], target } — never prints the key. */
  async function inspect() {
    const hook = await load();
    if (!hook) return { hook: null, problems: ['absent'], target: null };
    const problems = [];
    const auth = cfgOf(hook.auth_config);
    if (hook.auth_type !== 'api_key') problems.push(`auth_type is ${hook.auth_type}, expected api_key`);
    if (String(auth.header || '').toLowerCase() !== HEADER) problems.push(`auth header is ${auth.header || '(default x-hook-key)'}, expected ${HEADER}`);
    if (!auth.key) problems.push('no key is set');
    for (const k of ['filter_mode', 'transform_mode', 'dedup_path']) {
      if ((hook[k] || null) !== HOOK[k]) problems.push(`${k} is ${hook[k] || '(empty)'}, expected ${HOOK[k]}`);
    }
    if (!Number(hook.active)) problems.push('hook is inactive');
    if (hook.capture_mode === 'capturing') problems.push('capture mode is still ON (the next event would be captured, not ingested)');
    const target = (hook.targets || []).find((t) => t.target_type === 'internal_function' && cfgOf(t.config).function_name === 'mail_event_ingest') || null;
    if (target) {
      const pm = cfgOf(target.config).params_mapping || {};
      if (JSON.stringify(pm) !== JSON.stringify(TARGET.config.params_mapping)) problems.push(`target params_mapping is ${JSON.stringify(pm)}, expected {"event":"body"}`);
      if (!Number(target.active)) problems.push('the mail_event_ingest target is inactive');
    }
    return { hook, problems, target };
  }

  /** What check() hands back: a REDACTED summary — never the hook row (the editor route returns auth_config decrypted). */
  function summary(s) {
    if (!s.hook) return { present: false, problems: s.problems };
    const auth = cfgOf(s.hook.auth_config);
    return {
      present: true, hook_id: s.hook.id, slug: s.hook.slug, auth_type: s.hook.auth_type,
      header: auth.header || null, has_key: auth.key ? 'yes' : 'no',
      filter_mode: s.hook.filter_mode, transform_mode: s.hook.transform_mode, dedup_path: s.hook.dedup_path || null,
      active: !!Number(s.hook.active), capture_mode: s.hook.capture_mode,
      target_id: s.target ? s.target.id : null, problems: s.problems,
    };
  }

  async function check() {
    const s = await inspect();
    if (!s.hook) { console.log(`NO-GO — hook ${SLUG} is absent. Create it: await sesHook.create()`); return summary(s); }
    s.problems.forEach((p) => console.log(`  ✗ ${p}`));
    console.log(`hook ${SLUG} #${s.hook.id}; target mail_event_ingest: ${s.target ? `#${s.target.id}` : 'none'}`);
    if (s.problems.length) console.log('NO-GO — hook ses-events differs from its definition (above). Paste this to Claude.');
    else console.log(s.target ? 'GO — hook ses-events matches its definition, target included.'
      : 'GO — hook ses-events matches its definition; no target yet (add it at the land: await sesHook.addTarget()).');
    return summary(s);
  }

  async function create() {
    const s = await inspect();
    if (s.hook) { console.log(`NO-GO — hook ${SLUG} already exists (#${s.hook.id}); create() only builds a missing one.`); return; }
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const key = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    const r = await apiSend('/api/hooks', 'POST', { ...HOOK, auth_config: { header: HEADER, key } });
    if (!r || !r.id) { console.log('NO-GO — the create did not return an id. Paste this to Claude.'); return; }
    if (typeof copy === 'function') copy(key);
    console.log(`hook ${SLUG} created (#${r.id}); its key is on your clipboard${typeof copy === 'function' ? '' : ' — NOT: copy() is unavailable here; regenerate the key in the hook editor'} — paste it into the EventBridge Connection yisramail-hook-conn now.`);
    await check();
  }

  async function addTarget() {
    const s = await inspect();
    if (!s.hook) { console.log(`NO-GO — hook ${SLUG} is absent; create it first.`); return; }
    if (s.target) { console.log(`GO — the mail_event_ingest target already exists (#${s.target.id}); nothing added.`); return; }
    const r = await apiSend(`/api/hooks/${s.hook.id}/targets`, 'POST', TARGET);
    if (!r || !r.id) { console.log('NO-GO — the target create did not return an id. Paste this to Claude.'); return; }
    await check();
  }

  window.sesHook = { check, create, addTarget, HOOK, TARGET, HEADER };
  await check();
})();
