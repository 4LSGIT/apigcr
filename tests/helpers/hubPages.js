// tests/helpers/hubPages.js
//
/**
 * More Features and Admin as the FIRM'S PAGES — the shape production has had
 * since the launcher-nits C3 data step (2026-10-29), and the only shape since
 * C4 retired the static #tabMore / #tabAdmin hubs. Built from the C3 script's
 * frozen copy of the pre-C4 lists (scripts/launcherC3MoreAdminPages.js
 * HISTORIC), so every suite's More / Admin is the one production got:
 *
 *   HUB_MORE / HUB_ADMIN   the firm items firm:more / firm:admin (kind page)
 *   hubPages()             layout.pages for both: the old grids and icon rows
 *   hubFirm(opts)          the firm's two documents { registry_overrides, layout }:
 *                          the page items (+ opts.items), Admin's audience
 *                          (opts.visibleTo, default it + admin), Home and the
 *                          sidebar placing the pages where the hubs' items were
 *                          (opts.layout merges over it)
 *   panelIds(REG)          the registry ids with a panel on either page
 *   stageHtml(REG)         the stage's panel divs for those (#ycPanels' children)
 */

'use strict';

const { HISTORIC } = require('../../scripts/launcherC3MoreAdminPages');

const J = (x) => JSON.parse(JSON.stringify(x));
const LAY = HISTORIC.layouts;
const MAP = { moreFeatures: 'firm:more', admin: 'firm:admin' };
const mapList = (list) => list.map((e) => (e.item && MAP[e.item] ? { item: MAP[e.item] } : J(e)));

const HUB_MORE = Object.freeze({ id: 'firm:more', label: 'More Features', icon: 'grip', action: Object.freeze({ type: 'page' }) });
const HUB_ADMIN = Object.freeze({ id: 'firm:admin', label: 'Admin', icon: 'mug-hot', action: Object.freeze({ type: 'page' }) });

function hubPages() {
  return {
    'firm:more': { tiles: J(LAY.more), icons: J(LAY.moreIcons) },
    'firm:admin': { tiles: J(LAY.admin), icons: J(LAY.adminIcons) },
  };
}

function hubFirm({ items = [], visibleTo = { 'firm:admin': ['it', 'admin'] }, layout = {}, ro = {} } = {}) {
  return {
    registry_overrides: { hidden: [], locked: [], renames: {}, ...ro, items: [...J(items), J(HUB_MORE), J(HUB_ADMIN)], ...(visibleTo ? { visible_to: J(visibleTo) } : {}) },
    layout: {
      placed: { home: mapList(LAY.home), sidebar: mapList(LAY.sidebar), ...(layout.placed || {}) },
      removed: { ...(layout.removed || {}) },
      pages: { ...hubPages(), ...(layout.pages || {}) },
    },
  };
}

function panelIds(REG) {
  return [...LAY.more, ...LAY.admin].filter((e) => e.item && REG[e.item] && REG[e.item].target).map((e) => e.item);
}

function stageHtml(REG) {
  return panelIds(REG).map((id) => `<div id="${REG[id].target}" style="display:none"><iframe data-src="/${REG[id].target}.html"></iframe></div>`).join('');
}

module.exports = { HUB_MORE, HUB_ADMIN, hubPages, hubFirm, panelIds, stageHtml, HISTORIC_LAYOUTS: LAY };
