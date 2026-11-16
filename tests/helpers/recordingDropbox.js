// tests/helpers/recordingDropbox.js
//
/**
 * RECORDING FAKE of services/dropboxService.js — the storage-seam replay gate
 * (storage-seam D0; design ref/DOCUMENTS_V3_DESIGN.md §0 rule 2).
 *
 * Implements EVERY name dropboxService exports over an in-memory tree and
 * records every provider call a writer makes, so one golden of recorded calls
 * compares a writer before and after it is rerouted through the provider seam.
 * Recorded at THIS boundary on purpose: writers call dropboxService directly
 * today and through documentSourceService → dropboxProvider after D1, and the
 * calls that reach dropboxService are the invariant.
 *
 * Deterministic by construction: ids in creation order (id:F0001 folders,
 * id:f0001 files), shared links `https://www.dropbox.com/scl/fo/<id>?dl=0`,
 * temp links numbered, a fixed clock advanced one second per write, Buffers
 * recorded as {bytes, sha256}, object keys sorted. path_display keeps every
 * space exactly; path_lower is the lowercase of it — the firm's folders are
 * named "  Active Cases" and a fake that trimmed would pass a path the real
 * provider could never open.
 *
 *   jest.mock('../services/dropboxService', () => require('./helpers/recordingDropbox').factory());
 *   const fake = require('../services/dropboxService').__fake;
 *   fake.reset(); fake.seed({ folders, files, credentialId, saveUrlBodies, pages });
 *   … drive a writer …
 *   fake.calls           // [{fn, args}] — the golden's `calls`
 *   fake.snapshot()      // sorted [{tag, path}] — the golden's `provider_state`
 *
 * Error shapes copy the real module's: a missing path is a 409 whose
 * errorSummary starts with 'path/not_found' (isPathNotFoundError is the REAL
 * predicate, required from the actual module), a missing shared link a 409
 * 'shared_link/not_found'. normalizePath / joinPath / httpHeaderSafeJson and
 * the three is*Error predicates are the REAL functions and are not recorded —
 * they are pure helpers, not provider calls. `_rpc` throws: nothing here is
 * allowed to reach the network by accident.
 */

'use strict';

const crypto = require('crypto');

const CLOCK_START = Date.UTC(2026, 10, 17, 12, 0, 0);   // 2026-11-17T12:00:00Z

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

/** Deep copy with sorted keys; Buffers → {bytes, sha256}; undefined dropped. */
function scrub(v) {
  if (Buffer.isBuffer(v)) return { bytes: v.length, sha256: sha256(v) };
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === 'object') {
    if (v instanceof Date) return v.toISOString();
    const out = {};
    for (const k of Object.keys(v).sort()) {
      if (v[k] === undefined) continue;
      out[k] = scrub(v[k]);
    }
    return out;
  }
  return v;
}

function dbxError(status, summary, extra = {}) {
  const err = new Error(`dropbox ${summary} (${status})`);
  err.status = status;
  err.errorSummary = summary;
  err.dropboxError = extra.dropboxError || null;
  return err;
}

function factory() {
  const actual = jest.requireActual('../../services/dropboxService');
  const { normalizePath, joinPath } = actual;

  const state = {
    nodes: new Map(),       // path_lower → node
    byId: new Map(),        // id → node
    links: new Map(),       // shared link url → path_lower
    linkOf: new Map(),      // path_lower → url
    saveUrlBodies: new Map(),
    pages: null,            // seeded listing pages for listFolderPage/Continue
    credentialId: 8,
    nFolder: 0, nFile: 0, nLink: 0, nTemp: 0, nCursor: 0, nJob: 0,
    clock: CLOCK_START,
  };
  const calls = [];
  const rec = (fn, ...args) => { calls.push({ fn, args: scrub(args) }); };

  const tick = () => { state.clock += 1000; return new Date(state.clock).toISOString().replace(/\.\d{3}Z$/, 'Z'); };
  const nameOf = (display) => display.slice(display.lastIndexOf('/') + 1);

  function meta(node) {
    if (node.tag === 'folder') {
      return { '.tag': 'folder', id: node.id, name: node.name, path_display: node.path_display, path_lower: node.path_lower };
    }
    return {
      '.tag': 'file', id: node.id, name: node.name, path_display: node.path_display, path_lower: node.path_lower,
      size: node.size, rev: node.rev, content_hash: node.content_hash,
      server_modified: node.server_modified, client_modified: node.server_modified, is_downloadable: true,
    };
  }

  function mkFolder(display) {
    const lower = display.toLowerCase();
    const existing = state.nodes.get(lower);
    if (existing) {
      if (existing.tag !== 'folder') throw dbxError(409, 'path/conflict/file/..');
      return { node: existing, existed: true };
    }
    const parent = display.slice(0, display.lastIndexOf('/'));
    if (parent) mkFolder(parent);
    state.nFolder += 1;
    const node = { tag: 'folder', id: `id:F${String(state.nFolder).padStart(4, '0')}`, name: nameOf(display), path_display: display, path_lower: lower };
    state.nodes.set(lower, node);
    state.byId.set(node.id, node);
    return { node, existed: false };
  }

  function uniqueName(display) {
    if (!state.nodes.has(display.toLowerCase())) return display;
    const dot = nameOf(display).lastIndexOf('.');
    const parent = display.slice(0, display.lastIndexOf('/') + 1);
    const base = dot > 0 ? nameOf(display).slice(0, dot) : nameOf(display);
    const ext = dot > 0 ? nameOf(display).slice(dot) : '';
    for (let n = 1; ; n++) {
      const cand = `${parent}${base} (${n})${ext}`;
      if (!state.nodes.has(cand.toLowerCase())) return cand;
    }
  }

  function mkFile(display, bytes, { autorename = true, mode = 'add' } = {}) {
    const parent = display.slice(0, display.lastIndexOf('/'));
    if (parent) mkFolder(parent);
    let target = display;
    if (state.nodes.has(display.toLowerCase())) {
      if (mode === 'overwrite') { /* replace in place */ }
      else if (autorename) target = uniqueName(display);
      else throw dbxError(409, 'path/conflict/file/..');
    }
    const lower = target.toLowerCase();
    const prior = state.nodes.get(lower);
    if (prior) state.byId.delete(prior.id);
    state.nFile += 1;
    const node = {
      tag: 'file', id: `id:f${String(state.nFile).padStart(4, '0')}`, name: nameOf(target),
      path_display: target, path_lower: lower, size: bytes.length,
      rev: `rev${String(state.nFile).padStart(6, '0')}`, content_hash: sha256(bytes).slice(0, 64),
      server_modified: tick(), bytes,
    };
    state.nodes.set(lower, node);
    state.byId.set(node.id, node);
    return node;
  }

  function lookup(locator) {
    const s = String(locator);
    if (s.startsWith('id:')) return state.byId.get(s) || null;
    return state.nodes.get(normalizePath(s).toLowerCase()) || null;
  }

  function needNode(locator) {
    const node = lookup(locator);
    if (!node) throw dbxError(409, 'path/not_found/..', { dropboxError: { '.tag': 'path', path: { '.tag': 'not_found' } } });
    return node;
  }

  function linkFor(lower) {
    const have = state.linkOf.get(lower);
    if (have) return have;
    state.nLink += 1;
    const url = `https://www.dropbox.com/scl/fo/fake${String(state.nLink).padStart(4, '0')}?dl=0`;
    state.links.set(url, lower);
    state.linkOf.set(lower, url);
    return url;
  }

  function nodeOfLink(url) {
    const lower = state.links.get(String(url));
    const node = lower ? state.nodes.get(lower) : null;
    if (!node) throw dbxError(409, 'shared_link/not_found/..');
    return node;
  }

  function descendants(lower, recursive) {
    const out = [];
    for (const n of state.nodes.values()) {
      if (n.path_lower === lower) continue;
      if (!n.path_lower.startsWith(lower ? `${lower}/` : '')) continue;
      if (!recursive && n.path_lower.slice(lower.length + (lower ? 1 : 0)).includes('/')) continue;
      out.push(n);
    }
    out.sort((a, b) => (a.path_lower < b.path_lower ? -1 : a.path_lower > b.path_lower ? 1 : 0));
    return out.map(meta);
  }

  function moveNode(from, toDisplay, autorename) {
    const node = needNode(from);
    let target = normalizePath(toDisplay);
    if (state.nodes.has(target.toLowerCase())) {
      if (!autorename) throw dbxError(409, 'to/conflict/..');
      target = uniqueName(target);
    }
    const parent = target.slice(0, target.lastIndexOf('/'));
    if (parent) mkFolder(parent);
    const oldLower = node.path_lower;
    const moved = [node, ...[...state.nodes.values()].filter((n) => n.path_lower.startsWith(`${oldLower}/`))];
    for (const n of moved) {
      const was = n.path_lower;
      state.nodes.delete(was);
      n.path_display = target + n.path_display.slice(oldLower.length);
      n.path_lower = n.path_display.toLowerCase();
      n.name = nameOf(n.path_display);
      state.nodes.set(n.path_lower, n);
      // shared links follow the item (Dropbox keeps a link across a move)
      const url = state.linkOf.get(was);
      if (url) { state.linkOf.delete(was); state.linkOf.set(n.path_lower, url); state.links.set(url, n.path_lower); }
    }
    return { metadata: meta(node) };
  }

  async function _resolveCredential(db, opts = {}) {
    rec('_resolveCredential', opts);
    return opts.credentialId != null ? opts.credentialId : state.credentialId;
  }

  async function resolveLocation(db, credentialId, { path, sharedLink, expectFolder = false } = {}) {
    rec('resolveLocation', credentialId, { path, sharedLink, expectFolder });
    const hasPath = typeof path === 'string' && path !== '';
    const hasLink = typeof sharedLink === 'string' && sharedLink !== '';
    if (hasPath && hasLink) throw new Error('dropbox: provide path OR sharedLink, not both');
    if (!hasPath && !hasLink) throw new Error('dropbox: provide path or sharedLink');
    if (hasPath) return normalizePath(path);
    const node = nodeOfLink(sharedLink);
    if (expectFolder && node.tag !== 'folder') throw new Error(`dropbox: shared link resolves to a ${node.tag}, expected a folder`);
    return normalizePath(node.path_lower);
  }

  async function _dest(db, credentialId, opts) {
    const { path, sharedLink, filename, subfolder } = opts;
    if (path) {
      if (filename) throw new Error('dropbox: provide a full destination path OR sharedLink+filename, not path+filename');
      return normalizePath(path);
    }
    if (!sharedLink) throw new Error('dropbox: provide path or sharedLink');
    if (!filename) throw new Error('dropbox: filename is required with sharedLink');
    const folder = nodeOfLink(sharedLink);
    if (folder.tag !== 'folder') throw new Error('dropbox: shared link resolves to a file, expected a folder');
    return joinPath(folder.path_display, subfolder, filename);
  }

  const mod = {
    normalizePath, joinPath, httpHeaderSafeJson: actual.httpHeaderSafeJson,
    isCursorResetError: actual.isCursorResetError,
    isPathNotFoundError: actual.isPathNotFoundError,
    isTransientError: actual.isTransientError,
    _resolveCredential, resolveLocation,
    async _rpc() { throw new Error('recordingDropbox: _rpc is not modelled — a writer reached for the raw RPC'); },

    async createFolder(db, opts = {}) {
      rec('createFolder', opts);
      const path = normalizePath(opts.path);
      if (!path) throw new Error('dropbox createFolder requires a non-root path');
      const { node, existed } = mkFolder(path);
      return existed ? { path, existed: true } : { path, existed: false, metadata: meta(node) };
    },
    async createSubfolders(db, opts = {}) {
      rec('createSubfolders', opts);
      const base = normalizePath(opts.path);
      if (!base) throw new Error('dropbox createSubfolders requires a non-root path');
      const created = [];
      for (const sub of opts.subfolders || []) {
        if (!sub || typeof sub !== 'string') continue;
        const { existed } = mkFolder(joinPath(base, sub));
        created.push({ path: joinPath(base, sub), existed });
      }
      return created;
    },
    async createFolderWithOptions(db, opts = {}) {
      rec('createFolderWithOptions', opts);
      const path = normalizePath(opts.path);
      const { node, existed } = mkFolder(path);
      const shared_link = opts.shareLink === true ? linkFor(node.path_lower) : null;
      const subfolders_created = [];
      for (const sub of Array.isArray(opts.subfolders) ? opts.subfolders : []) {
        if (!sub || typeof sub !== 'string') continue;
        const r = mkFolder(joinPath(path, sub));
        subfolders_created.push({ path: joinPath(path, sub), existed: r.existed });
      }
      return { path, existed, subfolders_created, shared_link };
    },
    async getOrCreateSharedLink(db, opts = {}) {
      rec('getOrCreateSharedLink', opts);
      const path = normalizePath(opts.path);
      if (!path) throw new Error('dropbox getOrCreateSharedLink requires a non-root path');
      return linkFor(needNode(path).path_lower);
    },
    async getSharedLinkMetadata(db, opts = {}) {
      rec('getSharedLinkMetadata', opts);
      if (!opts.url) throw new Error('dropbox getSharedLinkMetadata requires url');
      return meta(nodeOfLink(opts.url));
    },
    async getMetadata(db, opts = {}) {
      rec('getMetadata', opts);
      const loc = opts.sharedLink ? nodeOfLink(opts.sharedLink).path_lower : opts.path;
      if (!loc || (!String(loc).startsWith('id:') && !normalizePath(loc))) throw new Error('dropbox getMetadata requires a non-root path');
      return meta(needNode(loc));
    },
    async listFolder(db, opts = {}) {
      rec('listFolder', opts);
      const maxEntries = Number(opts.maxEntries) > 0 ? Number(opts.maxEntries) : 2000;
      const lower = opts.sharedLink ? nodeOfLink(opts.sharedLink).path_lower : normalizePath(opts.path ?? '').toLowerCase();
      if (lower && !state.nodes.has(lower)) needNode(lower);
      const entries = descendants(lower, opts.recursive === true);
      return { entries: entries.slice(0, maxEntries), count: Math.min(entries.length, maxEntries), truncated: entries.length > maxEntries };
    },
    async listFolderPage(db, opts = {}) {
      rec('listFolderPage', opts);
      if (state.pages) {
        const page = state.pages[0];
        return { entries: page, cursor: `cur:${++state.nCursor}`, has_more: state.pages.length > 1 };
      }
      const lower = normalizePath(opts.path ?? '').toLowerCase();
      if (lower && !state.nodes.has(lower)) needNode(lower);
      return { entries: descendants(lower, opts.recursive === true), cursor: `cur:${++state.nCursor}`, has_more: false };
    },
    async listFolderContinue(db, opts = {}) {
      rec('listFolderContinue', opts);
      if (!opts.cursor) throw new Error('dropbox listFolderContinue requires cursor');
      if (!state.pages) return { entries: [], cursor: opts.cursor, has_more: false };
      const idx = Number(String(opts.cursor).slice(4));
      const page = state.pages[idx] || [];
      return { entries: page, cursor: `cur:${++state.nCursor}`, has_more: idx + 1 < state.pages.length };
    },
    async movePath(db, opts = {}) {
      rec('movePath', opts);
      if (!opts.toPath) throw new Error('dropbox movePath requires toPath');
      const from = opts.fromSharedLink ? nodeOfLink(opts.fromSharedLink).path_lower : opts.fromPath;
      if (!from || (!String(from).startsWith('id:') && !normalizePath(from))) throw new Error('dropbox: refusing to move root');
      if (!normalizePath(opts.toPath)) throw new Error('dropbox: refusing to move to root path');
      return moveNode(from, opts.toPath, opts.autorename === true);
    },
    async renamePath(db, opts = {}) {
      rec('renamePath', opts);
      if (!opts.newName || typeof opts.newName !== 'string') throw new Error('dropbox renamePath requires newName');
      if (opts.newName.includes('/')) throw new Error('dropbox renamePath: newName must not contain "/" — use movePath to relocate');
      const current = opts.sharedLink ? nodeOfLink(opts.sharedLink).path_lower : normalizePath(opts.path);
      if (!current) throw new Error('dropbox: refusing to rename root');
      // The REAL function derives the parent with lastIndexOf('/') on the
      // locator — on an "id:" handle that chops the id (documentSourceService
      // header). Reproduced faithfully: the golden must show it if a writer does it.
      const idx = current.lastIndexOf('/');
      const parent = current.slice(0, idx);
      return moveNode(current, `${parent}/${opts.newName}`, false);
    },
    async deletePath(db, opts = {}) {
      rec('deletePath', opts);
      const path = opts.sharedLink ? nodeOfLink(opts.sharedLink).path_lower : normalizePath(opts.path);
      if (!path) throw new Error('dropbox: refusing to delete root path');
      const node = needNode(path);
      for (const n of [...state.nodes.values()]) {
        if (n.path_lower === node.path_lower || n.path_lower.startsWith(`${node.path_lower}/`)) {
          state.nodes.delete(n.path_lower); state.byId.delete(n.id);
        }
      }
      return { deleted: true, path };
    },
    async getTemporaryUploadLink(db, opts = {}) {
      rec('getTemporaryUploadLink', opts);
      const { filename, subfolder } = opts;
      if (!filename) throw new Error('dropbox getTemporaryUploadLink requires filename');
      const folder = opts.sharedLink
        ? (() => { const n = nodeOfLink(opts.sharedLink); if (n.tag !== 'folder') throw new Error('dropbox: shared link resolves to a file, expected a folder'); return n.path_display; })()
        : normalizePath(opts.path);
      const fullPath = joinPath(folder, subfolder, filename);
      state.nTemp += 1;
      return { link: `https://content.dropboxapi.com/fake/tul/${state.nTemp}`, path: fullPath };
    },
    async getTemporaryLink(db, opts = {}) {
      rec('getTemporaryLink', opts);
      const loc = opts.sharedLink ? nodeOfLink(opts.sharedLink).path_lower : opts.path;
      if (!loc || (!String(loc).startsWith('id:') && !normalizePath(loc))) throw new Error('dropbox getTemporaryLink requires a non-root path');
      const node = needNode(loc);
      state.nTemp += 1;
      return { link: `https://dl.dropboxusercontent.com/fake/tl/${state.nTemp}`, metadata: meta(node) };
    },
    async saveUrl(db, opts = {}) {
      rec('saveUrl', opts);
      const credentialId = opts.credentialId != null ? opts.credentialId : state.credentialId;
      if (!opts.url) throw new Error('dropbox saveUrl requires url');
      const destPath = await _dest(db, credentialId, opts);
      const body = state.saveUrlBodies.get(String(opts.url));
      if (body == null) {
        state.nJob += 1;
        return { status: 'in_progress', path: destPath, async_job_id: `job${state.nJob}` };
      }
      const node = mkFile(destPath, body, { autorename: true });
      return { status: 'complete', path: destPath, metadata: { ...meta(node) } };
    },
    async checkSaveUrlJob(db, opts = {}) {
      rec('checkSaveUrlJob', opts);
      if (!opts.asyncJobId) throw new Error('dropbox checkSaveUrlJob requires asyncJobId');
      return { status: 'in_progress' };
    },
    async uploadFile(db, opts = {}) {
      rec('uploadFile', opts);
      const credentialId = opts.credentialId != null ? opts.credentialId : state.credentialId;
      const { content, mode = 'add', autorename = true } = opts;
      if (content == null) throw new Error('dropbox uploadFile requires content');
      const body = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
      const destPath = await _dest(db, credentialId, opts);
      return meta(mkFile(destPath, body, { autorename, mode }));
    },
    async downloadFile(db, opts = {}) {
      rec('downloadFile', opts);
      const loc = opts.sharedLink ? nodeOfLink(opts.sharedLink).path_lower : opts.path;
      if (!loc || (!String(loc).startsWith('id:') && !normalizePath(loc))) throw new Error('dropbox downloadFile requires a non-root path');
      const node = needNode(loc);
      if (node.tag !== 'file') throw dbxError(409, 'path/not_file/..');
      return { buffer: Buffer.from(node.bytes), metadata: meta(node) };
    },
  };

  mod.__fake = {
    calls,
    reset() {
      calls.length = 0;
      state.nodes.clear(); state.byId.clear(); state.links.clear(); state.linkOf.clear();
      state.saveUrlBodies.clear(); state.pages = null; state.credentialId = 8;
      state.nFolder = state.nFile = state.nLink = state.nTemp = state.nCursor = state.nJob = 0;
      state.clock = CLOCK_START;
    },
    /** folders: [display]; files: [{path, bytes}]; links: [path] (minted in order); saveUrlBodies: {url: bytes}; pages: [[entries]]. */
    seed({ folders = [], files = [], links = [], credentialId, saveUrlBodies, pages } = {}) {
      for (const f of folders) mkFolder(normalizePath(f));
      for (const f of files) mkFile(normalizePath(f.path), Buffer.isBuffer(f.bytes) ? f.bytes : Buffer.from(String(f.bytes ?? ''), 'utf8'), { autorename: false });
      const out = {};
      for (const p of links) out[p] = linkFor(needNode(p).path_lower);
      if (credentialId != null) state.credentialId = credentialId;
      for (const [url, body] of Object.entries(saveUrlBodies || {})) state.saveUrlBodies.set(url, Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8'));
      if (pages) state.pages = pages;
      return out;
    },
    linkFor(path) { return linkFor(needNode(path).path_lower); },
    /** The browser "uploaded" to a temp upload link: materialize the file. */
    simulateUpload(path, bytes) { return meta(mkFile(normalizePath(path), Buffer.from(bytes), { autorename: true })); },
    node(locator) { const n = lookup(locator); return n ? meta(n) : null; },
    snapshot() {
      return [...state.nodes.values()]
        .map((n) => ({ tag: n.tag, path: n.path_display, ...(n.tag === 'file' ? { size: n.size } : {}) }))
        .sort((a, b) => (a.path.toLowerCase() < b.path.toLowerCase() ? -1 : 1));
    },
    scrub,
  };
  return mod;
}

module.exports = { factory, scrub, CLOCK_START };
