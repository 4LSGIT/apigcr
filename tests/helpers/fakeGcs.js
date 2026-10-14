// tests/helpers/fakeGcs.js
//
// In-memory stand-in for @google-cloud/storage at the GCS BOUNDARY — the
// subset services/commsArchiveService.js calls. It models the two behaviours
// the archive's correctness rests on:
//   - createWriteStream({preconditionOpts:{ifGenerationMatch:0}}) refuses an
//     existing name with a 412 at finalize;
//   - an upload whose source errors (pipeline destroys the stream) is never
//     finalized — no object appears, exactly like an aborted GCS upload.
// Failure injection: fail.list / fail.put / fail.read / fail.sign / fail.perms / fail.exists / fail.delete
// = {code} (the call rejects); fail.putMid = {code} errors the upload on its
// FIRST chunk while the source is still flowing (how the real library fails a
// 403 / socket reset); fail.stall = true makes an upload accept nothing and
// never finish (a silent GCS); denied = Set of IAM permissions not granted.

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
              const pre = opts.preconditionOpts && opts.preconditionOpts.ifGenerationMatch;
              if (pre === 0 && objects.has(name)) return cb(err({ code: 412, message: 'conditionNotMet' }));
              const o = { buf: Buffer.concat(chunks), contentType: opts.metadata && opts.metadata.contentType, generation: String(++gen) };
              objects.set(name, o);
              f.metadata = { contentType: o.contentType, generation: o.generation };
              cb();
            },
          });
        },
        createReadStream() {
          calls.read++;
          if (fail.read) { const r = new Readable({ read() {} }); process.nextTick(() => r.destroy(err(fail.read))); return r; }
          const o = objects.get(name);
          if (!o) { const r = new Readable({ read() {} }); process.nextTick(() => r.destroy(err({ code: 404 }))); return r; }
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
          calls.deleted = calls.deleted || [];
          calls.deleted.push(name);
          if (!objects.has(name) && !o.ignoreNotFound) throw err({ code: 404 });
          objects.delete(name);
          return [{}];
        },
        async getSignedUrl(o) {
          if (fail.sign) throw err(fail.sign);
          calls.sign.push({ name, ...o });
          return [`https://storage.googleapis.com/fake/${name}?sig`];
        },
      };
      return f;
    },
  });

  return { storage: { bucket }, objects, fail, denied, hooks, calls };
}

module.exports = { fakeStorage };
