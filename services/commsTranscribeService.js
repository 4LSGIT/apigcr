// services/commsTranscribeService.js
//
/**
 * Comms archive S2 — READ helpers over stored transcripts, for callers outside
 * the sweep (S0's evaluation route today; S4's transcript viewer later).
 * Grant-blind like every service: the CALLER does the access check (design
 * §7) — and must honour comms_media.restricted by JOIN (R9).
 *
 *   variantSegments(db, mediaId) -> [{s, a, b, t}] | null
 *     The sample-mode OTHER Quo-stereo variant (design §6.3): the stt_raw
 *     child whose part is the variant NOT in comms_transcripts (parts are
 *     named by variant — 'assemblyai' diarized, 'assemblyai-mc'
 *     multichannel — so with the default diarize this is 'assemblyai-mc').
 *     Reads its JSON from the archive bucket and parses it with
 *     commsTranscribeVendor.segmentsFromVendorJson. null when there is no
 *     variant (mono, mode on, not yet transcribed, or purged). Throws ourSide
 *     on a storage failure, err.code 'DRIFT' on an unreadable JSON.
 */

'use strict';

const archive = require('./commsArchiveService');
const vendor = require('./commsTranscribeVendor');

/** A stored vendor JSON larger than this is not read into memory here (a 4-hour call is a few MB). */
const MAX_JSON_BYTES = 50 * 1024 * 1024;

async function variantSegments(db, mediaId) {
  const [[t]] = await db.query(
    `SELECT t.stt_model, t.state FROM comms_transcripts t WHERE t.media_id = ?`, [mediaId]);
  if (t && t.state === 'purged') return null;
  const canonical = /\+multichannel$/.test(String((t && t.stt_model) || '')) ? 'multichannel' : 'diarize';
  const part = vendor.VARIANTS[canonical === 'diarize' ? 'multichannel' : 'diarize'].part;
  const [[c]] = await db.query(
    `SELECT object_name, bytes FROM comms_media
      WHERE source_table = 'comms_media' AND source_id = ? AND kind = 'stt_raw' AND part = ? AND state = 'archived'`,
    [mediaId, part]);
  if (!c || !c.object_name) return null;
  const n = Number(c.bytes);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_JSON_BYTES) {
    const e = new Error(`variant JSON for comms_media ${mediaId} has an unusable size (${c.bytes})`);
    e.code = 'DRIFT';
    throw e;
  }
  const buf = await archive.readHead(c.object_name, n);
  let json;
  try { json = JSON.parse(buf.toString('utf8')); } catch (_) {
    const e = new Error(`variant JSON for comms_media ${mediaId} is not JSON`);
    e.code = 'DRIFT';
    throw e;
  }
  return vendor.segmentsFromVendorJson(json);
}

module.exports = { variantSegments, MAX_JSON_BYTES };
