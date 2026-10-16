// tests/helpers/uiConfigStore.js
//
/**
 * An in-memory ui_config + ui_config_versions store that the REAL
 * services/uiConfigService runs on (ui-custom S6c-3): a connection that
 * answers the statements write() issues inside its transaction, and a pool
 * that answers readFor / listVersions / getVersion / firmVersionIds. Rows and
 * versions keep their JSON as strings, as MySQL hands them back; nothing here
 * decides anything — validation, the base check, the version append and the
 * restore all run in the service.
 *
 * makeStore() → { db, rows, versions, apiFor(auth, opts) }
 *   apiFor(auth, { canEdit }) → an apiSend(url, method, body) that does what
 *   routes/api.uiConfig.js does for these endpoints (GET /api/ui-config with
 *   can_edit_firm + firm_versions, PUT, versions list / one / restore, and an
 *   empty pickers list), rejecting like the shell's apiSend: an Error with
 *   .status and .body { status, message, errors? }.
 *
 * An unscripted statement throws, so a service change that issues a new one
 * fails the suites that use this rather than passing on a guess.
 */

'use strict';

const svc = require('../../services/uiConfigService');

const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();

function makeStore() {
  const rows = new Map();            // 'scope|user|key' → { id, config (JSON string) }
  const versions = [];               // { id, ui_config_id, config_key, config (JSON string), saved_by, saved_at }
  let nextRow = 1;
  let nextVer = 1;
  const rowById = (id) => { for (const [k, r] of rows) if (r.id === id) return { k, r }; return null; };

  const conn = {
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {}, destroy: () => {},
    query: async (sql, p = []) => {
      const s = norm(sql);
      if (/^SELECT id, config FROM ui_config .* FOR UPDATE$/.test(s)) {
        const r = rows.get(p.slice(0, 3).join('|'));
        return [r ? [{ id: r.id, config: r.config }] : []];
      }
      if (/^SELECT MAX\(id\) AS id FROM ui_config_versions WHERE ui_config_id = \?$/.test(s)) {
        const ids = versions.filter((v) => v.ui_config_id === p[0]).map((v) => v.id);
        return [[{ id: ids.length ? Math.max(...ids) : null }]];
      }
      if (/^INSERT INTO ui_config \(scope, user_id, role, config_key, config, updated_by\)/.test(s)) {
        const k = p.slice(0, 3).join('|');
        const cur = rows.get(k);
        const id = cur ? cur.id : nextRow++;
        rows.set(k, { id, config: p[3] });
        return [{ insertId: id }];
      }
      if (/^INSERT INTO ui_config_versions \(ui_config_id, config_key, config, saved_by\)/.test(s)) {
        const id = nextVer++;
        versions.push({ id, ui_config_id: p[0], config_key: p[1], config: p[2], saved_by: p[3], saved_at: new Date(Date.UTC(2026, 9, 16, 9, id)).toISOString() });
        return [{ insertId: id }];
      }
      throw new Error('uiConfigStore conn: unscripted ' + s);
    },
  };

  const firmRow = (id) => { const x = rowById(id); return x && x.k.startsWith('firm|0|') ? x : null; };
  const db = {
    getConnection: async () => conn,
    query: async (sql, p = []) => {
      const s = norm(sql);
      if (s === norm(svc.READ_SQL)) {
        const out = [];
        for (const [k, r] of rows) {
          const [scope, user, key] = k.split('|');
          if ((scope === 'firm' && user === '0') || (scope === 'user' && p[0] != null && user === String(p[0]))) out.push({ scope, config_key: key, config: r.config });
        }
        return [out];
      }
      if (/FROM ui_config_versions v JOIN ui_config c ON c.id = v.ui_config_id .* AND c.config_key = \? ORDER BY v.id DESC/.test(s)) {
        const out = versions.filter((v) => { const x = firmRow(v.ui_config_id); return x && x.k === 'firm|0|' + p[0]; })
          .sort((a, b) => b.id - a.id)
          .map((v) => ({ id: v.id, saved_by: v.saved_by, saved_by_name: 'Admin ' + v.saved_by, saved_at: v.saved_at,
            size: v.config.length, is_current: v.config === firmRow(v.ui_config_id).r.config ? 1 : 0 }));
        return [out];
      }
      if (/FROM ui_config_versions v JOIN ui_config c ON c.id = v.ui_config_id .* WHERE v.id = \?/.test(s)) {
        const v = versions.find((x) => x.id === p[0]);
        const x = v && firmRow(v.ui_config_id);
        if (!x) return [[]];
        return [[{ id: v.id, config_key: v.config_key, row_config_key: x.k.split('|')[2], config: v.config, saved_by: v.saved_by,
          saved_by_name: 'Admin ' + v.saved_by, saved_at: v.saved_at }]];
      }
      if (/^SELECT c\.config_key, \(SELECT MAX\(v\.id\) FROM ui_config_versions v WHERE v\.ui_config_id = c\.id\) AS version_id FROM ui_config c/.test(s)) {
        const out = [];
        for (const [k, r] of rows) {
          if (!k.startsWith('firm|0|')) continue;
          const ids = versions.filter((v) => v.ui_config_id === r.id).map((v) => v.id);
          out.push({ config_key: k.split('|')[2], version_id: ids.length ? Math.max(...ids) : null });
        }
        return [out];
      }
      throw new Error('uiConfigStore pool: unscripted ' + s);
    },
  };

  const fail = (e) => {
    const err = new Error(e.message);
    err.status = e.status || 500;
    err.body = { status: 'error', message: e.message, ...(e.errors ? { errors: e.errors } : {}) };
    return err;
  };
  const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

  /** apiSend for one signed-in user. canEdit: their firm.settings (the route's can()). */
  function apiFor(auth, { canEdit = true } = {}) {
    const calls = [];
    const send = async (url, method = 'GET', body) => {
      calls.push({ url, method, body: clone(body) });
      const path = String(url).split('?')[0];
      const q = new URLSearchParams(String(url).split('?')[1] || '');
      try {
        if (method === 'GET' && path === '/api/ui-config') {
          const out = { status: 'success', ...(await svc.readFor(db, auth.userId)), can_edit_firm: canEdit };
          if (canEdit) out.firm_versions = await svc.firmVersionIds(db);
          return clone(out);
        }
        if (method === 'GET' && path === '/api/ui-config/pickers') return { status: 'success', tools: [], views: [] };
        if (method === 'PUT' && path === '/api/ui-config') {
          if (clone(body).scope === 'firm' && !canEdit) throw Object.assign(new Error('Forbidden'), { status: 403 });
          return clone({ status: 'success', ...(await svc.write(db, clone(body), auth)) });
        }
        if (!canEdit && /^\/api\/ui-config\/versions/.test(path)) throw Object.assign(new Error('Forbidden'), { status: 403 });
        if (method === 'GET' && path === '/api/ui-config/versions') return clone({ status: 'success', versions: await svc.listVersions(db, q.get('config_key')) });
        let m;
        if (method === 'GET' && (m = /^\/api\/ui-config\/versions\/(\d+)$/.exec(path))) {
          const v = await svc.getVersion(db, m[1]);
          if (!v) throw Object.assign(new Error('Version not found'), { status: 404 });
          const { row_config_key: _k, ...version } = v;
          return clone({ status: 'success', version });
        }
        if (method === 'POST' && (m = /^\/api\/ui-config\/versions\/(\d+)\/restore$/.exec(path))) {
          const b = clone(body) || {};
          return clone({ status: 'success', ...(await svc.restoreVersion(db, m[1], auth, Object.prototype.hasOwnProperty.call(b, 'base') ? b.base : undefined)) });
        }
      } catch (e) { throw fail(e); }
      throw new Error('uiConfigStore api: unscripted ' + method + ' ' + url);
    };
    send.calls = calls;
    return send;
  }

  /** The stored document of scope / user / key, parsed (null: no row). */
  const doc = (scope, user, key) => { const r = rows.get(`${scope}|${user}|${key}`); return r ? JSON.parse(r.config) : null; };
  return { db, rows, versions, apiFor, doc };
}

module.exports = { makeStore };
