// tests/helpers/fakeGcs.js
//
// In-memory stand-in for @google-cloud/storage at the GCS BOUNDARY — the
// subset services/commsArchiveService.js calls. It models the two behaviours
// the archive's correctness rests on:
//   - createWriteStream({preconditionOpts:{ifGenerationMatch:0}}) refuses an
//     existing name with a 412 at finalize;
//   - an upload whose source errors (pipeline destroys the stream) is never
//     finalized — no object appears, exactly like an aborted GCS upload.
// Failure injection: fail.list / fail.put / fail.read / fail.sign / fail.perms / fail.exists / fail.delete (fail.deleteNames = Set: only those)
// = {code} (the call rejects); fail.putMid = {code} errors the upload on its
// FIRST chunk while the source is still flowing (how the real library fails a
// 403 / socket reset); fail.stall = true makes an upload accept nothing and
// never finish (a silent GCS); denied = Set of IAM permissions not granted.
// signedHttp(url) stands in for GETting a signed URL (S2's signing proof and
// the STT vendor's fetch).

'use strict';

const { Writable, Readable } = require('stream');

function fakeStorage() {
  const objects = new Map();   // name → { buf, contentType, generation }
  const fail = {};
  const denied = new Set();
  const hooks = {};              // hooks.exists = async (name) => {} — runs inside exists()
  const calls = { list: 0, put: 0, read: 0, sign: [] };
  let gen = 1000;

  const err = (spec) => Object.assign(new Error(spec.message || `fake gcs ${spec.code}`), { code: spec.code });

  const bucket = (_name) => ({
    iam: {
      async testPermissions(perms) {
        calls.perms = (calls.perms || 0) + 1;
        if (fail.perms) throw err(fail.perms);
        return [Object.fromEntries([].concat(perms).map(p => [p, !denied.has(p)]))];
      },
    },
    async getFiles({ prefix = '' } = {}) {
      calls.list++;
      if (fail.list) throw err(fail.list);
      const files = [...objects.entries()]
        .filter(([n]) => n.startsWith(prefix))
        .map(([n, o]) => ({ name: n, metadata: { size: String(o.buf.length), contentType: o.contentType, generation: o.generation } }));
      return [files];
    },
    file(name) {
      const f = {
        name,
        metadata: objects.has(name)
          ? { contentType: objects.get(name).contentType, generation: objects.get(name).generation }
          : {},
        createWriteStream(opts = {}) {
          calls.put++;
          const chunks = [];
          return new Writable({
            write(c, _e, cb) {
              if (fail.stall) return;                    // never calls back
              if (fail.putMid) return cb(err(fail.putMid));
              chunks.push(c); cb();
            },
            final(cb) {
              if (fail.put) return cb(err(fail.put));
              if (fail.putPrefix && name.startsWith(fail.putPrefix)) return cb(err({ code: 403 }));
              const pre = opts.preconditionOpts && opts.preconditionOpts.ifGenerationMatch;
              if (pre === 0 && objects.has(name)) return cb(err({ code: 412, message: 'conditionNotMet' }));
              const o = { buf: Buffer.concat(chunks), contentType: opts.metadata && opts.metadata.contentType, generation: String(++gen) };
              objects.set(name, o);
              f.metadata = { contentType: o.contentType, generation: o.generation };
              cb();
            },
          });
        },
        createReadStream(ro = {}) {
          calls.read++;
          if (fail.read) { const r = new Readable({ read() {} }); process.nextTick(() => r.destroy(err(fail.read))); return r; }
          const o = objects.get(name);
          if (!o) { const r = new Readable({ read() {} }); process.nextTick(() => r.destroy(err({ code: 404 }))); return r; }
          if (ro.start != null || ro.end != null) {           // ranged read: inclusive end, like the library
            calls.ranged = (calls.ranged || 0) + 1;
            return Readable.from([o.buf.subarray(ro.start || 0, ro.end != null ? ro.end + 1 : undefined)]);
          }
          return Readable.from([o.buf]);
        },
        async exists() {
          calls.exists = (calls.exists || 0) + 1;
          if (fail.exists) throw err(fail.exists);
          const live = objects.has(name);
          if (hooks.exists) await hooks.exists(name);
          return [live];
        },
        async delete(o = {}) {
          if (fail.delete) throw err(fail.delete);
          if (fail.deleteNames && fail.deleteNames.has(name)) throw err({ code: 503 });
          calls.deleted = calls.deleted || [];
          calls.deleted.push(name);
          if (!objects.has(name) && !o.ignoreNotFound) throw err({ code: 404 });
          objects.delete(name);
          return [{}];
        },
        async getSignedUrl(o) {
          if (fail.sign) throw err(fail.sign);
          // A V4-shaped URL: a signature over (name, expires) that signedHttp() below checks.
          const sig = require('crypto').createHash('sha256').update(`${name}|${o.expires}`).digest('hex');
          const url = `https://storage.googleapis.com/fake/${name}?X-Goog-Expires=${o.expires}&X-Goog-Signature=${sig}`;
          calls.sign.push({ name, ...o, url });
          return [url];
        },
      };
      return f;
    },
  });

  /**
   * GCS's HTTP side for a signed URL (what AssemblyAI or the signing proof
   * GETs): 200 + the object's bytes only for a URL this fake minted, unexpired
   * and untampered; 403 otherwise. httpFail.status forces a status.
   */
  const httpFail = {};
  async function signedHttp(url) {
    calls.http = (calls.http || 0) + 1;
    if (httpFail.status) return { status: httpFail.status, text: httpFail.text || '' };
    const minted = calls.sign.find(c => c.url === url);
    if (!minted || minted.expires < Date.now()) return { status: 403, text: '<Error>SignatureDoesNotMatch</Error>' };
    const o = objects.get(minted.name);
    if (!o) return { status: 404, text: '' };
    return { status: 200, text: o.buf.toString('latin1'), buf: o.buf };
  }

  return { storage: { bucket }, objects, fail, denied, hooks, calls, signedHttp, httpFail };
}

module.exports = { fakeStorage };
