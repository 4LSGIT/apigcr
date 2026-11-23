// scripts/caseyS4aAdminTile.snippet.js — Casey v2 S4a: put the Casey Notes tile on
// the firm's Admin page. NOT a node script: paste the whole file into the main
// YisraCase window's DevTools console as a signed-in holder of firm.settings
// (CLAUDE.md "An action that needs Fred's own browser session"), AFTER the S4a
// deploy (the registry entry adminCaseyNotes must exist on the running build).
//
// The Admin page is the firm's own document (ui_config scope firm, key layout,
// pages['firm:admin'].tiles — edited in-app since launcher-nits C4), so a new
// tile is a data step, not a deploy: this reads the document, asserts the base
// it expects (adminMailboxes present, adminCaseyNotes absent), inserts the tile
// right after adminMailboxes, PUTs with the loaded version id as `base` (a
// concurrent edit is a 409, nothing written), re-reads to prove it, and ends on
// ONE GO / NO-GO line. Re-running it after a GO is a NO-GO that changes nothing.
(async () => {
  const say = (s) => console.log(s);
  try {
  const cfg = await apiSend('/api/ui-config');
  if (!cfg || cfg.status !== 'success' || !cfg.can_edit_firm) return say('NO-GO — paste this to Claude: /api/ui-config did not answer with can_edit_firm (are you a firm.settings holder?)');
  const layout = JSON.parse(JSON.stringify(cfg.firm.layout || {}));
  const pages = layout.pages || {};
  const admin = pages['firm:admin'];
  if (!admin || !Array.isArray(admin.tiles)) return say('NO-GO — paste this to Claude: the firm layout has no firm:admin page with tiles');
  const ids = admin.tiles.filter((t) => t.item).map((t) => t.item);
  if (ids.includes('adminCaseyNotes')) return say('NO-GO (nothing to do) — adminCaseyNotes is already on the Admin page at position ' + ids.indexOf('adminCaseyNotes'));
  const at = admin.tiles.findIndex((t) => t.item === 'adminMailboxes');
  if (at < 0) return say('NO-GO — paste this to Claude: adminMailboxes is not on the Admin page; the expected base is ' + JSON.stringify(ids));
  const before = JSON.stringify(admin.tiles);
  admin.tiles.splice(at + 1, 0, { item: 'adminCaseyNotes' });
  const base = cfg.firm_versions ? cfg.firm_versions.layout : undefined;
  const put = await apiSend('/api/ui-config', 'PUT', { scope: 'firm', config_key: 'layout', config: layout, ...(base !== undefined ? { base } : {}) });
  if (!put || put.status !== 'success') return say('NO-GO — paste this to Claude: the PUT failed: ' + JSON.stringify(put));
  const again = await apiSend('/api/ui-config');
  const after = (((again.firm || {}).layout || {}).pages || {})['firm:admin'];
  const afterIds = after && after.tiles ? after.tiles.filter((t) => t.item).map((t) => t.item) : [];
  if (afterIds.indexOf('adminCaseyNotes') !== afterIds.indexOf('adminMailboxes') + 1) return say('NO-GO — paste this to Claude: re-read does not show the tile after Mailboxes: ' + JSON.stringify(afterIds) + ' (tiles before: ' + before + ')');
  say('GO — adminCaseyNotes is on the Admin page right after Mailboxes (firm layout version ' + (put.version_id ?? '?') + ', changed=' + put.changed + '). Reload the shell to see it.');
  } catch (e) {   // apiSend throws on any non-2xx (a stale base is a 409, a grammar refusal a 400) and on a network error: still ONE line
    say('NO-GO — paste this to Claude: ' + (e && e.status ? e.status + ' ' : '') + (e && e.message || e));
  }
})();
