/**
 * @jest-environment node
 *
 * tests/commsArchive.s4.pane.test.js — comms archive S4 in public/comms.html
 * (the Phone tab's conversation), booted in jsdom against a stub shell
 * apiSend (the tests/phoneSPH.pane.test.js harness):
 *   - a call bubble: its summary (S3) as TEXT, Listen → GET …/media/:id/url →
 *     an <audio> on the signed URL (only storage.googleapis.com is ever used),
 *     the same player node kept across a quiet re-read, one re-mint
 *     (?renew=1) when the URL dies mid-playback; a voicemail on the call;
 *   - the transcript viewer: the R8 label, segments as TEXT, a timestamp
 *     seeks the player;
 *   - a text's files: images inline from a signed URL, a PDF / other file as
 *     a chip opening the archive viewer, files still archiving, a purged
 *     tombstone; the old note only when the archive holds nothing;
 *   - archive admins only: the ⋯ → Restrict / Unrestrict / Purge dialog —
 *     reason required, purge needs the item number AND the password, the
 *     password is cleared after every send.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const COMMS = fs.readFileSync(path.join(ROOT, 'public/comms.html'), 'utf8');
const PURIFY = fs.readFileSync(path.join(ROOT, 'public/js/vendor/purify-3.4.16.min.js'), 'utf8');
const RENDER = fs.readFileSync(path.join(ROOT, 'public/js/mailRender.js'), 'utf8');
const COLOR = fs.readFileSync(path.join(ROOT, 'public/js/mailboxColor.js'), 'utf8');

const DOMS = [];
afterEach(() => { DOMS.splice(0).forEach((d) => { try { d.window.close(); } catch (_) { /* noop */ } }); });
const tick = (w, ms = 40) => new Promise((r) => w.setTimeout(r, ms));
const fresh = (v) => JSON.parse(JSON.stringify(v));
const EVIL = '<img src=x onerror="window.top.__pwned=1">';
const SIGNED = (id) => `https://storage.googleapis.com/lsg-yc-comms-archive/obj-${id}?X-Goog-Signature=abc`;

function inlineScripts(html) {
  const noComments = html.replace(/<!--[\s\S]*?-->/g, '');
  const bodyHtml = (noComments.match(/<body[^>]*>([\s\S]*)<\/body>/) || [])[1] || '';
  const inline = [...noComments.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  return { bodyHtml: bodyHtml.replace(/<script[\s\S]*?<\/script>/g, ''), inline };
}

async function boot(handler, { before = null } = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', { url: 'https://app.4lsg.com/comms.html', runScripts: 'dangerously', pretendToBeVisual: true });
  DOMS.push(dom);
  const { window } = dom;
  window.Element.prototype.scrollIntoView = function () {};
  // jsdom has no media pipeline: play / pause are recorded, never real.
  window.HTMLMediaElement.prototype.play = function () { this.__played = (this.__played || 0) + 1; return Promise.resolve(); };
  window.HTMLMediaElement.prototype.pause = function () { this.__paused = true; };
  Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true });
  window.firmData = { firmTimezone: 'America/Detroit', currentUser: { user_auth: 'authorized', roles: 'staff' } };
  const calls = [];
  window.apiSend = async (u, method = 'GET', payload = null) => {
    calls.push({ url: u, method, payload: payload == null ? null : JSON.parse(JSON.stringify(payload)) });
    return handler(u, method, payload);
  };
  if (before) before(window);
  const { bodyHtml, inline } = inlineScripts(COMMS);
  window.document.body.innerHTML = bodyHtml;
  expect(inline.length).toBe(1);
  const errors = [];
  window.addEventListener('error', (e) => errors.push(String(e.error || e.message)));
  window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
  for (const src of [PURIFY, RENDER, COLOR, inline[0]]) {
    const sc = window.document.createElement('script');
    sc.textContent = src;
    window.document.body.appendChild(sc);
  }
  await tick(window, 80);
  return { window, doc: window.document, calls, errors };
}

const LINES = [{ id: 1, phone_number: '2485592400', display_name: 'Stuart', provider: 'ringcentral', active: true, mms_capable: true, can_read: true, can_send: true, can_manage: false }];
const PARTY = '3135550001';
const THREAD = (over = {}) => ({
  status: 'success', line_id: 1, other_party: PARTY, contact: null, next_cursor: null, archive_admin: false,
  messages: [
    { id: 10, kind: 'call', direction: 'incoming', at: '2026-10-08T15:00:00.000Z', logged: true, duration_s: 300, status: 'Accepted', unanswered: false, missed: false,
      archive: { media_id: 501, has_audio: true, has_transcript: true, summary_text: `Client asked about the 341 ${EVIL}`, restricted: false, extra: [] } },
    { id: 11, kind: 'call', direction: 'incoming', at: '2026-10-08T16:00:00.000Z', logged: true, duration_s: 20, status: 'no-answer', unanswered: true, missed: true,
      voicemail: { media_id: 502, provider: 'quo', has_audio: true, has_transcript: false, restricted: false } },
    { id: 12, kind: 'sms', direction: 'incoming', body: '', at: '2026-10-08T17:00:00.000Z', logged: false,
      attachments: [
        { media_id: 601, mime: 'image/jpeg', view: 'image', bytes: 50_000, restricted: false },
        { media_id: 602, mime: 'application/pdf', view: 'pdf', bytes: 2_500_000, restricted: false },
        { media_id: 603, mime: 'text/vcard', view: 'file', bytes: 300, restricted: false },
      ] },
    { id: 13, kind: 'sms', direction: 'incoming', body: 'pic coming', at: '2026-10-08T17:01:00.000Z', logged: false, attachments_pending: 2 },
    { id: 14, kind: 'sms', direction: 'incoming', body: ' ', at: '2026-10-08T17:02:00.000Z', logged: false },
    { id: 15, kind: 'call', direction: 'outgoing', at: '2026-10-08T18:00:00.000Z', logged: true, duration_s: 60, status: 'Accepted', unanswered: false, missed: false,
      archive: { media_id: 503, purged: { at: '2026-10-09T09:00:00.000Z', by: 'Fred', reason: `personal ${EVIL}` } } },
  ],
  ...over,
});

function handler({ thread = THREAD(), urls = {}, transcript = null, posts = {} } = {}) {
  return (url, method, payload) => {
    if (url === '/api/mail/mailboxes') return { mailboxes: [], viewer: { su: false, role: null, can_send: false } };
    if (url === '/api/mail/views') return { views: [] };
    if (url === '/api/mail/views/counts') return { counts: {} };
    if (url === '/api/mail/messages') return { messages: [], next_cursor: null };
    if (url === '/api/phone-lines/readable') return { viewer: { su: false }, lines: fresh(LINES) };
    if (url === '/api/phone-lines/1/conversations') return { conversations: [{ other_party: PARTY, count: 6, last_id: 15, contact: null, last: { id: 15, kind: 'call', direction: 'outgoing', at: '2026-10-08T18:00:00.000Z' } }], next_cursor: null };
    if (url === `/api/phone-lines/1/conversations/${PARTY}`) return fresh(typeof thread === 'function' ? thread() : thread);
    let m = /^\/api\/comms-archive\/media\/(\d+)\/url(\?renew=1)?$/.exec(url);
    if (m) {
      const f = urls[m[1]];
      if (typeof f === 'function') return f(!!m[2]);
      return { status: 'success', url: SIGNED(m[1]) + (m[2] ? '&r=1' : ''), mime: 'audio/mpeg', inline: true, expires_in: 300 };
    }
    m = /^\/api\/comms-archive\/media\/(\d+)\/transcript$/.exec(url);
    if (m) return transcript ? transcript(m[1]) : { status: 'success', media_id: Number(m[1]), source: 'assemblyai', label: 'AI-generated — check the recording before relying on it', segments: [], text: '' };
    m = /^\/api\/comms-archive\/media\/(\d+)\/(restrict|unrestrict|purge)$/.exec(url);
    if (m && method === 'POST') { const f = posts[m[2]]; if (f) return f(payload); return { status: 'success', media: { id: Number(m[1]) } }; }
    throw new Error(`unexpected ${method} ${url}`);
  };
}

async function openThread(env) {
  env.doc.getElementById('tab-phone').click();
  await tick(env.window, 60);
  env.doc.querySelector(`#ph-list .msg[data-party="${PARTY}"]`).click();
  await tick(env.window, 60);
}
const bub = (doc, id) => doc.querySelector(`#ph-body .bub[data-id="${id}"]`);
const btn = (el, label) => [...el.querySelectorAll('button')].find((b) => b.textContent.trim() === label);
const archiveCalls = (calls) => calls.filter((c) => c.url.startsWith('/api/comms-archive'));

describe('comms.html — archive on the call bubble', () => {
  test('summary as TEXT; Listen mints a URL and plays it in the bubble; nothing minted before the click', async () => {
    const env = await boot(handler());
    await openThread(env);
    const { doc, window, calls } = env;
    const b = bub(doc, 10);
    expect(b.querySelector('.ca-sum').textContent).toBe(`Client asked about the 341 ${EVIL}`);
    expect(b.querySelector('.ca-sum img')).toBeNull();
    expect(window.__pwned).toBeUndefined();
    expect(archiveCalls(calls).filter((c) => /\/50[123]\//.test(c.url))).toEqual([]);   // Listen is on demand
    btn(b, 'Listen').click();
    await tick(window);
    const a = b.querySelector('audio');
    expect(a.getAttribute('src')).toBe(SIGNED(501));
    expect(a.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(a.__played).toBe(1);
    expect(archiveCalls(calls).map((c) => c.url)).toContain('/api/comms-archive/media/501/url');
    expect(env.errors).toEqual([]);
  });

  test('R8: a summary always carries the "AI-generated" label (house hint class, no inline style); no summary, no label', async () => {
    const env = await boot(handler());
    await openThread(env);
    const { doc } = env;
    const b = bub(doc, 10);
    const label = b.querySelector('.ca-ai');
    expect(label && label.textContent).toBe('AI-generated — check the recording before relying on it');
    expect(label.classList.contains('yc-hint')).toBe(true);
    expect(label.getAttribute('style')).toBeNull();
    expect(label.previousElementSibling.className).toBe('ca-sum');
    expect(bub(doc, 11).querySelector('.ca-ai')).toBeNull();                 // a voicemail call with no summary
    expect(bub(doc, 15).querySelector('.ca-ai')).toBeNull();                 // a purged recording
  });

  test('a URL that is not storage.googleapis.com is refused — never put in a src', async () => {
    const env = await boot(handler({ urls: { 501: () => ({ status: 'success', url: 'https://evil.example/x.mp3', mime: 'audio/mpeg', inline: true, expires_in: 300 }) } }));
    await openThread(env);
    const b = bub(env.doc, 10);
    btn(b, 'Listen').click();
    await tick(env.window);
    expect(b.querySelector('audio')).toBeNull();
    expect(env.doc.getElementById('toast').textContent).toMatch(/unexpected link/);
  });

  test('a quiet re-read keeps the SAME player node (playback survives); an expired URL re-mints once with renew=1', async () => {
    const env = await boot(handler());
    await openThread(env);
    const { doc, window, calls } = env;
    btn(bub(doc, 10), 'Listen').click();
    await tick(window);
    const a = bub(doc, 10).querySelector('audio');
    window.eval(`openConversation('${PARTY}', null, { silent: true })`);
    await tick(window, 60);
    expect(bub(doc, 10).querySelector('audio')).toBe(a);
    a.dispatchEvent(new window.Event('error'));
    await tick(window);
    expect(a.getAttribute('src')).toBe(`${SIGNED(501)}&r=1`);
    expect(archiveCalls(calls).filter((c) => c.url === '/api/comms-archive/media/501/url?renew=1')).toHaveLength(1);
    btn(bub(doc, 10), 'Listen').click();                                      // Listen again: the same player, no new mint
    await tick(window);
    expect(bub(doc, 10).querySelectorAll('audio')).toHaveLength(1);
    expect(bub(doc, 10).querySelector('audio')).toBe(a);
    expect(archiveCalls(calls).filter((c) => c.url === '/api/comms-archive/media/501/url')).toHaveLength(1);
    a.dispatchEvent(new window.Event('error'));                              // a second failure: no loop
    await tick(window);
    expect(archiveCalls(calls).filter((c) => c.url === '/api/comms-archive/media/501/url?renew=1')).toHaveLength(1);
  });

  test('a call recorded in several files: Part 2 plays its own URL in the same slot', async () => {
    const t = THREAD();
    t.messages[0].archive.extra = [511];
    const env = await boot(handler({ thread: t }));
    await openThread(env);
    const b = bub(env.doc, 10);
    btn(b, 'Part 2').click();
    await tick(env.window);
    expect(b.querySelectorAll('audio')).toHaveLength(1);
    expect(b.querySelector('audio').getAttribute('src')).toBe(SIGNED(511));
    btn(b, 'Listen').click();
    await tick(env.window);
    expect(b.querySelectorAll('audio')).toHaveLength(1);
    expect(b.querySelector('audio').getAttribute('src')).toBe(SIGNED(501));
  });

  test('a voicemail on the call: chip + Listen (no Transcript when it has none); a purged recording is a tombstone of TEXT', async () => {
    const env = await boot(handler());
    await openThread(env);
    const { doc } = env;
    const v = bub(doc, 11);
    expect(v.querySelector('.ca-vm').textContent).toBe('Voicemail');
    expect(btn(v, 'Listen')).toBeTruthy();
    expect(btn(v, 'Transcript')).toBeUndefined();
    const t = bub(doc, 15).querySelector('.ca-purged');
    expect(t.textContent).toMatch(/Call recording purged .*2026 by Fred: personal <img/);
    expect(t.querySelector('img')).toBeNull();
    expect(btn(bub(doc, 15), 'Listen')).toBeUndefined();
  });
});

describe('comms.html — transcript viewer', () => {
  test('label on top, segments as TEXT with speakers, a timestamp plays from that moment', async () => {
    const env = await boot(handler({ transcript: () => ({ status: 'success', source: 'assemblyai', label: 'AI-generated — check the recording before relying on it',
      segments: [{ s: 'A', a: 0, b: 3, t: `Hello ${EVIL}` }, { s: 'B', a: 65.4, b: 70, t: 'Hi there' }], text: 'x' }) }));
    await openThread(env);
    const { doc, window } = env;
    btn(bub(doc, 10), 'Transcript').click();
    await tick(window);
    expect(doc.getElementById('ca-tx-backdrop').classList.contains('open')).toBe(true);
    expect(doc.getElementById('ca-tx-label').textContent).toBe('AI-generated — check the recording before relying on it');
    const segs = [...doc.querySelectorAll('#ca-tx-body .ca-seg')];
    expect(segs.map((s) => s.textContent)).toEqual([`0:00Speaker AHello ${EVIL}`, '1:05Speaker BHi there']);
    expect(doc.querySelector('#ca-tx-body img')).toBeNull();
    btn(segs[1], '1:05').click();
    await tick(window);
    const a = doc.querySelector('#ca-tx-player audio');
    expect(a.getAttribute('src')).toBe(SIGNED(501));
    expect(a.currentTime).toBe(65.4);
    window.eval(`openConversation('${PARTY}', null, { silent: true })`);     // a quiet re-read (post-send recheck) meanwhile
    await tick(window, 60);
    expect(doc.querySelector('#ca-tx-player audio')).toBe(a);                // the player stays in the open viewer
    btn(doc.getElementById('ca-tx-backdrop'), 'Close').click();
    await tick(window);
    expect(doc.getElementById('ca-tx-backdrop').classList.contains('open')).toBe(false);
    expect(bub(doc, 10).querySelector('audio')).toBe(a);                     // back in its bubble
    expect(env.errors).toEqual([]);
  });

  test('multichannel segments say Channel 1 / 2 (S2 writes ch1, ch2); a transcript with no speech says so', async () => {
    let which = 'multi';
    const env = await boot(handler({ transcript: () => (which === 'multi'
      ? { status: 'success', source: 'assemblyai', label: 'AI-generated — check the recording before relying on it', segments: [{ s: 'ch1', a: 0, b: 1, t: 'One.' }, { s: 'ch2', a: 1, b: 2, t: 'Two.' }], text: 'One.\nTwo.' }
      : { status: 'success', source: 'assemblyai', label: 'AI-generated — check the recording before relying on it', segments: [], text: '' }) }));
    await openThread(env);
    const { doc, window } = env;
    btn(bub(doc, 10), 'Transcript').click();
    await tick(window);
    expect([...doc.querySelectorAll('#ca-tx-body .ca-spk')].map((x) => x.textContent)).toEqual(['Channel 1', 'Channel 2']);
    btn(doc.getElementById('ca-tx-backdrop'), 'Close').click();
    which = 'silent';
    btn(bub(doc, 10), 'Transcript').click();
    await tick(window);
    expect(doc.querySelector('#ca-tx-body .ca-seg').textContent).toBe('No speech was transcribed.');
  });

  test('the provider\'s own transcript (no segments) is one block of text under its label', async () => {
    const env = await boot(handler({
      thread: THREAD({ messages: [{ ...THREAD().messages[1], voicemail: { media_id: 502, provider: 'quo', has_audio: true, has_transcript: true, restricted: false } }] }),
      transcript: () => ({ status: 'success', source: 'provider', vendor: 'quo', label: "The phone provider's automatic transcript (machine-generated) — check the recording before relying on it", segments: [], text: `Call me ${EVIL}` }),
    }));
    await openThread(env);
    btn(bub(env.doc, 11), 'Transcript').click();
    await tick(env.window);
    expect(env.doc.getElementById('ca-tx-label').textContent).toMatch(/phone provider's automatic transcript/);
    expect(env.doc.querySelector('#ca-tx-body .ca-seg').textContent).toBe(`Call me ${EVIL}`);
    expect(env.window.__pwned).toBeUndefined();
  });
});

describe('comms.html — files on a text', () => {
  test('image inline from its signed URL; PDF and vCard as chips; archiving count; the old note only when the archive holds nothing', async () => {
    const env = await boot(handler({ urls: {
      601: () => ({ status: 'success', url: SIGNED(601), mime: 'image/jpeg', inline: true, expires_in: 300 }),
      602: () => ({ status: 'success', url: SIGNED(602), mime: 'application/pdf', inline: true, expires_in: 300 }),
      603: () => ({ status: 'success', url: SIGNED(603), mime: 'text/vcard', inline: false, expires_in: 300 }),
    } }));
    await openThread(env);
    const { doc, window, calls } = env;
    const b = bub(doc, 12);
    expect(b.querySelector('.ca-thumb img').getAttribute('src')).toBe(SIGNED(601));
    expect(b.querySelector('.ca-thumb img').getAttribute('referrerpolicy')).toBe('no-referrer');
    expect([...b.querySelectorAll('.ca-file')].map((x) => x.textContent)).toEqual(['PDF · 2.4 MB', 'File · 1 KB']);
    expect(b.querySelector('.ph-att')).toBeNull();
    expect(bub(doc, 13).querySelector('.ca-note').textContent).toMatch(/2 attachments — archiving/);
    expect(bub(doc, 14).querySelector('.ph-att').textContent).toBe('Attachment — not shown here yet');
    // PDF → the archive viewer, an iframe on the signed URL + New tab
    btn(b, 'PDF · 2.4 MB').click();
    await tick(window);
    expect(doc.querySelector('#ca-view-body iframe').getAttribute('src')).toBe(SIGNED(602));
    expect(doc.querySelector('#ca-view-body iframe').getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(doc.getElementById('ca-view-tab').getAttribute('href')).toBe(SIGNED(602));
    btn(doc.getElementById('ca-view-backdrop'), 'Close').click();
    // a type that never renders inline → a Download link, nothing embedded
    btn(b, 'File · 1 KB').click();
    await tick(window);
    expect(doc.querySelector('#ca-view-body iframe')).toBeNull();
    expect(doc.querySelector('#ca-view-body a').getAttribute('href')).toBe(SIGNED(603));
    expect(doc.getElementById('ca-view-tab').hidden).toBe(true);
    // the image's URL was minted once, then cached; the SAME <img> survives a re-read (no reload / flash)
    const img = b.querySelector('.ca-thumb img');
    window.eval(`openConversation('${PARTY}', null, { silent: true })`);
    await tick(window, 60);
    expect(bub(doc, 12).querySelector('.ca-thumb img')).toBe(img);
    expect(calls.filter((c) => c.url === '/api/comms-archive/media/601/url')).toHaveLength(1);
    expect(env.errors).toEqual([]);
  });
});

describe('comms.html — pictures mint only when seen (review A3)', () => {
  test('no URL is minted for a picture until it scrolls into view; then once', async () => {
    const seen = [];
    const before = (w) => {
      w.IntersectionObserver = class {
        constructor(cb, opts) { this.cb = cb; this.opts = opts; this.els = new Set(); seen.push(this); }
        observe(el) { this.els.add(el); }
        unobserve(el) { this.els.delete(el); }
        disconnect() { this.els.clear(); }
        fire(el) { this.cb([{ target: el, isIntersecting: true }]); }
      };
    };
    const env = await boot(handler({ urls: { 601: () => ({ status: 'success', url: SIGNED(601), mime: 'image/jpeg', inline: true, expires_in: 300 }) } }), { before });
    await openThread(env);
    const { doc, window, calls } = env;
    const img = bub(doc, 12).querySelector('.ca-thumb img');
    expect(img.getAttribute('src')).toBeNull();
    expect(calls.filter((c) => c.url === '/api/comms-archive/media/601/url')).toHaveLength(0);
    expect(seen).toHaveLength(1);
    expect(seen[0].els.has(img)).toBe(true);
    seen[0].cb([{ target: img, isIntersecting: false }]);                 // near but not in: nothing
    await tick(window);
    expect(calls.filter((c) => c.url === '/api/comms-archive/media/601/url')).toHaveLength(0);
    seen[0].fire(img);
    await tick(window);
    expect(img.getAttribute('src')).toBe(SIGNED(601));
    expect(seen[0].els.has(img)).toBe(false);
    seen[0].fire(img);                                                     // a late duplicate entry: no second mint
    await tick(window);
    expect(calls.filter((c) => c.url === '/api/comms-archive/media/601/url')).toHaveLength(1);
    expect(env.errors).toEqual([]);
  });
});

describe('comms.html — a picture that will not load', () => {
  test('a failed mint or a failed image load turns the thumbnail into a chip (kept across a re-read); the chip still opens the viewer', async () => {
    const env = await boot(handler({ urls: {
      601: () => { const e = new Error('Archive item not found'); e.status = 404; throw e; },
    }, thread: THREAD({ messages: [{ ...THREAD().messages[2], attachments: [
      { media_id: 601, mime: 'image/jpeg', view: 'image', bytes: 50_000, restricted: false },
      { media_id: 604, mime: 'image/png', view: 'image', bytes: 2048, restricted: false },
    ] }] }) }));
    await openThread(env);
    const { doc, window } = env;
    expect(bub(doc, 12).querySelectorAll('.ca-thumb')).toHaveLength(1);    // 601: the mint failed
    expect(btn(bub(doc, 12), 'Picture · 49 KB')).toBeTruthy();
    bub(doc, 12).querySelector('.ca-thumb img').dispatchEvent(new window.Event('error'));   // 604: the bytes did not render
    expect(bub(doc, 12).querySelectorAll('.ca-thumb')).toHaveLength(0);
    window.eval(`openConversation('${PARTY}', null, { silent: true })`);
    await tick(window, 60);
    expect([...bub(doc, 12).querySelectorAll('.ca-file')].map((b) => b.textContent)).toEqual(['Picture · 49 KB', 'Picture · 2 KB']);
    btn(bub(doc, 12), 'Picture · 2 KB').click();
    await tick(window);
    expect(doc.querySelector('#ca-view-body img').getAttribute('src')).toBe(SIGNED(604));
    expect(doc.querySelector('#ca-view-body img').getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(env.errors).toEqual([]);
  });
});

describe('comms.html — restrict / purge (archive admins)', () => {
  test('no ⋯ for a viewer who is not an archive admin', async () => {
    const env = await boot(handler());
    await openThread(env);
    expect(env.doc.querySelector('#ph-body [aria-label^="Manage"]')).toBeNull();
  });

  test('restrict: reason required, POST {reason}, the thread is re-read', async () => {
    const env = await boot(handler({ thread: THREAD({ archive_admin: true }) }));
    await openThread(env);
    const { doc, window, calls } = env;
    bub(doc, 10).querySelector('[aria-label="Manage call recording in the archive"]').click();
    expect(doc.getElementById('ca-act-title').textContent).toBe('Restrict call recording #501');
    btn(doc.getElementById('ca-act-backdrop'), 'Restrict').click();
    await tick(window);
    expect(doc.getElementById('ca-act-msg').textContent).toBe('A reason is required.');
    doc.getElementById('ca-act-reason').value = 'privileged';
    const before = calls.length;
    btn(doc.getElementById('ca-act-backdrop'), 'Restrict').click();
    await tick(window, 60);
    expect(calls.slice(before).map((c) => [c.method, c.url, c.payload])).toEqual([
      ['POST', '/api/comms-archive/media/501/restrict', { reason: 'privileged' }],
      ['GET', `/api/phone-lines/1/conversations/${PARTY}`, null],
    ]);
    expect(doc.getElementById('ca-act-backdrop').classList.contains('open')).toBe(false);
  });

  test('purge: item number AND password required; the body carries both; the password is cleared after a refusal', async () => {
    let n = 0;
    const env = await boot(handler({ thread: THREAD({ archive_admin: true }), posts: { purge: () => {
      n++;
      if (n === 1) { const e = new Error('Incorrect password'); e.status = 403; throw e; }
      return { status: 'success' };
    } } }));
    await openThread(env);
    const { doc, window, calls } = env;
    const dlg = doc.getElementById('ca-act-backdrop');
    bub(doc, 12).querySelector('.ca-att[data-media="602"] [aria-label="Manage attachment in the archive"]').click();
    btn(dlg, 'Purge…').click();
    expect(doc.getElementById('ca-purge-fields').hidden).toBe(false);
    expect(doc.getElementById('ca-act-pw').getAttribute('type')).toBe('password');
    doc.getElementById('ca-act-reason').value = 'client asked';
    doc.getElementById('ca-act-confirm').value = '601';
    btn(dlg, 'Purge for good').click();
    await tick(window);
    expect(doc.getElementById('ca-act-msg').textContent).toBe('Type 602 to confirm the purge.');
    doc.getElementById('ca-act-confirm').value = '602';
    btn(dlg, 'Purge for good').click();
    await tick(window);
    expect(doc.getElementById('ca-act-msg').textContent).toBe('Enter your password to confirm the purge.');
    doc.getElementById('ca-act-pw').value = 'wrong';
    btn(dlg, 'Purge for good').click();
    await tick(window);
    expect(doc.getElementById('ca-act-msg').textContent).toBe('Incorrect password');
    expect(doc.getElementById('ca-act-pw').value).toBe('');
    doc.getElementById('ca-act-pw').value = 'right one';
    btn(dlg, 'Purge for good').click();
    await tick(window, 60);
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts.map((c) => c.payload)).toEqual([
      { reason: 'client asked', confirm: 602, password: 'wrong' },
      { reason: 'client asked', confirm: 602, password: 'right one' },
    ]);
    expect(dlg.classList.contains('open')).toBe(false);
    expect(doc.getElementById('ca-act-pw').value).toBe('');
    expect(env.errors).toEqual([]);
  });

  test('a restricted item says so (admins only ever receive one) and the dialog offers Unrestrict', async () => {
    const t = THREAD({ archive_admin: true });
    t.messages[0].archive.restricted = true;
    const env = await boot(handler({ thread: t }));
    await openThread(env);
    const b = bub(env.doc, 10);
    expect(b.querySelector('.ca-badge').textContent).toBe('Restricted');
    b.querySelector('[aria-label="Manage call recording in the archive"]').click();
    expect(btn(env.doc.getElementById('ca-act-backdrop'), 'Unrestrict')).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// systemAlerts.html — the Comms archive health section (design §10, F4)
// ─────────────────────────────────────────────────────────────────────────────
describe('systemAlerts.html — Comms archive health', () => {
  const SA = fs.readFileSync(path.join(ROOT, 'public/systemAlerts.html'), 'utf8');
  const PAGER = fs.readFileSync(path.join(ROOT, 'public/js/ycPager.js'), 'utf8');
  const HEALTH = {
    status: 'success', at: '2026-10-14T12:00:00.000Z',
    media: [
      { kind: 'call_recording', provider: 'ringcentral', state: 'archived', n: 877, restricted: 2 },
      { kind: 'call_recording', provider: 'ringcentral', state: 'pending', n: 1338, restricted: 0 },
      { kind: 'mms_file', provider: 'quo', state: 'pending', n: 36, restricted: 0 },
    ],
    pending: [{ kind: 'mms_file', provider: 'quo', n: 36, oldest_captured: '2026-06-09T13:24:59.000Z', oldest_created: '2026-10-14T07:20:00.000Z' }],
    pending_errors: [{ kind: 'mms_file', provider: 'quo', error: `quo 403 0200403 on /v1/messages/{id}: ${EVIL}`, n: 33 }],
    jobs: [{ key: 'comms_archive_media_sweep', name: 'Comms Archive Media Sweep', recurrence: '*/2 * * * *', active: true, status: 'pending',
      last: { status: 'success', at: '2026-10-14T11:58:00.000Z', duration_ms: 4100, output: { archived: 3, quo_forbidden: 1, nested: { x: 1 } }, error: null } }],
    alerts: [{ id: 632, severity: 'error', group_key: 'comms_archive_quo_forbidden:2489655355', title: `Quo forbids line ${EVIL}`, created_at: '2026-10-14T12:30:00.000Z', acked_at: null }],
    transcripts: null, cost: null,
  };

  async function bootSA(health) {
    const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', { url: 'https://app.4lsg.com/systemAlerts.html', runScripts: 'dangerously', pretendToBeVisual: true });
    DOMS.push(dom);
    const { window } = dom;
    const calls = [];
    const parent = {
      firmData: { currentUser: { roles: 'it,admin,su' } },
      apiSend: async (u, method = 'GET') => {
        calls.push(`${method} ${u}`);
        if (u.startsWith('/admin/system-alerts?')) return { rows: [], total: 0, counts: { open_critical: 0, open_error: 0, open_warning: 0, acked: 0, resolved_7d: 0, undigested: 0 }, sources: [] };
        if (u === '/api/comms-archive/health') { if (health instanceof Error) throw health; return JSON.parse(JSON.stringify(health)); }
        throw new Error(`unexpected ${method} ${u}`);
      },
    };
    Object.defineProperty(window, 'parent', { value: parent, configurable: true });
    const { bodyHtml, inline } = inlineScripts(SA);
    window.document.body.innerHTML = bodyHtml;
    for (const src of [PAGER, ...inline]) {
      const sc = window.document.createElement('script');
      sc.textContent = src;
      window.document.body.appendChild(sc);
    }
    await tick(window, 80);
    return { window, doc: window.document, calls };
  }

  test('closed: nothing is read; opened: the tables, every value as TEXT; Refresh re-reads while open', async () => {
    const { window, doc, calls } = await bootSA(HEALTH);
    doc.getElementById('btnRefresh').click();                                // Refresh while CLOSED reads alerts only
    await tick(window);
    expect(calls.filter((c) => c.includes('comms-archive'))).toEqual([]);
    const d = doc.getElementById('caHealth');
    d.open = true;                                                           // fires 'toggle'
    await tick(window);
    const body = doc.getElementById('caHealthBody');
    const rows = [...body.querySelectorAll('table')[0].querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent));
    expect(rows).toEqual([
      ['call_recording', 'ringcentral', '877', '1338', '0', '0', '0', '0', '2'],
      ['mms_file', 'quo', '0', '36', '0', '0', '0', '0', '0'],
    ]);
    expect(body.textContent).toContain(`quo 403 0200403 on /v1/messages/{id}: ${EVIL}`);
    expect(body.textContent).toContain('archived=3 quo_forbidden=1');
    expect(body.textContent).not.toContain('nested');
    expect(body.textContent).toContain(`Quo forbids line ${EVIL}`);
    expect(body.textContent).toContain('Not set up yet');
    expect(body.querySelector('img')).toBeNull();
    expect(window.__pwned).toBeUndefined();
    doc.getElementById('btnRefresh').click();
    await tick(window);
    expect(calls.filter((c) => c === 'GET /api/comms-archive/health')).toHaveLength(2);
  });

  test('a failed read says so in the section', async () => {
    const { window, doc } = await bootSA(new Error('Elevation required'));
    const d = doc.getElementById('caHealth');
    d.open = true;                                                           // fires 'toggle'
    await tick(window);
    expect(doc.getElementById('caHealthBody').textContent).toBe('Could not load the archive health: Elevation required');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// comms.html — S6 "In call transcripts" (the mailbox arc's search bar fires
// `ph-search` on #phone; S6 owns #ph-search-transcripts)
// ─────────────────────────────────────────────────────────────────────────────
describe('comms.html — S6 transcript search results', () => {
  const HIT = (over = {}) => ({ media_id: 501, event_id: 10, source_table: 'phone_event_log', line_id: 1, party: PARTY, kind: 'call_recording',
    captured_at: '2026-10-08T15:00:00.000Z', restricted: false, snippet: `about the Bankruptcy filing (rebankr) ${EVIL}`, snippet_at: 65.4, snippet_from: 'transcript', ...over });
  function searchHandler({ search, transcript } = {}) {
    const base = handler({ transcript });
    return (url, method, payload) => {
      if (url === '/api/comms-archive/search' && method === 'POST') return search(payload);
      return base(url, method, payload);
    };
  }
  const fire = (env, q, lineId = 1) => env.doc.getElementById('phone').dispatchEvent(new env.window.CustomEvent('ph-search', { detail: { q, lineId } }));
  const posts = (calls) => calls.filter((c) => c.url === '/api/comms-archive/search').map((c) => c.payload);
  const slot = (doc) => doc.getElementById('ph-search-transcripts');
  const openPhone = async (env) => { env.doc.getElementById('tab-phone').click(); await tick(env.window, 60); };

  test('typed in the bar: under 3 letters no request (hidden); then POST {q, line_id}; hits as TEXT with the words marked', async () => {
    const env = await boot(searchHandler({ search: () => ({ status: 'success', results: [HIT()], next_cursor: null, terms: ['bankr'], ignored: [] }) }));
    env.doc.getElementById('tab-phone').click();
    await tick(env.window, 60);
    const { doc, window, calls } = env;
    const box = doc.getElementById('ph-q');
    box.value = 'ba'; box.dispatchEvent(new window.Event('input'));
    await tick(window, 450);
    expect(posts(calls)).toEqual([]);
    expect(slot(doc).hidden).toBe(true);
    box.value = 'bankr'; box.dispatchEvent(new window.Event('input'));
    await tick(window, 450);
    expect(posts(calls)).toEqual([{ q: 'bankr', line_id: 1 }]);
    expect(slot(doc).hidden).toBe(false);
    expect(slot(doc).querySelector('.ca-sh').textContent).toBe('In call transcripts');
    const hit = slot(doc).querySelector('.ca-hit');
    expect(hit.querySelector('.snip').textContent).toBe(`about the Bankruptcy filing (rebankr) ${EVIL}`);
    expect([...hit.querySelectorAll('mark')].map((m) => m.textContent)).toEqual(['Bankruptcy']);
    expect(hit.querySelector('.snip img')).toBeNull();
    expect(window.__pwned).toBeUndefined();
    expect(hit.querySelector('.who').textContent).toBe('(313) 555-0001');
    box.value = ''; box.dispatchEvent(new window.Event('input'));            // cleared → hidden, nothing sent
    await tick(window);
    expect(slot(doc).hidden).toBe(true);
    expect(posts(calls)).toHaveLength(1);
    expect(env.errors).toEqual([]);
  });

  test('"the to" (3+ letters but nothing usable) → the server 400 echo, quietly; a stopword-only word is shown as not searched', async () => {
    const env = await boot(searchHandler({ search: () => { const e = new Error('A search needs a word of 3 or more letters or digits'); e.status = 400; e.body = { terms: [], ignored: ['the', 'to'] }; throw e; } }));
    await openPhone(env);
    fire(env, 'the to');
    await tick(env.window);
    expect(slot(env.doc).hidden).toBe(false);
    expect(slot(env.doc).querySelector('.ca-snote').textContent).toBe('Transcripts are searched by words of 3 or more letters or digits — not searched: the, to');
    expect(slot(env.doc).querySelector('.ca-hit')).toBeNull();
  });

  test('404 (line not readable) hides the group; 429 says so politely; All numbers sends no line_id and tags each hit with its line', async () => {
    let mode = '404';
    const env = await boot(searchHandler({ search: () => {
      if (mode === 'ok') return { status: 'success', results: [HIT({ line_id: 1 })], next_cursor: null, terms: ['bankr'], ignored: [] };
      const e = new Error('x'); e.status = mode === '404' ? 404 : 429; e.body = {}; throw e;
    } }));
    await openPhone(env);
    const { doc, window, calls } = env;
    fire(env, 'bankruptcy');
    await tick(window);
    expect(slot(doc).hidden).toBe(true);
    mode = '429';
    fire(env, 'bankruptcy filing');
    await tick(window);
    expect(slot(doc).querySelector('.ca-snote').textContent).toBe('Searching transcripts too often — try again in a few minutes.');
    mode = 'ok';
    window.eval("ph.lineId = 'all'");
    fire(env, 'bankruptcy', 'all');
    await tick(window);
    expect(posts(calls).pop()).toEqual({ q: 'bankruptcy' });
    expect([...slot(doc).querySelectorAll('.ca-hit .when')].map((x) => x.textContent)[0]).toBe('Stuart');
  });

  test('a newer search always wins: a slow first answer arriving last is dropped', async () => {
    const pending = [];
    const env = await boot(searchHandler({ search: (p) => new Promise((resolve) => pending.push({ p, resolve })) }));
    await openPhone(env);
    const { doc, window } = env;
    fire(env, 'alpha');
    fire(env, 'bravo');
    await tick(window);
    pending[1].resolve({ status: 'success', results: [HIT({ media_id: 2, snippet: 'bravo words' })], next_cursor: null, terms: ['bravo'], ignored: [] });
    await tick(window);
    pending[0].resolve({ status: 'success', results: [HIT({ media_id: 1, snippet: 'alpha words' })], next_cursor: null, terms: ['alpha'], ignored: [] });
    await tick(window);
    expect([...slot(doc).querySelectorAll('.ca-hit')].map((b) => b.dataset.media)).toEqual(['2']);
    fire(env, 'charlie');                                                    // in flight…
    await tick(window);
    fire(env, '');                                                           // …then cleared: its answer must not reopen the group
    pending[2].resolve({ status: 'success', results: [HIT({ media_id: 3, snippet: 'charlie words' })], next_cursor: null, terms: ['charlie'], ignored: [] });
    await tick(window);
    expect(slot(doc).hidden).toBe(true);
    expect(slot(doc).querySelector('.ca-hit')).toBeNull();
  });

  test('More: posts the cursor, appends, and disappears at the end; an empty search says so', async () => {
    const env = await boot(searchHandler({ search: (p) => (p.cursor
      ? { status: 'success', results: [HIT({ media_id: 9, snippet: 'page two bankruptcy' })], next_cursor: null, terms: ['bankruptcy'], ignored: [] }
      : p.q === 'zebra' ? { status: 'success', results: [], next_cursor: null, terms: ['zebra'], ignored: [] }
        : { status: 'success', results: [HIT()], next_cursor: '1759000000000.501', terms: ['bankruptcy'], ignored: [] }) }));
    await openPhone(env);
    const { doc, window, calls } = env;
    fire(env, 'bankruptcy');
    await tick(window);
    btn(slot(doc), 'More').click();
    await tick(window);
    expect(posts(calls)).toEqual([{ q: 'bankruptcy', line_id: 1 }, { q: 'bankruptcy', line_id: 1, cursor: '1759000000000.501' }]);
    expect([...slot(doc).querySelectorAll('.ca-hit')].map((b) => b.dataset.media)).toEqual(['501', '9']);
    expect(btn(slot(doc), 'More')).toBeUndefined();
    fire(env, 'zebra');
    await tick(window);
    expect(slot(doc).querySelector('.ca-sst').textContent).toBe('No call transcripts match.');
  });

  test('opening a hit opens its conversation and the transcript, the hit\'s segment marked', async () => {
    const env = await boot(searchHandler({
      search: () => ({ status: 'success', results: [HIT()], next_cursor: null, terms: ['bankr'], ignored: [] }),
      transcript: () => ({ status: 'success', source: 'assemblyai', label: 'AI-generated — check the recording before relying on it',
        segments: [{ s: 'A', a: 0, b: 3, t: 'Hello' }, { s: 'B', a: 65.4, b: 70, t: 'about the Bankruptcy filing' }, { s: 'A', a: 71, b: 72, t: 'ok' }], text: '' }),
    }));
    await openPhone(env);
    const { doc, window, calls } = env;
    fire(env, 'bankruptcy');
    await tick(window);
    slot(doc).querySelector('.ca-hit').click();
    await tick(window, 80);
    expect(calls.some((c) => c.url === `/api/phone-lines/1/conversations/${PARTY}`)).toBe(true);
    expect(doc.getElementById('ca-tx-backdrop').classList.contains('open')).toBe(true);
    expect(doc.getElementById('ca-tx-title').textContent).toBe('Call recording — transcript');
    expect([...doc.querySelectorAll('#ca-tx-body .ca-seg')].map((p) => p.classList.contains('hit'))).toEqual([false, true, false]);
    expect(env.errors).toEqual([]);
  });
});
