// tests/videoTracker.test.js
//
/**
 * The tracker inline in views/v.html, run for real in jsdom against a stub
 * video element: what a page reports decides Completed, so the page is what
 * has to be right. Chromium's own `video.played` was checked by hand
 * (2026-11-01); here the ranges are set per test.
 *
 *   - Seconds come from the played ranges, not currentTime, so dragging the
 *     bar to the end reports almost nothing, even when `ended` fires.
 *   - Every report carries the view's token.
 *   - The last few seconds are flushed on the way out, once.
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const TEMPLATE = fs.readFileSync(path.join(__dirname, '..', 'views', 'v.html'), 'utf8');

function boot({ viewId = '555', token = 'tok', duration = 100 } = {}) {
  const calls = [];
  const html = TEMPLATE
    .split('{{VIEW_ID}}').join(viewId)
    .split('{{TRACK_TOKEN}}').join(token)
    .split('{{CANONICAL_SLUG}}').join('demo')
    .split('{{ACTIONS_HTML}}').join('<a class="vid-btn" href="/x">Book</a>');
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://4lsg.com/v/demo',
    beforeParse(window) {
      window.fetch = (url, opts) => {
        calls.push({ url, body: JSON.parse(opts.body) });
        return Promise.resolve({ ok: true });
      };
      let ranges = [];
      Object.defineProperty(window.HTMLMediaElement.prototype, 'played', {
        get: () => ({ length: ranges.length, start: (i) => ranges[i][0], end: (i) => ranges[i][1] }),
      });
      Object.defineProperty(window.HTMLMediaElement.prototype, 'duration', { get: () => duration });
      window.__setRanges = (r) => { ranges = r; };
    },
  });
  const { window } = dom;
  const video = window.document.querySelector('.video-wrap video');
  return {
    calls, window, video,
    fire: (type) => video.dispatchEvent(new window.Event(type)),
    played: (...r) => window.__setRanges(r),
    reports: () => calls.filter((c) => c.url.endsWith('/track')).map((c) => c.body),
  };
}

describe('what counts as watched', () => {
  test('a drag to the end reports only what played, even though ended fires', () => {
    const p = boot();
    p.played([0, 3], [98, 100]);
    p.fire('ended');
    expect(p.reports()).toEqual([expect.objectContaining({ event: 'complete', watchSeconds: 5, completionPct: 5 })]);
  });

  test('watching it all reports 100', () => {
    const p = boot();
    p.played([0, 100]);
    p.fire('ended');
    expect(p.reports()[0]).toMatchObject({ event: 'complete', watchSeconds: 100, completionPct: 100 });
  });

  test('separate ranges add up', () => {
    const p = boot();
    p.played([0, 40], [60, 90]);
    p.fire('ended');
    expect(p.reports()[0]).toMatchObject({ watchSeconds: 70, completionPct: 70 });
  });

  test('an unknown duration reports the seconds and no percent', () => {
    const p = boot({ duration: NaN });
    p.played([0, 12]);
    p.fire('ended');
    expect(p.reports()[0]).toMatchObject({ watchSeconds: 12, completionPct: 0 });
  });
});

describe('progress beacons', () => {
  test('nothing under 10 real seconds, then one', () => {
    const p = boot();
    p.played([0, 9.9]);
    p.fire('timeupdate');
    expect(p.reports()).toHaveLength(0);
    p.played([0, 10]);
    p.fire('timeupdate');
    expect(p.reports()).toEqual([expect.objectContaining({ event: 'progress', watchSeconds: 10, completionPct: 10 })]);
  });

  test('the next one waits another 10 seconds', () => {
    const p = boot();
    p.played([0, 10]);
    p.fire('timeupdate');
    p.played([0, 19]);
    p.fire('timeupdate');
    expect(p.reports()).toHaveLength(1);
    p.played([0, 20]);
    p.fire('timeupdate');
    expect(p.reports()).toHaveLength(2);
  });

  test('a drag alone never reports', () => {
    const p = boot();
    p.played([0, 2], [80, 82]);
    p.fire('timeupdate');
    expect(p.reports()).toHaveLength(0);
  });
});

describe('leaving the page', () => {
  test('pagehide sends what played since the last report', () => {
    const p = boot();
    p.played([0, 7]);
    p.window.dispatchEvent(new p.window.Event('pagehide'));
    expect(p.reports()).toEqual([expect.objectContaining({ event: 'progress', watchSeconds: 7, completionPct: 7 })]);
  });

  test('going to the background sends it too', () => {
    const p = boot();
    p.played([0, 7]);
    Object.defineProperty(p.window.document, 'visibilityState', { value: 'hidden', configurable: true });
    p.window.document.dispatchEvent(new p.window.Event('visibilitychange'));
    expect(p.reports()).toHaveLength(1);
  });

  test('coming back to the page sends nothing', () => {
    const p = boot();
    p.played([0, 7]);
    Object.defineProperty(p.window.document, 'visibilityState', { value: 'visible', configurable: true });
    p.window.document.dispatchEvent(new p.window.Event('visibilitychange'));
    expect(p.reports()).toHaveLength(0);
  });

  test('nothing new means nothing sent, so background then pagehide sends once', () => {
    const p = boot();
    p.played([0, 7]);
    Object.defineProperty(p.window.document, 'visibilityState', { value: 'hidden', configurable: true });
    p.window.document.dispatchEvent(new p.window.Event('visibilitychange'));
    p.window.document.dispatchEvent(new p.window.Event('visibilitychange'));
    p.window.dispatchEvent(new p.window.Event('pagehide'));
    expect(p.reports()).toHaveLength(1);
  });
});

describe('identity on every report', () => {
  test('play, progress, complete and a button click all carry the token', () => {
    const p = boot({ token: 'secret-token' });
    p.fire('play');
    p.played([0, 10]);
    p.fire('timeupdate');
    p.fire('ended');
    p.window.document.addEventListener('click', (e) => e.preventDefault()); // jsdom cannot navigate
    p.window.document.querySelector('.actions a.vid-btn').click();
    expect(p.calls).toHaveLength(4);
    for (const c of p.calls) expect(c.body).toMatchObject({ viewId: '555', token: 'secret-token' });
  });

  test('play is sent once', () => {
    const p = boot();
    p.fire('play');
    p.fire('play');
    expect(p.reports()).toHaveLength(1);
  });

  test.each([['view', { viewId: '' }], ['token', { token: '' }]])('a page with no %s stays silent', (_n, opts) => {
    const p = boot(opts);
    p.fire('play');
    p.played([0, 50]);
    p.fire('ended');
    expect(p.calls).toHaveLength(0);
  });
});
