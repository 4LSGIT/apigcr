// tests/videoManager.views.test.js
//
/**
 * The Views tab, run for real in jsdom from public/videoManager.html. Every
 * action goes through the rendered control, because an inline handler resolves
 * names differently from a direct call and only a click can show that.
 *
 *   - Switching tabs leaves an open editor where it was.
 *   - Each filter reaches the query string, and Clear puts the defaults back.
 *   - "See who watched" opens this video with automated opens shown, so the
 *     list adds up to the panel.
 *   - Exclude and Restore refresh the list, the video counts and the open
 *     video's panel.
 *   - An answer to an older request can't overwrite a newer one, and Load more
 *     can't be pressed against rows a reload is replacing.
 *   - Stored text can't become markup.
 *   - Times are firm time, whatever the browser's zone.
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'videoManager.html'), 'utf8');

const viewRow = (over = {}) => ({
  id: 5, video_id: 3, video_title: 'Demo', contact_id: 10, contact_name: 'Ann Lee', case_id: 'C1', case_number: '26-40001',
  opened_at: '2026-07-01T12:00:00.000Z', played_at: '2026-07-01T12:00:05.000Z', completed_at: null,
  watch_seconds: 65, completion_pct: 40, cta_labels: [], user_agent: 'iPhone UA', device: 'iPhone',
  excluded_at: null, excluded_by_name: null, automated: false, before_reset: false, ...over,
});

function boot({ views = [viewRow()], total, onViews, secondTitle = 'Other' } = {}) {
  const calls = [];
  const addFile = jest.fn();
  let viewsAnswer = { views, total: total ?? views.length, played: 1, completed: 0 };
  const swal = { fire: jest.fn(async () => ({ isConfirmed: true })) };
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously',
    url: 'https://app.4lsg.com/videoManager.html',
    beforeParse(window) {
      window.Swal = { mixin: () => swal, fire: swal.fire };
      window.addFile = addFile;
      window.uploadWithProgress = () => {};
      window.apiSend = async (url, method = 'GET') => {
        calls.push({ url, method });
        if (url === '/api/videos') return { videos: [{ id: 3, title: 'Demo', slug: 'demo', view_count: 7 }, { id: 4, title: secondTitle, slug: 'other', view_count: 0 }] };
        if (url.startsWith('/api/videos/views/')) return { id: 5, video_id: 3, excluded: url.endsWith('exclude'), changed: true };
        if (url.startsWith('/api/videos/views')) {
          if (onViews) return onViews(url);
          return viewsAnswer;
        }
        if (url === '/api/videos/3/analytics') return { total_views: 7, played_count: 1, cta_clicks_by_label: [] };
        if (url === '/api/videos/3') return { id: 3, title: 'Demo', slug: 'demo', actions: [], tags: [], aliases: [], related_videos: [] };
        throw new Error('unexpected ' + url);
      };
    },
  });
  const { window } = dom;
  const $ = (s) => window.document.querySelector(s);
  return {
    window, $, calls, addFile, swal,
    setViews: (v) => { viewsAnswer = v; },
    viewCalls: () => calls.filter((c) => c.method === 'GET' && c.url.startsWith('/api/videos/views')).map((c) => c.url),
    query: () => {
      const urls = calls.filter((c) => c.url.startsWith('/api/videos/views?'));
      return Object.fromEntries(new URL('https://x' + urls[urls.length - 1].url).searchParams);
    },
    settle: async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); },
    change: (sel, value) => {
      const el = $(sel);
      if (value !== undefined) el.value = value;
      el.dispatchEvent(new window.Event('change', { bubbles: true }));
    },
  };
}

async function openViews(t) {
  await t.settle();
  t.$('.main-tab[data-main="views"]').click();
  await t.settle();
}

async function openEditor(t) {
  await t.settle();
  t.$('.list-item').click();
  await t.settle();
}

describe('tabs', () => {
  test('Views shows its pane, hides New Video, and asks with the defaults', async () => {
    const t = boot();
    await openViews(t);
    expect(t.$('#panes').style.display).toBe('none');
    expect(t.$('#viewsPane').style.display).toBe('');
    expect(t.$('#newVideoBtn').style.display).toBe('none');
    expect(t.$('.main-tab[data-main="views"]').classList.contains('active')).toBe(true);
    expect(t.query()).toEqual({ limit: '100', offset: '0' });
  });

  test('coming back finds the editor as it was, typed edits included', async () => {
    const t = boot();
    await openEditor(t);
    const title = t.$('#editorContent input[type="text"]');
    title.value = 'Typed, not saved';
    await openViews(t);
    t.$('.main-tab[data-main="videos"]').click();
    expect(t.$('#panes').style.display).toBe('');
    expect(t.$('#viewsPane').style.display).toBe('none');
    expect(t.$('#newVideoBtn').style.display).toBe('');
    expect(t.$('#editorContent input[type="text"]')).toBe(title);
    expect(title.value).toBe('Typed, not saved');
  });
});

describe('filters', () => {
  test('the video menu lists every video and keeps its choice across a reload', async () => {
    const t = boot();
    await openViews(t);
    expect([...t.$('#vfVideo').options].map((o) => o.textContent)).toEqual(['All videos', 'Demo', 'Other']);
    t.change('#vfVideo', '4');
    await t.settle();
    t.$('.main-tab[data-main="videos"]').click();
    t.$('.main-tab[data-main="views"]').click();
    await t.settle();
    expect(t.$('#vfVideo').value).toBe('4');
    expect(t.query().video_id).toBe('4');
  });

  test.each([
    ['#vfVideo', '4', { video_id: '4' }],
    ['#vfStatus', 'clicked', { status: 'clicked' }],
    ['#vfWho', 'anonymous', { who: 'anonymous' }],
    ['#vfFrom', '2026-07-01', { from: '2026-07-01' }],
    ['#vfTo', '2026-07-02', { to: '2026-07-02' }],
  ])('%s', async (sel, value, want) => {
    const t = boot();
    await openViews(t);
    t.change(sel, value);
    await t.settle();
    expect(t.query()).toEqual({ ...want, limit: '100', offset: '0' });
  });

  test.each([
    ['#vfHideAuto', false, { automated: '1' }],
    ['#vfExcluded', true, { excluded: '1' }],
    ['#vfBeforeReset', true, { before_reset: '1' }],
  ])('%s', async (sel, checked, want) => {
    const t = boot();
    await openViews(t);
    t.$(sel).click();
    expect(t.$(sel).checked).toBe(checked);
    await t.settle();
    expect(t.query()).toEqual({ ...want, limit: '100', offset: '0' });
  });

  test('typing waits for a pause, then searches once', async () => {
    const t = boot();
    await openViews(t);
    const before = t.viewCalls().length;
    const box = t.$('#vfContact');
    for (const text of ['a', 'an', 'ann ']) {
      box.value = text;
      box.dispatchEvent(new t.window.Event('input', { bubbles: true }));
    }
    await t.settle();
    expect(t.viewCalls().length).toBe(before);
    await new Promise((r) => setTimeout(r, 340));
    await t.settle();
    expect(t.viewCalls().length).toBe(before + 1);
    expect(t.query().q).toBe('ann');
  });

  test('Clear filters puts every default back', async () => {
    const t = boot();
    await openViews(t);
    t.change('#vfStatus', 'played');
    t.change('#vfVideo', '4');
    t.$('#vfContact').value = 'ann';
    t.$('#vfHideAuto').click();
    t.$('#vfExcluded').click();
    t.$('#vfBeforeReset').click();
    t.$('#viewsChecks button').click();
    await t.settle();
    expect(t.query()).toEqual({ limit: '100', offset: '0' });
    expect(t.$('#vfHideAuto').checked).toBe(true);
  });
});

describe('"See who watched"', () => {
  test('opens this video with automated opens shown, whatever was set before', async () => {
    const t = boot();
    await openViews(t);
    t.change('#vfStatus', 'played');
    t.$('#vfExcluded').click();
    await t.settle();
    t.$('.main-tab[data-main="videos"]').click();
    t.$('.list-item').click();
    await t.settle();
    [...t.window.document.querySelectorAll('#editorContent button')].find((b) => /See who watched/.test(b.textContent)).click();
    await t.settle();
    expect(t.$('#viewsPane').style.display).toBe('');
    expect(t.$('#vfVideo').value).toBe('3');
    expect(t.query()).toEqual({ video_id: '3', automated: '1', limit: '100', offset: '0' });
  });
});

describe('rows', () => {
  test('a row reads as what happened', async () => {
    const t = boot({ views: [viewRow({ completed_at: '2026-07-01T12:01:00.000Z', completion_pct: 92, cta_labels: ['Book', 'Call'] })] });
    await openViews(t);
    const row = t.$('.views-table tbody tr').textContent;
    expect(row).toContain('Completed');
    expect(row).toContain('1:05 · 92%');
    expect(row).toContain('Book, Call');
    expect(row).toContain('iPhone');
    expect(t.$('#viewsSummary').textContent).toBe('1 view · 1 played · 0 completed');
  });

  test.each([
    ['Played', { played_at: 'x' }, 'Played'],
    ['Not played', { played_at: null }, 'Not played'],
    ['Anonymous', { contact_id: null, contact_name: null, case_id: null }, 'Anonymous'],
    ['Automated', { automated: true }, 'Automated'],
    ['Before reset', { before_reset: true }, 'Before reset'],
  ])('%s', async (_n, over, text) => {
    const t = boot({ views: [viewRow(over)] });
    await openViews(t);
    expect(t.$('.views-table tbody tr').textContent).toContain(text);
  });

  test('an unplayed view shows no time', async () => {
    const t = boot({ views: [viewRow({ played_at: null })] });
    await openViews(t);
    expect(t.$('.views-table tbody tr').textContent).not.toContain('%');
  });

  test('the viewer and the case open their files', async () => {
    const t = boot();
    await openViews(t);
    const [contact, kase] = t.window.document.querySelectorAll('.v-link');
    contact.click();
    expect(t.addFile).toHaveBeenLastCalledWith('Ann Lee', 'client', '10');
    kase.click();
    expect(t.addFile).toHaveBeenLastCalledWith('26-40001', 'case', 'C1');
  });

  test('a case with no number opens by id', async () => {
    const t = boot({ views: [viewRow({ case_number: null })] });
    await openViews(t);
    t.window.document.querySelectorAll('.v-link')[1].click();
    expect(t.addFile).toHaveBeenLastCalledWith('C1', 'case', 'C1');
  });

  test('stored text stays text', async () => {
    const bad = '"><img src=x onerror=alert(1)>';
    const t = boot({ secondTitle: `</option>${bad}`, views: [viewRow({ contact_name: bad, video_title: bad, cta_labels: [bad], device: bad, user_agent: bad, case_number: bad, excluded_at: 'x', excluded_by_name: bad })] });
    await openViews(t);
    expect(t.window.document.querySelector('#viewsPane img')).toBeNull();
    expect(t.$('.views-table tbody tr').textContent).toContain('<img');
    expect(t.$('#vfVideo').options[2].textContent).toBe(`</option>${bad}`);
  });

  test('no views says so', async () => {
    const t = boot({ views: [] });
    await openViews(t);
    expect(t.$('.views-table')).toBeNull();
    expect(t.$('#viewsTableWrap').textContent).toContain('No views match');
  });

  test('a failed load says so and drops the old rows', async () => {
    let fail = false;
    const t = boot({ onViews: async () => { if (fail) throw new Error('nope'); return { views: [viewRow()], total: 1, played: 1, completed: 0 }; } });
    await openViews(t);
    fail = true;
    t.change('#vfStatus', 'played');
    await t.settle();
    expect(t.$('.views-table')).toBeNull();
    expect(t.$('#viewsTableWrap').textContent).toContain('Failed to load: nope');
  });

  test('Opened is firm time: 03:30 UTC on July 2 is July 1 in Detroit', async () => {
    const t = boot({ views: [viewRow({ opened_at: '2026-07-02T03:30:00.000Z' })] });
    await openViews(t);
    expect(t.$('td[data-label="Opened"]').textContent).toContain('7/1/2026');
  });

  test('a view with no open time shows none', async () => {
    const t = boot({ views: [viewRow({ opened_at: null })] });
    await openViews(t);
    expect(t.$('td[data-label="Opened"]').textContent).toBe('');
  });

  test('the shell\'s firm zone wins over the default', async () => {
    const t = boot({ views: [viewRow({ opened_at: '2026-07-02T03:30:00.000Z' })] });
    t.window.firmData = { firmTimezone: 'Asia/Jerusalem' };
    await openViews(t);
    expect(t.$('td[data-label="Opened"]').textContent).toContain('7/2/2026');
  });

  test('a reload takes Load more away until the new rows are in', async () => {
    const answers = [];
    const t = boot({ onViews: () => new Promise((resolve) => answers.push(resolve)) });
    await t.settle();
    t.$('.main-tab[data-main="views"]').click();
    answers[0]({ views: [viewRow()], total: 5, played: 1, completed: 0 });
    await t.settle();
    expect(t.$('#viewsMore button')).not.toBeNull();
    t.change('#vfStatus', 'played');
    expect(t.$('#viewsMore button')).toBeNull();
    answers[1]({ views: [viewRow()], total: 5, played: 1, completed: 0 });
    await t.settle();
    expect(t.$('#viewsMore button')).not.toBeNull();
  });

  test('a superseded Load more neither adds rows nor complains', async () => {
    const answers = [];
    const t = boot({ onViews: () => new Promise((resolve, reject) => answers.push({ resolve, reject })) });
    await t.settle();
    t.$('.main-tab[data-main="views"]').click();
    answers[0].resolve({ views: [viewRow()], total: 5, played: 1, completed: 0 });
    await t.settle();
    t.$('#viewsMore button').click();
    t.$('#viewsMore button').click();
    await t.settle();
    answers[1].reject(new Error('gone'));
    answers[2].resolve({ views: [viewRow({ id: 6 })], total: 5, played: 1, completed: 0 });
    await t.settle();
    expect(t.swal.fire).not.toHaveBeenCalledWith('Error', 'gone', 'error');
    expect(t.window.document.querySelectorAll('.views-table tbody tr').length).toBe(2);
  });

  test('a Load more answering after a reload began adds nothing', async () => {
    const answers = [];
    const t = boot({ onViews: () => new Promise((resolve) => answers.push(resolve)) });
    await t.settle();
    t.$('.main-tab[data-main="views"]').click();
    answers[0]({ views: [viewRow({ id: 5 })], total: 5, played: 1, completed: 0 });
    await t.settle();
    t.$('#viewsMore button').click();
    await t.settle();
    t.change('#vfStatus', 'played');
    await t.settle();
    answers[1]({ views: [viewRow({ id: 6 })], total: 5, played: 1, completed: 0 });
    await t.settle();
    expect(t.window.document.querySelectorAll('.views-table tbody tr').length).toBe(1);
    answers[2]({ views: [viewRow({ id: 7 }), viewRow({ id: 8 })], total: 2, played: 1, completed: 0 });
    await t.settle();
    expect(t.window.document.querySelectorAll('.views-table tbody tr').length).toBe(2);
  });

  test('Load more asks past what is loaded and adds to it', async () => {
    const t = boot({ views: [viewRow({ id: 5 }), viewRow({ id: 6 })], total: 3 });
    await openViews(t);
    expect(t.$('#viewsMore').textContent).toContain('1 left');
    t.setViews({ views: [viewRow({ id: 7 })], total: 3, played: 1, completed: 0 });
    t.$('#viewsMore button').click();
    await t.settle();
    expect(t.query()).toMatchObject({ offset: '2' });
    expect(t.window.document.querySelectorAll('.views-table tbody tr').length).toBe(3);
    expect(t.$('#viewsMore').textContent).toBe('');
  });

  test('an older answer cannot overwrite a newer one', async () => {
    const answers = [];
    const t = boot({ onViews: () => new Promise((resolve) => answers.push(resolve)) });
    await openViews(t);
    t.change('#vfStatus', 'played');
    await t.settle();
    expect(answers.length).toBe(2);
    answers[1]({ views: [viewRow({ contact_name: 'Newer' })], total: 1, played: 1, completed: 0 });
    await t.settle();
    answers[0]({ views: [viewRow({ contact_name: 'Older' })], total: 1, played: 1, completed: 0 });
    await t.settle();
    expect(t.$('.views-table tbody tr').textContent).toContain('Newer');
    expect(t.$('.views-table tbody tr').textContent).not.toContain('Older');
  });
});

describe('Exclude and Restore', () => {
  const button = (t, text) => [...t.window.document.querySelectorAll('.v-action button')].find((b) => b.textContent === text);
  const hits = (t, url) => t.calls.filter((c) => c.url === url).length;

  test('Exclude posts, reloads the rows and the video counts, and the open panel', async () => {
    const t = boot();
    await openEditor(t);
    const title = t.$('#editorContent input[type="text"]');
    title.value = 'Typed, not saved';
    await openViews(t);
    const [lists, panels] = [hits(t, '/api/videos'), hits(t, '/api/videos/3/analytics')];
    t.setViews({ views: [], total: 0, played: 0, completed: 0 });
    button(t, 'Exclude').click();
    await t.settle();
    expect(t.calls).toContainEqual({ url: '/api/videos/views/5/exclude', method: 'POST' });
    expect(t.$('.views-table')).toBeNull();
    expect(hits(t, '/api/videos')).toBe(lists + 1);
    expect(hits(t, '/api/videos/3/analytics')).toBe(panels + 1);
    expect(t.$('#analytics-panel').textContent).toContain('Total views');
    expect(t.$('#editorContent input[type="text"]')).toBe(title);
    expect(title.value).toBe('Typed, not saved');
  });

  test('another video open: its panel stays', async () => {
    const t = boot();
    await t.settle();
    t.window.document.querySelectorAll('.list-item')[0].click();
    await t.settle();
    t.window.eval('state.selected = 4');
    await openViews(t);
    const panels = hits(t, '/api/videos/3/analytics');
    button(t, 'Exclude').click();
    await t.settle();
    expect(hits(t, '/api/videos/3/analytics')).toBe(panels);
    expect(hits(t, '/api/videos/4/analytics')).toBe(0);
  });

  test('an excluded row offers Restore, and says who excluded it', async () => {
    const t = boot({ views: [viewRow({ excluded_at: '2026-07-02T00:00:00.000Z', excluded_by_name: 'Fred' })] });
    await openViews(t);
    expect(t.$('.views-table tbody tr').classList.contains('is-excluded')).toBe(true);
    expect(t.$('.badge-contact').textContent).toBe('Excluded');
    expect(t.$('td[data-label="Opened"]').textContent).toContain('By Fred, 7/1/2026');
    expect(button(t, 'Exclude')).toBeUndefined();
    button(t, 'Restore').click();
    await t.settle();
    expect(t.calls).toContainEqual({ url: '/api/videos/views/5/restore', method: 'POST' });
  });

  test('a failure tells the person', async () => {
    const t = boot();
    await openViews(t);
    const real = t.window.apiSend;
    t.window.apiSend = async (url, m) => {
      if (url.endsWith('/exclude')) throw new Error('denied');
      return real(url, m);
    };
    button(t, 'Exclude').click();
    await t.settle();
    expect(t.swal.fire).toHaveBeenCalledWith('Error', 'denied', 'error');
  });
});
