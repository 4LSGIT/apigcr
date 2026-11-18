// tests/helpers/storageReplayWorld.js
//
/**
 * THE WORLD the storage replay scenarios run in (storage-seam D0).
 *
 * A 4LSG-shaped fixture (cases with and without folders, a dead link, an org
 * contact with a trailing period, a stored email with attachments) behind a
 * `db.query` ROUTER that answers the exact SQL the writers send — and THROWS
 * on a SELECT it does not know, so a writer reaching for a row this world
 * never modelled fails loudly instead of degrading into a different rung.
 *
 * Effects — what a writer asked the registry, the task service, the e-sign
 * store or the sync engine's row layer to do — are recorded here too, so the
 * golden catches a refactor that drops the move-task raise or a registry
 * link, not only one that changes a provider call.
 */

'use strict';

const { scrub } = require('./recordingDropbox');

const ACTIVE_ROOT    = '/  Law Office/   Cases/  Active Cases';
const POTENTIAL_ROOT = '/  Law Office/   Cases/  Potential Cases';
const BINS = {
  uploads:   '/  Law Office/   Cases/  Unsorted Client Uploads',
  generated: '/  Law Office/   Cases/  Unsorted Generated Documents',
  forms:     '/  Law Office/   Cases/  Unsorted Form Submissions',
  esign:     '/  Law Office/   Cases/  Unsorted E-Signed Documents',
};
const CASE_A_FOLDER = `${ACTIVE_ROOT}/  Active - Bankruptcy/ hjSFMabb - Smith, John - 26-44274 - Ch 13`;
const CASE_A_POTENTIAL_FOLDER = `${POTENTIAL_ROOT}/  Potential - Bankruptcy/ Smith, John - hjSFMabb - 2026-06-01`;

function baseFixture() {
  return {
    cases: {
      hjSFMabb: { case_id: 'hjSFMabb', case_type: 'Bankruptcy', case_subtype: 'Ch 13', case_number: '26-44274', case_number_full: '26-44274-mar', case_dropbox: null, case_stage: 'Filed', case_status: 'Open', pipeline_phase: 'case' },
      k9PotLd2: { case_id: 'k9PotLd2', case_type: 'Bankruptcy', case_subtype: '',      case_number: '',         case_number_full: '',           case_dropbox: null, case_stage: 'Open',  case_status: 'Open', pipeline_phase: 'lead' },
      aCtv7Num: { case_id: 'aCtv7Num', case_type: 'Bankruptcy', case_subtype: 'Ch 7',  case_number: '26-50001', case_number_full: '26-50001-lsg', case_dropbox: null, case_stage: 'Filed', case_status: 'Open', pipeline_phase: 'case' },
      deadLnk1: { case_id: 'deadLnk1', case_type: 'Bankruptcy', case_subtype: 'Ch 7',  case_number: '26-50002', case_number_full: '26-50002-lsg', case_dropbox: 'https://www.dropbox.com/scl/fo/gone0000?dl=0', case_stage: 'Filed', case_status: 'Open', pipeline_phase: 'case' },
      orgCase1: { case_id: 'orgCase1', case_type: 'Litigation', case_subtype: '',      case_number: '',         case_number_full: '',           case_dropbox: null, case_stage: 'Open',  case_status: 'Open', pipeline_phase: 'lead' },
    },
    contacts: {
      501: { contact_id: 501, contact_name: 'John Smith', contact_lfm_name: 'Smith, John' },
      502: { contact_id: 502, contact_name: 'Jane Doe',   contact_lfm_name: 'Doe, Jane' },
      503: { contact_id: 503, contact_name: 'Bob Brown',  contact_lfm_name: 'Brown, Bob' },
      504: { contact_id: 504, contact_name: 'Ann Lee',    contact_lfm_name: 'Lee, Ann' },
      505: { contact_id: 505, contact_name: 'Legacy Signature Properties, Inc.', contact_lfm_name: 'Legacy Signature Properties, Inc.' },
    },
    primary: { hjSFMabb: 501, k9PotLd2: 502, aCtv7Num: 503, deadLnk1: 504, orgCase1: 505 },
    settings: { storage_folders: JSON.stringify({ contact: null }) },   // app_settings rows; absent = the code default. D3c-2: the 4LSG-shaped world keeps NO contact folders (its live row says so; the case block falls to the code default)
    messages: {
      9001: {
        id: 9001, mailbox_id: 1, folder: 'INBOX', uid: 10, message_id: '<m1@example.com>', provider_id: null,
        from_addr: 'John Smith <john@example.com>', to_addrs: 'docs@4lsg.com', cc_addrs: null,
        subject: 'Pay stubs', date: new Date('2026-11-15T14:30:00Z'), body_text: 'see attached', body_html: null,
        attachments: JSON.stringify([
          { part: '2', filename: 'paystub.pdf', size: 1400, mime: 'application/pdf' },
          { part: '3', filename: 'logo.png', size: 300, mime: 'image/png', cid: 'logo1' },
          { part: '4', filename: 'notes.eml', size: 900, mime: 'message/rfc822' },
        ]),
        log_id: null,
      },
    },
    filings: [],                        // mail_attachment_filings rows
    caseFolderCache: [],
    entityFolders: {},                  // entity_folders rows by case_id (D3b-1: the filing readers' source); seeded by the test as the backfill would
    nextId: 1,
    effects: [],
  };
}

function makeDb(w) {
  const effect = (kind, data) => w.effects.push({ kind, ...scrub(data) });
  const ok = (affectedRows = 1, insertId = 0) => [{ affectedRows, insertId, changedRows: affectedRows }];
  const rows = (r) => [r, []];

  async function query(sql, params = []) {
    const s = String(sql).replace(/\s+/g, ' ').trim();

    // ── cases ─────────────────────────────────────────────────────────────
    // D3d-2: the refresh's candidates are the bindings' links (the column is retired)
    if (/^SELECT f\.entity_id AS case_id, f\.human_link AS link FROM entity_folders f WHERE f\.entity_kind = 'case' AND f\.source = 'dropbox' AND f\.entity_id IN \(\?\)/.test(s)) {
      const ids = (params[0] || []).map(String);
      return rows(Object.entries(w.entityFolders).filter(([k, b]) => !k.includes(':') && ids.includes(k) && b.human_link).map(([k, b]) => ({ case_id: k, link: b.human_link })));
    }
    if (/^SELECT case_id FROM cases WHERE case_number = \?/.test(s)) {
      const c = Object.values(w.cases).find((x) => x.case_number === String(params[0]));
      return rows(c ? [{ case_id: c.case_id }] : []);
    }
    if (/^SELECT .* FROM cases(?: c)? WHERE (?:c\.)?case_id = \?/.test(s)) {
      const c = w.cases[String(params[0])];
      return rows(c ? [{ ...c }] : []);
    }
    // ── contacts ──────────────────────────────────────────────────────────
    if (/FROM case_relate cr JOIN contacts c ON/.test(s)) {
      const cid = w.primary[String(params[0])];
      const c = cid ? w.contacts[cid] : null;
      return rows(c ? [{ contact_id: c.contact_id, contact_name: c.contact_name, contact_lfm_name: c.contact_lfm_name }] : []);
    }
    if (/^SELECT .* FROM contacts WHERE contact_id = \?/.test(s)) {
      const c = w.contacts[Number(params[0])];
      return rows(c ? [{ ...c }] : []);
    }
    // ── app_settings ──────────────────────────────────────────────────────
    let m = s.match(/FROM app_settings WHERE `key` = (?:\?|'([a-z_]+)')/);
    if (m) {
      const key = m[1] || String(params[0]);
      const v = w.settings[key];
      return rows(v == null ? [] : [{ value: v }]);
    }
    // ── mail store ────────────────────────────────────────────────────────
    if (/FROM mail_messages WHERE id = \?/.test(s)) {
      const r = w.messages[Number(params[0])];
      return rows(r ? [{ ...r }] : []);
    }
    if (/^INSERT IGNORE INTO mail_attachment_filings/.test(s)) {
      const [mid, part, filename] = params;
      if (w.filings.some((f) => f.mail_message_id === Number(mid) && f.part === String(part))) return ok(0);
      const row = { id: w.nextId++, mail_message_id: Number(mid), part: String(part), filename, status: 'filing', claimed_at: new Date(), size: null, link_type: null, link_id: null, placement: null, match_method: null, dropbox_path: null, dropbox_id: null, document_id: null, filed_by: null, filed_at: null };
      w.filings.push(row);
      return ok(1, row.id);
    }
    if (/^SELECT \* FROM mail_attachment_filings WHERE mail_message_id = \? AND part = \?/.test(s)) {
      return rows(w.filings.filter((f) => f.mail_message_id === Number(params[0]) && f.part === String(params[1])).map((f) => ({ ...f })));
    }
    if (/^SELECT \* FROM mail_attachment_filings WHERE mail_message_id = \? AND status = 'filed'/.test(s)) {
      return rows(w.filings.filter((f) => f.mail_message_id === Number(params[0]) && f.status === 'filed').map((f) => ({ ...f })));
    }
    if (/^UPDATE mail_attachment_filings SET status = 'filed'/.test(s)) {
      const id = Number(params[params.length - 1]);
      const f = w.filings.find((x) => x.id === id && x.status === 'filing');
      if (f) Object.assign(f, { status: 'filed', size: params[0], link_type: params[1], link_id: params[2], placement: params[3], match_method: params[4], dropbox_path: params[5], dropbox_id: params[6], document_id: params[7], filed_by: params[8], filed_at: new Date() });
      effect('mail_attachment_filings.filed', { id, link_type: params[1], link_id: params[2], placement: params[3], match_method: params[4], dropbox_path: params[5], document_id: params[7] });
      return ok(f ? 1 : 0);
    }
    if (/^UPDATE mail_attachment_filings SET link_type = 'case'/.test(s)) {
      const id = Number(params[params.length - 1]);
      const f = w.filings.find((x) => x.id === id);
      if (f) Object.assign(f, { link_type: 'case', link_id: params[0], placement: params[1], match_method: 'refiled', dropbox_path: params[2], dropbox_id: params[3] || f.dropbox_id, document_id: params[4] || f.document_id });
      effect('mail_attachment_filings.refiled', { id, link_id: params[0], placement: params[1], dropbox_path: params[2], dropbox_id: params[3] });
      return ok(f ? 1 : 0);
    }
    if (/^UPDATE mail_attachment_filings f JOIN documents d/.test(s)) return ok(0);
    if (/^UPDATE mail_attachment_filings SET claimed_at/.test(s)) return ok(0);
    if (/^DELETE FROM mail_attachment_filings WHERE id = \?/.test(s)) {
      const i = w.filings.findIndex((f) => f.id === Number(params[0]));
      if (i >= 0) w.filings.splice(i, 1);
      effect('mail_attachment_filings.released', { id: params[0] });
      return ok(i >= 0 ? 1 : 0);
    }
    if (/mail_attachment_notices/.test(s)) return /^SELECT/.test(s) ? rows([]) : ok(1);
    if (/checklist/i.test(s)) return rows([]);
    // ── sync engine rows ──────────────────────────────────────────────────
    if (/^UPDATE document_sync_roots/.test(s)) { effect('document_sync_roots.update', { sql: s.slice(0, 60), params }); return ok(1); }
    // D3b-2: the sync engine's reads are on the binding, aliased to the cache's column names
    if (/^SELECT entity_id AS case_id, external_id AS folder_external_id, path_lower FROM entity_folders WHERE entity_kind = 'case' AND source = 'dropbox' AND path_lower IS NOT NULL/.test(s)) {
      return rows(Object.entries(w.entityFolders).filter(([id, b]) => b.path_lower && !id.includes(':')).map(([id, b]) => ({ case_id: id, folder_external_id: b.external_id ?? null, path_lower: b.path_lower })));
    }
    if (/^SELECT path_lower(?:, human_link)? FROM entity_folders WHERE entity_kind = 'case' AND source = 'dropbox' AND entity_id = \?/.test(s)) {
      const b = w.entityFolders[String(params[0])];
      return rows(b ? [{ path_lower: b.path_lower ?? null, human_link: b.human_link ?? null }] : []);
    }
    // ── entity_folders (D3b-1): modelled as state so a later read sees an earlier write, as MySQL would ──
    // keyed by case_id for kind 'case' (the sync reads list them by case) and 'contact:<id>' for kind 'contact' (D3c-2)
    const efKey = (kind, id) => (kind === 'case' ? String(id) : `${kind}:${id}`);
    if (/^SELECT external_id, path_lower, human_link FROM entity_folders WHERE entity_kind = \? AND entity_id = \? AND source = \?/.test(s)) {
      const b = w.entityFolders[efKey(params[0], params[1])];
      return rows(b ? [{ external_id: b.external_id ?? null, path_lower: b.path_lower ?? null, human_link: b.human_link ?? null }] : []);
    }
    if (/^SELECT path_lower, resolve_error FROM entity_folders WHERE entity_kind = \? AND entity_id = \? AND source = \?/.test(s)) {
      const b = w.entityFolders[efKey(params[0], params[1])];
      return rows(b ? [{ path_lower: b.path_lower ?? null, resolve_error: b.resolve_error ?? null }] : []);
    }
    if (/^SELECT \* FROM entity_folders WHERE entity_kind = \?/.test(s)) {
      const b = w.entityFolders[efKey(params[0], params[1])];
      return rows(b ? [{ entity_kind: params[0], entity_id: String(params[1]), source: 'dropbox', ...b }] : []);
    }
    if (/^INSERT INTO entity_folders \(entity_kind, entity_id, source, external_id, path_lower, path_display, human_link, resolve_error, resolved_at\)/.test(s)) {   // setResolved
      const [kind, id, , ext, pl, pd, link] = params;
      { const k = efKey(kind, id); const b = w.entityFolders[k] || {}; w.entityFolders[k] = { external_id: ext ?? b.external_id ?? null, path_lower: pl ?? b.path_lower ?? null, path_display: pd ?? b.path_display ?? null, human_link: link ?? b.human_link ?? null, resolve_error: null }; }
      effect('entity_folders.upsert', { params }); return ok(1);
    }
    if (/^INSERT INTO entity_folders \(entity_kind, entity_id, source, human_link, resolve_error, resolved_at\)/.test(s)) {   // setError
      const [kind, id, , link, error] = params;
      { const k = efKey(kind, id); const b = w.entityFolders[k] || {}; w.entityFolders[k] = { ...b, human_link: link ?? b.human_link ?? null, resolve_error: error }; }
      effect('entity_folders.upsert', { params }); return ok(1);
    }
    if (/^INSERT INTO entity_folders \(entity_kind, entity_id, source, human_link\)/.test(s)) {   // setHumanLink
      const [kind, id, , link] = params;
      { const k = efKey(kind, id); const b = w.entityFolders[k]; w.entityFolders[k] = b && b.human_link === link ? b : { external_id: null, path_lower: null, path_display: null, human_link: link, resolve_error: null }; }
      effect('entity_folders.upsert', { params }); return ok(1);
    }
    if (/^INSERT INTO entity_folders/.test(s)) { effect('entity_folders.upsert', { params }); return ok(1); }
    if (/^UPDATE entity_folders SET path_lower = \?, path_display = \?/.test(s)) {   // setPaths
      const [pl, pd, kind, id] = params;
      if (w.entityFolders[efKey(kind, id)]) Object.assign(w.entityFolders[efKey(kind, id)], { path_lower: pl, path_display: pd, resolve_error: null });
      effect('entity_folders.update', { params }); return ok(1);
    }
    if (/^UPDATE entity_folders/.test(s)) { effect('entity_folders.update', { params }); return ok(1); }
    if (/^DELETE FROM entity_folders/.test(s)) { delete w.entityFolders[efKey(params[0], params[1])]; effect('entity_folders.delete', { params }); return ok(1); }
    if (/FROM document_sync_roots WHERE enabled = 1/.test(s)) return rows([]);
    // ── anything else ─────────────────────────────────────────────────────
    if (/^(INSERT|UPDATE|DELETE)/.test(s)) { effect('db.write.unmodelled', { sql: s.slice(0, 120) }); return ok(1); }
    throw new Error(`storageReplayWorld: unmodelled SELECT — ${s.slice(0, 160)}`);
  }

  return { query, effect };
}

/** {{key}} → values[key]; unknown keys stay as written (the engine's behaviour). */
function substitute(v, values) {
  if (typeof v === 'string') return v.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in values ? values[k] : m));
  if (Array.isArray(v)) return v.map((x) => substitute(x, values));
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = substitute(v[k], values); return o; }
  return v;
}

module.exports = { baseFixture, makeDb, substitute, scrub, ACTIVE_ROOT, POTENTIAL_ROOT, BINS, CASE_A_FOLDER, CASE_A_POTENTIAL_FOLDER };
